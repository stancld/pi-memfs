// src/fs.test.ts — run: `npm test` (needs MinIO up: `docker compose up -d minio createbuckets`).
// A fresh random chat id per run guarantees a clean slate, so no teardown is needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { VirtualFs } from "./store/fs.js";

const s3 = new S3Client({
  region: "eu-central-1",
  endpoint: "http://localhost:9000",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "minio_key",
    secretAccessKey: "minio_secret_key",
  },
});
const bucket = "pi-memfs-dev";

test("empty → write → ls + read", async () => {
  const vfs = new VirtualFs(randomUUID(), s3, bucket);

  // ls → empty
  assert.deepEqual(await vfs.ls(), []);

  // write
  await vfs.write("notes/plan.md", "hello");

  // ls + read
  assert.deepEqual(await vfs.ls(), ["notes/plan.md"]);
  assert.equal(await vfs.read("notes/plan.md"), "hello");
});

test("read of missing → ENOENT", async () => {
  const vfs = new VirtualFs(randomUUID(), s3, bucket); // fresh chat = clean slate

  // read before any write → ENOENT
  await assert.rejects(() => vfs.read("notes/plan.md"), /ENOENT/);
});

test("write twice → latest wins", async () => {
  const vfs = new VirtualFs(randomUUID(), s3, bucket);

  await vfs.write("notes/plan.md", "hello");
  await vfs.write("notes/plan.md", "hello new");

  // ls + read
  assert.deepEqual(await vfs.ls(), ["notes/plan.md"]);
  assert.equal(await vfs.read("notes/plan.md"), "hello new");
});
