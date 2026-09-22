// ============================================================
// AgentSwarm Tool - schema, description and model-facing rendering
// ============================================================
// 从 agent-swarm.ts 拆出的静态声明与结果渲染，保持单个文件在仓库
// max-lines 上限内。

import {
  PROMPT_TEMPLATE_PLACEHOLDER,
  type SwarmProgressBoard,
  type AgentSwarmOutput,
} from "@zcode/contracts";

export const MAX_SWARM_MODEL_BYTES = 120_000;
/** 单个子代理文本进入聚合简报的上限；全文由 resultBudget 的 artifact 策略兜底。 */
const MAX_SUBAGENT_TEXT_BYTES = 4_096;

export const AGENT_SWARM_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: { const: "completed", type: "string" },
    description: { type: "string" },
    total: { type: "integer", minimum: 1 },
    completed: { type: "integer", minimum: 0 },
    failed: { type: "integer", minimum: 0 },
    subagents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string" },
          agentId: { type: "string" },
          outcome: { enum: ["completed", "failed"], type: "string" },
          text: { type: "string" },
          error: { type: "string" },
          stopReason: { const: "timeout", type: "string" },
          totalTokens: { type: "integer", minimum: 0 },
          totalToolUseCount: { type: "integer", minimum: 0 },
          totalDurationMs: { type: "integer", minimum: 0 },
        },
        required: ["item", "outcome"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "description", "total", "completed", "failed", "subagents"],
  additionalProperties: false,
} as const;

export const AGENT_SWARM_DESCRIPTION = [
  `Launch multiple subagents from one prompt template: each entry in items is substituted into prompt_template's ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder and run as its own subagent, with launches queued automatically up to a concurrency limit.`,
  "",
  "Use AgentSwarm when many subagents should run the same kind of task over different inputs (for example, reviewing each file in a list, or checking each service in a fleet). For a few differently-shaped tasks, make separate Agent calls in one message instead.",
  "",
  "Constraints, enforced before any subagent starts: items requires at least 2 entries (unless resume_agent_ids is provided) and at most 128 in total; prompt_template must contain the placeholder; the expanded prompts must be distinct.",
  "",
  "resume_agent_ids continues subagents that already exist from earlier work, such as ones that failed or timed out: map each agent_id to the prompt for that resumed subagent (usually `continue`), and do not duplicate resumed work in items. Subagents that time out report stop_reason=\"timeout\"; resume them the same way.",
  "",
  "If AgentSwarm is called, prefer making it the only tool call in the response.",
].join("\n");

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function clampText(text: string): string {
  if (text.length <= MAX_SUBAGENT_TEXT_BYTES) return text;
  return `${text.slice(0, MAX_SUBAGENT_TEXT_BYTES)}\n…(truncated; full output in session artifact)`;
}

export function formatAgentSwarmOutputForModel(output: unknown): string {
  if (typeof output === "string") return output;
  const data = output as AgentSwarmOutput;
  if (data?.status !== "completed") {
    return typeof output === "string" ? output : JSON.stringify(output) ?? String(output);
  }
  const lines = [
    "<agent_swarm_result>",
    `<summary>${data.completed}/${data.total} completed, ${data.failed} failed</summary>`,
  ];
  if (data.failed > 0) {
    lines.push(
      "<resume_hint>Failed subagents report agent_id below; resume them by calling AgentSwarm again with resume_agent_ids mapping each agent_id to a follow-up prompt (usually `continue`).</resume_hint>",
    );
  }
  for (const entry of data.subagents) {
    const agentId = entry.agentId === undefined ? "" : ` agent_id="${entry.agentId}"`;
    const mode = entry.stopReason === undefined ? "" : ` stop_reason="${entry.stopReason}"`;
    const usage =
      entry.totalTokens === undefined
        ? ""
        : ` tokens="${entry.totalTokens}" tool_uses="${entry.totalToolUseCount}" duration_ms="${entry.totalDurationMs}"`;
    const body = clampText(
      entry.outcome === "completed" ? (entry.text ?? "") : (entry.error ?? "unknown error"),
    );
    lines.push(
      `<subagent item="${escapeXmlAttribute(entry.item)}"${agentId}${mode} outcome="${entry.outcome}"${usage}>${body}</subagent>`,
    );
  }
  lines.push("</agent_swarm_result>");
  return lines.join("\n");
}

// ============================================================
// AgentSwarm 实时进度板（Kimi Code 同款视觉规格）
// ============================================================
// ─ Agent Swarm ─ description ─────── 线框标题
//  001 [⣿⣷⣄⣀] ✓ item…           多列网格 cell：
//  002 [⣶⣤⣀⣀] ⠋ item…             3 位序号 + braille 8 级进度条
//  003 [⣀⣀⣀⣀] Queued…              + 终态标记 + 标签
//  ⠋ Working… ━━━━━━━━━╌╌╌╌╌ (2/6)  底部 pip 状态条
// handler 在状态迁移与 tick 定时器上重发整板；TUI 热替换工具卡片。

export interface SwarmProgressEntry {
  item: string;
  status: "queued" | "running" | "suspended" | "done" | "failed";
  ticks: number;
  durationMs?: number;
  totalTokens?: number;
}

const BOARD_WIDTH = 88;
const CELL_COLUMNS = 2;
const CELL_GAP = "  ";
const CELL_WIDTH = Math.floor((BOARD_WIDTH - CELL_GAP.length * (CELL_COLUMNS - 1)) / CELL_COLUMNS);
const BAR_CELLS = 4;
const BRAILLE_LEVELS = ["⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"] as const;
const BRAILLE_EMPTY = "⣀";
const BRAILLE_SEPARATOR = "⢸";
const PIP_FILLED = "━";
const PIP_EMPTY = "╌";
const PIP_WIDTH = 18;
const TICKS_PER_BAR = BAR_CELLS * BRAILLE_LEVELS.length;

function brailleBar(ticks: number, settled: boolean): string {
  if (settled) return "⣿".repeat(BAR_CELLS);
  const safe = Math.max(0, Math.floor(ticks)) % TICKS_PER_BAR;
  const activeCells = safe === 0 ? 0 : Math.ceil(safe / BRAILLE_LEVELS.length);
  let out = "";
  for (let i = 0; i < BAR_CELLS; i += 1) {
    if (i === activeCells - 1 && activeCells > 0 && activeCells < BAR_CELLS) {
      out += BRAILLE_SEPARATOR;
      continue;
    }
    const cellStart = i * BRAILLE_LEVELS.length;
    const count = Math.max(0, Math.min(BRAILLE_LEVELS.length, safe - cellStart));
    out += count === 0 ? BRAILLE_EMPTY : BRAILLE_LEVELS[count - 1];
  }
  return out;
}

function cellLabel(entry: SwarmProgressEntry): string {
  if (entry.status === "failed") return `✗ ${entry.item}`;
  if (entry.status === "done") {
    const tokens = entry.totalTokens === undefined ? "" : ` · ${formatTokens(entry.totalTokens)}`;
    return `✓ ${entry.item}${tokens}`;
  }
  if (entry.status === "running") return `⠋ ${entry.item}`;
  if (entry.status === "suspended") return "⠏ Rate limited…";
  return "Queued…";
}

function padCell(text: string): string {
  return text.length > CELL_WIDTH ? `${text.slice(0, CELL_WIDTH - 1)}…` : text.padEnd(CELL_WIDTH, " ");
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`;
}

export function renderSwarmProgress(input: {
  description: string;
  entries: readonly SwarmProgressEntry[];
}): { title: string; rows: string[]; board: SwarmProgressBoard } {
  const entries = input.entries;
  const done = entries.filter((e) => e.status === "done").length;
  const failed = entries.filter((e) => e.status === "failed").length;
  const running = entries.filter((e) => e.status === "running").length;
  const suspended = entries.filter((e) => e.status === "suspended").length;
  const settled = done + failed;
  const total = entries.length;
  const idWidth = Math.max(3, String(Math.max(1, total)).length);

  // 标题：─ Agent Swarm ─ description ───────
  const head = "Agent Swarm";
  const desc = input.description.length > 0 ? ` ─ ${input.description}` : "";
  const used = head.length + desc.length + 2;
  const tail = "─".repeat(Math.max(1, BOARD_WIDTH - used - 1));
  const title = `${head}${desc} ${tail}`.slice(0, BOARD_WIDTH);

  // 网格行
  const rows: string[] = [];
  for (let i = 0; i < entries.length; i += CELL_COLUMNS) {
    const cells: string[] = [];
    for (let col = 0; col < CELL_COLUMNS && i + col < entries.length; col += 1) {
      const entry = entries[i + col]!;
      const id = String(i + col + 1).padStart(idWidth, "0");
      const settledCell = entry.status === "done" || entry.status === "failed";
      const bar = brailleBar(entry.ticks, settledCell);
      const mark = cellLabel(entry);
      cells.push(padCell(`${id} [${bar}] ${mark}`));
    }
    rows.push(cells.join(CELL_GAP));
  }

  // 底部 pip 状态条
  let statusLabel: string;
  if (total > 0 && settled === total) {
    statusLabel = failed > 0 ? `✗ Failed. (${done}/${total})` : `✓ Completed. (${total}/${total})`;
  } else if (suspended > 0 && running === 0) {
    statusLabel = `⏸ Rate limited… (${settled}/${total})`;
  } else if (running > 0 || suspended > 0) {
    statusLabel = `⠋ Working… (${settled}/${total})`;
  } else {
    statusLabel = `Queued… (${total})`;
  }
  const filled = total === 0 ? 0 : Math.round((settled / total) * PIP_WIDTH);
  const pip = `${PIP_FILLED.repeat(filled)}${PIP_EMPTY.repeat(Math.max(0, PIP_WIDTH - filled))}`;
  rows.push(`${statusLabel} ${pip}`);

  return {
    title,
    rows,
    board: {
      description: input.description,
      total,
      done,
      failed,
      running: running + suspended,
      entries: entries.map((entry, position) => ({
        index: position + 1,
        status: entry.status,
        ticks: entry.ticks,
        item: entry.item,
        ...(entry.totalTokens === undefined ? {} : { tokens: entry.totalTokens }),
      })),
    },
  };
}
