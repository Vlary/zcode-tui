import { once } from "node:events";
import { WebSocket } from "ws";
import {
  createFakeRelayV2,
  type FakeRelayV2Message,
  type FakeRelayV2Options,
  type FakeRelayV2Target,
  type FakeRelayV2ErrorCode,
} from "@zcode/shared/testing/fake-relay-v2";
import {
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
} from "@zcode/shared/web-remote-relay";

/**
 * server 被控端 e2e 测试的 fake relay 夹具。
 * 参照 desktop 先例 test/e2e/helpers/web-remote-control-session-events-fixture.ts:26-74，
 * 只替换外部 relay；设备侧走真实 transport，terminal 侧用最小 ws 客户端。
 */

export async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export type FakeRelay = Awaited<ReturnType<typeof createFakeRelayV2>>;

export async function startFakeRelay(options: FakeRelayV2Options): Promise<FakeRelay> {
  return createFakeRelayV2(options);
}

export function deviceMessages(relay: FakeRelay): FakeRelayV2Message[] {
  return relay.messages.filter((record) => record.role === "device");
}

export function deviceAuthInits(relay: FakeRelay): FakeRelayV2Message[] {
  return deviceMessages(relay).filter(
    (record) =>
      typeof record.message === "object" &&
      record.message !== null &&
      (record.message as { type?: string }).type === "auth_init",
  );
}

export function devicePairStatusQueries(relay: FakeRelay): FakeRelayV2Message[] {
  return deviceMessages(relay).filter(
    (record) =>
      typeof record.message === "object" &&
      record.message !== null &&
      (record.message as { type?: string }).type === "pair_status_query",
  );
}

export interface TerminalRelayHandle {
  socket: WebSocket;
  /** relay 下发的 data payload（手机侧视角的 app payload）。 */
  incoming: unknown[];
  sendPayload(payload: unknown): void;
  waitForPayload<T>(predicate: (payload: unknown) => payload is T, timeoutMs: number, what: string): Promise<T>;
  close(): Promise<void>;
}

export async function connectTerminal(options: {
  relay: FakeRelay;
  jwt: string;
  deviceSid: string;
  terminalMid?: string;
}): Promise<TerminalRelayHandle> {
  const { relay, jwt, deviceSid } = options;
  const tokenResponse = await fetch(new URL("/api/v1/remote/token", relay.httpUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "terminal" }),
  });
  const tokenBody = (await tokenResponse.json()) as {
    code: number;
    data?: { token: string; expires_in: number };
  };
  if (tokenBody.code !== 0 || !tokenBody.data) {
    throw new Error(`terminal token request failed: code=${tokenBody.code}`);
  }
  const url = new URL(relay.wsUrl);
  url.searchParams.set("token", tokenBody.data.token);
  url.searchParams.set("mid", options.terminalMid ?? "terminal-e2e");
  const socket = new WebSocket(url);
  await once(socket, "open");
  const incoming: unknown[] = [];
  const listeners: Array<(payload: unknown) => void> = [];
  socket.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let value: unknown;
    try {
      value = JSON.parse(String(raw));
    } catch {
      return;
    }
    const message: WebRemoteControlRelayV2IncomingMessage | null =
      parseWebRemoteControlRelayV2IncomingMessage(value);
    if (message?.type === "data") {
      incoming.push(message.payload);
      // 快照遍历：listener 可能自行注销。
      for (const listener of listeners.slice()) listener(message.payload);
    }
  });
  socket.send(
    JSON.stringify({
      type: "auth_init",
      device_sid: deviceSid,
      client_ts: Math.floor(Date.now() / 1000),
    }),
  );
  return {
    socket,
    incoming,
    sendPayload(payload) {
      socket.send(JSON.stringify({ type: "data", payload }));
    },
    waitForPayload(predicate, timeoutMs, what) {
      const existing = incoming.find((payload) => predicate(payload));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const late = incoming.find((payload) => predicate(payload));
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
          if (late !== undefined) resolve(late);
          else reject(new Error(`timeout waiting for terminal payload ${what}`));
        }, timeoutMs);
        const listener = (payload: unknown) => {
          if (!predicate(payload)) return;
          clearTimeout(timer);
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
          resolve(payload);
        };
        listeners.push(listener);
      });
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        const closed = once(socket, "close");
        socket.close();
        await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2000))]);
      }
    },
  };
}

export type { FakeRelayV2Target, FakeRelayV2ErrorCode };
