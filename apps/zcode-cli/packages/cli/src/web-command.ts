import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";

// ============================================================
// zcode web - 一条参数启动 Web UI
// ============================================================
// 复用仓库内既有的 Web 栈：packages/server 的 entry-http（Hono，支持
// ZCODE_WEB_STATIC_ROOT 静态托管 + SPA fallback）+ packages/web 的 vite 产物。
// 本命令只做编排：定位产物 → 缺失时自动构建 → 以正确 env 拉起 server →
// 打印（可选打开）访问 URL。不引入新依赖，不在 zcode.cjs 里内嵌 server
// （server 带 node-pty 等原生模块，不适合进单文件 bundle）。

export interface WebCommandOptions {
  host?: string;
  noBuild: boolean;
  open: boolean;
  port: number;
}

const DEFAULT_WEB_PORT = 3030;
const READY_TIMEOUT_MS = 30_000;

export function parseWebArgs(args: readonly string[]): { options?: WebCommandOptions; error?: string } {
  let port = DEFAULT_WEB_PORT;
  let host: string | undefined;
  let open = false;
  let noBuild = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--port" || arg === "-p") {
      const raw = args[i + 1];
      const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        return { error: `--port 需要一个 1-65535 的端口号（收到 "${raw ?? ""}"）。` };
      }
      port = value;
      i += 1;
    } else if (arg.startsWith("--port=")) {
      const value = Number.parseInt(arg.slice("--port=".length), 10);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        return { error: `--port 需要一个 1-65535 的端口号（收到 "${arg.slice(7)}"）。` };
      }
      port = value;
    } else if (arg === "--host") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return { error: "--host 需要一个主机名或地址。" };
      }
      host = value;
      i += 1;
    } else if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
    } else if (arg === "--open") {
      open = true;
    } else if (arg === "--no-build") {
      noBuild = true;
    } else {
      return { error: `未知参数 "${arg}"。用法：zcode web [--port N] [--host H] [--open] [--no-build]` };
    }
  }
  return { options: { ...(host ? { host } : {}), noBuild, open, port } };
}

/** 从 zcode.cjs 位置向上找到含 packages/server 的仓库根；env 可直接指定。 */
export function resolveWebRepoRoot(cliEntryPath: string): string | undefined {
  const fromEnv = process.env["ZCODE_REPO_ROOT"]?.trim();
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  let dir = dirname(resolve(cliEntryPath));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "packages", "server", "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function runPnpm(root: string, filter: string, task: string): boolean {
  const result = spawnSync(
    "pnpm",
    ["--filter", filter, "run", task],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
  );
  return result.status === 0;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore", shell: false }).unref();
}

async function waitForReady(
  url: string,
  timeoutMs: number,
  isAborted: () => boolean = () => false,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAborted()) return false;
    try {
      const response = await fetch(url);
      if (response.status >= 200 && response.status < 500) return true;
    } catch {
      // server 尚未监听，继续等
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
  }
  return false;
}

export async function runWebCommand(ctx: RunContext, args: readonly string[], _options?: GlobalOptions): Promise<number> {
  const parsed = parseWebArgs(args);
  if (parsed.error !== undefined || parsed.options === undefined) {
    ctx.stderr.write(`${parsed.error ?? "参数解析失败"}\n`);
    return 1;
  }
  const web = parsed.options;
  const cliEntry = process.argv[1] ?? "";
  const root = resolveWebRepoRoot(cliEntry);
  if (root === undefined) {
    ctx.stderr.write(
      "web 功能需要完整 ZCode 仓库（packages/server 与 packages/web）。" +
        "当前安装看起来是 standalone 产物；可在完整仓库内运行，或用 ZCODE_REPO_ROOT 指定仓库路径。\n",
    );
    return 1;
  }
  const serverEntry =
    process.env["ZCODE_SERVER_ENTRY"]?.trim() ||
    join(root, "packages", "server", "dist", "entry-http.js");
  const webDist =
    process.env["ZCODE_WEB_DIST"]?.trim() ||
    join(root, "packages", "web", "dist");

  const missingServer = !existsSync(serverEntry);
  const missingWeb = !existsSync(join(webDist, "index.html"));
  if ((missingServer || missingWeb) && web.noBuild) {
    ctx.stderr.write(
      `缺少构建产物（${missingServer ? serverEntry : ""}${missingServer && missingWeb ? "、" : ""}${missingWeb ? join(webDist, "index.html") : ""}），且指定了 --no-build；请先构建或去掉 --no-build。\n`,
    );
    return 1;
  }
  if (missingServer) {
    ctx.stdout.write("正在构建 @zcode/server（首次约 1-2 分钟）…\n");
    if (!runPnpm(root, "@zcode/server", "build")) {
      ctx.stderr.write("@zcode/server 构建失败，请在上游仓库目录手动运行 pnpm --filter @zcode/server run build 排查。\n");
      return 1;
    }
  }
  if (missingWeb) {
    ctx.stdout.write("正在构建 @zcode/web 前端（首次约 1-2 分钟）…\n");
    if (!runPnpm(root, "@zcode/web", "build")) {
      ctx.stderr.write("@zcode/web 构建失败，请手动运行 pnpm --filter @zcode/web run build 排查。\n");
      return 1;
    }
  }
  if (!existsSync(serverEntry) || !existsSync(join(webDist, "index.html"))) {
    ctx.stderr.write("构建后仍找不到产物，请检查 packages/server/dist 与 packages/web/dist。\n");
    return 1;
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(web.port),
    ZCODE_WEB_STATIC_ROOT: webDist,
    ...(web.host ? { ZCODE_SERVER_HOST: web.host } : {}),
  };
  ctx.stdout.write(`启动 zcode web（静态目录 ${webDist}）…\n`);
  const child = spawn(process.execPath, [serverEntry], { env, stdio: "inherit" });

  // 覆盖默认信号行为后必须自己负责退出：转发给 child 后以 128+N 约定码收尾，
  // 由下方 exit 监听统一 resolve；child 已死时 kill 是 no-op，但监听器已在
  // exit 时摘除，不会残留吞信号的 process 监听。
  let signalExitCode: number | undefined;
  let childGone = false;
  let childExitFact: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const forwardSignal = (signal: NodeJS.Signals) => {
    signalExitCode = signal === "SIGINT" ? 130 : 143;
    child.kill(signal);
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  // exit 监听必须紧跟 spawn、先于任何 await：server 在就绪窗口内崩溃（如端口被
  // 占用立即退出）时，晚注册会错过事件，收尾 Promise 永不 resolve，CLI 永久挂起。
  const childExitCode = new Promise<number>((resolveExit) => {
    child.once("exit", (code, signal) => {
      childGone = true;
      childExitFact = { code, signal };
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
      resolveExit(signalExitCode ?? code ?? 0);
    });
  });

  const readyUrl = `http://127.0.0.1:${web.port}/api/server-info`;
  const ready = await waitForReady(readyUrl, READY_TIMEOUT_MS, () => childGone);
  const displayHost = web.host ?? "127.0.0.1";
  if (ready) {
    ctx.stdout.write(`\nzcode web 已就绪：http://${displayHost}:${web.port}\n按 Ctrl+C 停止。\n`);
    if (web.open) openBrowser(`http://${displayHost}:${web.port}`);
  } else if (childGone) {
    const fact = childExitFact;
    ctx.stderr.write(
      `server 进程提前退出（${
        fact?.signal ? `信号 ${fact.signal}` : `退出码 ${fact?.code ?? 0}`
      }）；请检查上方输出或端口占用。\n`,
    );
  } else {
    ctx.stdout.write(
      `\n等待 ${READY_TIMEOUT_MS / 1000}s 未见 server 响应（${readyUrl}）；进程仍在运行，可稍后自行访问 http://${displayHost}:${web.port}。\n`,
    );
  }

  return await childExitCode;
}
