import type { SwarmProgressBoard } from "@zcode/contracts";
import { asRecord, numberField, stringField } from "./state.js";
import { truncateDisplay } from "./app-terminal-width.js";
import type { ToolTranscriptInputProjection } from "./app-tool-transcript.js";

// AgentSwarm 进度事件 payload 的结构化解析：从 ToolCallProgress 的
// swarmProgress.board 重建 SwarmProgressBoard，供专用视图渲染。

export function swarmBoardFromPayload(payload: Record<string, unknown>): SwarmProgressBoard | undefined {
  const swarm = asRecord(payload.swarmProgress);
  if (swarm === null) return undefined;
  const board = asRecord(swarm.board);
  if (board === null) return undefined;
  const entriesRaw = Array.isArray(board.entries) ? board.entries : [];
  return {
    description: stringField(board, "description") ?? "",
    total: numberField(board, "total") ?? 0,
    done: numberField(board, "done") ?? 0,
    failed: numberField(board, "failed") ?? 0,
    running: numberField(board, "running") ?? 0,
    entries: entriesRaw.map((entry, position) => {
      const record = asRecord(entry);
      const status = stringField(record, "status");
      const tokens = numberField(record, "tokens");
      return {
        index: numberField(record, "index") ?? position + 1,
        status:
          status === "running" || status === "done" || status === "failed"
            ? status
            : ("queued" as const),
        ticks: numberField(record, "ticks") ?? 0,
        item: stringField(record, "item") ?? "",
        ...(tokens === undefined ? {} : { tokens }),
      };
    }),
  };
}

export function swarmTitleFromPayload(payload: Record<string, unknown>): string | undefined {
  const swarm = asRecord(payload.swarmProgress);
  const title = swarm === null ? undefined : stringField(swarm, "title");
  return title !== undefined && title.length > 0 ? title : undefined;
}

export function swarmRowsFromPayload(payload: Record<string, unknown>): string[] | undefined {
  const swarm = asRecord(payload.swarmProgress);
  return Array.isArray(swarm?.rows) ? (swarm?.rows as string[]) : undefined;
}

export function agentSwarmProjection(record: Record<string, unknown>): ToolTranscriptInputProjection {
  const items = Array.isArray(record["items"]) ? (record["items"] as unknown[]) : [];
  const resumeIds = asRecord(record["resume_agent_ids"]);
  const resumeCount = resumeIds ? Object.keys(resumeIds).length : 0;
  const description =
    typeof record["description"] === "string" && record["description"].length > 0
      ? record["description"]
      : undefined;
  const total = items.length + resumeCount;
  // 与运行期进度板同款线框；首个 progress 事件到达后由动态板接管。
  const head = "Agent Swarm";
  const desc = description === undefined ? "" : ` ─ ${description}`;
  const idWidth = Math.max(3, String(Math.max(1, total)).length);
  const rows = [
    ...items.map((item) => `· ${truncateDisplay(String(item), 34)}`),
    ...Array.from({ length: resumeCount }, () => "⠏ resume"),
  ];
  const detailLines = rows.map((row, i) => `${String(i + 1).padStart(idWidth, "0")} [⣀⣀⣀⣀] ${row}`);
  const used = head.length + desc.length + 2;
  const tail = "─".repeat(Math.max(1, 88 - used - 1));
  return {
    title: `${head}${desc} ${tail}`.slice(0, 88),
    detailLines,
  };
}

