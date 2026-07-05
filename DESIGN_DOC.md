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
_is_ the metadata. A metadata DB earns its place only when we need a query S3
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

No in-memory index, no hydrate lifecycle: S3 _is_ the state. Every `read`/`ls`
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
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) keys.push(o.Key!);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }

  async read(path: string): Promise<string> {
    const key = (await this.keysUnder(`${this.chatId}/${normalize(path)}@`)).at(
      -1,
    ); // newest
    if (!key) throw new Error(`ENOENT: ${path}`);
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return res.Body!.transformToString();
  }

  /** New timestamped version. Old versions untouched. */
  async write(path: string, content: string): Promise<void> {
    const key = `${this.chatId}/${normalize(path)}@${timestamp()}`;
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: content }),
    );
  }

  async ls(): Promise<string[]> {
    const keys = await this.keysUnder(`${this.chatId}/`);
    const paths = new Set(
      keys.map((k) => k.slice(this.chatId.length + 1, k.lastIndexOf("@"))),
    );
    return [...paths].sort();
  }
}
```

That's the whole persistence layer. ~55 LoC.

## Tools (`src/store/tools.ts`)

Four tools, registered under the built-in names (so the model's priors carry
over) plus `jq`. Built-ins disabled via `noTools: "builtin"`. `grep` (text
search over latest versions) is the planned fifth — see the roadmap at the end.

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { VirtualFs } from "./fs.js";

const run = promisify(execFile);

export function tools(vfs: VirtualFs) {
  const read = defineTool({
    name: "read",
    label: "Read",
    description: "Read a file from the workspace",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, { path }) => ({
      content: [{ type: "text", text: await vfs.read(path) }],
      details: {},
    }),
  });

  const write = defineTool({
    name: "write",
    label: "Write",
    description: "Create or overwrite a file in the workspace",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, { path, content }) => {
      await vfs.write(path, content);
      return {
        content: [{ type: "text", text: `Wrote ${path}` }],
        details: {},
      };
    },
  });

  const ls = defineTool({
    name: "ls",
    label: "List",
    description: "List files in the workspace",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [
        { type: "text", text: (await vfs.ls()).join("\n") || "(empty)" },
      ],
      details: {},
    }),
  });

  // Completely dummy wrapper around the jq binary. Safe despite "no bash":
  // execFile (no shell) + a single trusted binary + arg array => no injection.
  // Input is workspace content piped on stdin. Requires `jq` on PATH.
  const jq = defineTool({
    name: "jq",
    label: "jq",
    description: "Run a jq filter over a JSON file in the workspace",
    parameters: Type.Object({ path: Type.String(), filter: Type.String() }),
    execute: async (_id, { path, filter }) => {
      const input = await vfs.read(path);
      try {
        // promisify(execFile) has no `input` option — pipe via child.stdin.
        const proc = run("jq", [filter], { maxBuffer: 32 << 20 });
        proc.child.stdin!.end(input);
        const { stdout } = await proc;
        return { content: [{ type: "text", text: stdout }], details: {} };
      } catch (e: any) {
        return {
          content: [
            { type: "text", text: `jq error: ${e.stderr || e.message}` },
          ],
          details: {},
        };
      }
    },
  });

  return { read, write, ls, jq };
}
```

## Harness (`src/agent.ts`)

`pi-dev-agent`-style readline REPL. Build the S3 client (dedicated `S3_*`
creds so MinIO doesn't clobber the AWS chain Bedrock uses — see `.env.sample`),
build the `VirtualFs`, wire the session.

```ts
const s3 = new S3Client({
  region: process.env.S3_REGION,
  endpoint: process.env.S3_ENDPOINT || undefined, // MinIO for local dev
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  credentials: process.env.S3_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      }
    : undefined, // else default AWS chain
});

const chatId = process.argv.includes("--chat")
  ? process.argv[process.argv.indexOf("--chat") + 1]
  : "default";

const vfs = new VirtualFs(chatId, s3, process.env.S3_BUCKET!);

const { session } = await createAgentSession({
  model,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  noTools: "builtin", // no real-FS tools, no bash — the whole point
  customTools: Object.values(tools(vfs)),
  tools: ["read", "write", "ls", "jq"],
});
// subscribe to events + readline loop, as in pi-dev-agent/agent.ts
```

## Concurrency

Nothing to reconcile: there is no in-memory index, so every read/ls already
reflects S3. Concurrent sessions on the same chat write timestamped versions
and each subsequent read sees the latest. Nothing corrupts.

Assumptions (deliberate, not bugs):

- **Not designed for sub-millisecond concurrency under one `chat_id`.** The
  version key is a millisecond-precision timestamp, so two writes to the _same
  path_ in the _same millisecond_ under the _same chat_ produce the identical
  key and the second silently wins. We assume a single logical writer per chat
  and do not defend against a write-write race that tight. (If that ever
  changes, add a uniquifier or move to native S3 versioning — roadmap item 2.)
- **`chat_id` is assumed unique and server-generated.** It is the namespace
  boundary between chats; the app embedding this workspace owns minting it
  (unique, no `/`). We do not validate it here — a colliding or slash-bearing
  id would alias namespaces, and that is the caller's contract to uphold
  (roadmap item 3).

## Deliberately not doing (YAGNI)

- **Postgres / a metadata DB** — `ListObjectsV2` is the metadata.
- **`edit` / `find`** — `read` + `write` + `ls` cover a small workspace;
  `jq` + `grep` cover structured JSON and text search (the Rossum case). Add
  `edit` back the day whole-file rewrites cost too many tokens. (`grep` is
  in scope but not yet built — it is the documented fallback for the Rossum
  search skill; see the roadmap.)
- **Delete, content cache, dedup, content-addressing, dir-tree synthesis.**

## What to materialize, in order

1. `src/store/fs.ts` — `VirtualFs` (timestamp, normalize, read, write, ls). ✅
2. `src/store/tools.ts` — the four tools (`read`/`write`/`ls`/`jq`). ✅
3. `src/agent.ts` — S3 client + `VirtualFs` + session + REPL. ✅ (currently
   hard-wired to MinIO + Bedrock haiku for the local leak test).

Test path: `docker compose up -d minio createbuckets`, then
`npm start -- --chat demo` → write a file, restart, read it back; write it
again and confirm a second timestamped object appears in the bucket.

## Roadmap (hardening, before this is production-shaped)

Ordered by what unblocks the go/no-go test against elis-couper:

1. **Harden `jq`** — run with an empty env (`env: {}`), a wall-clock
   `timeout`, and a capped output. Today the subprocess inherits the host env
   (AWS creds) and can run unbounded; that is the one place the "no shell, so
   nothing to isolate" argument leaks.
2. **Fix versioning** — the `@timestamp` scheme collides on same-millisecond
   writes and lets a literal `@` in a path shadow another file. Prefer native
   S3 object versioning (latest = one `GET`, history = `ListObjectVersions`);
   or, if keeping the scheme, add a uniquifier and reject `@` in `normalize()`.
3. **Treat `chat_id` as a server-generated, validated id** (no `/`), not raw
   client input — the prefix is a namespace convention, not yet a boundary.
4. **Add `grep` + `read` truncation + a shared read-only snapshot prefix**,
   then port the Rossum search skill and run elis-couper's read-only corpus.
   That is the real go/no-go test.
