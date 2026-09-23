// core 侧发射形态验证：renderSwarmProgress 的标题模型段与终态 text 标签。
import { renderSwarmProgress } from "./packages/core/src/tool/handlers/agent-swarm-format.js";

const view = renderSwarmProgress({
  description: "并行检查MC服务状态",
  modelLabel: "GLM-5.3 · max",
  entries: [
    { item: "192.168.3.21", status: "done", ticks: 0, totalTokens: 5100, text: "## 内网 MC 服务器检查报告（192.168.3.21）\n**检查时间**：实际 SSH 执行" },
    { item: "182.92.235.64", status: "done", ticks: 0, text: "三项检查全部实际执行成功，结果如下。" },
    { item: "203.0.113.9", status: "failed", ticks: 0, text: "connection timed out after 10s" },
    { item: "10.0.0.5", status: "running", ticks: 9 },
    { item: "10.0.0.6", status: "suspended", ticks: 3 },
    { item: "10.0.0.7", status: "queued", ticks: 0 },
  ],
});

let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${detail ? ` — ${detail}` : ""}`);
};
check("title has model segment", view.title.includes("GLM-5.3 · max"), view.title);
check("title keeps description", view.title.includes("并行检查MC服务状态"), view.title);
check("board.modelLabel set", view.board.modelLabel === "GLM-5.3 · max");
check(
  "done cell collapses multiline text to one line",
  view.rows.some((row) => row.includes("✓ ## 内网 MC 服务器检查报告（192.168.3.21")) &&
    !view.rows.some((row) => row.includes("\n")),
  JSON.stringify(view.rows[0]),
);
check("failed cell shows reason", view.rows.some((row) => row.includes("✗ connection timed out")));
check(
  "done cell prefers text over item",
  view.rows.some((row) => row.includes("✓ 三项检查全部实际执行成功")) &&
    !view.rows.some((row) => row.includes("✓ 182.92.235.64")),
);
check("running keeps item", view.rows.some((row) => row.includes("⠋ 10.0.0.5")));
check("queued shows item", view.rows.some((row) => row.includes("· 10.0.0.7")));
check("entry text on board", (view.board.entries[0]?.text ?? "").includes("内网 MC"), view.board.entries[0]?.text?.slice(0, 40));
check("no tokens in cell label", !view.rows.some((row) => row.includes("tok")));
console.log(fail === 0 ? "=== CORE SHAPE PASS ===" : `=== CORE SHAPE FAIL ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
