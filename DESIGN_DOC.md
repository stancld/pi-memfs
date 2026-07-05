# pi-memfs — a sandbox-free workspace for Pi agents (S3-only)

Experiment: replace sandboxing in `elis-couper` with a virtual filesystem.
The agent gets `read` / `write` / `ls` / `jq` tools that read and write files
in **S3, scoped by `chat_id`** — no bash, no containers, no real disk, and
**no Postgres**. Every write is a new timestamped version; "latest" wins.

## Why

The only reason to sandbox is `bash` — a real shell needs real isolation. We
don't need bash. The rest of the file tools are just an interface: resolve a
path, return bytes, list. Nothing forces that to be a disk.

- **Isolation by namespace, not a jail.** Every key is prefixed with
  `chat_id`. There is no path outside the chat, so nothing to escape to.
  (S3 keys are opaque strings — `..` is not special, there is no real FS.)
- **No infra we don't already run.** Just S3. No sandbox, no Postgres.
- **Durable + resumable.** Any node serves any chat by listing a prefix.

**Why no Postgres?** `ListObjectsV2` already returns key + size + mtime — that
*is* the metadata. A metadata DB earns its place only when we need a query S3
can't do (cross-chat search, joins, transactions). We don't. YAGNI. Add it
the day a query needs it.

## Layout in S3

One bucket. Each file version is one object:

```
{chat_id}/{path}@{timestamp}
```

- `timestamp` is **fixed-width and UTC** so a lexicographic sort equals a
  chronological one (rir's timestamped-handle pattern,
  `commons/storage/morgan_storage/storage.py::get_latest_timestamped_handle`).
  e.g. `2026-07-05T12:00:00.000Z` → `20260705120000000`.
- **Writes never overwrite.** Each write is a new object → the version history
  is the set of objects sharing a `{chat_id}/{path}@` prefix; "latest" is the
  max suffix. Free history, free rollback, no mutation to reason about.
- **No delete** (YAGNI). If ever needed, a tombstone version.

## The core (`src/store/fs.ts`)

No in-memory index, no hydrate lifecycle: S3 *is* the state. Every `read`/`ls`
lists the relevant prefix fresh, so it always sees the true latest — no stale
index to reconcile, nothing to keep current on write. The fixed-width stamp
means a lexical sort of the keys under a prefix is already chronological, so
"latest" is just `.at(-1)`. No content cache — S3 is fast and chats are short.

```ts
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

/** Fixed-width UTC stamp, so lexical order == chronological order. */
function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, ""); // "20260705120000000"
}

/** Cosmetic only — one canonical key per logical path. Not a security boundary. */
function normalize(path: string): string {
  return path.replace(/\/+/g, "/").replace(/^\/|\/$/g, ""); // "notes/plan.md"
}

export class VirtualFs {
  constructor(
    private readonly chatId: string,
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  /** All keys under a prefix, sorted oldest→newest (fixed-width stamp ⇒ lexical == chronological). */
  private async keysUnder(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) keys.push(o.Key!);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async read(path: string): Promise<string> {
    const key = (await this.keysUnder(`${this.chatId}/${normalize(path)}@`)).at(-1); // newest
    if (!key) throw new Error(`ENOENT: ${path}`);
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body!.transformToString();
  }

  /** New timestamped version. Old versions untouched. */
  async write(path: string, content: string): Promise<void> {
    const key = `${this.chatId}/${normalize(path)}@${timestamp()}`;
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content }));
  }

  async ls(): Promise<string[]> {
    const keys = await this.keysUnder(`${this.chatId}/`);
    const paths = new Set(keys.map((k) => k.slice(this.chatId.length + 1, k.lastIndexOf("@"))));
    return [...paths].sort();
  }
}
```

That's the whole persistence layer. ~55 LoC.

## Tools (`src/tools.ts`)

Four tools, registered under the built-in names (so the model's priors carry
over) plus `jq`. Built-ins disabled via `noTools: "builtin"`.

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VirtualFs } from "./fs.js";

const run = promisify(execFile);

export function tools(vfs: VirtualFs) {
  const read = defineTool({
    name: "read", label: "Read",
    description: "Read a file from the workspace",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, { path }) => ({
      content: [{ type: "text", text: await vfs.read(path) }], details: {},
    }),
  });

  const write = defineTool({
    name: "write", label: "Write",
    description: "Create or overwrite a file in the workspace",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, { path, content }) => {
      await vfs.write(path, content);
      return { content: [{ type: "text", text: `Wrote ${path}` }], details: {} };
    },
  });

  const ls = defineTool({
    name: "ls", label: "List",
    description: "List files in the workspace",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: vfs.ls().join("\n") || "(empty)" }], details: {},
    }),
  });

  // Completely dummy wrapper around the jq binary. Safe despite "no bash":
  // execFile (no shell) + a single trusted binary + arg array => no injection.
  // Input is workspace content piped on stdin. Requires `jq` on PATH.
  const jq = defineTool({
    name: "jq", label: "jq",
    description: "Run a jq filter over a JSON file in the workspace",
    parameters: Type.Object({ path: Type.String(), filter: Type.String() }),
    execute: async (_id, { path, filter }) => {
      const input = await vfs.read(path);
      try {
        const { stdout } = await run("jq", [filter], { input, maxBuffer: 32 << 20 });
        return { content: [{ type: "text", text: stdout }], details: {} };
      } catch (e: any) {
        return { content: [{ type: "text", text: `jq error: ${e.stderr || e.message}` }], details: {} };
      }
    },
  });

  return [read, write, ls, jq];
}
```

## Harness (`src/agent.ts`)

`pi-dev-agent`-style readline REPL. Build the S3 client (dedicated `S3_*`
creds so MinIO doesn't clobber the AWS chain Bedrock uses — see `.env.sample`),
build the `VirtualFs`, wire the session.

```ts
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined,          // MinIO for local dev
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: process.env.S3_ACCESS_KEY_ID
    ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! }
    : undefined,                                            // else default AWS chain
});

const chatId = process.argv.includes("--chat")
  ? process.argv[process.argv.indexOf("--chat") + 1]
  : "default";

const vfs = new VirtualFs(chatId, s3, process.env.S3_BUCKET!);

const { session } = await createAgentSession({
  model,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  noTools: "builtin",                    // no real-FS tools, no bash — the whole point
  customTools: tools(vfs),
  tools: ["read", "write", "ls", "jq"],
});
// subscribe to events + readline loop, as in pi-dev-agent/agent.ts
```

## Concurrency

Nothing to reconcile: there is no in-memory index, so every read/ls already
reflects S3. Two concurrent sessions on the same chat both write non-colliding
timestamped versions, and each subsequent read sees the true latest. Nothing
corrupts.

## Deliberately not doing (YAGNI)

- **Postgres / a metadata DB** — `ListObjectsV2` is the metadata.
- **`edit` / `grep` / `find`** — `read` + `write` + `ls` cover a small
  workspace; `jq` covers structured JSON (the Rossum case). Add `edit` back
  the day whole-file rewrites cost too many tokens.
- **Delete, content cache, dedup, content-addressing, dir-tree synthesis.**

## What to materialize, in order

1. `src/store/fs.ts` — `VirtualFs` (timestamp, normalize, read, write, ls).
2. `src/tools.ts` — the four tools.
3. `src/agent.ts` — S3 client + `VirtualFs` + session + REPL.

Test path: `docker compose up -d minio createbuckets`, then
`npm start -- --chat demo` → write a file, restart, read it back; write it
again and confirm a second timestamped object appears in the bucket.
