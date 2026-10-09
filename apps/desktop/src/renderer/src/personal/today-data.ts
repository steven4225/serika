import type { AppInfo } from "../../../shared/ui-contract.js";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { selectCurrentTask, taskStatusLabels } from "../work-task-data.js";

/** The Today view uses one explicit timezone; it does not invent weather or a user name. */
export function todayClock(date: Date) {
  const timeZone = "Asia/Shanghai";
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date));
  return {
    time: new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date),
    date: new Intl.DateTimeFormat("zh-CN", { timeZone, month: "long", day: "numeric", weekday: "long" }).format(date),
    greeting: hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好",
  };
}

export type TodayTaskSummary =
  | { state: "connecting" | "disabled" | "loading"; message: string }
  | { state: "failed"; message: string }
  | { state: "ready"; ongoing: number; awaiting: number; completed: number; current: WorkTask | null; currentStatus: string | null };

/** A bounded list projection, never a global count, completion judgment, or new task state. */
export function todayTaskSummary(info: AppInfo | null, tasks: readonly WorkTask[], loading: boolean, error: string | null): TodayTaskSummary {
  if (!info) return { state: "connecting", message: "正在连接工作区…" };
  if (!info.workTasks) return { state: "disabled", message: "工作任务未启用，你仍然可以直接聊天。" };
  if (error) return { state: "failed", message: error };
  if (loading) return { state: "loading", message: "正在读取当前会话的任务…" };
  const current = selectCurrentTask(tasks.filter(task => !["completed", "cancelled"].includes(task.status)));
  return {
    state: "ready",
    ongoing: tasks.filter(task => ["ready", "running", "paused"].includes(task.status)).length,
    awaiting: tasks.filter(task => ["needs_review", "awaiting_acceptance"].includes(task.status)).length,
    completed: tasks.filter(task => task.status === "completed").length,
    current,
    currentStatus: current ? taskStatusLabels[current.status] : null,
  };
}

export function todayMemorySummary(info: AppInfo | null, pending: number, error: string | null): string {
  if (!info) return "正在连接记忆…";
  if (!info.memory.enabled) return "记忆未启用。";
  if (error) return `记忆状态读取失败：${error}`;
  if (pending > 0) return `当前会话有 ${pending} 条记忆等你确认。`;
  return "查看已保存的信息，或告诉 Serika 新的偏好。";
}
