/*
 * Turn/flow adaptation of zai-org/ZCode at 29628c9acdb81b703bbd4080c207a0e7ce5e276e:
 * packages/ui/src/v4/conversationTurnFlowItems.ts and conversationTurnRenderUnits.ts.
 * Copyright 2026 Z.AI Co., Ltd. Apache-2.0; third-party/zcode/NOTICE.md.
 * Modified by Serika: use existing display rows, no upstream protocol/store.
 */
import type { ConversationRow, ResultRow, TextRow, ToolRow } from "../conversation.js";

export type ConversationFlowItem =
  | { kind: "text"; row: TextRow }
  | { kind: "work"; rows: ConversationRow[] }
  | { kind: "result"; row: ResultRow };

export interface ConversationTurn {
  key: string;
  items: ConversationFlowItem[];
  running: boolean;
  copyText: string;
}

/** Preserve row order inside one work group; only settled trailing text is a final reply. */
export function conversationTurns(rows: readonly ConversationRow[], running: boolean): ConversationTurn[] {
  const groups: ConversationRow[][] = [];
  let activeRun: string | undefined;
  for (const row of rows) {
    const userBoundary = row.kind === "text" && row.role === "user" && !row.steer;
    // Failed/cancelled Runs may have no committed user message. Known Run
    // identities still keep their receipts out of the previous completed task.
    const runBoundary = row.kind === "tool" && row.runId && activeRun && row.runId !== activeRun;
    if (userBoundary || runBoundary || groups.length === 0) {
      groups.push([]);
      activeRun = undefined;
    }
    if (row.kind === "tool" && row.runId) activeRun = row.runId;
    groups.at(-1)!.push(row);
  }
  return groups.map((group, index) => {
    const live = running && index === groups.length - 1;
    const content = group.filter(row => row.kind !== "step" && row.kind !== "result");
    const tail = content.at(-1);
    // A text before an unresolved/later tool is not a final answer. Never lift it
    // over the tool, and never infer a successful run from assistant wording.
    const finalReply = !live && tail?.kind === "text" && tail.role === "assistant" ? tail : undefined;
    const foldWork = group.some(row => row.kind === "tool");
    const items: ConversationFlowItem[] = [];
    for (const row of group) {
      if (row.kind === "result") {
        if (row.status !== "completed" || row.completion) items.push({ kind: "result", row });
      } else if (row.kind === "text" && (row.role !== "assistant" || row === finalReply || !foldWork)) {
        items.push({ kind: "text", row });
      } else if (row.kind !== "step") {
        const previous = items.at(-1);
        if (previous?.kind === "work") previous.rows.push(row);
        else items.push({ kind: "work", rows: [row] });
      }
    }
    return { key: group[0]!.key, items, running: live,
      copyText: group.filter((row): row is TextRow => row.kind === "text" && row.role === "assistant").map(row => row.text).join("\n\n") };
  });
}

const attentionStatuses = new Set<ToolRow["status"]>(["unknown", "timed_out", "dispatched", "incomplete"]);

export function isMissingFile(row: ToolRow): boolean {
  return row.toolName === "read_file" && row.status === "failed" && row.errorCode === "FILE_NOT_FOUND";
}

function needsAttention(row: ToolRow): boolean {
  // A known failure stays in the summary, without forcing the whole log open.
  return attentionStatuses.has(row.status) && !isMissingFile(row) && !(row.historical && (row.status === "failed" || row.status === "timed_out"));
}

export function workSummary(rows: readonly ConversationRow[]): { label: string; needsAttention: boolean; pending: boolean } {
  const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
  const attention = tools.some(needsAttention);
  const pending = tools.some(row => row.status === "requested");
  const historical = tools.length > 0 && tools.every(row => row.historical);
  return { label: `${historical ? "历史执行" : "执行过程"} · ${tools.length} 次工具调用${attention ? " · 有结果待查看" : pending ? " · 调用未结束" : tools.some(isMissingFile) ? " · 文件不存在" : tools.some(row => row.status === "failed" || row.status === "timed_out") ? " · 有调用未成功" : tools.some(row => row.status === "denied") ? " · 有调用被拒绝" : ""}`, needsAttention: attention, pending };
}

/** Compact facts only: arbitrary Shell success does not establish task/check completion. */
export function compactWorkSummary(rows: readonly ConversationRow[], running: boolean, waitingForApproval: boolean) {
  const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
  const { needsAttention, pending } = workSummary(rows);
  const commands = tools.filter(row => (row.toolName === "shell_exec" || row.toolName === "terminal_exec")).length;
  const changed = new Set(tools.filter(row => (row.toolName === "write_file" || row.toolName === "edit_file") && row.status === "ok" && row.receipt)
    .map(row => row.receipt!.path)).size;
  const failedCommands = tools.filter(row => (row.toolName === "shell_exec" || row.toolName === "terminal_exec") && row.status === "failed").length;
  const failedOthers = tools.filter(row => row.toolName !== "shell_exec" && row.toolName !== "terminal_exec" && row.status === "failed" && !isMissingFile(row)).length;
  const notices = [
    tools.some(row => row.status === "unknown") ? "效果未知 · 需人工核对，不自动重做" : "",
    tools.some(row => row.status === "dispatched") ? "动作已派发 · 待核对" : "",
    tools.some(row => row.status === "incomplete") ? "回执不完整 · 待核对" : "",
    tools.some(row => row.status === "timed_out") ? "有调用超时" : "",
    failedCommands ? `曾有 ${failedCommands} 次命令失败` : "",
    failedOthers ? `曾有 ${failedOthers} 次调用失败` : "",
    tools.some(isMissingFile) ? "文件不存在" : "",
    tools.some(row => row.status === "denied") ? "有调用被拒绝" : "",
  ].filter(Boolean);
  const settled = tools.filter(row => row.status !== "requested").length;
  const title = running ? `${waitingForApproval ? "等待确认后继续" : "正在执行"} · 已结束 ${settled} 步`
    : `${tools.length > 0 && tools.every(row => row.historical) ? "历史执行" : "执行过程"} · ${tools.length} 步`;
  return { title, facts: [changed ? `修改 ${changed} 个文件` : "", commands ? `${commands} 次命令` : ""].filter(Boolean).join(" · "),
    notice: notices.join(" · "), needsAttention, pending };
}

export function toolPresentation(row: ToolRow): { name: string; status: string; icon: "terminal" | "memory" | "timer" | "activity"; attention: boolean } {
  const names: Record<string, string> = { computer_observe: "观察应用", computer_action: "操作应用", read_file: "读取文件", list_directory: "查看目录", search_files: "查找文件", write_file: "写入文件", edit_file: "编辑文件", shell_exec: "运行命令", terminal_exec: "控制本地终端", web_fetch: "读取网页", web_search: "搜索网页", feed_read: "读取订阅", memory_add: "保存记忆", memory_update: "更新记忆", task_create: "创建提醒", task_reschedule: "调整提醒", task_cancel: "取消提醒", task_repeat_create: "重复提醒", task_repeat_cancel: "取消重复提醒", task_repeat_pause: "暂停重复提醒", task_repeat_resume: "恢复重复提醒", checkpoint_save: "保存进度" };
  const statuses: Record<ToolRow["status"], string> = { requested: "调用中", ok: "返回成功", incomplete: "回执不完整", observed: "观察已返回", dispatched: "已派发 · 待核对", not_started: "未执行", failed: "失败", denied: "已拒绝", unknown: "效果未知", timed_out: "超时", cancelled: "已取消" };
  return { name: names[row.toolName] ?? row.toolName, status: isMissingFile(row) ? "文件不存在" : statuses[row.status], attention: needsAttention(row),
    icon: (row.toolName === "shell_exec" || row.toolName === "terminal_exec") ? "terminal" : row.toolName.startsWith("memory_") ? "memory" : row.toolName.startsWith("task_") ? "timer" : "activity" };
}
