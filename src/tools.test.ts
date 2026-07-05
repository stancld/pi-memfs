import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  await text(t.write, { path: "notes/plan.md", content: "hello" });

  assert.equal(await text(t.ls, {}), "notes/plan.md");
  assert.equal(await text(t.read, { path: "notes/plan.md" }), "hello");
});

test("read truncates a long file with a continue hint (native truncation)", async () => {
  const t = freshTools();
  const body = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  await text(t.write, { path: "big.txt", content: body });

  const out = await text(t.read, { path: "big.txt" });
  assert.match(
    out,
    /Showing lines 1-2000 of 2500\. Use offset=2001 to continue\./,
  );
  assert.ok(!out.includes("line 2001"));
});

test("read offset continues from a given line", async () => {
  const t = freshTools();
  const body = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  await text(t.write, { path: "big.txt", content: body });

  const out = await text(t.read, { path: "big.txt", offset: 2001 });
  assert.ok(out.startsWith("line 2001"));
  assert.ok(out.includes("line 2500"));
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

test("jq cannot read host files via module import", async () => {
  const t = freshTools();

  // A secret .json file sitting anywhere on the host filesystem.
  const dir = mkdtempSync(join(tmpdir(), "pi-memfs-leak-"));
  writeFileSync(join(dir, "creds.json"), '{"host_secret":"SECRET123"}');

  try {
    await text(t.write, { path: "data.json", content: "{}" });
    // jq's module system honours an inline, attacker-controlled search path,
    // so `import "<name>" as $x {search:"<dir>"}` slurps <dir>/<name>.json off
    // the HOST fs — bypassing chat_id scoping entirely.
    const out = await text(t.jq, {
      path: "data.json",
      filter: `import "creds" as $c {search:"${dir}"}; $c`,
    });
    assert.doesNotMatch(out, /SECRET123/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
