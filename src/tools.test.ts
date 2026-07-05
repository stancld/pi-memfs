import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { VirtualFs } from "./store/fs";
import { tools } from "./store/tools";

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

function freshTools() {
  return tools(new VirtualFs(randomUUID(), s3, bucket));
}

// Invoke a tool and pull the first text out of its result. `params` is typed
// from the tool passed in; the session-only trailing args (signal/onUpdate/ctx)
// are unused by our tools, so we stub them with undefined.
async function text<P>(
  tool: { execute: (id: string, params: P, ...rest: any[]) => Promise<any> },
  params: P,
): Promise<string> {
  const res = await tool.execute(
    "test-call",
    params,
    undefined,
    undefined,
    undefined,
  );
  return res.content[0].text;
}

test("write → ls → read round-trip", async () => {
  const t = freshTools();

  assert.equal(await text(t.ls, {}), "(empty)");

  assert.equal(
    await text(t.write, { path: "notes/plan.md", content: "hello" }),
    "Wrote notes/plan.md",
  );

  assert.equal(await text(t.ls, {}), "notes/plan.md");
  assert.equal(await text(t.read, { path: "notes/plan.md" }), "hello");
});

test("write twice → read returns latest", async () => {
  const t = freshTools();

  await text(t.write, { path: "notes/plan.md", content: "hello" });
  await text(t.write, { path: "notes/plan.md", content: "hello new" });

  assert.equal(await text(t.read, { path: "notes/plan.md" }), "hello new");
});

test("jq filters a JSON file from the workspace", async () => {
  const t = freshTools();

  await text(t.write, { path: "data.json", content: '{"name":"pi","n":42}' });

  assert.equal(
    (await text(t.jq, { path: "data.json", filter: ".name" })).trim(),
    '"pi"',
  );
});

test("jq on invalid filter → error message, no throw", async () => {
  const t = freshTools();

  await text(t.write, { path: "data.json", content: "{}" });

  assert.match(
    await text(t.jq, { path: "data.json", filter: ".[" }),
    /jq error:/,
  );
});

test("jq does not leak host env into subprocess", async () => {
  const t = freshTools();
  process.env.PI_MEMFS_LEAK_CANARY = "SECRET123";

  try {
    await text(t.write, { path: "data.json", content: "{}" });
    const out = await text(t.jq, {
      path: "data.json",
      filter: 'env.PI_MEMFS_LEAK_CANARY // "absent"',
    });
    assert.equal(out.trim(), '"absent"');
    assert.doesNotMatch(out, /SECRET123/);
  } finally {
    delete process.env.PI_MEMFS_LEAK_CANARY;
  }
});
