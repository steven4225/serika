import type { UiState } from "../../shared/ui-contract.js";
import type { ConversationRow } from "./conversation.js";

export type AttentionKind = "approval" | "unknown" | "memory" | "none";

export function isMockModel(alias: string | undefined): boolean {
  return alias === "mock" || alias?.startsWith("mock/") === true;
}

/** Presentation priority only. It never changes permissions or controller state. */
export function attentionKind(input: { approval: boolean; unknownRuns: number; pendingMemory: number; idle: boolean; memoryDeferred?: boolean }): AttentionKind {
  if (input.approval) return "approval";
  if (input.unknownRuns > 0) return "unknown";
  if (input.idle && input.pendingMemory > 0 && !input.memoryDeferred) return "memory";
  return "none";
}

export function headerStatus(state: UiState, attention: AttentionKind): { label: string; tone: "idle" | "active" | "awaiting" | "review" } {
  if (attention === "approval") return { label: "等待确认", tone: "awaiting" };
  switch (state.kind) {
    case "running": return { label: state.phase === "skill" && state.background === true ? "后台 Skill，可继续聊天" : state.phase === "consolidation" && state.background === true ? "后台整理记忆，可继续聊天" : state.runId === null ? "正在启动" : state.phase === "skill" ? "正在运行 Skill" : state.phase === "consolidation" ? "正在整理记忆" : "正在处理", tone: "active" };
    case "compacting": return { label: "正在压缩上下文", tone: "active" };
    case "resuming": return { label: "正在核对工作区", tone: "active" };
    case "command": return { label: state.name === "memory-review" ? "审核记忆" : "正在执行命令", tone: "active" };
    case "idle":
      if (attention === "unknown") return { label: "有效果待核对", tone: "review" };
      if (attention === "memory") return { label: "有记忆待审", tone: "review" };
      return { label: "空闲", tone: "idle" };
  }
}

export function loadedCountLabel(count: number, hasMore: boolean): string | null {
  return count > 0 ? `${count}${hasMore ? "+" : ""}` : null;
}

/** Fold only a committed final assistant reply after tools in its own user turn. */
export function deliveredReplyKeys(rows: readonly ConversationRow[]): Set<string> {
  const keys = new Set<string>();
  let hadTool = false;
  let finalText: string | null = null;
  for (const row of rows) {
    if (row.kind === "text" && row.role === "user") {
      if (finalText !== null) keys.add(finalText);
      hadTool = false;
      finalText = null;
    } else if (row.kind === "tool") {
      hadTool = true;
      finalText = null;
    } else if (row.kind === "text" && row.role === "assistant" && row.committed && hadTool) {
      finalText = row.key;
    }
  }
  if (finalText !== null) keys.add(finalText);
  return keys;
}
