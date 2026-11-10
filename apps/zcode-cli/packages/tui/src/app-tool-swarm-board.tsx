import React from "react";
import type { SwarmProgressBoard } from "@zcode/contracts";
import { activeTuiTheme } from "./theme/index.js";
import { padDisplay, truncateDisplay } from "./app-terminal-width.js";
import {
  readSwarmLiveLine,
  useSwarmAnimationFrame,
  useSwarmLiveVersion,
} from "./app-swarm-live.js";

// ============================================================
// AgentSwarm 专用富文本板面（富文本视觉）
// ============================================================
// AgentSwarmBoardView 是薄 hook 壳：订阅 swarm 实时文本版本驱动重渲染，
// 元素树由纯函数 renderSwarmBoard 生成（可直接断言/回放）：
// - 渐变标题头：Agent Swarm 逐字符 primary→accent 插值 + 描述 + 模型段 + 尾线
// - 网格算法：列宽 30 期望值 → 列数铺满可用宽度，braille 条按剩余宽度取 6..8 格
// - running cell 滚动显示子代理最新模型输出行（app-swarm-live 跟踪器）
// - done/failed cell 显示最终输出/失败原因首段（board.entries[].text）
// - 底部 pip 状态条铺满整行剩余宽度

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

// 布局常量：TEXT_CELL_PREFERRED_WIDTH=30、
// TEXT_BRAILLE_BAR_MIN_WIDTH=6、BRAILLE_BAR_MAX_WIDTH=8。
const CELL_PREFERRED_WIDTH = 30;
const CELL_GAP = 2;
const BAR_MIN_CELLS = 6;
const BAR_MAX_CELLS = 8;
const MIN_LABEL_WIDTH = 16;
const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;
const BRAILLE_EMPTY = "⣀";
// 状态行活动 spinner：80ms 一帧。
const BRAILLE_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;
// 标题/网格/状态行统一 1 空格左缩进。
const LEFT_INDENT = " ";

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

/** 自适应网格：列数按 30 期望宽计算，cell 宽度均分铺满，bar 取剩余宽 6..8 格。 */
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

/** 单个网格 cell：纯函数。文本模式无独立 mark 列——终态标记并入标签，
 *  running 只有 bar 漂移 + live 文本。frame 为本地动画帧，驱动 running bar 漂移。 */
function renderSwarmCell(input: {
  entry: SwarmProgressBoard["entries"][number];
  id: string;
  barCells: number;
  labelWidth: number;
  colors: ThemeColors;
  liveLine: string;
  frame: number;
  compact: boolean;
}): React.ReactElement {
  const { entry, id, barCells, labelWidth, colors, liveLine, frame, compact } = input;
  const settled = entry.status === "done" || entry.status === "failed";
  const barColor =
    entry.status === "failed"
      ? colors.error
      : entry.status === "suspended"
        ? colors.warning
        : settled || entry.status === "running"
          ? colors.success
          : colors.textMuted;
  // 失败 bar：红色只点亮前段，空段用暗化占位。
  const failedDark = lerpColor(colors.error, colors.textMuted, 0.55);
  // running bar 本地漂移：core 帧 ticks 为底数，本地每 80ms +1（持续漂移观感）。
  const effectiveTicks = entry.status === "running" ? entry.ticks + frame : entry.ticks;
  const barText = brailleBarText(effectiveTicks, settled, barCells);
  const redCells = Math.max(1, Math.ceil(barCells / 2));
  const barRuns =
    entry.status === "failed" && barText.length > redCells
      ? [
          h("text", { style: { fg: colors.error } }, barText.slice(0, redCells)),
          h("text", { style: { fg: failedDark } }, barText.slice(redCells)),
        ]
      : [h("text", { style: { fg: barColor } }, barText)];

  // 终态标记是标签的一部分（"✓ text"），其余态直接标签。
  let label = "";
  let labelColor = colors.textMuted;
  if (entry.status === "done") {
    const body = collapseCellText(entry.text ?? "");
    label = `✓ ${body.length > 0 ? body : entry.item}`;
    labelColor = colors.success;
  } else if (entry.status === "failed") {
    const body = collapseCellText(entry.text ?? "");
    label = `✗ ${body.length > 0 ? body : entry.item}`;
    labelColor = colors.error;
  } else if (entry.status === "running") {
    // 运行标签优先级：实时行 > item > Working…。
    label = liveLine.length > 0 ? liveLine : entry.item.length > 0 ? entry.item : "Working…";
  } else if (entry.status === "suspended") {
    label = "Rate limited…";
    labelColor = colors.warning;
  } else {
    label = entry.item.length > 0 ? entry.item : "Queued…";
  }

  return h(
    "box",
    { key: `c-${entry.index}`, style: { flexDirection: "row", marginRight: CELL_GAP } },
    h("text", { style: { fg: colors.primary } }, `${id} `),
    h("text", { style: { fg: colors.textMuted } }, "["),
    ...barRuns,
    h("text", { style: { fg: colors.textMuted } }, "] "),
    compact
      ? h(
          "text",
          { style: { fg: labelColor } },
          settled ? label.slice(0, 1) : "",
        )
      : // 恒宽填充：实时文本长度变化只在固定框内刷新，不牵动相邻 cell（防闪烁）。
        h(
          "text",
          { style: { fg: labelColor } },
          padDisplay(truncateDisplay(label, labelWidth), labelWidth),
        ),
  );
}

/** 纯渲染：输入板面快照 + 终端宽度 + 动画帧，输出完整元素树（测试可直接遍历）。 */
export function renderSwarmBoard({
  board,
  terminalWidth = 100,
  toolCallId,
  frame = 0,
}: {
  board: SwarmProgressBoard;
  terminalWidth?: number;
  toolCallId?: string;
  frame?: number;
}): React.ReactElement {
  const colors = themeColors();
  const width = Math.max(40, terminalWidth - 4);
  const idWidth = Math.max(3, String(Math.max(1, board.total)).length);
  const { columns, cellWidth, barCells } = gridLayout(width, board.entries.length, idWidth);
  // 极窄终端的紧凑降级：cell 只剩 序号+[bar]+标记（compact cell）。
  const compact = width < 52;
  // 标签预算 = cell 宽 − (id+空格+[+bar+]+空格)；终态标记是标签前缀，同列结算。
  const labelWidth = Math.max(3, cellWidth - idWidth - 1 - barCells - 2 - 1);
  const hasActiveMembers =
    board.entries.some((entry) => entry.status === "running" || entry.status === "suspended") ||
    board.done + board.failed < board.total;

  const headerSegments: React.ReactElement[] = [
    h("text", { style: { fg: colors.primary } }, `${LEFT_INDENT}─ `),
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
    const cells: React.ReactElement[] = [
      h("text", { key: "indent", style: {} }, LEFT_INDENT),
    ];
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
          frame,
          compact,
        }),
      );
    }
    rows.push(h("box", { key: `r-${start}`, style: { flexDirection: "row" } }, ...cells));
  }

  const settled = board.done + board.failed;
  const queued = board.entries.filter((entry) => entry.status === "queued").length;
  // 总状态语义：任一成员非终态即 Working；仅全部挂起（无限速外无进展）才是限速等待。
  const allSuspended = board.running === 0 && queued === 0 && settled < board.total;
  const statusText =
    board.total > 0 && settled === board.total
      ? board.failed > 0
        ? `✗ Failed. (${board.done}/${board.total})`
        : `✓ Completed. (${board.total}/${board.total})`
      : allSuspended
        ? `⏸ Rate limited… (${settled}/${board.total})`
        : board.total > 0
          ? `Working… (${settled}/${board.total})`
          : `Queued… (${board.total})`;
  const statusColor =
    board.total > 0 && settled === board.total
      ? board.failed > 0
        ? colors.error
        : colors.success
      : colors.accent;
  // 活动期状态行前缀是 80ms 轮转的 braille spinner。
  const spinner = BRAILLE_SPINNER_FRAMES[frame % BRAILLE_SPINNER_FRAMES.length]!;
  const prefix = hasActiveMembers ? `${spinner} ` : "";
  // pip 条铺满状态行剩余宽度（缩进+前缀+label+2 空格+bar = width）。
  const pipWidth = Math.max(0, width - 1 - prefix.length - statusText.length - 2);
  const pipFilled = board.total === 0 ? 0 : Math.round((settled / board.total) * pipWidth);
  const footer = h(
    "box",
    { key: "foot", style: { flexDirection: "row", marginTop: 1 } },
    h("text", { style: { fg: statusColor } }, `${LEFT_INDENT}${prefix}${statusText}  `),
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

/** 渲染组件：live 文本版本推进 + 本地动画帧（活动期 80ms）驱动整板重渲染。 */
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
  const active =
    board.entries.some((entry) => entry.status === "running" || entry.status === "suspended") ||
    board.done + board.failed < board.total;
  const frame = useSwarmAnimationFrame(active);
  return renderSwarmBoard({ board, terminalWidth, toolCallId, frame });
}
