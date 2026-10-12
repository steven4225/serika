import type { WorkTask } from "../../../shared/work-tasks.js";
import { humanFacingTitle } from "../../../shared/human-title.js";
import type { ReminderSpeechClock } from "../reminder-copy.js";
import { localWhen, reminderRows, type ReminderDisplayRow } from "../reminder-copy.js";
import { taskActions, taskNextAction, taskStatusLabels, taskVerificationSummary } from "../work-task-data.js";

/**
 * Personal tasks presentation. Grouping and copy only: no scheduling, no Run,
 * and no success claim for a reminder that has not been saved.
 */

export const TASK_DAY_BUCKETS = ["今天", "昨天", "近 7 天", "即将", "更早", "时间未定"] as const;
export type TaskDayBucket = (typeof TASK_DAY_BUCKETS)[number];

export const TASK_CREATE_PROMPT = "我想创建一件任务。请先用一两句话确认目标，再帮我拆开。确认之前不要执行，也不要当成已经完成。";

export const TASK_EXAMPLE_PROMPTS = [
  { label: "整理一份说明", prompt: "帮我把这件事整理成一份可核对的说明。先确认材料和要交到哪里。确认之前不要执行。" },
  { label: "把一个问题查清楚", prompt: "帮我把这个问题查清楚，并记下带来源的结论。先确认范围。确认之前不要执行。" },
] as const;

export interface ScheduleTemplate {
  id: string;
  title: string;
  blurb: string;
  prompt: string;
}

const confirmBeforeSave = "先跟我确认时间和内容。确认保存之前，不要说已经设好。";

export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  { id: "morning-brief", title: "每日优先事项简报", blurb: "每天早上从日程、待办和消息里整理最重要的几件事。", prompt: `请帮我设一个每天早上的优先事项简报：从日程、待办和消息里整理最重要的几件事。${confirmBeforeSave}` },
  { id: "mail-digest", title: "邮件今日速览", blurb: "把新邮件按需要回复、需要行动、等待结果和仅供了解分类。", prompt: `请帮我设一个邮件今日速览：把新邮件按需要回复、需要行动、等待结果和仅供了解分类。${confirmBeforeSave}` },
  { id: "reply-check", title: "待回复事项检查", blurb: "找出邮件和消息里仍需要你回复、确认或补材料的对话。", prompt: `请帮我设一个待回复事项检查：找出邮件和消息里仍需要我回复、确认或补材料的对话。${confirmBeforeSave}` },
  { id: "meeting-prep", title: "今日会议准备", blurb: "提前整理今天重要会议的背景、议程和需要确认的问题。", prompt: `请帮我准备今天的重要会议，整理背景、议程和需要确认的问题。先确认是哪一场。确认之前不要把它说成已经完成。` },
  { id: "weekly-status", title: "每周项目进展汇总", blurb: "每周整理重点项目的进展、风险、阻塞和下一步。", prompt: `请帮我设一个每周的项目进展汇总：整理重点项目的进展、风险、阻塞和下一步。${confirmBeforeSave}` },
  { id: "deadline-watch", title: "截止事项提前检查", blurb: "提前发现未来两周的重要 Deadline，整理材料、依赖和风险。", prompt: `请帮我设一个截止事项提前提醒：查看未来两周的重要截止日期，整理材料、依赖和风险。${confirmBeforeSave}` },
  { id: "open-loops", title: "未完成事项跟进", blurb: "跟进还没做完的事，整理卡在哪里、还差什么。", prompt: "请帮我跟进还没做完的事，整理卡在哪里、还差什么。先确认要跟进哪些。确认之前不要把它说成已经完成。" },
];

export interface TaskComposerHandoff {
  mode: "chat" | "task";
  taskId: string | null;
  text: string;
  policy: "fill" | "replace";
}

export function planTaskCreateHandoff(prompt = TASK_CREATE_PROMPT): TaskComposerHandoff {
  return { mode: "chat", taskId: null, text: prompt, policy: "fill" };
}

export function taskFollowUpPrompt(title: string): string {
  const name = humanFacingTitle(title, "这项任务");
  return `我想继续了解「${name}」。请基于已经回来的结果回答。如果结果失败或还不确定，直接说明，不要说已经完成或已经提醒到我。`;
}

export function planTaskFollowUpHandoff(title: string): TaskComposerHandoff {
  return { mode: "chat", taskId: null, text: taskFollowUpPrompt(title), policy: "replace" };
}

/** Runnable work continues in the existing task composer. Everything else stays ordinary chat. */
export function planTaskContinueHandoff(task: WorkTask, draft: string): TaskComposerHandoff {
  const text = draft.trim() || taskFollowUpPrompt(humanFacingTitle(task.goal, "这项任务"));
  if (taskActions(task).run) return { mode: "task", taskId: task.id, text, policy: "replace" };
  return { mode: "chat", taskId: null, text, policy: "replace" };
}

export function nextComposerText(current: string, handoff: TaskComposerHandoff): string {
  if (handoff.policy === "fill" && current.trim()) return current;
  return handoff.text;
}

export function taskReturnLabel(title: string): string {
  return `来自任务：${humanFacingTitle(title, "这项任务")} · 继续追问`;
}

/** A failed or interrupted result keeps its subject. It never borrows a success sentence. */
export function inboxReturnTitle(task: { status: string; resultText?: string | null; prompt?: string | null }): string {
  if (task.status !== "completed") return humanFacingTitle(task.prompt, "这项任务");
  const raw = (task.resultText?.trim() || task.prompt || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(raw);
  const clipped = chars.length > 32 ? `${chars.slice(0, 31).join("")}…` : raw;
  return humanFacingTitle(clipped, "这项任务");
}

function localMidnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Exclusive local buckets. 今天, 昨天 and 近 7 天 together cover seven local days. */
export function taskDayBucket(at: string, now: Date): TaskDayBucket {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "时间未定";
  const diff = Math.round((localMidnight(now) - localMidnight(new Date(time))) / 86_400_000);
  if (diff < 0) return "即将";
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff <= 6) return "近 7 天";
  return "更早";
}

export function groupTaskRows<T extends { at: string }>(rows: readonly T[], now: Date): { bucket: TaskDayBucket; items: T[] }[] {
  const groups = new Map<TaskDayBucket, T[]>();
  const sorted = [...rows].sort((left, right) => {
    const a = Date.parse(left.at);
    const b = Date.parse(right.at);
    return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0);
  });
  for (const row of sorted) {
    const bucket = taskDayBucket(row.at, now);
    const items = groups.get(bucket) ?? [];
    items.push(row);
    groups.set(bucket, items);
  }
  return TASK_DAY_BUCKETS.flatMap(bucket => {
    const items = groups.get(bucket);
    return items && items.length > 0 ? [{ bucket, items }] : [];
  });
}

export interface WorkTaskRow {
  key: string;
  title: string;
  at: string;
}

export function workTaskRows(tasks: readonly WorkTask[]): WorkTaskRow[] {
  return tasks.map(task => ({
    key: task.id,
    title: humanFacingTitle(task.goal, "未命名任务"),
    at: task.updatedAt,
  }));
}

export function taskWhenLabel(at: string, now: Date, clock: ReminderSpeechClock): string {
  const bucket = taskDayBucket(at, now);
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return "时间未记录";
  if (bucket === "今天" || bucket === "昨天") {
    const hm = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: clock.timeZone,
    }).format(new Date(time));
    return `${bucket} ${hm}`;
  }
  return localWhen(at, clock);
}

export interface TaskArtifactCard {
  label: string;
  path: string;
}

export function taskArtifactCards(task: WorkTask): TaskArtifactCard[] {
  const paths = [
    ...(task.delivery?.artifactRefs ?? []),
    ...task.acceptance.flatMap(item => item.verification.kind === "artifact_exists" ? [item.verification.path] : []),
  ];
  const seen = new Set<string>();
  const cards: TaskArtifactCard[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const base = path.split("/").pop() || "产物";
    cards.push({ label: humanFacingTitle(base, "产物"), path });
  }
  return cards;
}

export function taskProgressLines(task: WorkTask): string[] {
  const lines = [taskStatusLabels[task.status]];
  const summary = taskVerificationSummary(task);
  if (summary) lines.push(summary);
  lines.push(`下一步：${taskNextAction(task)}`);
  if (task.delivery?.summary.trim()) lines.push(task.delivery.summary.trim());
  if (task.delivery?.unresolved.length) lines.push(`还有没解决的：${task.delivery.unresolved.join("、")}`);
  if (task.status === "needs_review") lines.push("上次执行的效果还不确定。先核对，不会自动重做，也不会当成已经成功。");
  return lines;
}

export interface ScheduledTaskRow extends ReminderDisplayRow {
  at: string;
  title: string;
}

export function scheduledTaskRows(input: Parameters<typeof reminderRows>[0], clock: ReminderSpeechClock): { rows: ScheduledTaskRow[]; other: number } {
  const atById = new Map<string, string>();
  for (const task of input.scheduled) {
    if (task.arrangement?.kind === "reminder") atById.set(task.id, task.runAt);
  }
  for (const task of input.recurring) {
    if (task.arrangement?.kind === "reminder" && task.nextRunAt) atById.set(task.id, task.nextRunAt);
  }
  const view = reminderRows(input, clock);
  return {
    other: view.other,
    rows: view.rows.map(row => ({
      ...row,
      at: atById.get(row.id) ?? "",
      title: humanFacingTitle(row.subject, "提醒"),
    })),
  };
}
