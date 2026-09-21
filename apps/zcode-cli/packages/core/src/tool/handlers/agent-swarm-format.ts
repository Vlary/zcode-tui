// ============================================================
// AgentSwarm Tool - schema, description and model-facing rendering
// ============================================================
// 从 agent-swarm.ts 拆出的静态声明与结果渲染，保持单个文件在仓库
// max-lines 上限内。

import {
  PROMPT_TEMPLATE_PLACEHOLDER,
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
