# pi-memfs — an in-memory virtual FS for Pi agents (no sandbox)

Experiment: replace sandboxing in `elis-couper` with a **virtual filesystem**.
The agent gets `read` / `write` / `edit` / `ls` / `grep` / `find` tools that
operate on an in-memory tree, not the OS filesystem. Persistence is split:

- **Metadata** (tree, paths, sizes, mtimes, blob hashes) → **PostgreSQL**, keyed by `chat_id`
- **Content** (file bytes) → **S3**, content-addressed per chat

## Why

The only reason `elis-couper` would need a sandbox is `bash` — a real shell
needs real isolation (containers, seccomp, fs jails …). But we don't need
bash. Everything else the Pi SDK's file tools do is just an FS *interface*:
resolve a path, return bytes, list a dir, search. Nothing forces that
interface to be backed by a disk.

So instead of isolating the agent *from* the real FS, we never give it one:

- **Isolation by namespace, not by jail.** Every operation keys on `chat_id`.
  There is no path outside the chat's tree, so there is nothing to escape to.
- **Zero infra for isolation.** No containers, no firecracker, no tmpdir
  cleanup jobs. Postgres and S3 we already run.
- **Durable + resumable for free.** A chat's workspace survives process
  restarts and horizontal scaling — any server node can hydrate any chat.
- **Auditable.** Every file version is a content-addressed blob; the DB is a
  log of what the agent did to the workspace.

What we give up: no arbitrary process execution (that's the point), and file
tools must be reimplemented as custom Pi tools instead of the built-ins
(small, see below — the built-ins are thin wrappers over `node:fs` anyway).

## Architecture

```
                    Pi SDK session (per chat)
                    tools: read/write/edit/ls/grep/find (custom, VFS-backed)
                                  │
                                  ▼
                       VirtualFs (in-memory tree)
                    hydrate on session start ── lazy blob fetch
                    write-through on mutation
                     │                                │
                     ▼                                ▼
        PostgreSQL: vfs_files              S3: blobs/{chat_id}/{sha256}
        (path → metadata + blob hash,      (immutable, content-addressed)
         source of truth for the tree)
```

- **Hydrate**: on session start, one `SELECT` loads the whole tree for
  `chat_id` — paths + metadata only, no content. Cheap even at thousands of
  files.
- **Lazy content**: file bytes are fetched from S3 on first `read` (or
  `grep`) and cached in memory for the session's lifetime.
- **Write-through**: every `write`/`edit` uploads the new blob to S3 *first*,
  then upserts the PG row. A crashed session loses nothing that a tool call
  reported as done.

### Consistency between PG and S3

A write touches two stores; ordering makes this safe without transactions
spanning both:

1. `PUT s3://bucket/blobs/{chat_id}/{sha256(content)}` — **immutable and
   idempotent**. Re-uploading the same content is a no-op; nothing ever
   overwrites a blob with different bytes.
2. `INSERT ... ON CONFLICT (chat_id, path) DO UPDATE` the metadata row
   pointing at that hash.

Failure modes:
- Crash between 1 and 2 → an **orphaned blob**. Harmless; a periodic sweep
  (or S3 lifecycle rule) can collect blobs not referenced by any row.
- The reverse (row without blob) **cannot happen** — the row is only written
  after the blob exists.

PG is the single source of truth for "what files exist"; S3 is a dumb,
append-only blob store.

### Content addressing

Blob key = `blobs/{chat_id}/{sha256(content)}`.

- Dedup for free (agent rewrites same content → same key, no new upload).
- Cheap versioning later: keep old `(path, blob_sha)` pairs in a history
  table and you have point-in-time workspace snapshots without copying bytes.
- Scoping the key by `chat_id` keeps deletion trivial (drop the prefix) and
  avoids cross-tenant blob sharing questions. Revisit if dedup across chats
  ever matters (it won't for a while).

Inline-in-PG alternative (a `bytea` column, skip S3 entirely) is genuinely
simpler and fine below ~100 KB/file; we go S3 because documents (PDFs, XLSX
extracts) will blow past that. If the experiment shows files stay tiny,
collapsing to PG-only is a one-file change (`BlobStore` interface below).

## PostgreSQL schema

```sql
CREATE TABLE vfs_files (
  chat_id    text        NOT NULL,
  path       text        NOT NULL,          -- normalized, absolute, '/'-rooted: '/notes/plan.md'
  blob_sha   text        NOT NULL,          -- sha256 hex of content; S3 key suffix
  size       integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, path)
);

-- hydrate query is a prefix scan:
--   SELECT path, blob_sha, size, updated_at FROM vfs_files WHERE chat_id = $1;
```

Notes:
- **Directories are implicit** (like S3/git): they exist iff a file path has
  them as a prefix. `ls`/`find` synthesize them in memory. No dir rows, no
  empty-dir support — acceptable for an agent workspace.
- Paths are normalized on the way in (`/` root, no `..`, no trailing `/`);
  the VFS rejects anything that escapes root, which is the entire "sandbox".

## The `VirtualFs` core (`src/vfs.ts`)

Session-lifetime object. Not an abstract POSIX layer — exactly the surface
the six tools need.

```ts
export interface FileMeta {
  path: string;      // '/notes/plan.md'
  blobSha: string;
  size: number;
  updatedAt: Date;
}

export interface MetaStore {
  loadTree(chatId: string): Promise<FileMeta[]>;
  upsert(chatId: string, meta: FileMeta): Promise<void>;
  remove(chatId: string, path: string): Promise<void>;
}

export interface BlobStore {
  get(chatId: string, sha: string): Promise<Uint8Array>;
  put(chatId: string, sha: string, content: Uint8Array): Promise<void>;
}

export class VirtualFs {
  private tree = new Map<string, FileMeta>();     // path → meta
  private cache = new Map<string, string>();      // blobSha → decoded content

  private constructor(
    private readonly chatId: string,
    private readonly meta: MetaStore,
    private readonly blobs: BlobStore,
  ) {}

  /** One PG query; no S3 traffic. */
  static async hydrate(chatId: string, meta: MetaStore, blobs: BlobStore) {
    const fs = new VirtualFs(chatId, meta, blobs);
    for (const f of await meta.loadTree(chatId)) fs.tree.set(f.path, f);
    return fs;
  }

  async read(path: string): Promise<string> {
    const f = this.tree.get(normalize(path));
    if (!f) throw new Error(`ENOENT: ${path}`);
    let content = this.cache.get(f.blobSha);
    if (content === undefined) {
      content = new TextDecoder().decode(await this.blobs.get(this.chatId, f.blobSha));
      this.cache.set(f.blobSha, content);
    }
    return content;
  }

  /** Blob first, then metadata — see "Consistency" above. */
  async write(path: string, content: string): Promise<void> {
    const p = normalize(path);
    const bytes = new TextEncoder().encode(content);
    const sha = await sha256hex(bytes);
    await this.blobs.put(this.chatId, sha, bytes);        // idempotent
    const meta: FileMeta = { path: p, blobSha: sha, size: bytes.length, updatedAt: new Date() };
    await this.meta.upsert(this.chatId, meta);            // source of truth
    this.tree.set(p, meta);
    this.cache.set(sha, content);
  }

  async edit(path: string, oldStr: string, newStr: string): Promise<void> {
    const content = await this.read(path);
    const idx = content.indexOf(oldStr);
    if (idx === -1) throw new Error(`edit: old_string not found in ${path}`);
    if (content.indexOf(oldStr, idx + 1) !== -1)
      throw new Error(`edit: old_string is not unique in ${path}`);
    await this.write(path, content.replace(oldStr, newStr));
  }

  /** Synthesizes implicit directories from path prefixes. */
  ls(dir: string): { name: string; type: "file" | "dir"; size?: number }[] { /* walk this.tree */ }

  /** Both run in-process over the in-memory tree — a chat workspace is small. */
  find(glob: string): string[] { /* micromatch over tree keys */ }
  async grep(pattern: string, glob?: string): Promise<GrepMatch[]> {
    // note: reads (and caches) every candidate blob — fine at workspace scale
  }
}
```

`normalize()` is the security boundary: resolve `.`/`..` segments, require
the result to stay under `/`, reject `\0` etc. ~15 lines, and it's the whole
"escape prevention" story.

## Store implementations

### `src/store/pg.ts`

```ts
import postgres from "postgres";
import type { FileMeta, MetaStore } from "../vfs.js";

export function pgMetaStore(sql: postgres.Sql): MetaStore {
  return {
    async loadTree(chatId) {
      return sql<FileMeta[]>`
        SELECT path, blob_sha AS "blobSha", size, updated_at AS "updatedAt"
        FROM vfs_files WHERE chat_id = ${chatId}`;
    },
    async upsert(chatId, m) {
      await sql`
        INSERT INTO vfs_files (chat_id, path, blob_sha, size, updated_at)
        VALUES (${chatId}, ${m.path}, ${m.blobSha}, ${m.size}, ${m.updatedAt})
        ON CONFLICT (chat_id, path)
        DO UPDATE SET blob_sha = EXCLUDED.blob_sha, size = EXCLUDED.size,
                      updated_at = EXCLUDED.updated_at`;
    },
    async remove(chatId, path) {
      await sql`DELETE FROM vfs_files WHERE chat_id = ${chatId} AND path = ${path}`;
    },
  };
}
```

### `src/store/s3.ts`

```ts
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { BlobStore } from "../vfs.js";

export function s3BlobStore(client: S3Client, bucket: string): BlobStore {
  const key = (chatId: string, sha: string) => `blobs/${chatId}/${sha}`;
  return {
    async get(chatId, sha) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(chatId, sha) }));
      return res.Body!.transformToByteArray();
    },
    async put(chatId, sha, content) {
      // Immutable + content-addressed: unconditional PUT is safe and idempotent.
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key(chatId, sha), Body: content }));
    },
  };
}
```

For local dev, point the same client at MinIO/localstack via `S3_ENDPOINT` +
`forcePathStyle` (see `.env.sample`). An `InMemoryBlobStore` (a `Map`) makes
tests need no infra at all.

## Wiring into the Pi session (`src/tools.ts`, `src/agent.ts`)

Disable the built-in file tools, register VFS-backed replacements under the
**same names** — the model's priors about `read`/`write`/`edit` carry over.

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { VirtualFs } from "./vfs.js";

export function vfsTools(vfs: VirtualFs) {
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
      return { content: [{ type: "text", text: `Wrote ${path}` }], details: {} };
    },
  });

  // edit / ls / grep / find follow the same shape
  return [read, write /*, edit, ls, grep, find */];
}
```

```ts
// per-chat session construction (agent.ts / the future Hono handler)
const vfs = await VirtualFs.hydrate(chatId, pgMetaStore(sql), s3BlobStore(s3, bucket));

const { session } = await createAgentSession({
  model,
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  noTools: "builtin",          // no real-FS tools, no bash — the whole point
  customTools: vfsTools(vfs),
  tools: ["read", "write", "edit", "ls", "grep", "find"],
});
```

In `elis-couper` this slots into the existing per-chat session setup: the
Hono handler already resolves a `chat_id`; `VirtualFs.hydrate` becomes part
of session construction. Nothing about the AG-UI adapter changes.

## Concurrency & lifecycle

- **One live session per chat at a time** is the operating assumption (same
  as chat semantics generally). Two concurrent sessions on one `chat_id`
  would last-write-win at the PG row level — not corrupt, just racy. If this
  ever matters, add `expected_sha` optimistic locking to `upsert`.
- **Memory**: the session holds the tree + read-blob cache. Workspaces are
  small (docs + notes, not repos); if a chat someday holds 500 MB of PDFs,
  cap the cache with LRU eviction — blobs re-fetch from S3 transparently.
- **Deletion / retention**: drop rows by `chat_id`, lifecycle-expire the
  `blobs/{chat_id}/` prefix.

## What to materialize, in order

1. `src/vfs.ts` — `VirtualFs` + `normalize()` + in-memory stores; unit-test
   the tree/edit/glob logic with zero infra.
2. `src/store/pg.ts` + `schema.sql` — against local Postgres.
3. `src/store/s3.ts` — against MinIO.
4. `src/tools.ts` + `src/agent.ts` — readline REPL clone of `pi-dev-agent`
   with `--chat <id>`, proving hydrate → converse → restart → re-hydrate.
5. Port into `elis-couper`'s session construction.

## Open questions

- **Binary files**: tools speak text. Store bytes, expose e.g. base64 or a
  "binary file, N bytes" stub on `read`? Decide when documents land.
- **Seeding**: how do uploaded documents enter the VFS — an ingest endpoint
  writing through the same `VirtualFs.write` path seems right.
- **History table** (`vfs_file_versions`): cheap to add given content
  addressing; skip until something needs point-in-time restore.
- **Size limits**: per-file and per-chat quotas belong in `write` from day
  one in prod; skip for the experiment.
