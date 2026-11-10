import { spawnSync } from "node:child_process";

const UTF8_CODE_PAGE = "65001";

/**
 * Windows 多字节区域（如中文 CP936/GBK）的控制台按本地代码页解码输出，而 CLI 的
 * 中文文本都是 UTF-8 字节；GBK 解码会让 TUI 出现整屏乱码，还会让 ANSI 转义序列
 * 字节错位后裸露成 `[0m` 之类的可见残片。进入交互输出前把当前控制台切到 UTF-8。
 *
 * chcp 只修改本进程所在的控制台会话，随窗口关闭失效，不持久化系统设置；
 * 非 Windows 平台、以及重定向/协议管道等无控制台可改的场景直接跳过，
 * 失败时静默，不阻断 CLI 启动。
 */
export function ensureWindowsConsoleUtf8(): void {
  if (process.platform !== "win32") return;
  if (!process.stdout.isTTY) return;
  try {
    spawnSync("cmd.exe", ["/d", "/c", "chcp", UTF8_CODE_PAGE], { stdio: "ignore" });
  } catch {
    // 控制台句柄不可用或权限受限时没有可修复的解码层，保持原样继续。
  }
}
