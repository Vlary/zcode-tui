import { basename } from "node:path";
import { getAppConfigDir, ensureTelemetryDeviceMid } from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";
import type { SourceServerWorkspaceIdentityMapper } from "@zcode/services/node";
import {
  ZCODE_VERSION,
  resolveRuntimeZCodeEndpointOrigin,
  resolveWebRemoteControlRelayWsUrl,
  type WebRemoteControlWorkspaceTarget,
} from "@zcode/shared";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import {
  setupChannelServerOverSocket,
  type WebRemoteControlPairingInfo,
  type WebRemoteControlPairingStatusKind,
} from "../http.js";
import {
  createWebRemoteControlDeviceFileStorage,
  createWebRemoteControlDeviceIdentity,
} from "./webRemoteControlDeviceIdentity.js";
import {
  createWebRemoteControlDeviceManager,
  type WebRemoteControlDeviceStatus,
} from "./webRemoteControlDeviceManager.js";
import {
  createWebRemoteControlServerLogin,
  WEB_REMOTE_CONTROL_JWT_ENV,
} from "./webRemoteControlLogin.js";
import type { WebRemoteControlLogin } from "./contract.js";

/**
 * Web 远程控制被控端（device relay）装配入口。
 *
 * env 覆盖入口（server 自带读取；desktop 侧读取方不在本仓库，不能参照）：
 * - ZCODE_WEB_REMOTE_CONTROL=1|true —— 总开关；未设置时不注册不建连。
 * - ZCODE_WEB_REMOTE_CONTROL_URL —— 端点 origin 覆盖（默认走 shared
 *   resolveRuntimeZCodeEndpointOrigin → buildRuntimeZCodeEndpointUrls 的推导链，
 *   见 zcodeEndpoint.ts:205-250）。
 * - ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL —— relay WS 完整覆盖，作为 overrideUrl 传
 *   resolveWebRemoteControlRelayWsUrl。
 * - ZCODE_WEB_REMOTE_CONTROL_JWT —— 凭据 store 读不到时的 JWT 回退。
 */

export const WEB_REMOTE_CONTROL_ENABLED_ENV = "ZCODE_WEB_REMOTE_CONTROL";
export const WEB_REMOTE_CONTROL_URL_ENV = "ZCODE_WEB_REMOTE_CONTROL_URL";
export const WEB_REMOTE_CONTROL_RELAY_WS_URL_ENV = "ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL";

export function isWebRemoteControlEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env[WEB_REMOTE_CONTROL_ENABLED_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export interface WebRemoteControlServerConfig {
  endpointOrigin: string;
  relayWsUrl: string;
  /** 配对二维码 base（endpoint 的 /remote/v4 页面）。 */
  remoteControlUrl: string;
}

export function resolveWebRemoteControlServerConfig(
  env: NodeJS.ProcessEnv,
): WebRemoteControlServerConfig {
  const endpointOverride = env[WEB_REMOTE_CONTROL_URL_ENV]?.trim();
  // overrideOrigin 只在非 production 生效（shared zcodeEndpoint.ts:185-196），显式覆盖
  // 必须始终优先：改用 envBaseOrigin（ZCODE_BASE_URL）注入，它在两种 env 下都最高优先。
  const endpointOrigin = resolveRuntimeZCodeEndpointOrigin(
    endpointOverride ? { ...env, ZCODE_BASE_URL: endpointOverride } : env,
  );
  const origin = new URL(endpointOrigin).origin;
  const relayWsUrl = resolveWebRemoteControlRelayWsUrl({
    endpointOrigin: origin,
    overrideUrl: env[WEB_REMOTE_CONTROL_RELAY_WS_URL_ENV],
  });
  return { endpointOrigin: origin, relayWsUrl, remoteControlUrl: `${origin}/remote/v4` };
}

/** server 工作区（与 http.ts resolveServerWorkspaces 同一推导：env 或 cwd）。 */
export function resolveWebRemoteControlWorkspaces(
  env: NodeJS.ProcessEnv,
): WebRemoteControlWorkspaceTarget[] {
  const workspacePath = env["ZCODE_SERVER_WORKSPACE"]?.trim() || process.cwd();
  return [
    {
      workspacePath,
      label: basename(workspacePath) || workspacePath,
      kind: "local",
    },
  ];
}

export interface StartWebRemoteControlDeviceRelayOptions {
  services: ServiceCollection;
  workspaceIdentityMapper?: SourceServerWorkspaceIdentityMapper;
  env?: NodeJS.ProcessEnv;
  logger?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 单测注入；缺省从共享 credential store + env 回退读取。 */
  getLogin?(): Promise<WebRemoteControlLogin | undefined>;
  deviceMid?: string;
  configDir?: string;
}

export interface WebRemoteControlDeviceRelayHandle {
  status: "started" | "auth-required";
  config: WebRemoteControlServerConfig;
  deviceMid: string;
  /** 配对二维码与 relay 注册使用的设备名（zcode-server@<cwd basename>）。 */
  deviceName: string;
  /** 被控端实时状态（manager.getStatus 的透传）；配对路由每次请求调用。 */
  getStatus(): WebRemoteControlDeviceStatus;
  stop(reason: string): Promise<void>;
}

/**
 * manager 实时状态 → GET /api/web-remote-control/pairing 契约映射：
 * - idle → off：relay handle 已装配但运行时未起/已停，与未启用同形（enabled=false）。
 * - starting/running → waiting-terminal：running 即 transport waiting_terminal（已连
 *   relay 等手机）；starting 阶段 qrUrl 尚未生成（manager 初始空串，getStatusOf 省略），
 *   前端以字段缺失渲染 loading。
 * - active → paired；auth-required/error → error。
 * enabled 仅在 idle 与 auth 门禁（启动即无凭据 / JWT 被替换）时为 false：auth-required
 * 映射 enabled=false + status="error"（远控已按 env 尝试启用，与「未启用 off」区分，
 * 与 /api/server-info 的 enabled=relay.status==="started" 语义一致）。
 */
export function toWebRemoteControlPairingInfo(
  handle: WebRemoteControlDeviceRelayHandle,
): WebRemoteControlPairingInfo {
  const device = handle.getStatus();
  let pairingStatus: WebRemoteControlPairingStatusKind;
  let enabled: boolean;
  switch (device.status) {
    case "active":
      pairingStatus = "paired";
      enabled = true;
      break;
    case "starting":
    case "running":
      pairingStatus = "waiting-terminal";
      enabled = true;
      break;
    case "error":
      pairingStatus = "error";
      enabled = true;
      break;
    case "auth-required":
      pairingStatus = "error";
      enabled = false;
      break;
    case "idle":
    default:
      pairingStatus = "off";
      enabled = false;
      break;
  }
  return {
    enabled,
    status: pairingStatus,
    ...(device.qrUrl ? { qrUrl: device.qrUrl } : {}),
    deviceName: handle.deviceName,
    relayWsUrl: handle.config.relayWsUrl,
  };
}

const fallbackLogger = {
  // 模块内日志消息已带 [web-remote-control:server] 前缀，这里不再重复包装。
  info: (...args: unknown[]) => console.log(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export async function startWebRemoteControlDeviceRelay(
  options: StartWebRemoteControlDeviceRelayOptions,
): Promise<WebRemoteControlDeviceRelayHandle> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? fallbackLogger;
  const config = resolveWebRemoteControlServerConfig(env);
  const deviceMid =
    options.deviceMid ??
    (await ensureTelemetryDeviceMid().catch((error: unknown) => {
      logger.warn(
        "deviceMid 初始化失败，使用进程占位:",
        error instanceof Error ? error.message : String(error),
      );
      return `server-${process.pid}`;
    }));
  const loginProvider = options.getLogin
    ? { getLogin: options.getLogin }
    : createWebRemoteControlServerLogin({ env, logger });
  const requireLogin = async (): Promise<WebRemoteControlLogin> => {
    const login = await loginProvider.getLogin();
    if (!login?.jwt || !login.userId)
      throw new WebRemoteControlV2ConnectionError("auth-required");
    return login;
  };
  const storage = createWebRemoteControlDeviceFileStorage({
    configDir: options.configDir ?? getAppConfigDir(),
    logger,
  });
  const deviceIdentity = createWebRemoteControlDeviceIdentity({
    endpointOrigin: config.endpointOrigin,
    deviceMid,
    getLogin: requireLogin,
    storage,
    logger,
  });
  const deviceName = `zcode-server@${basename(process.cwd()) || "server"}`;
  const manager = createWebRemoteControlDeviceManager({
    endpointOrigin: config.endpointOrigin,
    relayWsUrl: config.relayWsUrl,
    remoteControlUrl: config.remoteControlUrl,
    deviceMid,
    deviceName,
    appVersion: ZCODE_VERSION,
    platform: process.platform,
    getLogin: () => loginProvider.getLogin(),
    deviceIdentity,
    getWorkspaces: () => resolveWebRemoteControlWorkspaces(env),
    attachChannelServer: (socket) => {
      setupChannelServerOverSocket(
        socket,
        options.services,
        "web-remote-replayable",
        options.workspaceIdentityMapper,
      );
    },
    logger,
  });
  const status = await manager.start();
  return {
    status: status.status === "auth-required" ? "auth-required" : "started",
    config,
    deviceMid,
    deviceName,
    getStatus: () => manager.getStatus(),
    stop: (reason) => manager.stop(reason),
  };
}

export { WEB_REMOTE_CONTROL_JWT_ENV };
