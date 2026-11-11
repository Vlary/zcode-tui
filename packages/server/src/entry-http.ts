import {
  createServerHostServices,
  createTopicResourcePeers,
  getAppConfigDir,
} from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer, resolveHttpServerId } from "./http.js";
import {
  isWebRemoteControlEnabled,
  startWebRemoteControlDeviceRelay,
} from "./web-remote/index.js";
import type { ServerWebRemoteControlInfo } from "@zcode/shared";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const topicResourcePeers = createTopicResourcePeers();
  const serverId = resolveHttpServerId();
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
      sourceServerId: serverId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: Boolean(authToken),
    });

  // Web 远程控制被控端：ZCODE_WEB_REMOTE_CONTROL=1 时启动 device relay client。
  // 无凭据（auth-required）时不注册不建连，/api/server-info 仍下发 relay 地址与 enabled=false。
  let webRemoteControl: ServerWebRemoteControlInfo | undefined;
  if (isWebRemoteControlEnabled(process.env)) {
    const relay = await startWebRemoteControlDeviceRelay({
      services,
      workspaceIdentityMapper,
    });
    webRemoteControl = {
      enabled: relay.status === "started",
      relayWsUrl: relay.config.relayWsUrl,
      endpointOrigin: relay.config.endpointOrigin,
    };
    console.log(
      `[zcode-server:http] web remote control device relay ${relay.status} (relay=${relay.config.relayWsUrl} mid=${relay.deviceMid})`,
    );
  }

  createHttpServer(services, port, {
    serverId,
    workspaceIdentityMapper,
    migrationFailedPathCount,
    virtualProjects: true,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    ...(webRemoteControl ? { webRemoteControl } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
