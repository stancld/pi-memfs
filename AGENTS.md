# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Experiment repo: replace sandboxing for Pi-SDK agents (see `~/elis-couper-2`)
with a **virtual in-memory filesystem** — no bash, custom `read`/`write`/`edit`/
`ls`/`grep`/`find` tools over an in-memory tree, metadata per `chat_id` in
PostgreSQL, content-addressed blobs in S3.

[DESIGN_DOC.md](DESIGN_DOC.md) is the source of truth for the design and holds
the code snippets being materialized — keep it in sync when the implementation
diverges from it.

## Commands

- `npm install` — install dependencies
- `npm start` — run [src/agent.ts](src/agent.ts) via `tsx` (ESM, no build step)
- `npm run typecheck` — `tsc --noEmit`
- `psql "$DATABASE_URL" -f schema.sql` — apply the Postgres schema

## Layout

- `src/vfs.ts` — `VirtualFs` core + `MetaStore`/`BlobStore` interfaces (infra-free, unit-testable)
- `src/store/pg.ts` — Postgres `MetaStore` (postgres.js)
- `src/store/s3.ts` — S3 `BlobStore` (AWS SDK v3; MinIO-compatible via `S3_ENDPOINT`)
- `src/tools.ts` — VFS-backed Pi tools (`defineTool`), registered under the built-in names
- `src/agent.ts` — readline REPL harness, per-chat hydrate → session → write-through

SDK reference material lives in `node_modules/@earendil-works/pi-coding-agent/docs/`
and `.../examples/` — consult these when extending the agent rather than guessing
the API.

## Conventions

- Ordering invariant: on write, S3 blob **first**, PG row second (rows must never
  point at missing blobs; orphaned blobs are fine).
- `normalize()` in `src/vfs.ts` is the entire path-escape boundary — treat changes
  to it as security-sensitive.
