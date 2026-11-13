// 真实 E2E：Web 远程控制（被控端 device relay + 模拟手机 terminal）走完整链路，
// 全程本地回环（fake-relay-v2），无云端依赖。
// 用法：node web-remote-e2e.mjs（在完整 ZCode 仓库内运行，需已 pnpm install——
// 脚本会以 `node --import tsx` 重启自身：fake relay fixture 与 acknowledged 协议
// 只有 TS 源，@zcode/shared 的 exports 全部指向 src/*.ts，无编译产物可引）。
//
// 链路（协议事实见 packages/shared/src/web-remote-relay/CONTRACT.md）：
//   device  = node packages/server/dist/entry-http.js（ZCODE_WEB_REMOTE_CONTROL=1
//             + URL/RELAY_WS_URL/JWT env 覆盖；装配点 packages/server/src/entry-http.ts:36-52
//             与 packages/server/src/web-remote/index.ts:37-39）；
//   relay   = packages/shared/test/fixtures/fake-relay-v2.ts 进程内启动
//             （users 桩：Bearer JWT→userId；POST /api/v1/remote/token 一次性
//             role token（60s）；WS /api/v1/remote/ws2?token&mid；auth_init 配对）；
//   terminal= 本脚本，照 packages/web/src/web-remote-control/adapters 的
//             role=terminal 语义（webRemoteControlV2Token.ts：取 token→WS→auth_init）。
//
// 断言清单（全部通过打印 WEB-REMOTE-E2E-PASS，退出 0；任一失败打印原因退出 1；
// 构建失败退出 2；finally 清理全部子进程/临时目录）：
//   R0 [条件] packages/server/dist/entry-http.js 缺失时先
//      `pnpm --filter @zcode/server run build`（同 web-e2e.mjs A0 先例）；
//   R1 fake relay 起在 127.0.0.1 随机端口，鉴权桩生效（JWT→userId）；
//   R2 spawn node packages/server/dist/entry-http.js 成功（stdio pipe），进程不提前退出；
//   R3 40s 内 GET /api/server-info 返回 2xx JSON，且 webRemoteControl.enabled=true、
//      relayWsUrl/endpointOrigin 与 fake relay 一致（server-remote.ts:32-38 契约）；
//   R4 device 注册+建连：POST /api/v1/remote/device（body {device_mid}、同 userId）、
//      POST /api/v1/remote/token {role:"device"}，设备列表出现 online=true（取 device_sid）；
//      失败时打印 device 进程 stdout/stderr 尾部；
//   R5 terminal 配对：POST /api/v1/remote/token {role:"terminal"} → WS auth_init →
//      auth_ack pair_status=matched；
//   R6 bootstrap-request → bootstrap-response success=true、workspaces 含被控端
//      工作区（ZCODE_SERVER_WORKSPACE 注入的临时目录）、windowControlSessionId=device_sid；
//   R7 workspace-bridge-open → workspace-bridge-ready（bridge.kind=local 进程内桥，
//      装配同 http.ts setupChannelServerOverSocket）；
//   R8 发一条 rpc-frame（terminal 侧 acknowledged 协议，packages/client 源），
//      断言收到 rpc-frame-ack（ACK；若收到组装回包也计入响应）；
//   Rp1 GET /api/web-remote-control/pairing 返回 enabled=true 且
//      status ∈ {waiting-terminal, paired}（http.ts 契约 + web-remote/index.ts
//      toWebRemoteControlPairingInfo 的 manager 状态映射，每请求实时读）；
//   Rp2 qrUrl 存在且含非空 sid/mid 查询参数（buildWebRemoteControlExternalQrUrl
//      语义：shared/src/web-remote-control.ts，sid=deviceSid、mid=deviceMid）；
//   Rp3 terminal 配对完成后再次 GET pairing，status 变为 paired。
//   Rp1-3 的观测点挂在 R5 配对前后（Rp1/Rp2 在 R5 前，Rp3 在 R5 后）：既有 R8 会
//   把非 RPC 原始字节喂进 ChannelServer，device 进程在 R8 结束后毫秒级必然崩溃
//   （ChannelServer.onRawMessage 对未识别消息 deserialize 得 undefined 直接抛
//   TypeError，packages/rpc/src/channelServer.ts:69——先于本扩展即存在，属产品
//   健壮性缺陷，本脚本不修），R8 之后 server 已死，pairing 端点无从查询。Rp3
//   复用 R5 这条配对后持续持有的 terminal 连接（R6-R8 同一条 WS），不另起配对。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { WebSocket } from "ws";

// 路径由脚本位置推导（本脚本位于 apps/zcode-cli/，仓库根再上溯两级），不硬编码机器路径。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_ENTRY = join(REPO_ROOT, "packages", "server", "dist", "entry-http.js");
const SERVER_SRC = join(REPO_ROOT, "packages", "server", "src");
const SHARED_SRC = join(REPO_ROOT, "packages", "shared", "src");
const SHARED_FIXTURES = join(REPO_ROOT, "packages", "shared", "test", "fixtures");

// fixture 鉴权桩要求（fake-relay-v2.ts:70 options.users: Record<JWT, userId>）：
// device/terminal 用同一 JWT 即同账号，配对按 userId 归属匹配。
const E2E_JWT = "web-remote-e2e-jwt";
const E2E_USER_ID = "web-remote-e2e-user";
const TERMINAL_MID = "web-remote-e2e-terminal";

const READY_TIMEOUT_MS = 40_000;
const DEVICE_ONLINE_TIMEOUT_MS = 30_000;
const PAIR_TIMEOUT_MS = 15_000;
const PAYLOAD_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

const RUNNER_ENV = "ZCODE_WEB_REMOTE_E2E_RUNNER";

class AssertError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertError(message);
}

// ---------------------------------------------------------------------------
// 入口分两段：`node web-remote-e2e.mjs`（任意 cwd）先重启自身为
// `node --import tsx <self>`——TS 深路径动态导入必须挂在 tsx loader 下；
// 全部编排逻辑随后在 runner 分支执行，退出码原样透传。
// ---------------------------------------------------------------------------
const selfPath = fileURLToPath(import.meta.url);
if (!process.env[RUNNER_ENV]) {
  const runner = spawn(process.execPath, ["--import", "tsx", selfPath], {
    cwd: dirname(selfPath), // tsx 是 apps/zcode-cli devDependency，从脚本目录解析
    env: { ...process.env, [RUNNER_ENV]: "1" },
    stdio: "inherit",
  });
  runner.on("error", (error) => {
    console.error(
      `WEB-REMOTE-E2E-FAIL: 无法以 --import tsx 重启自身（${error.message}）；` +
        "请确认仓库已 pnpm install（tsx 在 apps/zcode-cli devDependencies）",
    );
    process.exit(1);
  });
  runner.on("close", (code) => process.exit(code ?? 1));
} else {
  void runE2E();
}

/** 尾部输出环形缓冲：进程意外退出时给出可读原因，同时排空管道防背压。 */
function drain(channel, sink) {
  channel?.on("data", (chunk) => {
    sink.text = (sink.text + chunk.toString("utf8")).slice(-8192);
  });
}

/** 定位辅助：device 进程输出尾部（stdout 承载 relay 重试日志，stderr 承载崩溃栈）。 */
function deviceOutputTail(serverOut, serverErr) {
  const parts = [];
  const out = serverOut?.text?.trim();
  const err = serverErr?.text?.trim();
  if (err) parts.push(`device 进程 stderr 尾部：\n${err}`);
  if (out) parts.push(`device 进程 stdout 尾部：\n${out}`);
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

/** Windows 下 server 可能再 spawn 子进程；taskkill /T 杀整棵树防端口残留（web-e2e 先例）。 */
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
  child.kill();
}

/** 目录树内最新文件 mtime（ms）；用于 dist 过期提示。 */
function newestSourceMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let stats;
    try {
      stats = statSync(current);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      try {
        for (const name of readdirSync(current)) stack.push(join(current, name));
      } catch {
        /* ignore */
      }
    } else if (stats.mtimeMs > newest) {
      newest = stats.mtimeMs;
    }
  }
  return newest;
}

/** R0：缺产物先构建（status!==0 退出 2，与运行断言失败区分开，web-e2e A0 先例）。 */
function ensureServerDist() {
  if (existsSync(SERVER_ENTRY)) {
    const srcNewest = Math.max(
      newestSourceMtime(SERVER_SRC),
      newestSourceMtime(SHARED_SRC),
      newestSourceMtime(SHARED_FIXTURES),
    );
    if (srcNewest > statSync(SERVER_ENTRY).mtimeMs) {
      console.log(
        `WARN R0: server/shared 源比 ${relative(REPO_ROOT, SERVER_ENTRY)} 新，dist 可能过期；` +
          `如行为异常请重跑 pnpm --filter @zcode/server run build`,
      );
    }
    console.log("PASS R0: packages/server/dist/entry-http.js 已存在");
    return;
  }
  console.log("STEP R0: dist/entry-http.js 缺失，执行 pnpm --filter @zcode/server run build …");
  const build =
    process.platform === "win32"
      ? spawnSync("cmd", ["/c", `cd /d "${REPO_ROOT}" && pnpm --filter @zcode/server run build`], {
          stdio: "inherit",
        })
      : spawnSync("pnpm", ["--filter", "@zcode/server", "run", "build"], {
          cwd: REPO_ROOT,
          stdio: "inherit",
          shell: true,
        });
  if (build.error || build.status !== 0) {
    console.error(
      `WEB-E2E-BUILD-FAIL: pnpm --filter @zcode/server run build 失败` +
        `（error=${build.error?.message ?? "-"} status=${build.status ?? "-"}）；` +
        `请在 ${REPO_ROOT} 手动重跑排查。`,
    );
    process.exit(2);
  }
  assert(existsSync(SERVER_ENTRY), `R0: 构建成功后仍找不到 ${SERVER_ENTRY}`);
  console.log("PASS R0: @zcode/server 构建完成");
}

/** 挑一个空闲 TCP 端口（listen 0 后释放；存在极小竞态，E2E 可接受）。 */
async function pickFreePort() {
  const net = await import("node:net");
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
    probe.on("error", reject);
  });
}

/** 宽松 fetch+JSON：非 2xx 或非 JSON 时 json=undefined，由调用方决定重试或断言。 */
async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { response, json, text };
}

/** 轮询直到 probe 返回非 undefined；device 进程提前退出立即失败（带输出尾部）。 */
async function waitFor(what, timeoutMs, probe, serverChild, serverOut, serverErr) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "未执行任何探测";
  for (;;) {
    if (serverChild && serverChild.exitCode !== null) {
      throw new AssertError(
        `device server 子进程提前退出（code=${serverChild.exitCode}）。${deviceOutputTail(serverOut, serverErr)}`,
      );
    }
    try {
      const value = await probe();
      if (value !== undefined) return value;
      lastReason = "条件未满足";
    } catch (error) {
      if (error instanceof AssertError) throw error;
      lastReason = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new AssertError(
        `${timeoutMs / 1000}s 内未等到 ${what}（最后状态：${lastReason}）。${deviceOutputTail(serverOut, serverErr)}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// runner 主流程
// ---------------------------------------------------------------------------
async function runE2E() {
  let exitCode = 1;
  try {
    exitCode = await main();
  } catch (error) {
    const reason = error instanceof AssertError ? error.message : (error?.stack ?? String(error));
    console.error(`WEB-REMOTE-E2E-FAIL: ${reason}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

async function main() {
  assert(existsSync(join(REPO_ROOT, "node_modules")), "前置: 仓库未 pnpm install（缺 node_modules）");
  ensureServerDist();

  // TS 深路径导入（tsx loader 下）：fixture / 协议解析 / acknowledged 协议 / workspace key。
  const { createFakeRelayV2 } = await import(
    pathToFileURL(join(SHARED_FIXTURES, "fake-relay-v2.ts")).href
  );
  const { parseWebRemoteControlRelayV2IncomingMessage } = await import(
    pathToFileURL(join(SHARED_SRC, "web-remote-relay", "index.ts")).href
  );
  const { resolveWebRemoteControlWorkspaceKey } = await import(
    pathToFileURL(join(SHARED_SRC, "web-remote-control.ts")).href
  );
  const { createAcknowledgedWebRemoteControlRelayProtocol } = await import(
    pathToFileURL(
      join(REPO_ROOT, "packages", "client", "src", "webRemoteControlAcknowledgedRelayProtocol.ts"),
    ).href
  );

  // R1：fake relay（进程内，loopback）。
  const relay = await createFakeRelayV2({ users: { [E2E_JWT]: E2E_USER_ID } });
  console.log(`PASS R1: fake relay 就绪 http=${relay.httpUrl} ws=${relay.wsUrl}`);

  // 临时数据目录隔离 credential store（强制走 ZCODE_WEB_REMOTE_CONTROL_JWT 回退，
  // webRemoteControlLogin.ts:57-58；避免开发机已登录账号抢占凭据）与 device 身份持久化；
  // ZCODE_DESKTOP_HOME_DIR 隔离 setting.json 读写（settingService.ts:53-59 的
  // HOME 回退链），避免污染开发机真实 ~/.zcode；
  // 临时工作区注入 ZCODE_SERVER_WORKSPACE，供 bootstrap 断言。
  const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-web-remote-e2e-data-"));
  const homeDir = mkdtempSync(join(tmpdir(), "zcode-web-remote-e2e-home-"));
  const workspacePath = mkdtempSync(join(tmpdir(), "zcode-web-remote-e2e-ws-"));

  // R2：spawn device server（env 覆盖入口 web-remote/index.ts:37-39）。
  const port = await pickFreePort();
  const serverOut = { text: "" };
  const serverErr = { text: "" };
  const serverEnv = {
    ...process.env,
    PORT: String(port),
    ZCODE_SERVER_ID: "web-remote-e2e",
    ZCODE_WEB_REMOTE_CONTROL: "1",
    ZCODE_WEB_REMOTE_CONTROL_URL: new URL(relay.httpUrl).origin,
    ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL: relay.wsUrl,
    ZCODE_WEB_REMOTE_CONTROL_JWT: E2E_JWT,
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    ZCODE_DESKTOP_HOME_DIR: homeDir,
    ZCODE_SERVER_WORKSPACE: workspacePath,
  };
  delete serverEnv[RUNNER_ENV];
  const serverChild = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: serverEnv,
    stdio: "pipe",
  });
  drain(serverChild.stdout, serverOut);
  drain(serverChild.stderr, serverErr);
  console.log(`STEP R2: 已 spawn device server pid=${serverChild.pid} port=${port}`);

  let terminal;
  let ackProtocol;
  try {
    // R3：/api/server-info 就绪且 relay 配置字段正确。
    const infoUrl = `http://127.0.0.1:${port}/api/server-info`;
    const info = await waitFor(
      "/api/server-info(webRemoteControl)",
      READY_TIMEOUT_MS,
      async () => {
        const { response, json } = await fetchJson(infoUrl);
        if (!response.ok || !json || typeof json !== "object") return undefined;
        return json;
      },
      serverChild,
      serverOut,
      serverErr,
    );
    const remote = info.webRemoteControl;
    assert(
      remote && typeof remote === "object",
      `R3: /api/server-info 缺 webRemoteControl 字段：${JSON.stringify(info).slice(0, 200)}`,
    );
    assert(remote.enabled === true, `R3: webRemoteControl.enabled!==true：${JSON.stringify(remote)}`);
    assert(
      remote.relayWsUrl === relay.wsUrl,
      `R3: webRemoteControl.relayWsUrl=${remote.relayWsUrl} 与 fake relay ${relay.wsUrl} 不一致`,
    );
    assert(
      remote.endpointOrigin === new URL(relay.httpUrl).origin,
      `R3: webRemoteControl.endpointOrigin=${remote.endpointOrigin} 与 fake relay origin 不一致`,
    );
    console.log(`PASS R2+R3: server-info 就绪，webRemoteControl=${JSON.stringify(remote)}`);

    // R4：device 注册 + WS 上线。失败时附 device 进程 stdout/stderr 尾部（帮助定位）。
    let device;
    try {
      device = await waitFor(
        "device 上线（GET /api/v1/remote/device）",
        DEVICE_ONLINE_TIMEOUT_MS,
        async () => {
          const { json } = await fetchJson(new URL("/api/v1/remote/device", relay.httpUrl), {
            headers: { Authorization: `Bearer ${E2E_JWT}` },
          });
          const online = Array.isArray(json?.data)
            ? json.data.find((d) => d && d.online === true)
            : undefined;
          return online;
        },
        serverChild,
        serverOut,
        serverErr,
      );
    } catch (error) {
      throw new AssertError(
        `R4: device 注册/上线失败：${error instanceof AssertError ? error.message : String(error)}` +
          `${deviceOutputTail(serverOut, serverErr)}`,
      );
    }
    const deviceSid = device.device_sid;
    assert(
      typeof deviceSid === "string" && deviceSid.length > 0,
      `R4: 设备记录缺 device_sid：${JSON.stringify(device)}`,
    );
    const registerCall = relay.httpCalls.find(
      (call) => call.path === "/api/v1/remote/device" && call.method === "POST",
    );
    assert(registerCall, "R4: fake relay 未观测到 POST /api/v1/remote/device（device 未注册）");
    assert(
      registerCall.userId === E2E_USER_ID,
      `R4: 注册 userId=${registerCall.userId}，期望 ${E2E_USER_ID}`,
    );
    assert(
      registerCall.body &&
        typeof registerCall.body === "object" &&
        typeof registerCall.body.device_mid === "string" &&
        registerCall.body.device_mid.length > 0,
      `R4: 注册 body 缺 device_mid：${JSON.stringify(registerCall.body)}`,
    );
    const deviceTokenCall = relay.httpCalls.find(
      (call) => call.path === "/api/v1/remote/token" && call.method === "POST",
    );
    assert(deviceTokenCall, "R4: fake relay 未观测到 POST /api/v1/remote/token");
    assert(
      deviceTokenCall.body && deviceTokenCall.body.role === "device",
      `R4: device 取 token 的 body.role 应为 "device"：${JSON.stringify(deviceTokenCall.body)}`,
    );
    console.log(
      `PASS R4: device 注册并在线 sid=${deviceSid} mid=${registerCall.body.device_mid}`,
    );

    // Rp1：GET /api/web-remote-control/pairing 基本契约（http.ts:411-415 路由每次请求
    // 实时读 manager，entry-http.ts:51-53 装配 getter）。放在 R5 配对前的窗口：
    // 此时 transport=waiting_terminal → 预期 status=waiting-terminal（allowed set
    // {waiting-terminal, paired} 依据 ask）。轮询探测与 R3/R4 同一容错口径。
    const pairingUrl = `http://127.0.0.1:${port}/api/web-remote-control/pairing`;
    let pairingBefore;
    try {
      pairingBefore = await waitFor(
        "pairing 响应（GET /api/web-remote-control/pairing）",
        PAIR_TIMEOUT_MS,
        async () => {
          let fetched;
          try {
            fetched = await fetchJson(pairingUrl);
          } catch (error) {
            const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message;
            throw new Error(`fetch failed（${cause}）`);
          }
          if (!fetched.response.ok || !fetched.json || typeof fetched.json !== "object") {
            throw new Error(`HTTP ${fetched.response.status} ${fetched.text.slice(0, 200)}`);
          }
          return fetched.json;
        },
        serverChild,
        serverOut,
        serverErr,
      );
    } catch (error) {
      throw new AssertError(
        `Rp1: pairing 响应异常：${error instanceof AssertError ? error.message : String(error)}` +
          `${deviceOutputTail(serverOut, serverErr)}`,
      );
    }
    assert(
      pairingBefore.enabled === true,
      `Rp1: pairing.enabled!==true：${JSON.stringify(pairingBefore)}`,
    );
    assert(
      pairingBefore.status === "waiting-terminal" || pairingBefore.status === "paired",
      `Rp1: pairing.status=${JSON.stringify(pairingBefore.status)} 不在 {waiting-terminal, paired}：` +
        JSON.stringify(pairingBefore),
    );
    console.log(
      `PASS Rp1: pairing enabled=true status=${pairingBefore.status}` +
        `（deviceName=${pairingBefore.deviceName}）`,
    );

    // Rp2：qrUrl 存在且含非空 sid/mid（buildWebRemoteControlExternalQrUrl 语义，
    // shared/src/web-remote-control.ts:168-191——sid=deviceSid、mid=deviceMid 必带）。
    assert(
      typeof pairingBefore.qrUrl === "string" && pairingBefore.qrUrl.length > 0,
      `Rp2: pairing 缺 qrUrl：${JSON.stringify(pairingBefore)}`,
    );
    let pairingQrUrl;
    try {
      pairingQrUrl = new URL(pairingBefore.qrUrl);
    } catch (error) {
      throw new AssertError(
        `Rp2: qrUrl 无法解析：${pairingBefore.qrUrl}（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    const pairingQrSid = pairingQrUrl.searchParams.get("sid") ?? "";
    const pairingQrMid = pairingQrUrl.searchParams.get("mid") ?? "";
    assert(pairingQrSid.length > 0, `Rp2: qrUrl 缺 sid 参数：${pairingBefore.qrUrl}`);
    assert(pairingQrMid.length > 0, `Rp2: qrUrl 缺 mid 参数：${pairingBefore.qrUrl}`);
    console.log(
      `PASS Rp2: qrUrl 含 sid/mid（${pairingQrUrl.origin}${pairingQrUrl.pathname}` +
        `?sid=${pairingQrSid}&mid=${pairingQrMid}&…）`,
    );

    // R5：terminal 配对（adapters/webRemoteControlV2Token.ts 的 role=terminal 语义）。
    terminal = await connectTerminal({ relay, jwt: E2E_JWT, deviceSid, parseIncoming: parseWebRemoteControlRelayV2IncomingMessage });
    const authAck = await terminal.waitForControl(
      (m) => m.type === "auth_ack" && m.pair_status === "matched",
      PAIR_TIMEOUT_MS,
      "auth_ack(pair_status=matched)",
    );
    console.log(`PASS R5: terminal 配对 matched（terminal_sid=${authAck.terminal_sid}）`);

    // Rp3：terminal 配对完成后再次 GET pairing，status 变为 paired。直接复用 R5 这条
    // 持续持有的 terminal 连接（后续 R6-R8 同一条 WS），不另起配对时序；transport
    // paired → manager active（webRemoteControlDeviceManager.ts:833-835 mapTransportState
    // → web-remote/index.ts:134-137 toWebRemoteControlPairingInfo）可能有毫秒级传播，
    // 轮询等待而非单次快照。
    const pairingAfter = await waitFor(
      "pairing status=paired（terminal 配对后）",
      PAIR_TIMEOUT_MS,
      async () => {
        const { response, json } = await fetchJson(pairingUrl);
        if (!response.ok || !json || typeof json !== "object") return undefined;
        return json.status === "paired" ? json : undefined;
      },
      serverChild,
      serverOut,
      serverErr,
    );
    assert(
      pairingAfter.enabled === true,
      `Rp3: paired 状态下 enabled!==true：${JSON.stringify(pairingAfter)}`,
    );
    console.log(
      `PASS Rp3: terminal 配对后 pairing status=paired` +
        `（Rp1 时为 ${pairingBefore.status}，qrUrl sid=${pairingQrSid}）`,
    );

    // R6：bootstrap（owner 认领 + 工作区列表）。
    terminal.sendPayload({
      zcode_type: "bootstrap-request",
      terminalClientSessionId: TERMINAL_MID,
      requestId: "bootstrap-1",
    });
    const bootstrap = await terminal.waitForPayload(
      (p) => p && typeof p === "object" && p.zcode_type === "bootstrap-response",
      PAYLOAD_TIMEOUT_MS,
      "bootstrap-response",
    );
    assert(
      bootstrap.success === true,
      `R6: bootstrap success!==true：${JSON.stringify(bootstrap).slice(0, 300)}`,
    );
    assert(
      bootstrap.result?.windowControlSessionId === deviceSid,
      `R6: windowControlSessionId=${bootstrap.result?.windowControlSessionId} 应等于 device_sid=${deviceSid}`,
    );
    const workspaces = Array.isArray(bootstrap.result?.workspaces) ? bootstrap.result.workspaces : [];
    const listed = workspaces.find((w) => w?.workspacePath === workspacePath);
    assert(
      listed && listed.kind === "local",
      `R6: bootstrap workspaces 不含 ${workspacePath}(kind=local)：${JSON.stringify(workspaces)}`,
    );
    console.log(`PASS R6: bootstrap 成功，workspaces=${JSON.stringify(workspaces)}`);

    // R7：workspace bridge（进程内桥建立）。
    const workspaceKey = resolveWebRemoteControlWorkspaceKey({ workspacePath });
    const bridgeIdentity = {
      bridgeSessionId: "bridge-session-e2e",
      bridgeGeneration: 1,
      recoveryId: "recovery-e2e",
    };
    terminal.sendPayload({
      zcode_type: "workspace-bridge-open",
      terminalClientSessionId: TERMINAL_MID,
      requestId: "bridge-open-1",
      ...bridgeIdentity,
      workspaceKey,
    });
    const bridgeReady = await terminal.waitForPayload(
      (p) => p && typeof p === "object" && p.zcode_type === "workspace-bridge-ready",
      PAYLOAD_TIMEOUT_MS,
      "workspace-bridge-ready",
    );
    assert(
      bridgeReady.bridgeSessionId === bridgeIdentity.bridgeSessionId,
      `R7: bridge-ready 的 bridgeSessionId 不一致：${JSON.stringify(bridgeReady).slice(0, 300)}`,
    );
    assert(
      bridgeReady.bridge?.kind === "local" && bridgeReady.bridge?.workspacePath === workspacePath,
      `R7: bridge 元数据异常：${JSON.stringify(bridgeReady.bridge)}`,
    );
    console.log(
      `PASS R7: workspace-bridge-ready（kind=local workspace=${bridgeReady.bridge.workspacePath}）`,
    );

    // R8：rpc-frame（terminal 侧 acknowledged 协议；先挂观察者再发送）。
    let assembledResponses = 0;
    ackProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      ...bridgeIdentity,
      sendFrame: (payload) => {
        terminal.sendPayload(payload);
        return true;
      },
    });
    // 组装完成的回包经 protocol.onMessage（IMessagePassingProtocol）上抛。
    ackProtocol.protocol.onMessage(() => {
      assembledResponses += 1;
    });
    const ack = await new Promise((resolveAck, reject) => {
      const timer = setTimeout(() => {
        stopObserving();
        reject(
          new AssertError(
            `R8: ${PAYLOAD_TIMEOUT_MS / 1000}s 内未收到 rpc-frame-ack（assembled=${assembledResponses}）` +
              deviceOutputTail(serverOut, serverErr),
          ),
        );
      }, PAYLOAD_TIMEOUT_MS);
      const stopObserving = terminal.observeRpcTransport((payload) => {
        ackProtocol.acceptPayload(payload);
        if (
          payload.zcode_type === "rpc-frame-ack" &&
          typeof payload.ackMessageSeq === "number" &&
          payload.ackMessageSeq >= 1
        ) {
          clearTimeout(timer);
          stopObserving();
          resolveAck(payload);
        }
      });
      ackProtocol.protocol.send(
        (() => {
          const bytes = new TextEncoder().encode("web-remote-e2e rpc ping");
          return { buffer: bytes, byteLength: bytes.byteLength };
        })(),
      );
    });
    console.log(
      `PASS R8: rpc-frame 已确认 ackMessageSeq=${ack.ackMessageSeq}` +
        `${assembledResponses > 0 ? `（另收到 ${assembledResponses} 条组装回包）` : ""}`,
    );

    console.log("WEB-REMOTE-E2E-PASS");
    return 0;
  } finally {
    try {
      ackProtocol?.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      await terminal?.close();
    } catch {
      /* ignore */
    }
    killTree(serverChild);
    try {
      await relay.close();
    } catch {
      /* ignore */
    }
    for (const dir of [dataBaseDir, homeDir, workspacePath]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 句柄延迟释放时容忍 %TEMP% 残留 */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// terminal 侧最小客户端（照 packages/server/test/web-remote/helpers/fake-relay-fixture.ts
// 的 connectTerminal 与 packages/web/src/web-remote-control/adapters 的 role=terminal 语义）
// ---------------------------------------------------------------------------
async function connectTerminal(options) {
  const { relay, jwt, deviceSid, parseIncoming } = options;
  const tokenResponse = await fetch(new URL("/api/v1/remote/token", relay.httpUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "terminal" }),
  });
  const tokenBody = await tokenResponse.json().catch(() => undefined);
  assert(
    tokenBody?.code === 0 && typeof tokenBody?.data?.token === "string",
    `R5: terminal 取 token 失败：HTTP ${tokenResponse.status} ${JSON.stringify(tokenBody).slice(0, 200)}`,
  );
  const url = new URL(relay.wsUrl);
  url.searchParams.set("token", tokenBody.data.token);
  url.searchParams.set("mid", TERMINAL_MID);
  const socket = new WebSocket(url);
  await once(socket, "open");

  const incoming = [];
  const controlMessages = [];
  const payloadListeners = [];
  const rpcTransportListeners = [];
  socket.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let value;
    try {
      value = JSON.parse(String(raw));
    } catch {
      return;
    }
    const message = parseIncoming ? parseIncoming(value) : value;
    if (!message || typeof message !== "object") return;
    if (message.type === "data") {
      const payload = message.payload;
      incoming.push(payload);
      if (payload && typeof payload === "object") {
        if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
          for (const l of rpcTransportListeners.slice()) l(payload);
        }
      }
      for (const l of payloadListeners.slice()) l(payload);
    } else {
      controlMessages.push(message);
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
    sendPayload(payload) {
      assert(socket.readyState === WebSocket.OPEN, "terminal WS 已断开，无法发送 payload");
      socket.send(JSON.stringify({ type: "data", payload }));
    },
    waitForPayload(predicate, timeoutMs, what) {
      return waitForEvent(incoming, payloadListeners, predicate, timeoutMs, `payload ${what}`);
    },
    waitForControl(predicate, timeoutMs, what) {
      return waitForEvent(controlMessages, [], predicate, timeoutMs, `control ${what}`);
    },
    /** 入站 rpc-frame/rpc-frame-ack 观察者（喂 terminal 侧 acknowledged 协议 / 断言 ACK）。 */
    observeRpcTransport(listener) {
      rpcTransportListeners.push(listener);
      return () => {
        const i = rpcTransportListeners.indexOf(listener);
        if (i >= 0) rpcTransportListeners.splice(i, 1);
      };
    },
    async close() {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        const closed = once(socket, "close");
        socket.close();
        await Promise.race([closed, new Promise((r) => setTimeout(r, 2000))]);
      }
    },
  };
}

function waitForEvent(records, listeners, predicate, timeoutMs, what) {
  const existing = records.find((record) => predicate(record));
  if (existing !== undefined) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const unregister = () => {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    };
    const timer = setTimeout(() => {
      const late = records.find((record) => predicate(record));
      unregister();
      if (late !== undefined) resolve(late);
      else reject(new AssertError(`等待 ${what} 超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);
    const listener = (record) => {
      if (!predicate(record)) return;
      clearTimeout(timer);
      unregister();
      resolve(record);
    };
    listeners.push(listener);
  });
}
