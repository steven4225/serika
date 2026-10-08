import type { AppInfo } from "../../shared/ui-contract.js";
import type { RunResult } from "@aisdk-agent/core";
import type { WorkTask } from "../../shared/work-tasks.js";

export interface ConversationDraft { text: string; excludeFromMemory: boolean }
/** An unavailable task stays a task target; loading must never route it to chat. */
export function bindTaskComposer(id: string | null, task: WorkTask | null):
  { kind: "chat" } | { kind: "task"; task: WorkTask | null } {
  return id === null ? { kind: "chat" } : { kind: "task", task: task?.id === id ? task : null };
}
/** Identity key shared by the in-memory cache and main-owned persistent storage. */
export function draftKey(info: Pick<AppInfo, "workspaceRoot" | "directory" | "threadId">): string {
  return JSON.stringify([info.workspaceRoot, info.directory, info.threadId]);
}
export function completionLabel(result: Pick<RunResult, "status" | "completion">): string {
  if (result.status === "cancelled") return "已停止 · 已执行的操作不会撤回";
  if (result.status === "timed_out") return "时间已用完 · 查看任务后再决定是否继续";
  switch (result.completion?.reason) {
    case "delivered": return "程序检查通过 · 任务验收见工作任务";
    case "needs_confirmation": return "需要你的确认 · 被拒绝的操作没有自动重试";
    case "needs_information": return "需要补充信息或启用所需能力";
    case "budget_exhausted": return "本轮额度已用完 · 任务尚未完成";
    case "needs_review": return "执行效果待核对 · 不会自动重做";
    default: return result.status === "completed" ? "本轮回复结束" : "本轮执行失败";
  }
}
