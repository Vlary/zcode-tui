// AgentSwarmBoardView 元素树结构断言：渐变标题逐字着色、自适应网格列数、
// 全宽 pip、模型段标题、终态 text 标签、running cell 实时模型文本。
import React from "react";
import { renderSwarmBoard } from "./packages/tui/src/app-tool-swarm-board.js";
import {
  resetSwarmLiveState,
  swarmLiveIngest,
} from "./packages/tui/src/app-swarm-live.js";
import { SessionEventType } from "./packages/contracts/src/events/session.events.js";

type ElementLike = {
  type: unknown;
  props?: Record<string, unknown> | null;
};

const asElements = (node: unknown): ElementLike[] => {
  if (React.isValidElement(node)) return [node as unknown as ElementLike];
  if (Array.isArray(node)) return node.flatMap(asElements);
  return [];
};

function walk(node: unknown, visit: (element: ElementLike) => void): void {
  for (const element of asElements(node)) {
    visit(element);
    const children = (element.props as { children?: unknown } | null)?.children;
    if (children !== undefined) walk(children, visit);
  }
}

function collectTexts(node: unknown): Array<{ fg?: unknown; text: string }> {
  const out: Array<{ fg?: unknown; text: string }> = [];
  const flatten = (children: unknown): string => {
    if (typeof children === "string") return children;
    if (Array.isArray(children)) return children.map(flatten).join("");
    if (React.isValidElement(children)) {
      return flatten((children.props as { children?: unknown }).children);
    }
    return "";
  };
  walk(node, (element) => {
    if (typeof element.type === "string" && element.type === "text") {
      const style = (element.props?.style ?? {}) as { fg?: unknown };
      out.push({ fg: style.fg, text: flatten((element.props as { children?: unknown }).children) });
    }
  });
  return out;
}

const board = {
  description: "review core files",
  modelLabel: "GLM-5.3 · max",
  total: 6,
  done: 2,
  failed: 1,
  running: 1,
  entries: [
    { index: 1, status: "done" as const, ticks: 28, item: "src/a.ts", tokens: 1200, text: "## 内网 MC 服务器检查报告 全部服务在线" },
    { index: 2, status: "done" as const, ticks: 28, item: "src/b.ts", tokens: 900 },
    { index: 3, status: "running" as const, ticks: 9, item: "src/c.ts" },
    { index: 4, status: "suspended" as const, ticks: 3, item: "src/d.ts" },
    { index: 5, status: "queued" as const, ticks: 0, item: "src/e.ts" },
    { index: 6, status: "failed" as const, ticks: 0, item: "src/f.ts", text: "connection refused" },
  ],
};

let fail = 0;
const assert = (label: string, ok: boolean, detail?: string) => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
};

// 1. 渐变标题：Agent Swarm 12 个字符各一个独立着色 text；模型段出现在头部
{
  const view = renderSwarmBoard({ board, terminalWidth: 100 });
  const texts = collectTexts(view);
  const headerRun = texts.filter((t) => /^[A-Za-z]$/.test(t.text));
  assert("gradient per-char colors", headerRun.length >= 10, `chars=${headerRun.length}`);
  const distinctFg = new Set(headerRun.map((t) => String(t.fg)));
  assert("gradient has distinct colors", distinctFg.size >= 8, `distinct=${distinctFg.size}`);
  const fullText = texts.map((t) => t.text).join("");
  assert(
    "header text present",
    fullText.includes("Agent Swarm") && fullText.includes("review core files"),
  );
  assert("header model segment", fullText.includes("GLM-5.3 · max"), fullText.slice(0, 90));
}

// 2. 自适应网格：窄屏 1 列、宽屏多列（columns = floor((w+2)/32) 上限 count）
{
  const countCells = (width: number): number[] => {
    const view = renderSwarmBoard({ board, terminalWidth: width });
    const rows: number[] = [];
    walk(view, (element) => {
      if (element.type !== "box") return;
      const style = (element.props?.style ?? {}) as { flexDirection?: string };
      if (style.flexDirection !== "row") return;
      const cells = asElements((element.props as { children?: unknown }).children).filter(
        (child) => String(child.type) === "box" || String(child.type).includes("SwarmCell"),
      );
      if (cells.length > 1) rows.push(cells.length);
    });
    return rows;
  };
  const narrow = countCells(50);
  const wide = countCells(120);
  assert("narrow stays 1 column", narrow.length === 0 || Math.max(...narrow) <= 2, JSON.stringify(narrow));
  assert("wide uses multi-column", wide.length > 0 && Math.max(...wide) >= 2, JSON.stringify(wide));
}

// 3. 全宽 pip + 统一缩进：状态行与网格行同缩进 1 空格，pip 铺满剩余宽度
{
  const view = renderSwarmBoard({ board, terminalWidth: 100 });
  const texts = collectTexts(view);
  const pipFilled = texts.find((t) => /^━+$/.test(t.text));
  const pipEmpty = texts.find((t) => /^╌+$/.test(t.text));
  const statusText = "Working… (3/6)";
  const expected = 96 - 1 - 2 - statusText.length - 2;
  assert(
    "pip fills remaining width",
    pipFilled !== undefined &&
      pipEmpty !== undefined &&
      pipFilled.text.length + pipEmpty.text.length === expected,
    `filled=${pipFilled?.text.length} empty=${pipEmpty?.text.length} expected=${expected}`,
  );
  assert("pip ratio half", pipFilled?.text.length === Math.round((3 / 6) * expected));
  const joinedAll = texts.map((t) => t.text).join("");
  const firstCell = texts.find((t) => t.text.startsWith("001 "));
  const footerText = texts.find((t) => t.text.includes(statusText));
  assert(
    "grid rows and status line share 1-space indent",
    firstCell !== undefined && footerText !== undefined && footerText.text.startsWith(" "),
    `cell0=${JSON.stringify(firstCell?.text)} footer=${JSON.stringify(footerText?.text)}`,
  );
}

// 4. 状态语义：done 显示最终输出首段、failed 显示原因、queued 显示 item、限速标签
//    （单列宽度下标签有完整预算：65 列终端 → 板宽 61 → 1 列 → cell 61）
{
  const view = renderSwarmBoard({ board, terminalWidth: 65 });
  const joined = collectTexts(view).map((t) => t.text).join("");
  assert(
    "done cell shows final text",
    joined.includes("✓ ## 内网 MC 服务器检查报告 全部服务在线"),
    joined.slice(0, 160),
  );
  assert("done without text falls back to item", joined.includes("✓ src/b.ts"));
  assert("failed cell shows error text", joined.includes("✗ connection refused"));
  assert("queued cell shows item", joined.includes("src/e.ts"));
  assert("suspended label", joined.includes("Rate limited…"));
}

// 5. running cell 实时模型文本：SubagentSpawned 路由 + ModelStreaming delta 滚动
{
  resetSwarmLiveState();
  swarmLiveIngest({
    type: SessionEventType.SubagentSpawned,
    sessionId: "parent",
    payload: {
      parentToolCallId: "call_sw_9#swarm-3",
      childSessionId: "child-3",
      agentId: "agent-3",
    },
  } as never);
  swarmLiveIngest({
    type: SessionEventType.ModelStreaming,
    sessionId: "child-3",
    payload: { kind: "reasoning_delta", delta: "The task is straightforward.\n1. On 192.168.3.21: " },
  } as never);
  swarmLiveIngest({
    type: SessionEventType.ModelStreaming,
    sessionId: "child-3",
    payload: { kind: "reasoning_delta", delta: "easytier-cli peer status" },
  } as never);
  const view = renderSwarmBoard({ board, terminalWidth: 65, toolCallId: "call_sw_9" });
  const joined = collectTexts(view).map((t) => t.text).join("");
  assert(
    "running cell shows latest model line",
    joined.includes("1. On 192.168.3.21: easytier-cli peer status"),
    joined.slice(0, 220),
  );
  // 未挂 toolCallId（历史回放）时回退到 item
  const historyView = renderSwarmBoard({ board, terminalWidth: 65 });
  const historyJoined = collectTexts(historyView).map((t) => t.text).join("");
  assert("history view falls back to item", historyJoined.includes("src/c.ts"));
  // 防闪烁：实时行长度变化时 cell 标签保持恒定显示宽度（右侧格子不移动）。
  const widthOf = (text: string): number =>
    [...text].reduce(
      (sum, char) =>
        sum +
        (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1),
      0,
    );
  const runningLabelOf = (view: React.ReactElement): string | undefined =>
    collectTexts(view).find((t) => t.text.startsWith("1. On 19"))?.text;
  const switchedLabelOf = (view: React.ReactElement): string | undefined =>
    collectTexts(view).find((t) => /^X +$/.test(t.text))?.text;
  const shortRun = renderSwarmBoard({ board, terminalWidth: 65, toolCallId: "call_sw_9" });
  swarmLiveIngest({
    type: SessionEventType.ModelStreaming,
    sessionId: "child-3",
    payload: { kind: "reasoning_delta", delta: "\nX" },
  } as never);
  const switchedRun = renderSwarmBoard({ board, terminalWidth: 65, toolCallId: "call_sw_9" });
  const labelBefore = runningLabelOf(shortRun);
  const labelAfter = switchedLabelOf(switchedRun);
  assert(
    "running label keeps constant display width while text streams",
    labelBefore !== undefined &&
      labelAfter !== undefined &&
      widthOf(labelBefore) === widthOf(labelAfter),
    `before(${widthOf(labelBefore ?? "")})=${JSON.stringify(labelBefore?.slice(0, 24))} after(${widthOf(labelAfter ?? "")})=${JSON.stringify(labelAfter?.slice(0, 24))}`,
  );
  resetSwarmLiveState();
}

// 6. 本地动效：活动期 spinner 轮转 + running bar 漂移
{
  const frame0 = collectTexts(renderSwarmBoard({ board, terminalWidth: 100, frame: 0 }));
  const frame3 = collectTexts(renderSwarmBoard({ board, terminalWidth: 100, frame: 3 }));
  const frame5 = collectTexts(renderSwarmBoard({ board, terminalWidth: 100, frame: 5 }));
  const joined3 = frame3.map((t) => t.text).join("");
  assert(
    "spinner rotates with frame (⠸ at frame 3)",
    joined3.includes("⠸ Working…"),
    joined3.slice(0, 120),
  );
  assert(
    "spinner at frame 5 is ⠴",
    frame5.map((t) => t.text).join("").includes("⠴ Working…"),
  );
  const isDriftingBar = (t: { text: string }): boolean =>
    /^[⣀-⣿]{6,8}$/.test(t.text) && !/^⣿+$/.test(t.text) && !/^⣀+$/.test(t.text);
  const bar0 = frame0.find(isDriftingBar)?.text;
  const bar3 = frame3.find(isDriftingBar)?.text;
  assert(
    "running bar drifts with local frame",
    bar0 !== undefined && bar3 !== undefined && bar0 !== bar3,
    `frame0=${bar0} frame3=${bar3}`,
  );
  const settledBoard = {
    ...board,
    done: board.total,
    failed: 0,
    running: 0,
    entries: board.entries.map((entry) => ({ ...entry, status: "done" as const })),
  };
  const settledTexts = collectTexts(
    renderSwarmBoard({ board: settledBoard, terminalWidth: 100, frame: 9 }),
  ).map((t) => t.text);
  assert(
    "settled board has no spinner prefix",
    settledTexts.some((t) => t.includes("Completed.")) &&
      !settledTexts.some((t) => /[⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(t)),
  );
}

console.log(fail === 0 ? "=== VIEW PASS ===" : `=== VIEW FAIL ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
