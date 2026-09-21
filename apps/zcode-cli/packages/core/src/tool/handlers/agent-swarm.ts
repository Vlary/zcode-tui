// ============================================================
// AgentSwarm Tool Handler
// ============================================================
// 模板化 fan-out：一份 prompt_template + items 列表展开成 N 个同类子代理，
// 引擎侧限并发排队执行并聚拢结果。与 Agent（一次一个、异构任务）和
// CreateWorkflow（TS 脚本编排）互补，覆盖「同类任务 × 大量不同输入」的档位。
//
// 引擎能力（对齐同类 swarm 实现）：
// - resume_agent_ids：经 subagentPort.sendMessage 复活已停止子代理并
//   waitForTask 等待，与新增 items 混跑；
// - 每子代理超时（ZCODE_SWARM_TIMEOUT_MS，默认 10 分钟），超时标记
//   stop_reason="timeout" 供下次 resume；
// - 限速识别与指数退避重排队（3s 基数、2 倍率、60s 封顶、至多 3 次）；
// - 启动节流：前 5 个子代理按 700ms 间隔放行，避免瞬时打爆 provider。

import { randomUUID } from "node:crypto";
import {
  AgentErrorCode,
  SessionEventType,
  AgentSwarmInputJsonSchema,
  AgentSwarmInputSchema,
  CoreErrorType,
  createCoreError,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  type AgentSwarmInput,
  type AgentSwarmOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { runSwarmPool, type SwarmEngineOptions, type SwarmEnginePorts } from "./agent-swarm-pool.js";
import {
  renderSwarmProgress,
  type SwarmProgressEntry,
  AGENT_SWARM_DESCRIPTION,
  AGENT_SWARM_OUTPUT_SCHEMA,
  formatAgentSwarmOutputForModel,
  MAX_SWARM_MODEL_BYTES,
} from "./agent-swarm-format.js";

const DEFAULT_SWARM_CONCURRENCY = 8;
const MAX_SWARM_CONCURRENCY = 32;




function resolveSwarmConcurrency(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env["ZCODE_SWARM_MAX_CONCURRENCY"] ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_SWARM_CONCURRENCY;
  return Math.min(raw, MAX_SWARM_CONCURRENCY);
}







export interface SwarmItemSpec {
  item: string;
  prompt: string;
  index: number;
  resumeAgentId?: string;
}

function invalidSwarmInput(message: string): never {
  throw createCoreError(CoreErrorType.InvalidInput, message, {
    context: {
      code: "agent_swarm_invalid_input",
      toolName: "AgentSwarm",
    },
  });
}

function expandSwarmItems(input: AgentSwarmInput): SwarmItemSpec[] {
  const items = input.items ?? [];
  const resumeEntries = Object.entries(input.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  if (resumeEntries.some((entry) => !entry.agentId || !entry.prompt)) {
    invalidSwarmInput("resume_agent_ids entries must be non-empty agent ids and prompts.");
  }
  if (items.length === 0 && resumeEntries.length === 0) {
    invalidSwarmInput("AgentSwarm requires items or resume_agent_ids.");
  }
  if (resumeEntries.length === 0 && items.length < 2) {
    invalidSwarmInput(
      "AgentSwarm requires at least 2 items unless resume_agent_ids is provided.",
    );
  }
  if (items.length + resumeEntries.length > MAX_AGENT_SWARM_SUBAGENTS) {
    invalidSwarmInput(
      `AgentSwarm supports at most ${MAX_AGENT_SWARM_SUBAGENTS} subagents (items plus resumes).`,
    );
  }
  if (items.length > 0 && !input.prompt_template.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    invalidSwarmInput(
      `AgentSwarm prompt_template must contain the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
    );
  }

  const specs: SwarmItemSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      item: entry.agentId,
      prompt: entry.prompt,
      index: specs.length + 1,
      resumeAgentId: entry.agentId,
    });
  }
  const seen = new Map<string, number>();
  for (const [position, rawItem] of items.entries()) {
    const item = rawItem.trim();
    const prompt = input.prompt_template.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
    const previous = seen.get(prompt);
    if (previous !== undefined) {
      invalidSwarmInput(
        `AgentSwarm items ${previous} and ${position + 1} expand to the same prompt; subagent prompts must be distinct.`,
      );
    }
    seen.set(prompt, position + 1);
    specs.push({ item, prompt, index: specs.length + 1 });
  }
  return specs;
}

const agentSwarmHandler: ToolHandler = async (input, context) => {
  const parsed = AgentSwarmInputSchema.parse(input) as AgentSwarmInput;

  if (!context.subagentPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SubagentPort is not configured for AgentSwarm tool",
      {
        context: {
          code: AgentErrorCode.SUBAGENT_UNAVAILABLE,
          toolCallId: context.toolCallId,
          toolName: "AgentSwarm",
        },
      },
    );
  }
  const port = context.subagentPort;
  const specs = expandSwarmItems(parsed);
  if (specs.some((spec) => spec.resumeAgentId !== undefined) && !port.sendMessage) {
    invalidSwarmInput(
      "resume_agent_ids requires subagent message delivery, which is unavailable in this runtime.",
    );
  }
  if (specs.some((spec) => spec.resumeAgentId !== undefined) && !port.waitForTask) {
    invalidSwarmInput(
      "resume_agent_ids requires subagent task waiting, which is unavailable in this runtime.",
    );
  }

  const emitSwarmProgress = (entries: readonly SwarmProgressEntry[]): void => {
    if (!context.emitEvent) return;
    const view = renderSwarmProgress({ description: parsed.description, entries });
    void context
      .emitEvent({
        id: randomUUID() as never,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ToolCallProgress,
        timestamp: Date.now(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: {
          toolCallId: context.toolCallId,
          toolName: "AgentSwarm",
          swarmProgress: view,
        },
      } as never)
      .catch(() => undefined);
  };

  const engineOptions: SwarmEngineOptions = {
    agentType: parsed.subagent_type ?? "general-purpose",
    concurrency: resolveSwarmConcurrency(process.env),
    env: process.env,
    parentToolCallId: context.toolCallId,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onProgress: emitSwarmProgress,
  };
  const traceContext: TraceContext = {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  };
  const ports: SwarmEnginePorts = {
    launch: (spec, signal) =>
      port.launch(
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          // 每个 swarm 子任务带序号后缀，TUI/trace 里可与父调用区分。
          parentToolCallId: `${context.toolCallId}#swarm-${spec.index}`,
          agentType: engineOptions.agentType,
          description: `${parsed.description} #${spec.index}`,
          prompt: spec.prompt,
          callerCanReadOutputFile: false,
          workingDirectory: context.workingDirectory,
          workspaceRoot: context.workspaceRoot,
          trace: traceContext,
        },
        {
          signal,
          ...(context.model ? { model: context.model } : {}),
          ...(context.subagentModelOverride ? { modelOverride: context.subagentModelOverride } : {}),
        },
      ),
    resume: async (spec, signal) => {
      const sendResult = await port.sendMessage!(
        {
          sessionId: context.sessionId,
          turnId: context.turnId,
          parentToolCallId: `${context.toolCallId}#swarm-${spec.index}`,
          to: spec.resumeAgentId!,
          summary: `${parsed.description} #${spec.index} (resume)`,
          message: spec.prompt,
          workingDirectory: context.workingDirectory,
          workspaceRoot: context.workspaceRoot,
          trace: traceContext,
        },
        { signal },
      );
      if (sendResult.status !== "success") {
        throw new Error(sendResult.message ?? `Failed to resume agent ${spec.resumeAgentId}.`);
      }
      const snapshot = await port.waitForTask!(sendResult.taskId ?? "", { signal });
      if (!snapshot) {
        throw new Error(`Resumed agent ${spec.resumeAgentId} disappeared before finishing.`);
      }
      if (snapshot.output) return snapshot.output;
      if (snapshot.status === "failed") {
        throw new Error(snapshot.error ?? `Resumed agent ${spec.resumeAgentId} failed.`);
      }
      // 终止但无输出：按取消后文本收尾处理，避免吞掉已完成的结论。
      throw new Error(
        `Resumed agent ${spec.resumeAgentId} ended with status ${snapshot.status}.`,
      );
    },
  };

  const subagents = await runSwarmPool(specs, engineOptions, ports);
  emitSwarmProgress(
    specs.map((spec, index) => {
      const entry = subagents[index]!;
      return entry.outcome === "completed"
        ? {
            item: spec.resumeAgentId === undefined ? spec.item : `${spec.item} (resume)`,
            status: "done" as const,
            durationMs: entry.totalDurationMs,
            totalTokens: entry.totalTokens,
          }
        : {
            item: spec.resumeAgentId === undefined ? spec.item : `${spec.item} (resume)`,
            status: "failed" as const,
            durationMs: entry.totalDurationMs,
          };
    }),
  );

  const output: AgentSwarmOutput = {
    status: "completed",
    description: parsed.description,
    total: subagents.length,
    completed: subagents.filter((entry) => entry.outcome === "completed").length,
    failed: subagents.filter((entry) => entry.outcome === "failed").length,
    subagents,
  };
  return output;
};

export const agentSwarmToolEntry: ToolEntry = {
  capability: "Launch a template fan-out swarm of profile-backed subagents with resume support",
  metadata: {
    name: "AgentSwarm",
    description: AGENT_SWARM_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: MAX_SWARM_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: agentSwarmHandler,
  formatModelContent: formatAgentSwarmOutputForModel,
  inputSchema: AgentSwarmInputJsonSchema,
  outputSchema: AGENT_SWARM_OUTPUT_SCHEMA,
  runtimeInputSchema: AgentSwarmInputSchema,
  permission: {
    permission: "subagent",
    reason:
      "AgentSwarm launches child runtimes; child tool calls are separately constrained and approved",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SWARM_MODEL_BYTES,
    maxModelBytes: MAX_SWARM_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_SWARM_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage:
      "AgentSwarm was cancelled; subagents that already started keep running to their own cancellation handling",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
