import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile } from "@zcode/shared/node";
import { WebRemoteControlV2ConnectionError } from "@zcode/shared/web-remote-relay";
import type { WebRemoteControlRegisteredDevice, WebRemoteControlDeviceStorage, WebRemoteControlLogin } from "./contract.js";
import { createWebRemoteControlV2Http } from "./webRemoteControlV2Http.js";

/**
 * server 被控端的设备身份持久化与注册编排。
 *
 * - 存储：desktop 用 AppSettings.patchSettings（webRemoteControlDeviceStorage.ts:5-25）；
 *   server 无 AppSettings，落到 getAppConfigDir() 下自有 JSON 文件（仅非敏感身份）。
 * - 注册串行化 / 旧 SID 清理 / 保存失败回滚，迁自 desktop manager 的
 *   resolveRegistration（webRemoteControlManager.ts:409-462）与 retryIfJwtReplaced（394-408）。
 */

export const WEB_REMOTE_CONTROL_DEVICE_IDENTITY_FILE_NAME = "web-remote-control-device.json";

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function isValidRegisteredDevice(value: unknown): value is WebRemoteControlRegisteredDevice {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.deviceSid === "string" &&
    record.deviceSid.length > 0 &&
    typeof record.userId === "string" &&
    record.userId.length > 0 &&
    typeof record.endpointOrigin === "string" &&
    record.endpointOrigin.length > 0
  );
}

export function createWebRemoteControlDeviceFileStorage(dependencies: {
  configDir: string;
  fileName?: string;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): WebRemoteControlDeviceStorage {
  const filePath = join(dependencies.configDir, dependencies.fileName ?? WEB_REMOTE_CONTROL_DEVICE_IDENTITY_FILE_NAME);
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return undefined;
        throw error;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        // 损坏文件保留证据后按缺失处理：下次注册会生成新 SID，不会覆盖其他配置。
        const backupPath = await backupCorruptFile(filePath).catch(() => undefined);
        dependencies.logger.warn("[web-remote-control:server] device identity file corrupt", {
          filePath,
          backupPath,
        });
        return undefined;
      }
      if (!isValidRegisteredDevice(value)) return undefined;
      return value;
    },
    async save(device) {
      await atomicWritePrivateTextFile(filePath, `${JSON.stringify(device, null, 2)}\n`);
    },
  };
}

/**
 * Bugfix 语义保留（manager:388-408）：401 只否定发起请求时用的 JWT。
 * 同账号 JWT 刚被刷新时旧请求的 401 转为可重试；账号/endpoint 变化仍保留 auth-required。
 */
export function retryIfJwtReplaced<T>(
  currentLogin: () => Promise<WebRemoteControlLogin>,
  used: WebRemoteControlLogin,
  request: () => Promise<T>,
): Promise<T> {
  return request().catch(async (error: unknown) => {
    if (!(error instanceof WebRemoteControlV2ConnectionError) || error.reason !== "auth-required")
      throw error;
    if ((await currentLogin()).jwt !== used.jwt)
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", true);
    throw error;
  });
}

export interface WebRemoteControlDeviceIdentityDependencies {
  endpointOrigin: string;
  deviceMid: string;
  getLogin(): Promise<WebRemoteControlLogin>;
  storage: WebRemoteControlDeviceStorage;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export interface WebRemoteControlDeviceIdentity {
  /** transport 的 resolveDeviceSid 注入点：串行注册 + 旧 SID 清理（manager:409-462）。 */
  resolveDeviceSid(signal: AbortSignal, force: boolean): Promise<string>;
}

export function createWebRemoteControlDeviceIdentity(
  dependencies: WebRemoteControlDeviceIdentityDependencies,
): WebRemoteControlDeviceIdentity {
  const http = createWebRemoteControlV2Http(dependencies.endpointOrigin);
  // 同一 manager 串行读取/更新身份，避免并发连接尝试各自覆盖持久化 SID。
  let registrationQueue: Promise<unknown> = Promise.resolve();
  const currentLogin = async () => {
    const current = await dependencies.getLogin();
    if (!current?.jwt || !current.userId)
      throw new WebRemoteControlV2ConnectionError("auth-required");
    return current;
  };
  return {
    resolveDeviceSid(signal, force) {
      const operation = registrationQueue.then(async () => {
        const current = await currentLogin();
        const stored = await dependencies.storage.load();
        signal.throwIfAborted();
        if (!force && stored?.userId === current.userId && stored.endpointOrigin === dependencies.endpointOrigin)
          return stored.deviceSid;
        if (stored?.endpointOrigin === dependencies.endpointOrigin) {
          try {
            await http.delete(stored.deviceSid, current.jwt, signal);
          } catch {
            dependencies.logger.warn("[web-remote-control:server] V2 old device cleanup failed");
          }
        }
        signal.throwIfAborted();
        const deviceSid = await retryIfJwtReplaced(currentLogin, current, () =>
          http.register(dependencies.deviceMid, current.jwt, signal),
        );
        await currentLogin();
        signal.throwIfAborted();
        try {
          await dependencies.storage.save({
            deviceSid,
            userId: current.userId,
            endpointOrigin: dependencies.endpointOrigin,
          });
        } catch (error) {
          // 保存失败不是网络故障；裸错误会让 transport 每次退避都注册新 SID，留下孤儿设备。
          // 新 SID 尚未建连，先尽力撤销远端注册，再以不可重试错误结束本次启动。
          dependencies.logger.error(
            "[web-remote-control:server] V2 device identity persistence failed",
            error,
          );
          try {
            await http.delete(deviceSid, current.jwt, signal);
          } catch {
            dependencies.logger.warn("[web-remote-control:server] V2 new device cleanup failed");
          }
          throw new WebRemoteControlV2ConnectionError("relay-unavailable");
        }
        signal.throwIfAborted();
        dependencies.logger.info("[web-remote-control:server] V2 device registered");
        return deviceSid;
      });
      registrationQueue = operation.catch(() => {});
      return operation;
    },
  };
}
