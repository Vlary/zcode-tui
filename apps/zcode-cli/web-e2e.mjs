// 真实 E2E：`zcode web` 拉起 HTTP server + Web UI 静态站，走完整启动→探活→首页→参数校验链路。
// 用法：node web-e2e.mjs（在完整 ZCode 仓库内运行；缺失 packages/web/dist 时会先自动构建）。
//
// 断言清单（全部通过打印 WEB-E2E-PASS，退出 0；任一失败打印原因退出 1；构建失败退出 2）：
//   A0 [条件] packages/web/dist 缺失时，先 `pnpm --filter @zcode/web run build`（spawnSync cmd /c）；
//   A1 `node zcode.cjs web --port 3311` spawn 成功（stdio pipe），进程在探活期内不提前退出；
//   A2 40s 内 GET /api/server-info 返回 2xx 且响应体是合法 JSON；
//   A3 GET / 首页 HTML 含 `<div id="root"` 或 `<title`（SPA 入口）；
//   A4 `zcode.cjs web --port abc` 退出码为 1 且 stderr 含 "port"（参数校验路径）。
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 路径由脚本位置推导（本脚本位于 apps/zcode-cli/，仓库根再上溯两级），
// 不硬编码机器路径，CI/他机可用。
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(REPO_ROOT, "apps", "zcode-cli", "packages", "cli", "dist", "zcode.cjs");
const WEB_DIST = join(REPO_ROOT, "packages", "web", "dist");
const PORT = 3311;
const INFO_URL = `http://127.0.0.1:${PORT}/api/server-info`;
const HOME_URL = `http://127.0.0.1:${PORT}/`;
const READY_TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 500;

class AssertError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertError(message);
}

/** A0：缺产物先构建（status!==0 退出 2，与运行断言失败区分开）。 */
function ensureWebDist() {
  if (existsSync(WEB_DIST)) {
    console.log("PASS A0: packages/web/dist 已存在，跳过构建");
    return;
  }
  console.log("STEP A0: packages/web/dist 缺失，执行 pnpm --filter @zcode/web run build …");
  const build =
    process.platform === "win32"
      ? spawnSync("cmd", ["/c", `cd /d "${REPO_ROOT}" && pnpm --filter @zcode/web run build`], {
          stdio: "inherit",
        })
      : spawnSync("pnpm", ["--filter", "@zcode/web", "run", "build"], {
          cwd: REPO_ROOT,
          stdio: "inherit",
          shell: true,
        });
  if (build.error) {
    console.error(`WEB-E2E-BUILD-ERROR: 无法启动构建进程：${build.error.message}`);
    process.exit(2);
  }
  if (build.status !== 0) {
    console.error(
      `WEB-E2E-BUILD-FAIL: pnpm --filter @zcode/web run build 退出码 ${build.status}；` +
        `请在 ${REPO_ROOT} 手动重跑排查。`,
    );
    process.exit(2);
  }
  assert(existsSync(WEB_DIST), `A0: 构建成功后仍找不到 ${WEB_DIST}`);
  console.log("PASS A0: @zcode/web 构建完成");
}

/** 尾部输出环形缓冲：进程意外退出时给出可读原因，同时排空管道防背压。 */
function drain(channel, sink) {
  channel?.on("data", (chunk) => {
    sink.text = (sink.text + chunk.toString("utf8")).slice(-4096);
  });
}

async function waitForServerInfo(child, outSink, errSink) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "未发起任何请求";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new AssertError(
        `A1: server 子进程提前退出（code=${child.exitCode}）。stderr 尾部：\n${errSink.text.trim()}`,
      );
    }
    try {
      const response = await fetch(INFO_URL);
      lastError = `HTTP ${response.status}`;
      if (response.ok) {
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new AssertError(`A2: /api/server-info 返回 ${response.status}，但响应体不是 JSON：${text.slice(0, 200)}`);
        }
        assert(
          json !== null && typeof json === "object",
          `A2: /api/server-info JSON 不是对象：${text.slice(0, 200)}`,
        );
        return json;
      }
    } catch (error) {
      if (error instanceof AssertError) throw error;
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new AssertError(
    `A2: ${READY_TIMEOUT_MS / 1000}s 内 /api/server-info 未就绪（最后错误：${lastError}）。` +
      `stdout 尾部：\n${outSink.text.trim()}\nstderr 尾部：\n${errSink.text.trim()}`,
  );
}

async function assertHomePage() {
  const response = await fetch(HOME_URL);
  assert(response.ok, `A3: GET / 返回 ${response.status}`);
  const html = await response.text();
  assert(
    html.includes('<div id="root"') || /<title/i.test(html),
    `A3: 首页 HTML 不含 SPA 入口（<div id="root" 或 <title）；前 200 字符：${html.slice(0, 200)}`,
  );
  return html.length;
}

function assertInvalidPortRejected() {
  const result = spawnSync(process.execPath, [CLI, "web", "--port", "abc"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert(result.error === undefined, `A4: 无法启动 zcode web --port abc：${result.error?.message ?? ""}`);
  assert(result.status === 1, `A4: 期望退出码 1，实际 ${result.status}；stderr：${(result.stderr ?? "").slice(0, 400)}`);
  assert(
    /port/i.test(result.stderr ?? ""),
    `A4: stderr 不含 "port"：${(result.stderr ?? "").slice(0, 400)}`,
  );
}

/** Windows 下 CLI 还会再 spawn 真正的 server 孙进程；taskkill /T 杀整棵树防端口残留。 */
function killServerTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  }
  child.kill();
}

async function main() {
  if (!existsSync(CLI)) {
    throw new AssertError(`前置: 找不到 CLI 产物 ${CLI}，请先构建 @zcode/cli`);
  }
  ensureWebDist();

  // A1：启动 web server（stdio pipe，输出进缓冲便于诊断）。
  const outSink = { text: "" };
  const errSink = { text: "" };
  const child = spawn(process.execPath, [CLI, "web", "--port", String(PORT)], { stdio: "pipe" });
  drain(child.stdout, outSink);
  drain(child.stderr, errSink);
  console.log(`STEP A1: 已 spawn pid=${child.pid}：node zcode.cjs web --port ${PORT}`);
  try {
    const info = await waitForServerInfo(child, outSink, errSink);
    console.log(`PASS A1+A2: /api/server-info 就绪：${JSON.stringify(info).slice(0, 160)}`);
    const homeBytes = await assertHomePage();
    console.log(`PASS A3: 首页为 SPA 入口（${homeBytes} 字节）`);
  } finally {
    killServerTree(child);
  }

  assertInvalidPortRejected();
  console.log("PASS A4: --port abc 退出码 1 且 stderr 含 port");

  console.log("WEB-E2E-PASS");
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  const reason = error instanceof AssertError ? error.message : (error?.stack ?? String(error));
  console.error(`WEB-E2E-FAIL: ${reason}`);
  exitCode = 1;
}
process.exit(exitCode);
