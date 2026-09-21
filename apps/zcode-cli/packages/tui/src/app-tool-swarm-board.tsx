import React from "react";
import type { SwarmProgressBoard } from "@zcode/contracts";
import { activeTuiTheme } from "./theme/index.js";
import { truncateDisplay } from "./app-terminal-width.js";

// ============================================================
// AgentSwarm 专用富文本板面（Kimi Code 同款视觉）
// ============================================================
// 与纯文本 detailLines 管线并行的专用渲染路径：
// - 渐变标题头：Agent Swarm 逐字符 primary→accent 插值 + 描述 + 主题色尾线
// - 宽度自适应 N 列网格：cell = 序号 + braille 8 级条（成功色填充）+ 状态标记 + 标签
// - 分段 pip 状态条：完成比例按主题色填充

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const CELL_MIN_WIDTH = 40;
const CELL_MAX_COLUMNS = 4;
const CELL_GAP = 2;
const CELL_WIDTH = 42;
const BAR_CELLS = 4;
const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;
const PIP_WIDTH = 18;
const TICKS_PER_BAR = BAR_CELLS * BRAILLE_LEVELS.length;

interface ThemeColors {
  primary: string;
  accent: string;
  success: string;
  error: string;
  warning: string;
  text: string;
  textMuted: string;
  border: string;
}

function themeColors(): ThemeColors {
  const theme = activeTuiTheme();
  const tokens = (theme as unknown as { palette?: Record<string, string> }).palette ?? {};
  const pick = (key: string, fallback: string): string =>
    typeof tokens[key] === "string" ? tokens[key]! : fallback;
  return {
    primary: pick("primary", "#7aa2f7"),
    accent: pick("accent", "#bb9af7"),
    success: pick("success", "#9ece6a"),
    error: pick("error", "#f7768e"),
    warning: pick("warning", "#e0af68"),
    text: pick("text", "#c0caf5"),
    textMuted: pick("textMuted", "#565f89"),
    border: pick("border", "#3b4261"),
  };
}

function lerpColor(from: string, to: string, ratio: number): string {
  const parse = (hex: string): [number, number, number] | undefined => {
    const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
    return match
      ? [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)]
      : undefined;
  };
  const a = parse(from);
  const b = parse(to);
  if (a === undefined || b === undefined) return from;
  const channel = (x: number, y: number): string =>
    Math.round(x + (y - x) * ratio)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(a[0]!, b[0]!)}${channel(a[1]!, b[1]!)}${channel(a[2]!, b[2]!)}`;
}

function gradientRun(text: string, from: string, to: string): React.ReactElement[] {
  return [...text].map((char, index) =>
    h(
      "text",
      {
        key: `g-${index}`,
        style: { fg: lerpColor(from, to, text.length <= 1 ? 0 : index / (text.length - 1)) },
      },
      char,
    ),
  );
}

function brailleBarText(ticks: number, settled: boolean): string {
  if (settled) return "⣿".repeat(BAR_CELLS);
  const safe = Math.max(0, Math.floor(ticks)) % TICKS_PER_BAR;
  let out = "";
  for (let i = 0; i < BAR_CELLS; i += 1) {
    const cellStart = i * BRAILLE_LEVELS.length;
    const count = Math.max(0, Math.min(BRAILLE_LEVELS.length, safe - cellStart));
    out += count === 0 ? "⣀" : BRAILLE_LEVELS[count - 1];
  }
  return out;
}

function gridColumns(width: number, count: number): number {
  if (count <= 1) return 1;
  const byWidth = Math.floor((Math.max(1, width) - CELL_GAP) / (CELL_MIN_WIDTH + CELL_GAP));
  return Math.max(1, Math.min(CELL_MAX_COLUMNS, count, Math.max(1, byWidth)));
}

function cellStatusLabel(
  entry: SwarmProgressBoard["entries"][number],
  colors: ThemeColors,
): { text: string; color: string } {
  if (entry.status === "done") {
    const tokens = entry.tokens === undefined ? "" : ` · ${formatTokens(entry.tokens)}`;
    return { text: `✓ ${entry.item}${tokens}`, color: colors.success };
  }
  if (entry.status === "failed") return { text: `✗ ${entry.item}`, color: colors.error };
  if (entry.status === "running") return { text: `⠋ ${entry.item}`, color: colors.text };
  return { text: "Queued…", color: colors.textMuted };
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`;
}

export function AgentSwarmBoardView({
  board,
  terminalWidth = 100,
}: {
  board: SwarmProgressBoard;
  terminalWidth?: number;
}): React.ReactElement {
  const colors = themeColors();
  const width = Math.max(40, terminalWidth - 4);
  const columns = gridColumns(width, board.entries.length);
  const idWidth = Math.max(3, String(Math.max(1, board.total)).length);

  const header = h(
    "box",
    { key: "head", style: { flexDirection: "row" } },
    h("text", { style: { fg: colors.border } }, "─ "),
    ...gradientRun("Agent Swarm", colors.primary, colors.accent),
    ...(board.description.length > 0
      ? [
          h("text", { style: { fg: colors.primary } }, " ─ "),
          h("text", { style: { fg: colors.text } }, truncateDisplay(board.description, 46)),
        ]
      : []),
    h("text", { style: { fg: colors.border } }, " ─"),
  );

  const rows: React.ReactElement[] = [];
  const visible = board.entries;
  for (let start = 0; start < visible.length; start += columns) {
    const cells: React.ReactElement[] = [];
    for (let col = 0; col < columns && start + col < visible.length; col += 1) {
      const entry = visible[start + col]!;
      const id = String(entry.index).padStart(idWidth, "0");
      const settled = entry.status === "done" || entry.status === "failed";
      const barColor =
        entry.status === "failed"
          ? colors.error
          : settled || entry.status === "running"
            ? colors.success
            : colors.textMuted;
      const label = cellStatusLabel(entry, colors);
      const labelWidth = Math.max(1, CELL_WIDTH - idWidth - BAR_CELLS - 6);
      cells.push(
        h(
          "box",
          { key: `c-${entry.index}`, style: { flexDirection: "row", marginRight: CELL_GAP } },
          h("text", { style: { fg: colors.primary } }, `${id} `),
          h("text", { style: { fg: colors.textMuted } }, "["),
          h("text", { style: { fg: barColor } }, brailleBarText(entry.ticks, settled)),
          h("text", { style: { fg: colors.textMuted } }, "] "),
          h(
            "text",
            { style: { fg: label.color } },
            truncateDisplay(label.text, labelWidth),
          ),
        ),
      );
    }
    rows.push(
      h("box", { key: `r-${start}`, style: { flexDirection: "row" } }, ...cells),
    );
  }

  const settled = board.done + board.failed;
  const pipFilled = board.total === 0 ? 0 : Math.round((settled / board.total) * PIP_WIDTH);
  const statusText =
    board.total > 0 && settled === board.total
      ? board.failed > 0
        ? `✗ Failed. (${board.done}/${board.total})`
        : `✓ Completed. (${board.total}/${board.total})`
      : board.running > 0
        ? `⠋ Working… (${settled}/${board.total})`
        : `Queued… (${board.total})`;
  const statusColor =
    board.total > 0 && settled === board.total
      ? board.failed > 0
        ? colors.error
        : colors.success
      : colors.accent;
  const footer = h(
    "box",
    { key: "foot", style: { flexDirection: "row" } },
    h("text", { style: { fg: statusColor } }, `  ${statusText} `),
    h("text", { style: { fg: colors.success } }, "━".repeat(pipFilled)),
    h("text", { style: { fg: colors.textMuted } }, "╌".repeat(Math.max(0, PIP_WIDTH - pipFilled))),
  );

  return h(
    "box",
    {
      style: {
        backgroundColor: "transparent",
        flexDirection: "column",
        marginTop: 1,
        width: "100%",
      },
    },
    header,
    h("box", { style: { flexDirection: "column", marginTop: 1 } }, ...rows),
    footer,
  );
}
