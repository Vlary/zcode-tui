// ============================================================
// AgentSwarm - concurrency pool engine
// ============================================================
// 从 agent-swarm.ts 拆出的执行池：固定并发上限、启动节流、限速退避重试、
// 每子代理超时与实时进度板快照。

import {
  DEFAULT_SWARM_TASK_TIMEOUT_MS,
  type AgentOutput,
  type AgentSwarmSubagentResult,
  SWARM_RATE_LIMIT_MAX_RETRIES,
  SWARM_RATE_LIMIT_RETRY_BASE_MS,
  SWARM_RATE_LIMIT_RETRY_MAX_MS,
} from "@zcode/contracts";
import type { SwarmProgressEntry } from "./agent-swarm-format.js";
import type { SwarmItemSpec } from "./agent-swarm.js";

export interface SwarmEngineOptions {
  agentType: string;
  concurrency: number;
  env: NodeJS.ProcessEnv;
  parentToolCallId: string;
  sleep: (ms: number) => Promise<void>;
  onProgress?: (entries: readonly SwarmProgressEntry[]) => void;
}

export interface SwarmEnginePorts {
  launch: (spec: SwarmItemSpec, signal: AbortSignal) => Promise<AgentOutput>;
  resume: (spec: SwarmItemSpec, signal: AbortSignal) => Promise<AgentOutput>;
}

const INITIAL_LAUNCH_LIMIT = 5;
const INITIAL_LAUNCH_INTERVAL_MS = 700;
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|429|resource_exhaust|quota/i;
function resolveSwarmTaskTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env["ZCODE_SWARM_TIMEOUT_MS"] ?? "", 10);
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_SWARM_TASK_TIMEOUT_MS;
  return raw;
}
function isRateLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (RATE_LIMIT_PATTERN.test(error.message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && RATE_LIMIT_PATTERN.test(cause.message);
}
class SwarmTaskTimeoutError extends Error {
  constructor() {
    super("Swarm subagent timed out.");
    this.name = "SwarmTaskTimeoutError";
  }
}


/** 固定并发上限的有序池：结果按下标落位，先完成的 worker 立即取下一个任务。 */
export async function runSwarmPool(
  specs: readonly SwarmItemSpec[],
  options: SwarmEngineOptions,
  ports: SwarmEnginePorts,
): Promise<AgentSwarmSubagentResult[]> {
  const results: AgentSwarmSubagentResult[] = Array.from({ length: specs.length });
  // 进度板：按 spec 序维护状态，任何状态迁移都触发一次 onProgress 快照。
  const board = specs.map<SwarmProgressEntry>((spec) => ({
    item: spec.resumeAgentId === undefined ? spec.item : `${spec.item} (resume)`,
    status: "queued",
    ticks: 0,
  }));
  const reportProgress = (): void => {
    options.onProgress?.(board.map((entry) => ({ ...entry })));
  };
  let next = 0;
  let launched = 0;
  const workerCount = Math.max(1, Math.min(options.concurrency, specs.length));
  const timeoutMs = resolveSwarmTaskTimeoutMs(options.env);

  const runOne = async (spec: SwarmItemSpec, index: number): Promise<AgentSwarmSubagentResult> => {
    const controller = new AbortController();
    // 引擎层超时：即使底层调用不响应 abort 信号，也按 deadline 强制归类 timeout。
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeoutRace = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        const error = new SwarmTaskTimeoutError();
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const startedAt = Date.now();
    board[index]!.status = "running";
    reportProgress();
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          const run =
            spec.resumeAgentId === undefined
              ? ports.launch(spec, controller.signal)
              : ports.resume(spec, controller.signal);
          const output = await Promise.race([run, timeoutRace]);
          if (output.status !== "completed") {
            board[index]!.status = "failed";
            board[index]!.durationMs = Date.now() - startedAt;
            reportProgress();
            return {
              item: spec.item,
              agentId: output.agentId,
              outcome: "failed",
              error: "backgrounded",
            };
          }
          board[index]!.status = "done";
          board[index]!.durationMs = Date.now() - startedAt;
          board[index]!.totalTokens = output.totalTokens;
          reportProgress();
          return {
            item: spec.item,
            agentId: output.agentId,
            outcome: "completed",
            text: output.content.map((block) => block.text).join("\n"),
            totalTokens: output.totalTokens,
            totalToolUseCount: output.totalToolUseCount,
            totalDurationMs: Date.now() - startedAt,
          };
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason ?? error;
          if (attempt >= SWARM_RATE_LIMIT_MAX_RETRIES || !isRateLimitError(error)) throw error;
          const delay = Math.min(
            SWARM_RATE_LIMIT_RETRY_BASE_MS * 2 ** attempt,
            SWARM_RATE_LIMIT_RETRY_MAX_MS,
          );
          await options.sleep(delay);
        }
      }
    } catch (error) {
      board[index]!.status = "failed";
      board[index]!.durationMs = Date.now() - startedAt;
      reportProgress();
      const timedOut =
        error instanceof SwarmTaskTimeoutError ||
        controller.signal.reason instanceof SwarmTaskTimeoutError;
      return {
        item: spec.item,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
        ...(timedOut ? { stopReason: "timeout" as const } : {}),
      };
    } finally {
      clearTimeout(deadline);
    }
  };

  const workers = Array.from({ length: workerCount }, async () => {
    while (next < specs.length) {
      const index = next++;
      // 启动节流：前 INITIAL_LAUNCH_LIMIT 个子代理按固定间隔放行。
      if (launched < INITIAL_LAUNCH_LIMIT && launched > 0) {
        await options.sleep(INITIAL_LAUNCH_INTERVAL_MS);
      }
      launched += 1;
      results[index] = await runOne(specs[index]!, index);
    }
  });
  // Kimi 同款呼吸感：running cell 的 braille 条随时间漂移（简化估算器：每帧 +2）。
  const animator = setInterval(() => {
    let animated = false;
    for (const entry of board) {
      if (entry.status === "running") {
        entry.ticks += 2;
        animated = true;
      }
    }
    if (animated) reportProgress();
  }, 800);
  if (typeof animator === "object" && "unref" in animator) animator.unref();
  try {
    await Promise.all(workers);
  } finally {
    clearInterval(animator);
  }
  return results;
}

