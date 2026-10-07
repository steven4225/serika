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

/** Preserve the row order; only completed work before the final reply can fold. */
export function conversationTurns(rows: readonly ConversationRow[], running: boolean): ConversationTurn[] {
  const groups: ConversationRow[][] = [];
  for (const row of rows) {
    if ((row.kind === "text" && row.role === "user") || groups.length === 0) groups.push([]);
    groups.at(-1)!.push(row);
  }
  return groups.map((group, index) => {
    const live = running && index === groups.length - 1;
    const content = group.filter(row => row.kind !== "step" && row.kind !== "result");
    const tail = content.at(-1);
    // A text before an unresolved/later tool is not a final answer. Never lift it
    // over the tool, and never infer a successful run from assistant wording.
    const finalReply = !live && tail?.kind === "text" && tail.role === "assistant" ? tail : undefined;
    const foldWork = group.some(row => row.kind === "tool") && finalReply !== undefined;
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

const attentionStatuses = new Set<ToolRow["status"]>(["failed", "unknown", "timed_out", "dispatched", "incomplete"]);

export function workSummary(rows: readonly ConversationRow[]): { label: string; needsAttention: boolean; pending: boolean } {
  const tools = rows.filter((row): row is ToolRow => row.kind === "tool");
  const needsAttention = tools.some(row => attentionStatuses.has(row.status));
  const pending = tools.some(row => row.status === "requested");
  return { label: `执行过程 · ${tools.length} 次工具调用${needsAttention ? " · 有结果待查看" : pending ? " · 调用未结束" : tools.some(row => row.status === "denied") ? " · 有调用被拒绝" : ""}`, needsAttention, pending };
}

export function toolPresentation(row: ToolRow): { name: string; status: string; icon: "terminal" | "memory" | "timer" | "activity"; attention: boolean } {
  const names: Record<string, string> = { computer_observe: "观察应用", computer_action: "操作应用", read_file: "读取文件", write_file: "写入文件", edit_file: "编辑文件", shell_exec: "运行命令", web_fetch: "读取网页", web_search: "搜索网页", feed_read: "读取订阅", memory_add: "保存记忆", memory_update: "更新记忆", task_create: "创建提醒", task_reschedule: "调整提醒", checkpoint_save: "保存进度" };
  const statuses: Record<ToolRow["status"], string> = { requested: "调用中", ok: "返回成功", incomplete: "回执不完整", observed: "观察已返回", dispatched: "已派发 · 待核对", not_started: "未执行", failed: "失败", denied: "已拒绝", unknown: "效果未知", timed_out: "超时", cancelled: "已取消" };
  return { name: names[row.toolName] ?? row.toolName, status: statuses[row.status], attention: attentionStatuses.has(row.status),
    icon: row.toolName === "shell_exec" ? "terminal" : row.toolName.startsWith("memory_") ? "memory" : row.toolName.startsWith("task_") ? "timer" : "activity" };
}
