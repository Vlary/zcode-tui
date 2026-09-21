// ============================================================
// AgentSwarm Tool - Template fan-out subagent swarm
// ============================================================
// 一次调用按 prompt 模板 + items 批量启动同类子代理：模板在引擎侧展开，
// 模型只需声明一份模板和输入列表，结果聚合成单份简报返回。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const MIN_AGENT_SWARM_SUBAGENTS = 2;
export const MAX_AGENT_SWARM_SUBAGENTS = 128;
export const PROMPT_TEMPLATE_PLACEHOLDER = "{{item}}";
/** 单个子代理的执行超时（毫秒）；超时的子代理按 failed+timeout 聚合，其余继续。 */
export const DEFAULT_SWARM_TASK_TIMEOUT_MS = 10 * 60 * 1_000;
/** 限速退避：基数、倍率、封顶与单任务最大重试次数，对齐同类 swarm 引擎的节奏。 */
export const SWARM_RATE_LIMIT_RETRY_BASE_MS = 3_000;
export const SWARM_RATE_LIMIT_RETRY_MAX_MS = 60_000;
export const SWARM_RATE_LIMIT_MAX_RETRIES = 3;

export const AgentSwarmInputSchema = z.object({
  description: z.string().describe("A short (3-8 word) description of the swarm"),
  prompt_template: z
    .string()
    .describe(
      `Template for every subagent prompt; must contain the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder where each item is substituted`,
    ),
  items: z
    .array(z.string().min(1))
    .max(MAX_AGENT_SWARM_SUBAGENTS)
    .optional()
    .describe(
      "One entry per subagent; each is substituted into the template's placeholder. May be omitted when only resuming via resume_agent_ids.",
    ),
  resume_agent_ids: z
    .record(z.string())
    .optional()
    .describe(
      "Map of existing agent_id to the prompt that resumes it (usually 'continue'); resumes failed or timed-out subagents alongside new items",
    ),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for every subagent in this swarm"),
});

export type AgentSwarmInput = z.infer<typeof AgentSwarmInputSchema>;

export const AgentSwarmInputJsonSchema = toToolJsonSchema(AgentSwarmInputSchema);

export interface AgentSwarmSubagentResult {
  /** 展开前的原始 item，用于结果行与输入对齐。 */
  item: string;
  /** 子代理 ID；启动失败时缺省。可用于 SendMessage 续跑。 */
  agentId?: string;
  outcome: "completed" | "failed";
  /** 子代理最终文本（completed 时）。 */
  text?: string;
  /** 失败原因（failed 时）。 */
  error?: string;
  /** 终止归类：timeout 表示子代理超时被中止，可被 resume_agent_ids 续跑。 */
  stopReason?: "timeout";
  totalTokens?: number;
  totalToolUseCount?: number;
  totalDurationMs?: number;
}

export interface AgentSwarmOutput {
  status: "completed";
  description: string;
  total: number;
  completed: number;
  failed: number;
  subagents: AgentSwarmSubagentResult[];
}
