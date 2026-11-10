// 真实 E2E：SDK 客户端跨进程连 `zcode acp` 桥，走完整会话流。
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

const bundle = "E:\\WorkSpace\\ZCode\\apps\\zcode-cli\\packages\\cli\\dist\\zcode.cjs";
const cwd = "E:\\WorkSpace\\acp-probe";
mkdirSync(cwd, { recursive: true });
const child = spawn(process.execPath, [bundle, "acp"], { cwd, stdio: ["pipe", "pipe", "inherit"] });

const app = client({ name: "probe-client" });
let textAll = "";
let thoughtChars = 0;
const toolCalls: Array<{ id?: string; title?: string; kind?: string }> = [];
let finishes = 0;

app.onNotification("session/update", (context: { params: { update?: Record<string, unknown> } }) => {
  console.log("GOT update:", String(context.params.update?.sessionUpdate));
  const update = context.params.update ?? {};
  if (update.sessionUpdate === "agent_message_chunk") {
    textAll += (update.content as { text?: string })?.text ?? "";
  } else if (update.sessionUpdate === "agent_thought_chunk") {
    thoughtChars += ((update.content as { text?: string })?.text ?? "").length;
  } else if (update.sessionUpdate === "tool_call") {
    toolCalls.push({
      id: String(update.toolCallId ?? ""),
      title: String(update.title ?? ""),
      kind: String(update.kind ?? ""),
    });
  } else if (update.sessionUpdate === "finish") {
    finishes += 1;
  }
});

const conn = (await app.connect(
  ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ),
)) as unknown as { agent: Record<string, (params: unknown) => Promise<unknown>> };

const agentApi = conn.agent as unknown as { request(method: string, params: unknown): Promise<unknown> };
const init = (await agentApi.request("initialize", {
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: { name: "probe-client", version: "0" },
})) as { agentInfo?: { name?: string } };
console.log("PASS initialize:", JSON.stringify(init.agentInfo));

const created = (await agentApi.request("session/new", { cwd, mcpServers: [] })) as { sessionId: string };
console.log("PASS session/new:", created.sessionId);

const prompted = (await agentApi.request("session/prompt", {
  sessionId: created.sessionId,
  prompt: [{ type: "text", text: "Reply with exactly: ACP_BRIDGE_OK" }],
})) as { stopReason?: string };
console.log("PASS session/prompt:", JSON.stringify(prompted));

await new Promise((r) => setTimeout(r, 1500));
console.log("text:", JSON.stringify(textAll));
console.log("thoughtChars:", thoughtChars, "| toolCalls:", JSON.stringify(toolCalls), "| finishes:", finishes);
const ok = textAll.includes("ACP_BRIDGE_OK") && prompted?.stopReason === "end_turn";
console.log(ok ? "=== E2E PASS ===" : "=== E2E INCOMPLETE ===");
child.kill();
process.exit(ok ? 0 : 1);
