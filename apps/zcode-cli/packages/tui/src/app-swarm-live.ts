import React from "react";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";

// ============================================================
// AgentSwarm 运行中 cell 的实时模型文本跟踪
// ============================================================
// 运行中体验：running cell 滚动显示子代理最新的模型输出行。
// 数据源复用既有事件流——子代理的 ModelStreaming 事件（含 reasoning/text
// delta）与 SubagentSpawned 事件都会投递到 TUI 的 observeSessionEvent，
// 这里按 `parentToolCallId` 里的 `#swarm-N` 后缀把子会话路由回板面条目，
// 不需要改动 SubagentPort 或 runtime。
//
// 存储：每个 (toolCallId, index) 一条滚动缓冲（滚动缓冲上限
// 2000 字符，超出从左侧丢弃），视图取「最后一个非空行」渲染。

const MAX_LATEST_MODEL_CHARS = 2_000;
const MAX_TRACKED_CHILDREN = 256;
const SWARM_SUFFIX = /#swarm-(\d+)$/;

interface SwarmLiveState {
  /** childSessionId → 板面定位（父工具调用 + 条目序号）。 */
  childKeys: Map<string, string>;
  /** 板面键 → 滚动缓冲。 */
  buffers: Map<string, string>;
  listeners: Map<string, Set<() => void>>;
  /** 父工具调用 → 版本号：任一子代理 delta 到达即 +1，驱动整板重渲染。 */
  toolVersions: Map<string, number>;
  toolListeners: Map<string, Set<() => void>>;
}

const state: SwarmLiveState = {
  childKeys: new Map(),
  buffers: new Map(),
  listeners: new Map(),
  toolVersions: new Map(),
  toolListeners: new Map(),
};

function cellKey(toolCallId: string, index: number): string {
  return `${toolCallId}#${index}`;
}

function notify(key: string): void {
  const listeners = state.listeners.get(key);
  if (listeners === undefined) return;
  for (const listener of [...listeners]) listener();
}

function trackChild(childSessionId: string, key: string): void {
  if (state.childKeys.get(childSessionId) === key) return;
  if (state.childKeys.size >= MAX_TRACKED_CHILDREN && !state.childKeys.has(childSessionId)) {
    const oldest = state.childKeys.keys().next().value;
    if (oldest !== undefined) {
      const staleKey = state.childKeys.get(oldest);
      state.childKeys.delete(oldest);
      if (staleKey !== undefined) {
        state.buffers.delete(staleKey);
        state.listeners.delete(staleKey);
      }
    }
  }
  state.childKeys.set(childSessionId, key);
}

function appendDelta(childSessionId: string, delta: string): void {
  if (delta.length === 0) return;
  const key = state.childKeys.get(childSessionId);
  if (key === undefined) return;
  const next = `${state.buffers.get(key) ?? ""}${delta}`.slice(-MAX_LATEST_MODEL_CHARS);
  state.buffers.set(key, next);
  notify(key);
  // 板面级版本：key 形如 `${toolCallId}#${index}`，取最后一个 '#' 之前为父工具调用。
  const hash = key.lastIndexOf("#");
  const toolCallId = hash === -1 ? key : key.slice(0, hash);
  state.toolVersions.set(toolCallId, (state.toolVersions.get(toolCallId) ?? 0) + 1);
  const toolListeners = state.toolListeners.get(toolCallId);
  if (toolListeners !== undefined) for (const listener of [...toolListeners]) listener();
}

/** 挂在 TUI 中央事件管线上（主会话闸门之前），逐事件喂入。 */
export function swarmLiveIngest(event: SessionEvent): void {
  if (event.type === SessionEventType.SubagentSpawned) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const parent = typeof payload?.["parentToolCallId"] === "string"
      ? payload["parentToolCallId"]
      : undefined;
    const child = typeof payload?.["childSessionId"] === "string"
      ? payload["childSessionId"]
      : undefined;
    if (parent === undefined || child === undefined) return;
    const match = SWARM_SUFFIX.exec(parent);
    if (match === null) return;
    trackChild(child, cellKey(parent.slice(0, match.index), Number(match[1])));
    return;
  }
  if (event.type === SessionEventType.ModelStreaming) {
    const payload = event.payload as Record<string, unknown> | undefined;
    const kind = payload?.["kind"];
    if (kind !== "text_delta" && kind !== "reasoning_delta") return;
    if (typeof payload?.["delta"] !== "string") return;
    appendDelta(event.sessionId, payload["delta"]);
  }
}

/** 折叠空白后取最后一个非空行。 */
export function latestNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").replaceAll(/\s+/g, " ").trim();
    if (line.length > 0) return line;
  }
  return "";
}

/** 运行中 cell 的同步读取：最后一个非空行；无跟踪数据返回空串。 */
export function readSwarmLiveLine(toolCallId: string | undefined, index: number): string {
  if (toolCallId === undefined) return "";
  return latestNonEmptyLine(state.buffers.get(cellKey(toolCallId, index)) ?? "");
}

/**
 * 板面级重渲染订阅：toolCallId 下任一子代理的 delta 到达时触发。
 * 视图在渲染期用 readSwarmLiveLine 同步取文本，本 hook 只负责版本推进。
 */
export function useSwarmLiveVersion(toolCallId: string | undefined): number {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      if (toolCallId === undefined) return () => undefined;
      const listeners = state.toolListeners.get(toolCallId) ?? new Set<() => void>();
      listeners.add(onStoreChange);
      state.toolListeners.set(toolCallId, listeners);
      return () => {
        listeners.delete(onStoreChange);
        if (listeners.size === 0) state.toolListeners.delete(toolCallId);
      };
    },
    [toolCallId],
  );
  const getSnapshot = React.useCallback(
    () => (toolCallId === undefined ? 0 : state.toolVersions.get(toolCallId) ?? 0),
    [toolCallId],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 活动期本地动画帧：80ms 递增（80ms 一帧），终态停表。
 *  驱动状态行 spinner 轮转与 running cell 的 braille 条漂移。 */
const SWARM_ANIMATION_INTERVAL_MS = 80;

export function useSwarmAnimationFrame(active: boolean): number {
  const [frame, setFrame] = React.useState(0);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % 1_000_000);
    }, SWARM_ANIMATION_INTERVAL_MS);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    return () => clearInterval(timer);
  }, [active]);
  return active ? frame : 0;
}

/** 测试与板面终态后的清理入口。 */
export function resetSwarmLiveState(): void {
  for (const listeners of state.listeners.values()) listeners.clear();
  for (const listeners of state.toolListeners.values()) listeners.clear();
  state.childKeys.clear();
  state.buffers.clear();
  state.listeners.clear();
  state.toolVersions.clear();
  state.toolListeners.clear();
}
