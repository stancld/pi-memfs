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
