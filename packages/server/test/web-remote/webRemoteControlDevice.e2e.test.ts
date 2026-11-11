import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelClient, ChannelServer, SocketProtocol, type IServerChannel, type ISocket } from "@zcode/rpc";
import { createAcknowledgedWebRemoteControlRelayProtocol } from "@zcode/client";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import {
  createWebRemoteControlDeviceFileStorage,
  createWebRemoteControlDeviceIdentity,
} from "../../src/web-remote/webRemoteControlDeviceIdentity.js";
import { createWebRemoteControlDeviceManager } from "../../src/web-remote/webRemoteControlDeviceManager.js";
import { resolveWebRemoteControlServerConfig } from "../../src/web-remote/index.js";
import {
  connectTerminal,
  deviceAuthInits,
  devicePairStatusQueries,
  startFakeRelay,
  waitFor,
  type FakeRelay,
  type TerminalRelayHandle,
} from "./helpers/fake-relay-fixture.js";

/**
 * server 被控端 e2e：真实 device transport + fake-relay-v2（loopback HTTP/WS）。
 * 断言链：register → token(role=device) → ws2?token&mid → auth_init →
 * 5s±1s pair_status_query → terminal matched → rpc-frame 经 acknowledged 桥打到 ChannelServer。
 */

const JWT = "device-e2e-jwt";
const USER_ID = "device-e2e-user";
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_JITTER_MS = 1_000;

interface TestContext {
  relay: FakeRelay;
  configDir: string;
  workspacePath: string;
  manager: ReturnType<typeof createTestManager> | undefined;
  terminal: TerminalRelayHandle | undefined;
}

function createTestChannelServer(socket: ISocket): { dispose(): void } {
  const protocol = new SocketProtocol(socket);
  const server = new ChannelServer(protocol, "server");
  const echoChannel: IServerChannel = {
    call: async (_ctx, command, arg) => {
      if (command !== "echo") throw new Error(`unknown command: ${command}`);
      return { echoed: arg, at: "channel-server" };
    },
    listen: () => () => ({ dispose() {} }),
  };
  server.registerChannel("webRemoteControlTest.echo", echoChannel);
  return {
    dispose() {
      server.dispose();
      protocol.dispose();
    },
  };
}

function createTestManager(context: { configDir: string; workspacePath: string; relay: FakeRelay }) {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const getLogin = async () => ({ userId: USER_ID, jwt: JWT });
  const storage = createWebRemoteControlDeviceFileStorage({ configDir: context.configDir, logger });
  const deviceIdentity = createWebRemoteControlDeviceIdentity({
    endpointOrigin: new URL(context.relay.httpUrl).origin,
    deviceMid: "server-e2e-mid",
    getLogin,
    storage,
    logger,
  });
  return createWebRemoteControlDeviceManager({
    endpointOrigin: new URL(context.relay.httpUrl).origin,
    relayWsUrl: context.relay.wsUrl,
    remoteControlUrl: `${context.relay.httpUrl}/remote/v4`,
    deviceMid: "server-e2e-mid",
    deviceName: "zcode-server-e2e",
    appVersion: "0.0.0-e2e",
    platform: "test",
    getLogin,
    deviceIdentity,
    getWorkspaces: () => [
      {
        workspacePath: context.workspacePath,
        label: "e2e-workspace",
        kind: "local" as const,
      },
    ],
    attachChannelServer: (socket) => {
      createTestChannelServer(socket);
    },
    logger,
  });
}

async function waitPairStatusQueryCount(relay: FakeRelay, count: number, timeoutMs: number) {
  await waitFor(
    () => (devicePairStatusQueries(relay).length >= count ? true : undefined),
    timeoutMs,
    `${count} device pair_status_query messages`,
  );
}

describe("web remote control device (server side) e2e over fake-relay-v2", () => {
  let context: TestContext;

  beforeEach(async () => {
    const relay = await startFakeRelay({ users: { [JWT]: USER_ID } });
    const configDir = await mkdtemp(join(tmpdir(), "zcode-web-remote-config-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "zcode-web-remote-ws-"));
    context = {
      relay,
      configDir,
      workspacePath,
      manager: undefined,
      terminal: undefined,
    };
  });

  afterEach(async () => {
    await context.manager?.dispose();
    await context.terminal?.close();
    await context.relay.close();
  });

  it("registers, authenticates, heartbeats at 5s±1s, pairs with terminal and bridges rpc-frames to ChannelServer", async () => {
    const manager = createTestManager(context);
    context.manager = manager;
    const startStatus = await manager.start();
    expect(startStatus.status).not.toBe("auth-required");

    // register → token(role=device) → ws2?token&mid → auth_init
    await waitFor(
      () => (deviceAuthInits(context.relay).length >= 1 ? true : undefined),
      15_000,
      "device auth_init",
    );
    const registerCall = context.relay.httpCalls.find(
      (call) => call.path === "/api/v1/remote/device" && call.method === "POST",
    );
    expect(registerCall).toBeDefined();
    expect(registerCall?.body).toEqual({ device_mid: "server-e2e-mid" });
    expect(registerCall?.userId).toBe(USER_ID);
    const tokenCall = context.relay.httpCalls.find(
      (call) => call.path === "/api/v1/remote/token" && call.method === "POST",
    );
    expect(tokenCall?.body).toEqual({ role: "device" });
    const authInit = deviceAuthInits(context.relay)[0]?.message as {
      device_sid: string;
      meta?: { platform?: string; name?: string };
    };
    expect(authInit.device_sid).toMatch(/^d_/);
    expect(authInit.meta?.platform).toBe("test");

    // 设备身份持久化：{deviceSid, userId, endpointOrigin}
    const stored = JSON.parse(
      await readFile(join(context.configDir, "web-remote-control-device.json"), "utf-8"),
    ) as { deviceSid: string; userId: string; endpointOrigin: string };
    expect(stored).toEqual({
      deviceSid: authInit.device_sid,
      userId: USER_ID,
      endpointOrigin: new URL(context.relay.httpUrl).origin,
    });

    // 心跳 5s±1s：连续两条 pair_status_query 的观测间隔落在 [4s, 6s]。
    await waitPairStatusQueryCount(context.relay, 1, 10_000);
    const firstQueryAt = Date.now();
    await waitPairStatusQueryCount(context.relay, 2, 10_000);
    const gapMs = Date.now() - firstQueryAt;
    expect(gapMs).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS - HEARTBEAT_JITTER_MS - 500);
    expect(gapMs).toBeLessThanOrEqual(HEARTBEAT_INTERVAL_MS + HEARTBEAT_JITTER_MS + 500);

    // terminal 接入 → matched
    const terminal = await connectTerminal({
      relay: context.relay,
      jwt: JWT,
      deviceSid: authInit.device_sid,
    });
    context.terminal = terminal;

    // bootstrap：owner 认领 + server 工作区列表
    terminal.sendPayload({
      zcode_type: "bootstrap-request",
      terminalClientSessionId: "terminal-client-session-1",
      requestId: "bootstrap-1",
    });
    const bootstrap = await terminal.waitForPayload(
      (payload): payload is { zcode_type: string } =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { zcode_type?: string }).zcode_type === "bootstrap-response",
      10_000,
      "bootstrap-response",
    ) as { zcode_type: "bootstrap-response"; requestId: string; success: boolean; result: { windowControlSessionId: string; workspaces: Array<{ workspacePath: string; kind: string }> } };
    expect(bootstrap.success).toBe(true);
    expect(bootstrap.result.windowControlSessionId).toBe(authInit.device_sid);
    expect(bootstrap.result.workspaces).toEqual([
      { workspacePath: context.workspacePath, label: "e2e-workspace", kind: "local" },
    ]);

    // platform-request 方法表：枚举/MCP 读回空结果（与普通 Web 无宿主 fallback 同形），
    // 写操作回 unsupported-action 失败。
    const waitForPlatformResponse = (requestId: string) =>
      terminal.waitForPayload(
        (payload): payload is { zcode_type: string } =>
          typeof payload === "object" &&
          payload !== null &&
          (payload as { zcode_type?: string }).zcode_type === "platform-response" &&
          (payload as { requestId?: string }).requestId === requestId,
        10_000,
        `platform-response ${requestId}`,
      ) as Promise<{ success: boolean; result?: unknown; error?: string }>;
    terminal.sendPayload({
      zcode_type: "platform-request",
      requestId: "platform-docker",
      method: "isDockerAvailable",
    });
    expect(await waitForPlatformResponse("platform-docker")).toEqual({
      zcode_type: "platform-response",
      requestId: "platform-docker",
      method: "isDockerAvailable",
      success: true,
      result: false,
    });
    terminal.sendPayload({
      zcode_type: "platform-request",
      requestId: "platform-wsl",
      method: "listWSLDistros",
    });
    expect(await waitForPlatformResponse("platform-wsl")).toEqual({
      zcode_type: "platform-response",
      requestId: "platform-wsl",
      method: "listWSLDistros",
      success: true,
      result: [],
    });
    terminal.sendPayload({
      zcode_type: "platform-request",
      requestId: "platform-mcp-read",
      method: "loadMcpFromUserDirectory",
    });
    expect(await waitForPlatformResponse("platform-mcp-read")).toEqual({
      zcode_type: "platform-response",
      requestId: "platform-mcp-read",
      method: "loadMcpFromUserDirectory",
      success: true,
      result: { servers: [] },
    });
    terminal.sendPayload({
      zcode_type: "platform-request",
      requestId: "platform-mcp-write",
      method: "saveMcpToUserDirectory",
      args: { action: "upsert", source: "claudeclimcp", name: "e2e-mcp" },
    });
    const mcpWrite = await waitForPlatformResponse("platform-mcp-write");
    expect(mcpWrite.success).toBe(false);
    expect(mcpWrite.error).toContain("unsupported-action");

    // workspace-bridge-open → ready（进程内桥建立）
    const workspaceKey = resolveWebRemoteControlWorkspaceKey({
      workspacePath: context.workspacePath,
    });
    terminal.sendPayload({
      zcode_type: "workspace-bridge-open",
      terminalClientSessionId: "terminal-client-session-1",
      requestId: "bridge-open-1",
      bridgeSessionId: "bridge-session-1",
      bridgeGeneration: 1,
      recoveryId: "recovery-1",
      workspaceKey,
    });
    const bridgeReady = await terminal.waitForPayload(
      (payload): payload is { zcode_type: string } =>
        typeof payload === "object" &&
        payload !== null &&
        (payload as { zcode_type?: string }).zcode_type === "workspace-bridge-ready",
      10_000,
      "workspace-bridge-ready",
    ) as { zcode_type: "workspace-bridge-ready"; requestId: string; bridge: { kind: string; bridgeSessionId: string } };
    expect(bridgeReady.requestId).toBe("bridge-open-1");
    expect(bridgeReady.bridge.kind).toBe("local");
    expect(bridgeReady.bridge.bridgeSessionId).toBe("bridge-session-1");

    // rpc-frame 经 acknowledged 桥打到 ChannelServer：terminal 侧同款 acknowledged 协议 + ChannelClient。
    const terminalAckProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: "bridge-session-1",
      bridgeGeneration: 1,
      recoveryId: "recovery-1",
      sendFrame: (payload) => {
        terminal.sendPayload(payload);
        return true;
      },
    });
    // 追加一个 message 监听，把入站 rpc-frame/rpc-frame-ack 喂给 terminal 侧 acknowledged 协议。
    terminal.socket.on("message", (raw, isBinary) => {
      if (isBinary) return;
      try {
        const value = JSON.parse(String(raw)) as { type?: string; payload?: unknown };
        if (value.type === "data") {
          const payload = value.payload as { zcode_type?: string } | null;
          if (
            payload &&
            (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack")
          ) {
            terminalAckProtocol.acceptPayload(payload);
          }
        }
      } catch {
        // ignore
      }
    });
    const channelClient = new ChannelClient(terminalAckProtocol.protocol);
    const echoChannel = channelClient.getChannel<{
      echoed: { hello: string };
      at: string;
    }>("webRemoteControlTest.echo");
    const echoResult = await echoChannel.call("echo", { hello: "world" });
    expect(echoResult).toEqual({ echoed: { hello: "world" }, at: "channel-server" });
    channelClient.dispose();
    terminalAckProtocol.dispose();
  }, 60_000);

  it("reuses the persisted device identity on restart without re-registering", async () => {
    const first = createTestManager(context);
    context.manager = first;
    await first.start();
    const firstAuthInit = await waitFor(
      () => deviceAuthInits(context.relay)[0],
      15_000,
      "first auth_init",
    );
    const firstSid = (firstAuthInit.message as { device_sid: string }).device_sid;
    await first.dispose();

    // restart：同 userId + 同 endpointOrigin → 复用持久化 SID，不再 POST /device
    const registerCallsBefore = context.relay.httpCalls.filter(
      (call) => call.path === "/api/v1/remote/device" && call.method === "POST",
    ).length;
    const second = createTestManager(context);
    context.manager = second;
    await second.start();
    await waitFor(
      () => (deviceAuthInits(context.relay).length >= 2 ? true : undefined),
      15_000,
      "second auth_init",
    );
    const registerCallsAfter = context.relay.httpCalls.filter(
      (call) => call.path === "/api/v1/remote/device" && call.method === "POST",
    ).length;
    expect(registerCallsAfter).toBe(registerCallsBefore);
    const secondAuthInits = deviceAuthInits(context.relay);
    expect(
      secondAuthInits.map((record) => (record.message as { device_sid: string }).device_sid),
    ).toEqual([firstSid, firstSid]);
  }, 45_000);

  it("does not register or connect when no credential is available", async () => {
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const storage = createWebRemoteControlDeviceFileStorage({
      configDir: context.configDir,
      logger,
    });
    const deviceIdentity = createWebRemoteControlDeviceIdentity({
      endpointOrigin: new URL(context.relay.httpUrl).origin,
      deviceMid: "server-e2e-mid",
      // manager.start 在 identity 之前就按无凭据返回，此桩不应被调用。
      getLogin: async () => {
        throw new Error("unreachable: auth-required short-circuits registration");
      },
      storage,
      logger,
    });
    const manager = createWebRemoteControlDeviceManager({
      endpointOrigin: new URL(context.relay.httpUrl).origin,
      relayWsUrl: context.relay.wsUrl,
      remoteControlUrl: `${context.relay.httpUrl}/remote/v4`,
      deviceMid: "server-e2e-mid",
      deviceName: "zcode-server-e2e",
      appVersion: "0.0.0-e2e",
      platform: "test",
      getLogin: async () => undefined,
      deviceIdentity,
      getWorkspaces: () => [],
      attachChannelServer: () => undefined,
      logger,
    });
    context.manager = manager;
    const status = await manager.start();
    expect(status.status).toBe("auth-required");
    expect(context.relay.httpCalls).toHaveLength(0);
    expect(context.relay.messages).toHaveLength(0);
  });

  it("resolves relay config from env overrides", () => {
    const base = resolveWebRemoteControlServerConfig({
      ZCODE_BASE_URL: "https://zcode.example.com",
    });
    expect(base.endpointOrigin).toBe("https://zcode.example.com");
    expect(base.relayWsUrl).toBe("wss://zcode.example.com/api/v1/remote/ws2");
    expect(base.remoteControlUrl).toBe("https://zcode.example.com/remote/v4");

    const overridden = resolveWebRemoteControlServerConfig({
      ZCODE_BASE_URL: "https://zcode.example.com",
      ZCODE_WEB_REMOTE_CONTROL_URL: "https://override.example.com",
      ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: "ws://127.0.0.1:9999/custom-ws",
    });
    expect(overridden.endpointOrigin).toBe("https://override.example.com");
    expect(overridden.relayWsUrl).toBe("ws://127.0.0.1:9999/custom-ws");
  });

  it("prefers the credential store over the env JWT fallback", async () => {
    const { createWebRemoteControlServerLogin } = await import(
      "../../src/web-remote/webRemoteControlLogin.js"
    );
    const logger = { warn: () => undefined };
    const withStore = createWebRemoteControlServerLogin({
      env: { ZCODE_WEB_REMOTE_CONTROL_JWT: "env-jwt" },
      credentialRepo: {
        loadActiveTokenSet: async () => ({ accessToken: " store-jwt " }),
        loadActiveUserProfile: async () => ({ id: "user-1" }),
      },
      logger,
    });
    expect(await withStore.getLogin()).toEqual({ userId: "user-1", jwt: "store-jwt" });

    const fallback = createWebRemoteControlServerLogin({
      env: { ZCODE_WEB_REMOTE_CONTROL_JWT: "env-jwt" },
      credentialRepo: {
        loadActiveTokenSet: async () => null,
        loadActiveUserProfile: async () => null,
      },
      logger,
    });
    expect(await fallback.getLogin()).toEqual({
      userId: "zcode-web-remote-control-env",
      jwt: "env-jwt",
    });

    const none = createWebRemoteControlServerLogin({
      env: {},
      credentialRepo: {
        loadActiveTokenSet: async () => null,
        loadActiveUserProfile: async () => null,
      },
      logger,
    });
    expect(await none.getLogin()).toBeUndefined();
  });
});
