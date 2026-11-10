import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { agent, ndJsonStream, type AgentApp } from "@agentclientprotocol/sdk";
import type { RunContext } from "@zcode/shared-types";

// ============================================================
// ACP <-> ZCode Protocol 桥
// ============================================================
// `zcode acp` 以 ACP（Agent Client Protocol）agent 身份服务 stdio：Zed 等
// ACP 客户端可直接驱动本 CLI。内部 spawn 一个 `zcode app-server` 子进程
// （ZCode Protocol，NDJSON over stdio），把 ACP 的会话/prompt 流翻译过去，
// 并把 ZCode 的事件流（text/reasoning delta、tool 调度、turn 完成）以
// sessionUpdate 通知转发回客户端。

declare const __CLI_VERSION__: string;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface BridgeDeps {
  onNotification(method: string, params: unknown): void;
  onServerRequest(method: string, id: number | string, params: unknown): void;
  onExit(code: number | null): void;
}

class ZCodeAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private readonly deps: BridgeDeps;
  readonly process: ChildProcess;

  constructor(
    command: string,
    args: readonly string[],
    cwd: string,
    deps: BridgeDeps,
  ) {
    this.deps = deps;
    this.process = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    this.process.stdout?.setEncoding("utf8");
    this.process.stdout?.on("data", (chunk: string) => this.consume(chunk));
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("close", (code) => {
      this.failAll(new Error(`app-server exited with code ${code ?? "unknown"}`));
      deps.onExit(code);
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        this.deps.onServerRequest(message.method, message.id as number | string, message.params);
      } else if (typeof message.method === "string") {
        this.deps.onNotification(message.method, message.params);
      } else if (typeof message.id === "number" && message.error) {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          const error = message.error as { message?: string };
          entry.reject(new Error(String(error.message ?? "app-server request failed")));
        }
      } else if (typeof message.id === "number") {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          entry.resolve(message.result);
        }
      }
    }
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.process.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  respond(id: number | string, body: unknown): void {
    this.process.stdin?.write(`${JSON.stringify({ id, ...((body ?? {}) as object) })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.process.stdin?.write(`${JSON.stringify({ method, params })}\n`);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}

interface BridgeSession {
  seenToolCalls: Set<string>;
  finishedTurns: Set<string>;
  promptResolve?: () => void;
}

function acpToolKind(
  toolName: string,
): "execute" | "read" | "edit" | "search" | "fetch" | "think" {
  const lower = toolName.toLowerCase();
  if (lower === "bash" || lower === "shell") return "execute";
  if (lower === "read" || lower === "glob") return "read";
  if (lower === "edit" || lower === "write") return "edit";
  if (lower === "grep" || lower === "search") return "search";
  if (lower === "webfetch" || lower === "websearch") return "fetch";
  return "think";
}

function contentBlocksText(blocks: readonly unknown[] | undefined): string {
  return (blocks ?? [])
    .map((block) => {
      const record = block as { type?: string; text?: string };
      return record?.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

const RUNTIME_PREFERENCES_DEFAULT = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
} as const;

interface AcpClientLike {
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
}

export async function runAcpServer(ctx: RunContext): Promise<number> {
  const selfEntry = process.argv[1];
  const app: AgentApp = agent({ name: "zcode" });
  let server: ZCodeAppServerClient | undefined;
  let client: AcpClientLike | undefined;
  const sessions = new Map<string, BridgeSession>();

  const handleServerRequest = (method: string, id: number | string, params: unknown): void => {
    const current = server;
    if (!current) return;
    if (method === "session/requestRuntimePreferences") {
      current.respond(id, { result: RUNTIME_PREFERENCES_DEFAULT });
      return;
    }
    if (method === "interaction/requestPermission") {
      const record = params as {
        sessionId?: string;
        toolName?: string;
        options?: Array<{ name?: string }>;
      };
      if (!client) {
        current.respond(id, {
          result: { outcome: { name: "selected", optionId: "allow" } },
        });
        return;
      }
      void client
        .request("session/request_permission", {
          sessionId: record.sessionId ?? "",
          options: (record.options ?? [{ name: "allow" }]).map((option) => ({
            optionId: option.name ?? "allow",
            name: option.name ?? "Allow",
            kind: "allow_once" as const,
          })),
        })
        .then((response) => {
          current.respond(id, { result: response ?? { outcome: { outcome: "selected", optionId: "allow" } } });
        })
        .catch(() => {
          current.respond(id, { error: { code: -32000, message: "permission relay failed" } });
        });
      return;
    }
    current.respond(id, { error: { code: -32601, message: `zcode acp: ${method} not handled` } });
  };

  const forwardNotification = (method: string, params: unknown): void => {
    if (method !== "session/event" || !client) return;
    const envelope = params as { sessionId?: string; payload?: Record<string, unknown> };
    const sessionId = envelope.sessionId ?? "";
    const payload = envelope.payload ?? {};
    const state = sessions.get(sessionId);
    if (!state) return;
    const kind = typeof payload.kind === "string" ? payload.kind : "";

    if (kind === "text_delta" && typeof payload.delta === "string") {
      void client
        .notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: payload.delta },
          },
        });
      return;
    }
    if (kind === "reasoning_delta" && typeof payload.delta === "string") {
      void client
        .notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: payload.delta },
          },
        });
      return;
    }
    if (kind === "tool-scheduled" || kind === "tool-started") {
      const toolCallId = String(payload.toolCallId ?? "");
      if (!toolCallId || state.seenToolCalls.has(toolCallId)) return;
      state.seenToolCalls.add(toolCallId);
      const toolName = String(payload.toolName ?? "tool");
      const title =
        typeof payload.commandDisplay === "string" && payload.commandDisplay.length > 0
          ? payload.commandDisplay
          : toolName;
      void client
        .notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title,
            kind: acpToolKind(toolName),
          },
        });
      return;
    }
    // turn 完成信号：带 stopReason 的投影或 response 汇总事件。ACP 的完成语义由
    // session/prompt 响应承载，这里 resolve 挂起的 prompt 并补一条 usage_update。
    const stopReason = payload.stopReason;
    const hasResponse = typeof payload.response === "string";
    if ((typeof stopReason === "string" && stopReason.length > 0) || hasResponse) {
      const turnKey = `turn:${String(payload.turnId ?? payload.assistantMessageId ?? Date.now())}`;
      if (!state.finishedTurns.has(turnKey)) {
        state.finishedTurns.add(turnKey);
        const usage = (payload.usage ?? {}) as Record<string, unknown>;
        const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
        if (totalTokens !== undefined) {
          client.notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: { totalTokens, inputTokens: 0, outputTokens: 0 },
            },
          });
        }
        state.promptResolve?.();
        state.promptResolve = undefined;
      }
    }
  };

  app.onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "zcode", version: __CLI_VERSION__ },
    authMethods: [],
  }));

  app.onRequest("session/new", (context: { params: { cwd?: string } }) => {
    const requested =
      context.params.cwd && context.params.cwd.length > 0 ? context.params.cwd : process.cwd();
    const current = server ?? new ZCodeAppServerClient(
      process.execPath,
      [selfEntry ?? "zcode", "app-server"],
      requested,
      {
        onNotification: forwardNotification,
        onServerRequest: handleServerRequest,
        onExit: (code) => {
          ctx.stderr.write(`zcode acp: app-server exited (${code ?? "unknown"})\n`);
          server = undefined;
        },
      },
    );
    server = current;
    return (async () => {
      const created = (await current.request<{ sessionId?: string; session?: { sessionId?: string } }>(
        "session/create",
        {
          workspace: {
            workspacePath: requested,
            workspaceKey: basename(requested) || "workspace",
          },
        },
      )) as { sessionId?: string; session?: { sessionId?: string } } | undefined;
      const sessionId = created?.sessionId ?? created?.session?.sessionId;
      if (!sessionId) throw new Error("zcode acp: session/create returned no sessionId");
      sessions.set(sessionId, { seenToolCalls: new Set(), finishedTurns: new Set() });
      await current.request("session/subscribe", {
        sessionId,
        deliveryKind: "desktop-continuous",
      });
      return { sessionId };
    })().catch((error: unknown) => {
      ctx.stderr.write(
        `zcode acp: session/new failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      throw error;
    });
  });

  app.onRequest("session/prompt", (context: {
    params: { sessionId: string; prompt?: unknown[] };
  }) => {
    const { sessionId, prompt } = context.params;
    const current = server;
    if (!current || !sessions.has(sessionId)) {
      throw new Error("zcode acp: unknown session");
    }
    return (async () => {
      const sent = (await current.request<{ accepted?: boolean }>("session/send", {
        sessionId,
        content: contentBlocksText(prompt),
      })) as { accepted?: boolean } | undefined;
      if (!sent?.accepted) throw new Error("zcode acp: session/send rejected");
      const state = sessions.get(sessionId)!;
      await new Promise<void>((resolve) => {
        state.promptResolve = resolve;
        setTimeout(resolve, 10 * 60 * 1_000);
      });
      return { stopReason: "end_turn" };
    })();
  });

  app.onNotification("session/cancel", (context: { params: { sessionId: string } }) => {
    server?.notify("session/stop", { sessionId: context.params.sessionId });
  });

  const { Readable, Writable } = await import("node:stream");
  const connection = await app.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
  client = (connection as unknown as { client: AcpClientLike }).client;
  ctx.stderr.write(`zcode acp: serving ACP on stdio (v${__CLI_VERSION__})\n`);
  await new Promise<void>(() => undefined);
  return 0;
}
