import React from "react";
import type { SwarmProgressBoard } from "@zcode/contracts";
import { activeTuiTheme } from "./theme/index.js";
import { truncateDisplay } from "./app-terminal-width.js";
import { readSwarmLiveLine, useSwarmLiveVersion } from "./app-swarm-live.js";

// ============================================================
// AgentSwarm 专用富文本板面（Kimi Code 同款视觉）
// ============================================================
// AgentSwarmBoardView 是薄 hook 壳：订阅 swarm 实时文本版本驱动重渲染，
// 元素树由纯函数 renderSwarmBoard 生成（可直接断言/回放）：
// - 渐变标题头：Agent Swarm 逐字符 primary→accent 插值 + 描述 + 模型段 + 尾线
// - Kimi 网格算法：列宽 30 期望值 → 列数铺满可用宽度，braille 条按剩余宽度取 6..8 格
// - running cell 滚动显示子代理最新模型输出行（app-swarm-live 跟踪器）
// - done/failed cell 显示最终输出/失败原因首段（board.entries[].text）
// - 底部 pip 状态条铺满整行剩余宽度

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// Kimi agent-swarm-progress.ts 同参：TEXT_CELL_PREFERRED_WIDTH=30、
// TEXT_BRAILLE_BAR_MIN_WIDTH=6、BRAILLE_BAR_MAX_WIDTH=8。
const CELL_PREFERRED_WIDTH = 30;
const CELL_GAP = 2;
const BAR_MIN_CELLS = 6;
const BAR_MAX_CELLS = 8;
const MIN_LABEL_WIDTH = 16;
const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;
const BRAILLE_EMPTY = "⣀";

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

function brailleBarText(ticks: number, settled: boolean, cells: number): string {
  if (settled) return "⣿".repeat(cells);
  const capacity = cells * BRAILLE_LEVELS.length;
  const safe = Math.max(0, Math.floor(ticks)) % capacity;
  let out = "";
  for (let i = 0; i < cells; i += 1) {
    const cellStart = i * BRAILLE_LEVELS.length;
    const count = Math.max(0, Math.min(BRAILLE_LEVELS.length, safe - cellStart));
    out += count === 0 ? BRAILLE_EMPTY : BRAILLE_LEVELS[count - 1];
  }
  return out;
}

/** Kimi 同款网格：列数按 30 期望宽计算，cell 宽度均分铺满，bar 取剩余宽 6..8 格。 */
function gridLayout(width: number, count: number, idWidth: number) {
  const columns = Math.max(
    1,
    Math.min(count, Math.floor((Math.max(1, width) + CELL_GAP) / (CELL_PREFERRED_WIDTH + CELL_GAP))),
  );
  const cellWidth = Math.max(
    1,
    Math.floor((Math.max(1, width) - CELL_GAP * (columns - 1)) / columns),
  );
  const fixedWidth = idWidth + 1 + 2 + 1 + MIN_LABEL_WIDTH;
  const availableForBar = cellWidth - fixedWidth;
  const barCells =
    availableForBar >= BAR_MIN_CELLS ? Math.min(BAR_MAX_CELLS, availableForBar) : BAR_MIN_CELLS;
  return { columns, cellWidth, barCells };
}

function collapseCellText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/** 单个网格 cell：纯函数，live 文本由调用方经 readSwarmLiveLine 注入。 */
function renderSwarmCell(input: {
  entry: SwarmProgressBoard["entries"][number];
  id: string;
  barCells: number;
  labelWidth: number;
  colors: ThemeColors;
  liveLine: string;
  compact: boolean;
}): React.ReactElement {
  const { entry, id, barCells, labelWidth, colors, liveLine, compact } = input;
  // 标签预算含状态标记（"✓ "/"⠋ " 各占 2 列）。
  const textWidth = Math.max(1, labelWidth - 2);
  const settled = entry.status === "done" || entry.status === "failed";
  const barColor =
    entry.status === "failed"
      ? colors.error
      : entry.status === "suspended"
        ? colors.warning
        : settled || entry.status === "running"
          ? colors.success
          : colors.textMuted;
  // Kimi failedBrailleBar：失败格红色只点亮前段，空段用暗化占位。
  const failedDark = lerpColor(colors.error, colors.textMuted, 0.55);
  const barText = brailleBarText(entry.ticks, settled, barCells);
  const redCells = Math.max(1, Math.ceil(barCells / 2));
  const barRuns =
    entry.status === "failed" && barText.length > redCells
      ? [
          h("text", { style: { fg: colors.error } }, barText.slice(0, redCells)),
          h("text", { style: { fg: failedDark } }, barText.slice(redCells)),
        ]
      : [h("text", { style: { fg: barColor } }, barText)];

  let mark = "·";
  let markColor = colors.textMuted;
  const labelChildren: React.ReactElement[] = [];
  if (entry.status === "done" || entry.status === "failed") {
    const body = collapseCellText(entry.text ?? "");
    const label = body.length > 0 ? body : entry.item;
    mark = entry.status === "done" ? "✓ " : "✗ ";
    markColor = entry.status === "done" ? colors.success : colors.error;
    labelChildren.push(h("text", { style: { fg: markColor } }, truncateDisplay(label, textWidth)));
  } else if (entry.status === "running") {
    mark = "⠋ ";
    markColor = colors.accent;
    // Kimi runningCellLabelText：实时行 > item > Working…。
    const text = liveLine.length > 0 ? liveLine : entry.item.length > 0 ? entry.item : "Working…";
    labelChildren.push(h("text", { style: { fg: colors.textMuted } }, truncateDisplay(text, textWidth)));
  } else if (entry.status === "suspended") {
    mark = "⠏ ";
    markColor = colors.warning;
    labelChildren.push(h("text", { style: { fg: colors.warning } }, "Rate limited…"));
  } else {
    labelChildren.push(
      h(
        "text",
        { style: { fg: colors.textMuted } },
        truncateDisplay(entry.item.length > 0 ? entry.item : "Queued…", textWidth),
      ),
    );
  }

  return h(
    "box",
    { key: `c-${entry.index}`, style: { flexDirection: "row", marginRight: CELL_GAP } },
    h("text", { style: { fg: colors.primary } }, `${id} `),
    h("text", { style: { fg: colors.textMuted } }, "["),
    ...barRuns,
    h("text", { style: { fg: colors.textMuted } }, "] "),
    compact
      ? h("text", { style: { fg: markColor } }, mark.trimEnd())
      : h(
          "box",
          { style: { flexDirection: "row" } },
          h("text", { style: { fg: markColor } }, mark),
          ...labelChildren,
        ),
  );
}

/** 纯渲染：输入板面快照 + 终端宽度，输出完整元素树（测试可直接遍历）。 */
export function renderSwarmBoard({
  board,
  terminalWidth = 100,
  toolCallId,
}: {
  board: SwarmProgressBoard;
  terminalWidth?: number;
  toolCallId?: string;
}): React.ReactElement {
  const colors = themeColors();
  const width = Math.max(40, terminalWidth - 4);
  const idWidth = Math.max(3, String(Math.max(1, board.total)).length);
  const { columns, cellWidth, barCells } = gridLayout(width, board.entries.length, idWidth);
  // 极窄终端的紧凑降级：cell 只剩 序号+[bar]+标记（Kimi 的 compact cell）。
  const compact = width < 52;
  // 标签预算 = cell 宽 − (id+空格+[+bar+]+空格)，含状态标记占位。
  const labelWidth = Math.max(3, cellWidth - idWidth - 1 - barCells - 2 - 1);

  const headerSegments: React.ReactElement[] = [
    h("text", { style: { fg: colors.primary } }, "─ "),
    ...gradientRun("Agent Swarm", colors.primary, colors.accent),
  ];
  if (board.description.length > 0) {
    headerSegments.push(
      h("text", { style: { fg: colors.primary } }, " ─ "),
      h("text", { style: { fg: colors.text } }, truncateDisplay(board.description, 44)),
    );
  }
  if (board.modelLabel !== undefined && board.modelLabel.length > 0) {
    headerSegments.push(
      h("text", { style: { fg: colors.primary } }, " ─ "),
      h("text", { style: { fg: colors.textMuted } }, truncateDisplay(board.modelLabel, 24)),
    );
  }
  headerSegments.push(h("text", { style: { fg: colors.border } }, " ─"));

  const rows: React.ReactElement[] = [];
  const visible = board.entries;
  for (let start = 0; start < visible.length; start += columns) {
    const cells: React.ReactElement[] = [];
    for (let col = 0; col < columns && start + col < visible.length; col += 1) {
      const entry = visible[start + col]!;
      cells.push(
        renderSwarmCell({
          entry,
          id: String(entry.index).padStart(idWidth, "0"),
          barCells,
          labelWidth,
          colors,
          liveLine: entry.status === "running" ? readSwarmLiveLine(toolCallId, entry.index) : "",
          compact,
        }),
      );
    }
    rows.push(h("box", { key: `r-${start}`, style: { flexDirection: "row" } }, ...cells));
  }

  const settled = board.done + board.failed;
  const statusText =
    board.total > 0 && settled === board.total
      ? board.failed > 0
        ? `✗ Failed. (${board.done}/${board.total})`
        : `✓ Completed. (${board.total}/${board.total})`
      : board.running > 0
        ? `⠋ Working… (${settled}/${board.total})`
        : board.total > 0 && board.done + board.failed + board.running === 0
          ? `⏸ Rate limited… (${settled}/${board.total})`
          : `Queued… (${board.total})`;
  const statusColor =
    board.total > 0 && settled === board.total
      ? board.failed > 0
        ? colors.error
        : colors.success
      : colors.accent;
  // Kimi 同款：pip 条铺满状态行剩余宽度（label + 2 空格 + bar = width）。
  const pipWidth = Math.max(0, width - 2 - statusText.length - 2);
  const pipFilled = board.total === 0 ? 0 : Math.round((settled / board.total) * pipWidth);
  const footer = h(
    "box",
    { key: "foot", style: { flexDirection: "row" } },
    h("text", { style: { fg: statusColor } }, `  ${statusText}  `),
    h("text", { style: { fg: colors.success } }, "━".repeat(pipFilled)),
    h("text", { style: { fg: colors.textMuted } }, "╌".repeat(Math.max(0, pipWidth - pipFilled))),
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
    h("box", { style: { flexDirection: "row" } }, ...headerSegments),
    h("box", { style: { flexDirection: "column", marginTop: 1 } }, ...rows),
    footer,
  );
}

/** 渲染组件：实时文本版本推进时整板重渲染（元素生成本身是纯函数）。 */
export function AgentSwarmBoardView({
  board,
  terminalWidth,
  toolCallId,
}: {
  board: SwarmProgressBoard;
  terminalWidth?: number;
  toolCallId?: string;
}): React.ReactElement {
  useSwarmLiveVersion(toolCallId);
  return renderSwarmBoard({ board, terminalWidth, toolCallId });
}
