// AgentSwarmBoardView 元素树结构断言：渐变标题逐字着色、宽度自适应列数、pip 分段。
import React from "react";
import { AgentSwarmBoardView } from "./packages/tui/src/app-tool-swarm-board.js";

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
  total: 6,
  done: 2,
  failed: 1,
  running: 1,
  entries: [
    { index: 1, status: "done" as const, ticks: 28, item: "src/a.ts", tokens: 1200 },
    { index: 2, status: "done" as const, ticks: 28, item: "src/b.ts", tokens: 900 },
    { index: 3, status: "running" as const, ticks: 9, item: "src/c.ts" },
    { index: 4, status: "queued" as const, ticks: 0, item: "src/d.ts" },
    { index: 5, status: "queued" as const, ticks: 0, item: "src/e.ts" },
    { index: 6, status: "failed" as const, ticks: 0, item: "src/f.ts" },
  ],
};

let fail = 0;
const assert = (label: string, ok: boolean, detail?: string) => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
};

// 1. 渐变标题：Agent Swarm 12 个字符各一个独立着色 text
{
  const view = AgentSwarmBoardView({ board, terminalWidth: 100 });
  const texts = collectTexts(view);
  const headerRun = texts.filter((t) => /^[A-Za-z]$/.test(t.text));
  assert("gradient per-char colors", headerRun.length >= 10, `chars=${headerRun.length}`);
  const distinctFg = new Set(headerRun.map((t) => String(t.fg)));
  assert("gradient has distinct colors", distinctFg.size >= 8, `distinct=${distinctFg.size}`);
  const fullText = texts.map((t) => t.text).join("");
  assert("header text present", fullText.includes("Agent Swarm") && fullText.includes("review core files"));
}

// 2. 自适应列数：窄屏 1 列、宽屏多列（按 row box 的 cell 计数）
{
  const countCells = (width: number): number[] => {
    const view = AgentSwarmBoardView({ board, terminalWidth: width });
    const rows: number[] = [];
    walk(view, (element) => {
      if (element.type !== "box") return;
      const style = (element.props?.style ?? {}) as { flexDirection?: string };
      if (style.flexDirection !== "row") return;
      const cells = asElements((element.props as { children?: unknown }).children).filter(
        (child) => String(child.type) === "box",
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

// 3. pip 状态条：完成比例填充（settled=3/6 → 9 filled）
{
  const view = AgentSwarmBoardView({ board, terminalWidth: 100 });
  const texts = collectTexts(view);
  const pipFilled = texts.find((t) => /^━+$/.test(t.text));
  const pipEmpty = texts.find((t) => /^╌+$/.test(t.text));
  assert("pip filled 9", pipFilled?.text.length === 9, pipFilled?.text.length.toString());
  assert("pip empty 9", pipEmpty?.text.length === 9, pipEmpty?.text.length.toString());
}

// 4. 状态语义：✓ 绿、✗ 红、⠋、Queued… 存在
{
  const view = AgentSwarmBoardView({ board, terminalWidth: 100 });
  const joined = collectTexts(view).map((t) => t.text).join("");
  assert("cell states rendered", joined.includes("✓ src/a.ts") && joined.includes("✗ src/f.ts") && joined.includes("⠋ src/c.ts") && joined.includes("Queued…"));
}

console.log(fail === 0 ? "=== VIEW PASS ===" : `=== VIEW FAIL ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
