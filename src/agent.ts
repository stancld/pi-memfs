// src/agent.ts — readline REPL harness.
//
//   npm start -- --chat <id>
//
// Wires a per-chat VirtualFs (S3) into a pi AgentSession whose only tools are
// our read/write/ls/jq (built-ins disabled). Two processes with different
// --chat ids share one bucket but never see each other's keys: every key is
// prefixed with its chat id. That is the whole isolation story — run two of
// these side by side to test it.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { S3Client } from "@aws-sdk/client-s3";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { VirtualFs } from "./store/fs.js";
import { tools } from "./store/tools.js";

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const chatId = arg("--chat", "default");

// Mocked S3 = local MinIO (docker compose up -d minio createbuckets).
// Hard-wired for the experiment; matches src/**/*.test.ts.
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

const vfs = new VirtualFs(chatId, s3, bucket);

// Hard-wired to Bedrock haiku (creds come from the ambient AWS chain,
// e.g. AWS_PROFILE — kept separate from the MinIO creds above).
const model = getModel(
  "amazon-bedrock",
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
);
if (!model) throw new Error("Model not found");

const { session } = await createAgentSession({
  model,
  sessionManager: SessionManager.inMemory(),
  noTools: "builtin", // no real-FS tools, no bash — the whole point
  customTools: Object.values(tools(vfs)),
  tools: ["read", "write", "ls", "jq"],
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    stdout.write(event.assistantMessageEvent.delta);
  }
  // Surface tool calls (with args) so cross-chat isolation is observable.
  if (event.type === "tool_execution_start") {
    stdout.write(`\n  ⚙ ${event.toolName}(${JSON.stringify(event.args)})\n`);
  }
});

console.error(
  `chat=${chatId}  model=${model.provider}/${model.id}  bucket=${bucket}\n` +
    `Type a message ("exit" or Ctrl-D to quit).\n`,
);

const rl = createInterface({ input: stdin, output: stdout });
try {
  while (true) {
    const line = (await rl.question("› ")).trim();
    if (!line) continue;
    if (line === "exit" || line === "quit") break;
    await session.prompt(line);
    stdout.write("\n");
  }
} finally {
  rl.close();
  session.dispose();
}
