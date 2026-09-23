// /yolo 命令链路断言：解析映射、帮助条目、补全建议、handler 切换。
import { parseSlashCommand, listSlashCommandSuggestions } from "./packages/cli/src/command-center/slash-commands.js";
import { SLASH_COMMAND_HELP_ENTRIES } from "./packages/cli/src/command-center/slash-command-help.js";
import { handleModeCommand } from "./packages/cli/src/command-center/handlers/mode.js";

let fail = 0;
const assert = (label: string, ok: boolean, detail?: string) => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
};

const yolo = parseSlashCommand("/yolo");
assert(
  "/yolo maps to mode command with yolo arg",
  yolo?.type === "known" && yolo?.name === "mode" && yolo?.args === "yolo",
  JSON.stringify(yolo),
);
const yoloExtra = parseSlashCommand("/yolo extra");
assert(
  "/yolo ignores extra args",
  yoloExtra?.name === "mode" && yoloExtra?.args === "yolo",
  JSON.stringify(yoloExtra),
);
const modeYolo = parseSlashCommand("/mode yolo");
assert(
  "/mode yolo unchanged (regression)",
  modeYolo?.name === "mode" && modeYolo?.args === "yolo",
  JSON.stringify(modeYolo),
);
const modeBare = parseSlashCommand("/mode");
assert(
  "/mode bare unchanged (regression)",
  modeBare?.name === "mode" && modeBare?.args === "",
  JSON.stringify(modeBare),
);
const helpEntry = SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === "yolo");
assert("help entry exists", helpEntry !== undefined, JSON.stringify(helpEntry));
const suggestions = listSlashCommandSuggestions();
assert(
  "completion suggestion includes /yolo",
  suggestions.some((entry) => entry.name === "yolo" && entry.usage === "/yolo"),
  suggestions.filter((entry) => entry.name === "yolo").map((entry) => entry.usage).join(","),
);

// handler 链：/yolo 解析结果的 args 驱动 handleModeCommand 完成真实切换。
let switchedTo: string | undefined;
const modeResult = await handleModeCommand(yolo!.args, {
  getMode: () => "build",
  setMode: async (mode) => {
    switchedTo = mode;
    return mode;
  },
});
assert(
  "handler switches to yolo via parsed args",
  modeResult.mode === "yolo" && switchedTo === "yolo" && modeResult.response.includes("yolo"),
  JSON.stringify({ response: modeResult.response, switchedTo }),
);

console.log(fail === 0 ? "=== YOLO PASS ===" : `=== YOLO FAIL ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
