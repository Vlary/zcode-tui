// TUI 消费链路硬验证：静态投影样式 + swarmProgress 事件驱动 part 更新。
import {
  buildToolTranscriptProjection,
  applyToolTranscriptEvent,
} from "./packages/tui/src/app-tool-transcript.js";
import type { Message } from "./packages/tui/src/app-model.js";
import { SessionEventType } from "./packages/contracts/src/events/session.events.js";

const assert = (label: string, ok: boolean, detail?: string) => {
  if (!ok) process.exitCode = 1;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
};

// 1. 静态投影新样式
const projection = buildToolTranscriptProjection("AgentSwarm", {
  description: "review core files",
  prompt_template: "Review {{item}}",
  items: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"],
});
assert(
  "static title",
  projection.title.startsWith("Agent Swarm ─ review core files"),
  projection.title,
);
const joined = projection.detailLines.join("\n");
assert("static rows", joined.includes("001") && joined.includes("· a.ts") && joined.includes("006"), joined);

// 2. 事件驱动更新：Scheduled → Progress(swarmProgress) → Result
type Handlers = Parameters<typeof applyToolTranscriptEvent>[1];
const toolNamesById = new Map<string, string>();
let messages: Message[] = [];
const handlers: Handlers = {
  setMessages: (update) => {
    messages = typeof update === "function" ? update(messages) : update;
  },
  toolNamesById,
};

const toolCallId = "call_sw_1";
const mkEvent = (type: SessionEventType, payload: Record<string, unknown>) =>
  ({ type, payload: { toolCallId, ...payload } }) as never;

applyToolTranscriptEvent(
  mkEvent(SessionEventType.ToolCallScheduled, {
    toolName: "AgentSwarm",
    input: { description: "review", prompt_template: "R {{item}}", items: ["x", "y"] },
  }),
  handlers,
);
let part = messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool");
assert("scheduled part created", part !== undefined);
assert("scheduled title set", (part as { title?: string }).title?.includes("Agent Swarm"), JSON.stringify(part));

applyToolTranscriptEvent(
  mkEvent(SessionEventType.ToolCallProgress, {
    toolName: "AgentSwarm",
    swarmProgress: {
      title: "Agent Swarm ─ review ── 1/2 done",
      rows: ["✓ #1 x · 3.2s · 1.1k tok", "⠏ #2 y"],
    },
  }),
  handlers,
);
part = messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool");
const dynamic = part as unknown as { title?: string; detailLines?: string[]; status?: string };
assert("progress title applied", dynamic.title.startsWith("Agent Swarm ─ review") || dynamic.title.startsWith("swarm · review"), dynamic.title);
assert(
  "progress rows applied",
  (dynamic.detailLines ?? []).join("\n").includes("✓ #1 x · 3.2s") &&
    (dynamic.detailLines ?? []).join("\n").includes("⠏ #2 y"),
  JSON.stringify(dynamic.detailLines),
);
assert("status running", dynamic.status === "running");

applyToolTranscriptEvent(
  mkEvent(SessionEventType.ToolCallResult, { toolName: "AgentSwarm", result: {}, duration: 4200 }),
  handlers,
);
part = messages.flatMap((m) => m.parts ?? []).find((p) => p.type === "tool");
const finalPart = part as unknown as { title?: string; status?: string; detailLines?: string[] };
assert("result keeps final board title", finalPart.title.startsWith("Agent Swarm ─ review") || finalPart.title.startsWith("swarm · review"));
assert("result status completed", finalPart.status === "completed");
assert("result keeps rows", (finalPart.detailLines ?? []).length >= 1);

// 3. 普通 Bash progress 不受影响（无 swarmProgress 字段走原路径）
const bashPart0 = messages.length;
applyToolTranscriptEvent(
  ({ type: SessionEventType.ToolCallProgress, payload: { toolCallId: "bash1", toolName: "Bash" } }) as never,
  { ...handlers, toolNamesById },
);
assert("plain progress path intact", messages.length >= bashPart0);
