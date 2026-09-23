// 把 renderSwarmBoard 元素树渲染成带 ANSI 颜色的文本，人工核对与 Kimi 截图的差异。
import React from "react";
import { renderSwarmBoard } from "./packages/tui/src/app-tool-swarm-board.js";
import {
  resetSwarmLiveState,
  swarmLiveIngest,
} from "./packages/tui/src/app-swarm-live.js";
import { SessionEventType } from "./packages/contracts/src/events/session.events.js";

const ANSI_RESET = "\u001b[0m";
let enabled = true;
function color(text: string, fg?: unknown): string {
  if (!enabled || typeof fg !== "string" || !fg.startsWith("#")) return text;
  const hex = fg.slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `\u001b[38;2;${r};${g};${b}m${text}${ANSI_RESET}`;
}

function flatten(node: unknown, width: number): string {
  const lines: string[] = [];
  const renderBox = (element: { type: unknown; props?: Record<string, unknown> | null }): string => {
    const children = (element.props as { children?: unknown } | null)?.children;
    const parts: string[] = [];
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === undefined || child === null || child === false) continue;
      if (React.isValidElement(child)) {
        const record = child as unknown as { type: unknown; props?: Record<string, unknown> | null };
        if (record.type === "text") {
          const style = (record.props?.style ?? {}) as { fg?: unknown };
          const inner = (record.props as { children?: unknown }).children;
          const text = typeof inner === "string" ? inner : Array.isArray(inner) ? inner.join("") : String(inner ?? "");
          parts.push(color(text, style.fg));
        } else {
          parts.push(renderBox(record as { type: unknown; props?: Record<string, unknown> | null }));
        }
      } else if (typeof child === "string") {
        parts.push(child);
      }
    }
    return parts.join("");
  };
  const walk = (node2: unknown): void => {
    if (!React.isValidElement(node2)) return;
    const record = node2 as unknown as { type: unknown; props?: Record<string, unknown> | null };
    const children = (record.props as { children?: unknown } | null)?.children;
    const style = (record.props?.style ?? {}) as { flexDirection?: string };
    if (record.type === "text") {
      const fg = style.fg ?? (record.props?.style as { fg?: unknown } | undefined)?.fg;
      const text = typeof children === "string" ? children : Array.isArray(children) ? children.join("") : String(children ?? "");
      lines.push(color(text.padEnd(width, " "), fg));
      return;
    }
    if (style.flexDirection === "row") {
      lines.push(renderBox(record).trimEnd());
      return;
    }
    for (const child of Array.isArray(children) ? children : [children]) walk(child);
  };
  walk(node);
  return lines.join("\n");
}

function show(label: string, node: React.ReactElement, width: number): void {
  console.log(`\n===== ${label} =====`);
  console.log(flatten(node, width));
}

resetSwarmLiveState();

const base = (entries: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  description: "并行检查MC服务状态",
  modelLabel: "GLM-5.3 · max",
  total: entries.length,
  done: entries.filter((e) => e.status === "done").length,
  failed: entries.filter((e) => e.status === "failed").length,
  running: entries.filter((e) => e.status === "running" || e.status === "suspended").length,
  entries,
  ...extra,
});

const WIDTH = 108;
show(
  "A. 启动初期（3 格 queued，Kimi 应显示 Working）",
  renderSwarmBoard({
    board: base([
      { index: 1, status: "queued", ticks: 0, item: "192.168.3.21" },
      { index: 2, status: "queued", ticks: 0, item: "182.92.235.64" },
      { index: 3, status: "queued", ticks: 0, item: "203.0.113.9" },
    ]) as never,
    terminalWidth: WIDTH,
  }),
  WIDTH,
);

swarmLiveIngest({
  type: SessionEventType.SubagentSpawned,
  sessionId: "parent",
  payload: { parentToolCallId: "call_sw#swarm-1", childSessionId: "c1", agentId: "a1" },
} as never);
swarmLiveIngest({
  type: SessionEventType.ModelStreaming,
  sessionId: "c1",
  payload: { kind: "reasoning_delta", delta: "The task is straightforward — check the easytier\n1. On 192.168.3.21: easytier-cli peer status" },
} as never);
swarmLiveIngest({
  type: SessionEventType.SubagentSpawned,
  sessionId: "parent",
  payload: { parentToolCallId: "call_sw#swarm-2", childSessionId: "c2", agentId: "a2" },
} as never);
swarmLiveIngest({
  type: SessionEventType.ModelStreaming,
  sessionId: "c2",
  payload: { kind: "text_delta", delta: "正在通过 SSH 连接 182.92.235.64 检查公网转发节点…" },
} as never);

show(
  "B. 运行中（done 1 + running 2 带实时文本，Kimi 截图 1/2 对应态）",
  renderSwarmBoard({
    board: base([
      { index: 1, status: "done", ticks: 28, item: "192.168.3.21", text: "## 内网 MC 服务器检查报告（192.168.3.21） **检查时间**：实际 SSH 执行" },
      { index: 2, status: "running", ticks: 9, item: "182.92.235.64" },
      { index: 3, status: "running", ticks: 5, item: "203.0.113.9" },
    ], { done: 1, running: 2 }) as never,
    terminalWidth: WIDTH,
    toolCallId: "call_sw",
  }),
  WIDTH,
);

show(
  "C. 全部完成（Kimi 截图 3 对应态）",
  renderSwarmBoard({
    board: base([
      { index: 1, status: "done", ticks: 28, item: "192.168.3.21", text: "## 内网 MC 服务器检查报告（192.168.3.21） **检查时间**：实际 SSH 执行…" },
      { index: 2, status: "done", ticks: 28, item: "182.92.235.64", text: "三项检查全部实际执行成功，结果如下。 ## 公网转发节点（182.92.235.64）…" },
      { index: 3, status: "failed", ticks: 0, item: "203.0.113.9", text: "connection timed out" },
    ], { done: 2, failed: 1, running: 0 }) as never,
    terminalWidth: WIDTH,
  }),
  WIDTH,
);

show(
  "D. 窄终端单列（62 列，用户截图疑似形态）",
  renderSwarmBoard({
    board: base([
      { index: 1, status: "running", ticks: 9, item: "192.168.3.21" },
      { index: 2, status: "running", ticks: 5, item: "182.92.235.64" },
      { index: 3, status: "queued", ticks: 0, item: "203.0.113.9" },
    ], { running: 2 }) as never,
    terminalWidth: 62,
    toolCallId: "call_sw",
  }),
  62,
);
resetSwarmLiveState();
