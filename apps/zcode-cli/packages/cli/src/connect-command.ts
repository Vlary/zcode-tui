import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";

// ============================================================
// zcode connect - SSH 远程工作区直通
// ============================================================
// 对齐桌面版「远程工作区」的核心语义：agent 与文件改动都发生在远端机器，
// 本地终端只承载交互。实现上不引入任何依赖：用系统 ssh 以 PTY 直通方式在
// 远端目标目录启动 zcode TUI；--deploy 顺带把当前 CLI 单文件产物推到远端
// （~/.local/bin/zcode），首次连接远端没有 zcode 时也能一键装好。

export interface ConnectTarget {
  user?: string;
  host: string;
  port?: number;
  path?: string;
}

const DEPLOY_REMOTE_BIN = "~/.local/bin/zcode";

export function parseConnectTarget(raw: string): ConnectTarget | undefined {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return undefined;
  let rest = value;
  let user: string | undefined;
  const at = rest.lastIndexOf("@");
  if (at > 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  if (!rest) return undefined;
  // 只按最后一个冒号拆分端口/路径，覆盖 host、host:22、host:/path、host:22:/path。
  const colon = rest.indexOf(":");
  if (colon === -1) return { ...(user ? { user } : {}), host: rest };
  const head = rest.slice(0, colon);
  const tail = rest.slice(colon + 1);
  if (!head) return undefined;
  if (tail.startsWith("/")) {
    return { ...(user ? { user } : {}), host: head, path: tail };
  }
  const secondColon = tail.indexOf(":");
  if (secondColon === -1) {
    const port = Number.parseInt(tail, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
    return { ...(user ? { user } : {}), host: head, port };
  }
  const portText = tail.slice(0, secondColon);
  const remotePath = tail.slice(secondColon + 1);
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  if (!remotePath.startsWith("/")) return undefined;
  return { ...(user ? { user } : {}), host: head, port, path: remotePath };
}

function sshBaseArgs(target: ConnectTarget): string[] {
  const args: string[] = [];
  if (target.port !== undefined) args.push("-p", String(target.port));
  const destination = target.user === undefined ? target.host : `${target.user}@${target.host}`;
  args.push(destination);
  return args;
}

function sshExecutable(): string {
  const candidates =
    process.platform === "win32"
      ? ["C:\\Windows\\System32\\OpenSSH\\ssh.exe", "ssh"]
      : ["ssh"];
  for (const candidate of candidates) {
    if (!candidate.includes("\\")) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return "ssh";
}

function runSsh(target: ConnectTarget, remoteCommand: string): { ok: boolean; output: string } {
  // BatchMode 禁用交互提示：远端需要密码时检查立即失败而不是挂死；
  // 只有最终的直通 ssh 保留交互（用户可以输密码）。
  const result = spawnSync(
    sshExecutable(),
    ["-o", "BatchMode=yes", ...sshBaseArgs(target), remoteCommand],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function localCliBundlePath(): string | undefined {
  // 打包态 argv[1] 就是 zcode.cjs；开发态回退到包内 dist。
  const entry = process.argv[1];
  if (entry && existsSync(entry) && entry.endsWith(".cjs")) return entry;
  return undefined;
}

function deployToRemote(ctx: RunContext, target: ConnectTarget): boolean {
  const localPath = localCliBundlePath();
  if (!localPath) {
    ctx.stderr.write(
      "connect --deploy needs the bundled CLI; run from the packaged zcode binary or dist/zcode.cjs.\n",
    );
    return false;
  }
  ctx.stdout.write(`Deploying zcode to ${target.host}:${DEPLOY_REMOTE_BIN} …\n`);
  const destination =
    target.user === undefined ? `${target.host}:${DEPLOY_REMOTE_BIN}` : `${target.user}@${target.host}:${DEPLOY_REMOTE_BIN}`;
  const mkdir = runSsh(target, "mkdir -p ~/.local/bin");
  if (!mkdir.ok) {
    ctx.stderr.write(`Failed to prepare remote bin directory: ${mkdir.output}\n`);
    return false;
  }
  const scp = spawnSync(
    process.platform === "win32" && existsSync("C:\\Windows\\System32\\OpenSSH\\scp.exe")
      ? "C:\\Windows\\System32\\OpenSSH\\scp.exe"
      : "scp",
    [
      ...(target.port !== undefined ? ["-P", String(target.port)] : []),
      localPath,
      destination,
    ],
    { stdio: "inherit", windowsHide: false },
  );
  if (scp.status !== 0) {
    ctx.stderr.write("scp failed; check connectivity and credentials.\n");
    return false;
  }
  const chmod = runSsh(target, `chmod +x ${DEPLOY_REMOTE_BIN}`);
  if (!chmod.ok) {
    ctx.stderr.write(`Failed to mark remote binary executable: ${chmod.output}\n`);
    return false;
  }
  ctx.stdout.write("Deployed.\n");
  return true;
}

export function runConnectCommand(
  ctx: RunContext,
  _options: GlobalOptions,
  args: readonly string[],
): number {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const deploy = args.includes("--deploy");
  if (positional.length !== 1) {
    ctx.stderr.write(
      "Usage: zcode connect <[user@]host[:port][:/remote/path]> [--deploy]\n",
    );
    return 1;
  }
  const target = parseConnectTarget(positional[0] ?? "");
  if (!target) {
    ctx.stderr.write(
      `Invalid connect target: ${positional[0]}\nExpected [user@]host[:port][:/remote/path]\n`,
    );
    return 1;
  }

  const remoteCheck = runSsh(target, "command -v zcode");
  if (!remoteCheck.ok) {
    ctx.stderr.write(
      `Cannot reach ${target.host} over SSH. Check the host, port and credentials.\n${remoteCheck.output}\n`,
    );
    return 1;
  }
  if (!remoteCheck.output.includes("zcode")) {
    ctx.stderr.write(
      `zcode is not installed on ${target.host}. Re-run with --deploy to push this CLI there first.\n`,
    );
    return 1;
  }
  if (deploy && !deployToRemote(ctx, target)) return 1;

  const label = target.path === undefined ? target.host : `${target.host}:${target.path}`;
  ctx.stdout.write(`Connecting to ${label}; the agent runs on the remote machine.\n`);
  const remoteCommand =
    target.path === undefined
      ? "exec zcode"
      : `cd ${JSON.stringify(target.path)} && exec zcode`;
  const child = spawn(
    sshExecutable(),
    [...sshBaseArgs(target), "-t", remoteCommand],
    { stdio: "inherit", windowsHide: false },
  );
  child.on("error", (error) => {
    ctx.stderr.write(`ssh failed: ${error.message}\n`);
  });
  child.on("close", (code) => {
    process.exit(code ?? 0);
  });
  // 直通模式下父进程随 ssh 生命周期退出；返回 0 仅为类型完备。
  return 0;
}
