/* eslint-disable max-lines -- Web 远程控制被控端 manager 承担外部 relay app payload 路由与
   workspace bridge 编排；与 desktop webRemoteControlManager.ts 同一豁免先例。 */
import { randomUUID } from "node:crypto";
import type { ISocket } from "@zcode/rpc";
import {
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  buildWebRemoteControlExternalQrUrl,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
  resolveUnrecognizedWebRemoteControlRequest,
  resolveWebRemoteControlWorkspaceKey,
  WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlExternalWorkspaceBridge,
  type WebRemoteControlFailure,
  type WebRemoteControlFailureReason,
  type WebRemoteControlMobileDeviceInfo,
  type WebRemoteControlMobileViewState,
  type WebRemoteControlPlatformMethod,
  type WebRemoteControlPlatformMethodResultMap,
  type WebRemoteControlPlatformResponsePayload,
  type WebRemoteControlWindowBootstrapResult,
  type WebRemoteControlWorkspaceBridgeOpenPayload,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import { WebRemoteControlDeviceTransport } from "./webRemoteControlDeviceTransport.js";
import { createWebRemoteControlChannelBridge } from "./webRemoteControlChannelBridge.js";
import { createWebRemoteControlV2Http } from "./webRemoteControlV2Http.js";
import { retryIfJwtReplaced } from "./webRemoteControlDeviceIdentity.js";
import type { WebRemoteControlDeviceIdentity } from "./webRemoteControlDeviceIdentity.js";
import type {
  WebRemoteControlDeviceTransportOptions,
  WebRemoteControlDeviceTransportState,
  WebRemoteControlLogin,
} from "./contract.js";

/**
 * Web 远程控制被控端 manager-lite：desktop webRemoteControlManager.ts（2331 行）的
 * 非 Electron 裁剪版，保留四段核心语义：
 * - routePayload（desktop:1556-1625）：bootstrap / workspace-list / workspace-bridge-open /
 *   rpc-frame(-ack) / view-state / app-error；task-pin/task-archive/workspace-create
 *   依赖 Renderer（BrowserWindow IPC），在 server 上回 unsupported-action。
 * - bootstrap（desktop:1018-1029）：workspaces 来自 server 工作区（env ZCODE_SERVER_WORKSPACE / cwd）。
 * - terminalOwner（desktop:612-646）：进程内记录，无 setTerminalOwner IPC。
 * - acknowledged 桥（desktop:1284-1330 / 重放 1944-1958 / 降级 2258-2275 语义）：
 *   relay rpc-frame ↔ 进程内 ChannelServer；不迁 mobileLog / mobilePush / 通知 / 窗口恢复。
 */

interface WorkspaceBridgeRuntime {
  terminalOwnerId?: string;
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  initialTaskId?: string;
  relayProtocol?: AcknowledgedWebRemoteControlRelayProtocolAdapter;
  disposeBridge?: () => void;
  readyAnnounced: boolean;
  degraded: boolean;
}

interface WebRemoteControlDeviceTransportLike {
  start(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  sendPayloadResult?(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult;
  measurePayloadBytes?(payload: WebRemoteControlAppPayload): number;
  dispose(): void;
}

export type WebRemoteControlDeviceStatusKind =
  | "idle"
  | "starting"
  | "running"
  | "active"
  | "auth-required"
  | "error";

export interface WebRemoteControlDeviceStatus {
  status: WebRemoteControlDeviceStatusKind;
  sessionId?: string;
  deviceMid?: string;
  qrUrl?: string;
  failure?: WebRemoteControlFailure;
}

interface DeviceRuntime {
  status: WebRemoteControlDeviceStatusKind;
  failure?: WebRemoteControlFailure;
  terminalOwner?: { clientSessionId: string; id: string };
  deviceSid: string;
  deviceMid: string;
  qrUrl: string;
  transport: WebRemoteControlDeviceTransportLike;
  transportState?: WebRemoteControlDeviceTransportState;
  currentBridge?: WorkspaceBridgeRuntime;
  bridgeOpen?: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    intentKey: string;
    promise: Promise<WebRemoteControlExternalWorkspaceBridge>;
  };
  pendingBridgeInvalidation?: Extract<
    WebRemoteControlAppPayload,
    { zcode_type: "bridge-degraded" }
  >;
  pendingOutboundPayloads: WebRemoteControlAppPayload[];
  pendingOutboundPayloadTimer?: ReturnType<typeof setTimeout>;
  mobileViewState?: WebRemoteControlMobileViewState;
  mobileDeviceInfo?: WebRemoteControlMobileDeviceInfo;
}

export interface WebRemoteControlDeviceManagerDependencies {
  /** relay HTTP（注册/token）所用端点 origin；与身份持久化的 endpointOrigin 一致。 */
  endpointOrigin: string;
  relayWsUrl: string;
  /** 配对二维码 base URL（endpoint origin 的 /remote/v4 页面）。 */
  remoteControlUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  platform?: string;
  getLogin(): Promise<WebRemoteControlLogin | undefined>;
  deviceIdentity: WebRemoteControlDeviceIdentity;
  getWorkspaces(): WebRemoteControlWorkspaceTarget[];
  /**
   * 进程内桥的 ChannelServer 端：生产装配 setupChannelServerOverSocket(services, ...)。
   * ChannelServer 自身的释放由桥关闭 socket 触发其内部 onClose 清理。
   */
  attachChannelServer(socket: ISocket): void;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onStatusChanged?(status: WebRemoteControlDeviceStatus): void;
  createDeviceTransport?: (
    options: WebRemoteControlDeviceTransportOptions,
  ) => WebRemoteControlDeviceTransportLike;
}

function createFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

/**
 * server-lite platform 方法表（首版）：枚举类与 MCP 读返回与普通 Web 无宿主 fallback
 * （packages/web/src/platform/index.ts:79-96）完全相同的空结果，手机端 UI 走与 Web
 * 一致的空态而不是异常；需要 desktop host 能力的写操作（MCP 保存/迁移、临时附件）
 * 不在表内，回 unsupported-action 失败，手机端 requestPlatformMethod 对 success:false
 * 会 throw（web main.tsx:1389-1391）从而立即降级。
 */
const SERVER_PLATFORM_EMPTY_RESULTS: {
  [K in WebRemoteControlPlatformMethod]?: WebRemoteControlPlatformMethodResultMap[K];
} = {
  isDockerAvailable: false,
  listWSLDistros: [],
  listDockerContainers: [],
  listSSHConfigAliases: [],
  loadMcpFromUserDirectory: { servers: [] },
};

export interface WebRemoteControlDeviceManager {
  start(): Promise<WebRemoteControlDeviceStatus>;
  stop(reason: string): Promise<void>;
  getStatus(): WebRemoteControlDeviceStatus;
  dispose(): Promise<void>;
}

export function createWebRemoteControlDeviceManager(
  dependencies: WebRemoteControlDeviceManagerDependencies,
): WebRemoteControlDeviceManager {
  let runtime: DeviceRuntime | undefined;
  let authRequired = false;
  const http = createWebRemoteControlV2Http(dependencies.endpointOrigin);

  function emitStatus(status: WebRemoteControlDeviceStatus): void {
    dependencies.onStatusChanged?.(status);
  }

  function createTransport(options: WebRemoteControlDeviceTransportOptions) {
    return dependencies.createDeviceTransport
      ? dependencies.createDeviceTransport(options)
      : new WebRemoteControlDeviceTransport(options);
  }

  function sendPayloadToTransport(
    current: DeviceRuntime,
    payload: WebRemoteControlAppPayload,
  ): WebRemoteControlPayloadSendResult {
    if (current.transport.sendPayloadResult) {
      return current.transport.sendPayloadResult(payload);
    }
    return current.transport.sendPayload(payload)
      ? { kind: "sent", bytes: 0 }
      : { kind: "unavailable" };
  }

  function clearPendingOutboundPayloadTimer(current: DeviceRuntime): void {
    if (!current.pendingOutboundPayloadTimer) return;
    clearTimeout(current.pendingOutboundPayloadTimer);
    current.pendingOutboundPayloadTimer = undefined;
  }

  function schedulePendingOutboundPayloadTimeout(current: DeviceRuntime): void {
    if (current.pendingOutboundPayloadTimer || current.pendingOutboundPayloads.length === 0) {
      return;
    }
    current.pendingOutboundPayloadTimer = setTimeout(() => {
      current.pendingOutboundPayloadTimer = undefined;
      const droppedCount = current.pendingOutboundPayloads.splice(0).length;
      dependencies.logger.warn("[web-remote-control:server] dropped buffered outbound payloads", {
        session: current.deviceSid,
        droppedCount,
      });
    }, WEB_REMOTE_CONTROL_OUTBOUND_PAYLOAD_BUFFER_TIMEOUT_MS);
  }

  function bufferOutboundPayload(current: DeviceRuntime, payload: WebRemoteControlAppPayload): void {
    if (current.pendingOutboundPayloads.length >= 50) {
      const droppedCount = current.pendingOutboundPayloads.length + 1;
      current.pendingOutboundPayloads.length = 0;
      clearPendingOutboundPayloadTimer(current);
      dependencies.logger.warn("[web-remote-control:server] dropped overflowing outbound payloads", {
        session: current.deviceSid,
        droppedCount,
      });
      return;
    }
    current.pendingOutboundPayloads.push(payload);
    schedulePendingOutboundPayloadTimeout(current);
  }

  function flushPendingOutboundPayloads(current: DeviceRuntime): void {
    while (current.pendingOutboundPayloads.length > 0) {
      const payload = current.pendingOutboundPayloads[0];
      if (!payload) break;
      const result = sendPayloadToTransport(current, payload);
      if (result.kind === "unavailable") {
        schedulePendingOutboundPayloadTimeout(current);
        return;
      }
      if (result.kind === "oversize") {
        // Bugfix：永久 oversize 不能伪装成临时不可发送后反复进入 50 项 buffer。
        dependencies.logger.warn("[web-remote-control:server] dropped oversize app payload", {
          zcodeType: payload.zcode_type,
          bytes: result.bytes,
          maxBytes: result.maxBytes,
        });
      }
      current.pendingOutboundPayloads.shift();
    }
    clearPendingOutboundPayloadTimer(current);
  }

  function sendAppPayload(current: DeviceRuntime, payload: WebRemoteControlAppPayload): void {
    if (current.pendingOutboundPayloads.length > 0) {
      bufferOutboundPayload(current, payload);
      flushPendingOutboundPayloads(current);
      return;
    }
    const result = sendPayloadToTransport(current, payload);
    if (result.kind === "sent") return;
    if (result.kind === "oversize") {
      dependencies.logger.warn("[web-remote-control:server] rejected oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
      return;
    }
    // Bugfix: relay suspect 窗口内 sendPayload 会返回 false。
    // server 发出的响应/RPC 帧不能静默丢弃，先短暂缓冲，等 paired 恢复后再 flush。
    bufferOutboundPayload(current, payload);
  }

  function sendPendingBridgeInvalidation(current: DeviceRuntime): void {
    const payload = current.pendingBridgeInvalidation;
    if (!payload) return;
    const result = sendPayloadToTransport(current, payload);
    if (result.kind === "oversize") {
      dependencies.logger.error("[web-remote-control:server] bridge invalidation is oversized", {
        bridgeSessionId: payload.bridgeSessionId,
        bytes: result.bytes,
        maxBytes: result.maxBytes,
      });
    }
    // unavailable 时保持 latch；sent 后也保留，直到手机用新 bridge identity 发起 open。
  }

  function disposeRuntimeBridgeResources(current: DeviceRuntime): void {
    const bridge = current.currentBridge;
    if (!bridge) return;
    bridge.disposeBridge?.();
    bridge.disposeBridge = undefined;
    bridge.relayProtocol?.dispose();
    bridge.relayProtocol = undefined;
    current.currentBridge = undefined;
  }

  function cancelBridgeOpen(current: DeviceRuntime): void {
    current.bridgeOpen = undefined;
  }

  function endTerminalOwner(current: DeviceRuntime): void {
    const hadOwner = current.terminalOwner !== undefined;
    current.terminalOwner = undefined;
    // 旧客户端没有页面 owner，但确认断线仍必须结束 bridge，才能回收其独立终端 scope。
    // 结束 owner 先撤销在途 open，不能让晚到的 bridge 把已回收的资源再挂回。
    cancelBridgeOpen(current);
    const bridge = current.currentBridge;
    if (bridge) {
      current.pendingBridgeInvalidation = {
        zcode_type: "bridge-degraded",
        bridgeSessionId: bridge.bridgeSessionId,
        ...(bridge.bridgeGeneration === undefined
          ? {}
          : { bridgeGeneration: bridge.bridgeGeneration }),
        ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
        reason: "terminal-owner-ended",
      };
    }
    disposeRuntimeBridgeResources(current);
    if (hadOwner) {
      // desktop 在此回调 setTerminalOwner(windowId, null)（Electron IPC）；server 只保留进程内记录。
      dependencies.logger.info("[web-remote-control:server] terminal owner ended", {
        session: current.deviceSid,
      });
    }
    sendPendingBridgeInvalidation(current);
  }

  function ensureTerminalOwner(current: DeviceRuntime, clientSessionId?: string): void {
    if (!clientSessionId) {
      // 旧页面没有认领协议；bootstrap 是认领/读取，不是断线事件；
      // 旧客户端重复 bootstrap 不应销毁其活跃 bridge（desktop:634-639）。
      if (current.terminalOwner) endTerminalOwner(current);
      return;
    }
    if (current.terminalOwner?.clientSessionId === clientSessionId) return;
    endTerminalOwner(current);
    current.terminalOwner = { clientSessionId, id: randomUUID() };
  }

  function degradeBridgeAfterRawFault(
    current: DeviceRuntime,
    bridge: WorkspaceBridgeRuntime,
    reasonCode: string,
  ): void {
    if (current.currentBridge !== bridge || bridge.degraded) return;
    bridge.degraded = true;
    dependencies.logger.warn("[web-remote-control:server] raw relay bridge degraded", {
      session: current.deviceSid,
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      recoveryId: bridge.recoveryId,
      reasonCode,
    });
    current.pendingBridgeInvalidation = {
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: bridge.bridgeGeneration }),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      // Bugfix：checksum/oversize/future ACK 等 fault 不能伪装成 frame gap；
      // app control 只传通用恢复原因，typed reasonCode 留在上面的安全日志。
      reason: "rpc-transport-fault",
    };
    // degraded 后 raw 两端都已禁止继续转发，保留旧 attachment 只会泄漏 scoped subscription。
    disposeRuntimeBridgeResources(current);
    sendPendingBridgeInvalidation(current);
  }

  function routeRawTransportCandidate(current: DeviceRuntime, payload: unknown): boolean {
    const bridge = current.currentBridge;
    if (!bridge || bridge.degraded) return false;
    return bridge.relayProtocol?.acceptPayload(payload) ?? false;
  }

  /** 不认识的请求型 payload 回 app-error，让新手机连旧 server 时能立即降级而不是等超时。 */
  function respondToUnrecognizedPayload(current: DeviceRuntime, value: unknown): void {
    const request = resolveUnrecognizedWebRemoteControlRequest(value);
    if (!request) return;
    sendAppPayload(current, {
      zcode_type: "app-error",
      requestId: request.requestId,
      reason: "unsupported-action",
      error: `Server does not recognize app payload type: ${request.zcodeType}`,
    });
  }

  function buildBootstrapResult(current: DeviceRuntime): WebRemoteControlWindowBootstrapResult {
    return {
      windowControlSessionId: current.deviceSid,
      // schema 字段名与手机端契约保持一致（桌面 App 版本位）。
      desktopAppVersion: dependencies.appVersion,
      workspaces: dependencies.getWorkspaces(),
      ...(current.mobileViewState ? { mobileViewState: current.mobileViewState } : {}),
    };
  }

  function buildWorkspaceListResult(current: DeviceRuntime): WebRemoteControlWorkspaceListResult {
    const workspaces = dependencies.getWorkspaces();
    const bridge = current.currentBridge;
    const activeWorkspaceKey =
      current.mobileViewState?.activeWorkspaceKey ??
      bridge?.workspaceKey ??
      (workspaces[0] ? resolveWebRemoteControlWorkspaceKey(workspaces[0]) : "");
    return {
      workspaces,
      ...(activeWorkspaceKey ? { activeWorkspaceKey } : {}),
      ...(bridge?.initialTaskId || current.mobileViewState?.activeTaskId
        ? {
            activeTaskId:
              current.mobileViewState?.activeTaskId ?? bridge?.initialTaskId,
          }
        : {}),
    };
  }

  function toExternalBridge(
    bridge: WorkspaceBridgeRuntime,
  ): WebRemoteControlExternalWorkspaceBridge {
    return {
      ...(bridge.terminalOwnerId ? { terminalOwnerId: bridge.terminalOwnerId } : {}),
      bridgeSessionId: bridge.bridgeSessionId,
      ...(bridge.bridgeGeneration !== undefined
        ? { bridgeGeneration: bridge.bridgeGeneration }
        : {}),
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
      workspaceKey: bridge.workspaceKey,
      workspacePath: bridge.workspacePath,
      ...(bridge.initialTaskId ? { initialTaskId: bridge.initialTaskId } : {}),
      kind: "local",
    };
  }

  function createWorkspaceBridge(
    current: DeviceRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    // 只有 bootstrap 建立页面 owner；旧页面迟到的 open 不得重新认领已结束的会话（desktop:1128-1133）。
    if (
      request.terminalClientSessionId &&
      current.terminalOwner?.clientSessionId !== request.terminalClientSessionId
    ) {
      return Promise.reject(new Error("Terminal page session has ended; bootstrap is required."));
    }
    const intentKey = JSON.stringify([
      request.terminalClientSessionId,
      request.workspaceKey,
      request.taskId ?? null,
      request.project?.projectId,
      request.project?.hostId,
      request.project?.draftId,
      request.taskHostId,
      request.fileTreeTaskId,
    ]);
    const previous = current.bridgeOpen;
    if (
      previous?.bridgeSessionId === request.bridgeSessionId &&
      previous.bridgeGeneration === request.bridgeGeneration
    ) {
      if (previous.intentKey !== intentKey)
        return Promise.reject(new Error("Workspace bridge identity cannot change intent."));
      if (
        current.currentBridge?.degraded ||
        (current.pendingBridgeInvalidation?.bridgeSessionId === request.bridgeSessionId &&
          current.pendingBridgeInvalidation.bridgeGeneration === request.bridgeGeneration)
      )
        return Promise.reject(new Error("Degraded workspace bridge requires a new identity."));
      return previous.promise;
    }
    cancelBridgeOpen(current);
    const pending: NonNullable<DeviceRuntime["bridgeOpen"]> = {
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      intentKey,
      promise: undefined as never,
    };
    current.bridgeOpen = pending;
    pending.promise = buildWorkspaceBridge(current, request, pending);
    return pending.promise;
  }

  async function buildWorkspaceBridge(
    current: DeviceRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
    pending: NonNullable<DeviceRuntime["bridgeOpen"]>,
  ): Promise<WebRemoteControlExternalWorkspaceBridge> {
    // server-lite：项目/任务导航依赖桌面 Renderer（prepareProjectWorkspace），不迁。
    if (request.project || request.taskHostId || request.fileTreeTaskId) {
      throw new Error("Project navigation is unavailable on this server.");
    }
    const target = dependencies
      .getWorkspaces()
      .find(
        (workspace) => resolveWebRemoteControlWorkspaceKey(workspace) === request.workspaceKey,
      );
    if (runtime !== current || current.bridgeOpen !== pending)
      throw new Error("Workspace bridge request was superseded.");
    if (!target) {
      throw new Error("目标工作区不在当前 server 工作区列表中，无法创建 Web 远程控制 bridge。");
    }
    const targetWorkspaceKey = resolveWebRemoteControlWorkspaceKey(target);

    const invalidation = current.pendingBridgeInvalidation;
    if (
      invalidation?.bridgeSessionId === request.bridgeSessionId &&
      invalidation.bridgeGeneration === request.bridgeGeneration
    ) {
      throw new Error("Degraded workspace bridge must be rebuilt with a new transport identity.");
    }
    // 收到新 identity 的 open 已证明手机消费了 invalidation；后续失败由显式 bridge-error
    // 和 Web 侧有界 retry 收口，不再重复旧 generation 的 degraded 通知。
    current.pendingBridgeInvalidation = undefined;

    disposeRuntimeBridgeResources(current);
    current.status = "starting";
    emitStatus(getStatusOf(current));

    const bridgeRuntime: WorkspaceBridgeRuntime = {
      terminalOwnerId: request.terminalClientSessionId
        ? current.terminalOwner?.id
        : undefined,
      bridgeSessionId: request.bridgeSessionId,
      bridgeGeneration: request.bridgeGeneration,
      recoveryId: request.recoveryId,
      workspaceKey: targetWorkspaceKey,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      initialTaskId: request.taskId,
      readyAnnounced: false,
      degraded: false,
    };
    current.currentBridge = bridgeRuntime;

    dependencies.logger.info(
      `[web-remote-control:server] attaching workspace bridge session=${current.deviceSid} bridgeSession=${request.bridgeSessionId} workspace=${target.workspacePath}`,
    );

    try {
      // acknowledged relay protocol（desktop:1284-1299）。
      const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: bridgeRuntime.bridgeSessionId,
        bridgeGeneration: bridgeRuntime.bridgeGeneration,
        recoveryId: bridgeRuntime.recoveryId,
        measureFrameBytes: (frame) =>
          current.transport.measurePayloadBytes?.(frame) ??
          measureWebRemoteControlRpcRelayEnvelopeBytes(frame),
        sendFrame: (payload) => {
          if (!bridgeRuntime.readyAnnounced || bridgeRuntime.degraded) return false;
          const result = sendPayloadToTransport(current, payload);
          if (result.kind === "oversize") {
            throw new Error("remote.rpcFrame.envelopeTooLarge");
          }
          return result.kind === "sent";
        },
      });
      const disposeDegraded = relayProtocol.onDegraded((fault) => {
        degradeBridgeAfterRawFault(current, bridgeRuntime, fault.reasonCode);
      });
      const channelBridge = createWebRemoteControlChannelBridge({
        attachChannelServer: dependencies.attachChannelServer,
        relayProtocol,
        logger: dependencies.logger,
      });
      bridgeRuntime.relayProtocol = relayProtocol;
      bridgeRuntime.disposeBridge = () => {
        disposeDegraded.dispose();
        channelBridge.dispose();
      };
      current.status = current.transportState === "paired" ? "active" : "running";
      emitStatus(getStatusOf(current));

      dependencies.logger.info(
        `[web-remote-control:server] workspace bridge active session=${current.deviceSid} bridgeSession=${request.bridgeSessionId}`,
      );
      return toExternalBridge(bridgeRuntime);
    } catch (error) {
      if (runtime === current) {
        disposeRuntimeBridgeResources(current);
        current.status = "running";
        emitStatus(getStatusOf(current));
      }
      throw error;
    }
  }

  async function respondToWorkspaceBridgeOpen(
    current: DeviceRuntime,
    request: WebRemoteControlWorkspaceBridgeOpenPayload,
  ): Promise<void> {
    try {
      const bridge = await createWorkspaceBridge(current, request);
      sendAppPayload(current, {
        zcode_type: "workspace-bridge-ready",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        bridge,
      });
      const currentBridge = current.currentBridge;
      if (
        currentBridge?.bridgeSessionId === request.bridgeSessionId &&
        currentBridge.bridgeGeneration === request.bridgeGeneration
      ) {
        // bridge-ready 必须先进入 ordinary app transport，才允许 queued raw frames 开闸。
        currentBridge.readyAnnounced = true;
        currentBridge.relayProtocol?.flushPendingFrames();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dependencies.logger.warn(
        `[web-remote-control:server] workspace bridge failed session=${current.deviceSid} workspaceKey=${request.workspaceKey} error=${message}`,
      );
      sendAppPayload(current, {
        zcode_type: "workspace-bridge-error",
        requestId: request.requestId,
        bridgeSessionId: request.bridgeSessionId,
        ...(request.bridgeGeneration !== undefined
          ? { bridgeGeneration: request.bridgeGeneration }
          : {}),
        ...(request.recoveryId ? { recoveryId: request.recoveryId } : {}),
        reason: "unexpected-error",
        error: message,
      });
    }
  }

  function preserveRuntimeFailure(
    current: DeviceRuntime,
    reason: string,
    failure: WebRemoteControlFailure,
  ): void {
    // 与 desktop preserveWindowRuntimeFailure（872-904）一致：同因失败不重复拆运行时。
    if (current.status === "error" && current.failure?.reason === failure.reason) return;
    sendAppPayload(current, {
      zcode_type: "app-error",
      reason: failure.reason,
      error: failure.message ?? failure.reason,
    });
    endTerminalOwner(current);
    cancelBridgeOpen(current);
    disposeRuntimeBridgeResources(current);
    clearPendingOutboundPayloadTimer(current);
    current.pendingOutboundPayloads.length = 0;
    current.transport.dispose();
    current.status = "error";
    current.failure = failure;
    emitStatus({
      status: "error",
      sessionId: current.deviceSid,
      deviceMid: current.deviceMid,
      ...(current.qrUrl ? { qrUrl: current.qrUrl } : {}),
      failure,
    });
    dependencies.logger.warn(
      `[web-remote-control:server] runtime closed session=${current.deviceSid} reason=${reason} failure=${failure.reason}`,
    );
  }

  /** desktop requireAuthentication（937-942）：停运行时 + auth-required 门禁，不注册不建连。 */
  async function requireAuthentication(reason: string): Promise<void> {
    await stopRuntime(reason);
    authRequired = true;
    emitStatus({ status: "auth-required" });
  }

  async function stopRuntime(reason: string): Promise<void> {
    const current = runtime;
    if (!current) return;
    runtime = undefined;
    if (current.status !== "error") {
      sendAppPayload(current, {
        zcode_type: "app-error",
        reason: "desktop-disconnected",
        error: "Server closed this Web remote control session.",
      });
    }
    endTerminalOwner(current);
    cancelBridgeOpen(current);
    disposeRuntimeBridgeResources(current);
    clearPendingOutboundPayloadTimer(current);
    current.pendingOutboundPayloads.length = 0;
    current.transport.dispose();
    dependencies.logger.info(
      `[web-remote-control:server] stopped session=${current.deviceSid} reason=${reason}`,
    );
  }

  function routePayload(current: DeviceRuntime, payload: WebRemoteControlAppPayload): void {
    switch (payload.zcode_type) {
      case "bootstrap-request":
        ensureTerminalOwner(current, payload.terminalClientSessionId);
        sendAppPayload(current, {
          zcode_type: "bootstrap-response",
          requestId: payload.requestId,
          success: true,
          result: buildBootstrapResult(current),
        });
        break;
      case "workspace-list-request":
        sendAppPayload(current, {
          zcode_type: "workspace-list-response",
          requestId: payload.requestId,
          success: true,
          result: buildWorkspaceListResult(current),
        });
        break;
      case "platform-request": {
        // server-lite 无 Renderer 平台方法：枚举/MCP 读按方法表回空结果，
        // 写操作回 unsupported-action 失败（desktop 走 dependencies.platformHandlers）。
        const emptyResult = SERVER_PLATFORM_EMPTY_RESULTS[payload.method];
        if (emptyResult !== undefined) {
          sendAppPayload(current, {
            zcode_type: "platform-response",
            requestId: payload.requestId,
            method: payload.method,
            success: true,
            result: emptyResult,
          } as WebRemoteControlPlatformResponsePayload);
        } else {
          sendAppPayload(current, {
            zcode_type: "platform-response",
            requestId: payload.requestId,
            method: payload.method,
            success: false,
            error: `unsupported-action: ${payload.method} requires a desktop host; unavailable on this server.`,
          });
        }
        break;
      }
      case "mobile-view-state-update":
        current.mobileViewState = payload.viewState;
        if (payload.deviceInfo) current.mobileDeviceInfo = payload.deviceInfo;
        break;
      case "workspace-bridge-open":
        void respondToWorkspaceBridgeOpen(current, payload);
        break;
      case "workspace-reconnect-request":
        sendAppPayload(current, {
          zcode_type: "workspace-reconnect-response",
          requestId: payload.requestId,
          workspaceKey: payload.workspaceKey,
          success: false,
          error: "Workspace reconnect is unavailable on this server.",
        });
        break;
      case "rpc-frame":
      case "rpc-frame-ack":
        routeRawTransportCandidate(current, payload);
        break;
      case "telemetry-report":
        // 手机已在创建边界构造事件；server 被控端只记录计数，不再转发（桌面遥测链路不迁）。
        dependencies.logger.info("[web-remote-control:server] mobile telemetry event received");
        break;
      case "mobile-diagnostic":
        dependencies.logger.info("[web-remote-control:server] mobile diagnostic", {
          event: payload.event,
          state: payload.state,
          pairStatus: payload.pairStatus,
          closeCode: payload.closeCode,
        });
        break;
      case "task-pin-request":
      case "task-archive-request":
      case "workspace-create-request":
        // 依赖 Renderer（BrowserWindow IPC）的动作在 server 上不支持；
        // 回 unsupported-action 让新手机立即降级（desktop 走 runRendererAction）。
        sendAppPayload(current, {
          zcode_type: "app-error",
          requestId: payload.requestId,
          reason: "unsupported-action",
          error: `Server does not support app payload type: ${payload.zcode_type}`,
        });
        break;
      case "mobile-log":
        // 手机日志通道（落盘/拉取）为桌面特有，server 只记录丢弃。
        dependencies.logger.info("[web-remote-control:server] dropped mobile log payload", {
          sessionId: payload.sessionId,
        });
        break;
      case "mobile-log-pull-response":
        dependencies.logger.info("[web-remote-control:server] dropped stale mobile log pull response", {
          requestId: payload.requestId,
        });
        break;
      case "app-error":
        dependencies.logger.warn("[web-remote-control:server] mobile app error", {
          reason: payload.reason,
          error: payload.error,
        });
        break;
      case "mobile-task-view-update":
        // 任务视图快照依赖桌面任务 owner 语义，server-lite 不维护；静默丢弃。
        break;
      default:
        respondToUnrecognizedPayload(current, payload);
        break;
    }
  }

  function getStatusOf(current: DeviceRuntime): WebRemoteControlDeviceStatus {
    return {
      status: current.status,
      sessionId: current.deviceSid || undefined,
      deviceMid: current.deviceMid,
      ...(current.qrUrl ? { qrUrl: current.qrUrl } : {}),
      ...(current.failure ? { failure: current.failure } : {}),
    };
  }

  function mapTransportState(
    current: DeviceRuntime,
    state: WebRemoteControlDeviceTransportState,
  ): void {
    const previous = current.transportState;
    current.transportState = state;
    if (state === "waiting_terminal" || state === "paired") {
      current.status = state === "paired" ? "active" : "running";
      emitStatus(getStatusOf(current));
    }
    if (state === "paired") {
      if (previous !== "paired") {
        // Bugfix: 普通断线重连重新 paired 时 transport 不一定触发 onSendReady。
        // 状态恢复可发送后主动 flush，避免重连窗口内缓冲的响应/RPC 帧超时丢弃。
        flushPendingOutboundPayloads(current);
      }
      sendPendingBridgeInvalidation(current);
      return;
    }
    if (state === "kicked") {
      preserveRuntimeFailure(
        current,
        "external-relay-kicked",
        createFailure("session-conflict", "Web remote control connection was kicked by relay."),
      );
      return;
    }
    if (state === "error") {
      current.status = "error";
      emitStatus(getStatusOf(current));
    }
  }

  function createQrUrl(deviceSid: string): string {
    return buildWebRemoteControlExternalQrUrl({
      baseUrl: dependencies.remoteControlUrl,
      deviceSid,
      deviceMid: dependencies.deviceMid,
      deviceName: dependencies.deviceName,
      appVersion: dependencies.appVersion,
    });
  }

  async function start(): Promise<WebRemoteControlDeviceStatus> {
    await stopRuntime("restart");
    authRequired = false;
    // auth 门禁（spec：无 JWT → auth-required，不注册、不建连）。
    const login = await dependencies.getLogin();
    if (!login?.jwt || !login.userId) {
      await requireAuthentication("auth-required");
      dependencies.logger.warn(
        "[web-remote-control:server] no login credential; device relay not started",
      );
      return { status: "auth-required" };
    }
    const loginUserId = login.userId;
    const currentLogin = async () => {
      const current = await dependencies.getLogin();
      if (!current?.jwt || current.userId !== loginUserId) {
        throw new WebRemoteControlV2ConnectionError("auth-required");
      }
      return current;
    };
    const transport = createTransport({
      relayWsUrl: dependencies.relayWsUrl,
      deviceMid: dependencies.deviceMid,
      meta: {
        platform: dependencies.platform ?? "server",
        version: dependencies.appVersion,
        name: dependencies.deviceName,
      },
      getToken: async (transportSignal) => {
        const current = await currentLogin();
        const token = await retryIfJwtReplaced(currentLogin, current, () =>
          http.token(current.jwt, transportSignal),
        );
        await currentLogin();
        dependencies.logger.info("[web-remote-control:server] V2 device token acquired");
        return token;
      },
      resolveDeviceSid: async (transportSignal, forceRegistration) => {
        const deviceSid = await dependencies.deviceIdentity.resolveDeviceSid(
          transportSignal,
          forceRegistration,
        );
        if (runtime) {
          runtime.deviceSid = deviceSid;
          runtime.qrUrl = "";
        }
        return deviceSid;
      },
      logger: dependencies.logger,
      onStateChange: (state) => {
        if (runtime !== current) return;
        if (state === "waiting_terminal" || state === "paired") {
          current.qrUrl = createQrUrl(current.deviceSid);
          if (state === "waiting_terminal") {
            dependencies.logger.info(
              `[web-remote-control:server] waiting for terminal; pair url: ${current.qrUrl}`,
            );
          }
        }
        mapTransportState(current, state);
      },
      onPayload: (payload) => {
        if (runtime === current) routePayload(current, payload);
      },
      onUnrecognizedPayload: (value) => {
        if (runtime === current) respondToUnrecognizedPayload(current, value);
      },
      onRawTransportPayload: (payload) =>
        runtime === current ? routeRawTransportCandidate(current, payload) : false,
      onRawTransportFault: (reasonCode) => {
        if (runtime !== current) return;
        current.currentBridge?.relayProtocol?.markDegraded(reasonCode);
      },
      onSendReady: () => {
        if (runtime !== current) return;
        flushPendingOutboundPayloads(current);
        // 后台可能丢弃首次失效通知；沿已有心跳重送直到新 bridge identity 接管。
        // Web 按 bridge 幂等消费，重复通知不会重置恢复或退避预算。
        sendPendingBridgeInvalidation(current);
        const relayProtocol = current.currentBridge?.relayProtocol;
        // 同 bridge 未 ACK 批次仍由 adapter 独占；重连后重放，不刷新 queued age。
        if (relayProtocol && !relayProtocol.isDegraded()) relayProtocol.replayUnacknowledged();
      },
      onError: (error) => {
        if (runtime !== current) return;
        const failure = createFailure(
          error instanceof WebRemoteControlV2ConnectionError
            ? error.reason
            : "relay-unavailable",
          error.message,
        );
        if (failure.reason === "auth-required") void requireAuthentication("v2-auth-failed");
        else preserveRuntimeFailure(current, "v2-auth-failed", failure);
      },
    });
    const current: DeviceRuntime = {
      status: "starting",
      deviceSid: "",
      deviceMid: dependencies.deviceMid,
      qrUrl: "",
      transport,
      pendingOutboundPayloads: [],
    };
    runtime = current;
    emitStatus(getStatusOf(current));
    transport.start();
    return getStatusOf(current);
  }

  function getStatus(): WebRemoteControlDeviceStatus {
    if (authRequired) return { status: "auth-required" };
    const current = runtime;
    if (!current) return { status: "idle" };
    return getStatusOf(current);
  }

  return {
    start,
    async stop(reason) {
      authRequired = false;
      await stopRuntime(reason);
      emitStatus({ status: "idle" });
    },
    getStatus,
    async dispose() {
      await stopRuntime("dispose");
    },
  };
}
