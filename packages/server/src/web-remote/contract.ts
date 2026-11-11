import type { WebRemoteControlAppPayload } from "@zcode/shared";
import type { WebRemoteControlRelayV2Meta } from "@zcode/shared/web-remote-relay";

/**
 * server 侧 Web 远程控制（被控端）契约。
 *
 * 移植自 packages/desktop/src/main/web-remote-relay/contract.ts：
 * - `WebRemoteControlRegisteredDevice` 与 desktop AppSettings 的
 *   `webRemoteControlRelayV2Device` 同构（{deviceSid, userId, endpointOrigin}），
 *   server 不依赖 AppSettings，身份落在 getAppConfigDir() 下自有文件。
 * - wire 语义（心跳 5s±1s、ACK watchdog 15s、退避 1s→30s、KICKED 60s 冷却）全部
 *   由 @zcode/shared/web-remote-relay 的共享实现承载，本目录不再复制时序常量。
 */

export interface WebRemoteControlRegisteredDevice {
  deviceSid: string;
  userId: string;
  endpointOrigin: string;
}

export interface WebRemoteControlDeviceStorage {
  load(): Promise<WebRemoteControlRegisteredDevice | undefined>;
  save(device: WebRemoteControlRegisteredDevice): Promise<void>;
}

export interface WebRemoteControlLogin {
  userId: string;
  jwt: string;
}

export type WebRemoteControlDeviceTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "kicked"
  | "error";

export interface WebRemoteControlDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  meta: WebRemoteControlRelayV2Meta;
  getToken(signal: AbortSignal): Promise<string>;
  resolveDeviceSid(signal: AbortSignal, forceRegistration: boolean): Promise<string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onStateChange(state: WebRemoteControlDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  /** schema 不认识的 payload；由上层决定是否回 unsupported-action，transport 不理解业务语义。 */
  onUnrecognizedPayload?(payload: unknown): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
}
