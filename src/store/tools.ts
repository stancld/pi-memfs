import { Type } from "typebox";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative } from "node:path";
import type { VirtualFs } from "./fs.js";

const run = promisify(execFile);

// The native read/write tools resolve a path against a cwd, then hand the
// absolute path to our operations. Nothing real lives at this sentinel root,
// so their FS probes all miss and we map straight back to a workspace path.
const WORKSPACE_ROOT = "/workspace";
const wsPath = (absolutePath: string) => relative(WORKSPACE_ROOT, absolutePath);

export function tools(vfs: VirtualFs) {
  // Native read tool (offset/limit + 2000-line/50KB truncation) over the
  // in-memory workspace instead of disk — no wheel reinvented.
  const read = createReadToolDefinition(WORKSPACE_ROOT, {
    autoResizeImages: false,
    operations: {
      readFile: async (abs) =>
        Buffer.from(await vfs.read(wsPath(abs)), "utf-8"),
      access: async () => {}, // missing files surface as ENOENT from vfs.read
      detectImageMimeType: async () => null, // workspace is text/JSON only
    },
  });

  // Native write tool over the workspace. Flat keyspace → mkdir is a no-op.
  const write = createWriteToolDefinition(WORKSPACE_ROOT, {
    operations: {
      writeFile: async (abs, content) => vfs.write(wsPath(abs), content),
      mkdir: async () => {},
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
        const proc = run("jq", [filter], {
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, // no host env → no cred leak
          maxBuffer: 32 << 20,
          timeout: 10_000, // kill a runaway filter (e.g. `repeat(.)`) instead of hanging the turn
        });
        proc.child.stdin!.on("error", () => {}); // swallow EPIPE when jq exits before its input is fully written
        proc.child.stdin!.end(input);
        const { stdout } = await proc;
        return { content: [{ type: "text", text: stdout }], details: {} };
      } catch (e: any) {
        const text = e.killed
          ? `jq timed out after 10s`
          : `jq error: ${e.stderr || e.message}`;
        return { content: [{ type: "text", text }], details: {} };
      }
    },
  });

  return { read, write, ls, jq };
}
