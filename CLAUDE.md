# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Experiment repo: replace sandboxing for Pi-SDK agents (see `~/elis-couper-2`)
with a **sandbox-free S3-backed workspace** — no bash, no Postgres. Custom
`read`/`write`/`ls`/`jq` tools read/write files in S3, scoped by `chat_id`.
Every write is a new timestamped version; "latest" wins (rir's
timestamped-handle pattern).

[DESIGN_DOC.md](DESIGN_DOC.md) is the source of truth for the design and holds
the code snippets being materialized — keep it in sync when the implementation
diverges from it. Guiding principle: **ridiculous simplicity, YAGNI.**

## Commands

- `npm install` — install dependencies
- `npm start -- --chat <id>` — run [src/agent.ts](src/agent.ts) via `tsx` (ESM, no build step)
- `npm run typecheck` — `tsc --noEmit`
- `docker compose up -d minio createbuckets` — local S3 (MinIO) + bucket

## Layout

- `src/fs.ts` — `VirtualFs`: stamp/normalize/hydrate/read/write/ls over S3 (the whole persistence layer)
- `src/tools.ts` — Pi tools (`defineTool`) `read`/`write`/`ls`/`jq`, registered under the built-in names
- `src/agent.ts` — readline REPL harness: S3 client → per-chat hydrate → session

Requires the `jq` binary on PATH (the `jq` tool is a dummy `execFile` wrapper).

SDK reference material lives in `node_modules/@earendil-works/pi-coding-agent/docs/`
and `.../examples/` — consult these when extending the agent rather than guessing
the API.

## Conventions

- S3 key = `{chat_id}/{path}@{timestamp}`; timestamp is fixed-width UTC so
  lexical sort == chronological. Writes never overwrite (versioning is free).
- `normalize()` in `src/fs.ts` is cosmetic (one key per logical path), **not**
  a security boundary — S3 keys are opaque, there is no real FS to escape.
