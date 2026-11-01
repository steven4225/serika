import { reminderWhen } from "@serika/assistant/browser";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { humanFacingTitle } from "../../../shared/human-title.js";
import type { ReminderSpeechClock } from "../reminder-copy.js";
import { localWhen, reminderRows, scheduleStatusLabel, type ReminderDisplayRow } from "../reminder-copy.js";
import { workTaskPhase } from "../../../shared/work-tasks.js";
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
  purpose?: "arrangement";
  taskId: string | null;
  text: string;
  /** fill keeps a non-empty composer draft. replace is not used by create or continue. */
  policy: "fill" | "replace";
}

export function planTaskCreateHandoff(prompt = ""): TaskComposerHandoff {
  return { mode: "chat", taskId: null, text: prompt, policy: "fill" };
}

export function taskFollowUpPrompt(title: string): string {
  const name = humanFacingTitle(title, "这项任务");
  return `我想继续了解「${name}」。请基于已经回来的结果回答。如果结果失败或还不确定，直接说明，不要说已经完成或已经提醒到我。`;
}

/** Saved inbox result used to continue. The chip title is separate and display-only. */
export interface ReturnedTaskSource {
  id: string;
  status: string;
  statusLabel: string;
  prompt: string;
  resultText: string | null;
  errorMessage: string | null;
}

export function returnedTaskSource(task: {
  id: string;
  status: string;
  prompt?: string | null;
  resultText?: string | null;
  error?: { message?: string | null } | null;
  runAt?: string | null;
  arrangement?: { kind?: string } | null;
}, now = new Date()): ReturnedTaskSource {
  return {
    id: task.id,
    status: task.status,
    statusLabel: scheduleStatusLabel(task.status, task.runAt, now, task.arrangement?.kind),
    prompt: task.prompt ?? "",
    resultText: task.resultText ?? null,
    errorMessage: task.error?.message?.trim() || null,
  };
}

function followUpBody(source: ReturnedTaskSource): string {
  const result = source.resultText?.trim() ?? "";
  const error = source.errorMessage?.trim() ?? "";
  if (result && error && error !== result) return `${result}\n错误：${error}`;
  if (result) return result;
  if (error) return error;
  const prompt = source.prompt.trim();
  return prompt || "没有保存结果正文。";
}

/** Title in quotes is the chip summary. The source id, status and body are the result itself. */
export function taskResultFollowUpPrompt(source: ReturnedTaskSource): string {
  const name = humanFacingTitle(inboxReturnTitle(source), "这项任务");
  return [
    `我想继续了解「${name}」。引号里只是显示用的摘要。`,
    `来源编号：${source.id}`,
    `实际状态：${source.status}（${source.statusLabel}）`,
    "结果全文：",
    followUpBody(source),
    "请基于这份来源编号、实际状态和结果全文回答。如果结果失败或还不确定，直接说明，不要说已经完成或已经提醒到我。",
  ].join("\n");
}

export function planTaskFollowUpHandoff(source: ReturnedTaskSource): TaskComposerHandoff {
  return { mode: "chat", taskId: null, text: taskResultFollowUpPrompt(source), policy: "fill" };
}

/** Runnable work continues in the existing task composer. Everything else stays ordinary chat. */
export function planTaskContinueHandoff(task: WorkTask, draft: string): TaskComposerHandoff {
  const text = draft.trim() || taskFollowUpPrompt(humanFacingTitle(task.goal, "这项任务"));
  if (taskActions(task).run) return { mode: "task", taskId: task.id, text, policy: "fill" };
  return { mode: "chat", taskId: null, text, policy: "fill" };
}

export function planScheduleContinueHandoff(row: { title: string; family: "reminder" | "schedule" }, draft: string): TaskComposerHandoff {
  const name = humanFacingTitle(row.title, row.family === "reminder" ? "这项提醒" : "这项安排");
  const text = draft.trim() || scheduleContinueFallback(row.family, name);
  return { mode: "chat", taskId: null, text, policy: "fill" };
}

function scheduleContinueFallback(family: "reminder" | "schedule", name: string): string {
  switch (family) {
    case "reminder":
      return `我想调整「${name}」。先确认新的时间。确认之前不要说已经改好。`;
    case "schedule":
      return `我想调整「${name}」这项定时安排。先确认要改什么。确认之前不要说已经改好。`;
    default: {
      const unreachable: never = family;
      return unreachable;
    }
  }
}

export function nextComposerText(current: string, handoff: TaskComposerHandoff): string {
  if (handoff.policy === "fill" && current.trim()) return current;
  return handoff.text;
}

/** Null means the current task supplement must not be written or autosaved. */
export function nextTaskInstruction(current: string, handoff: TaskComposerHandoff): string | null {
  const next = nextComposerText(current, handoff);
  return next === current ? null : next;
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
  status: string;
}

export function workTaskRows(tasks: readonly WorkTask[]): WorkTaskRow[] {
  return tasks.map(task => ({
    key: task.id,
    title: humanFacingTitle(task.goal, "未命名任务"),
    at: task.updatedAt,
    status: taskStatusLabels[workTaskPhase(task)],
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
  const lines = [taskStatusLabels[workTaskPhase(task)]];
  const summary = taskVerificationSummary(task);
  if (summary) lines.push(summary);
  lines.push(`下一步：${taskNextAction(task)}`);
  if (task.delivery?.summary.trim()) lines.push(task.delivery.summary.trim());
  if (task.delivery?.unresolved.length) lines.push(`还有没解决的：${task.delivery.unresolved.join("、")}`);
  if (workTaskPhase(task) === "needs_review") lines.push("上次执行的效果还不确定。先核对，不会自动重做，也不会当成已经成功。");
  return lines;
}

export interface ScheduledTaskRow extends ReminderDisplayRow {
  at: string;
  title: string;
  family: "reminder" | "schedule";
  kindLabel: string;
  /** Saved reminder body. Null while the instance has not finished. */
  resultText: string | null;
}

function scheduleKindLabel(kind: string | undefined): string {
  if (kind === "reminder") return "提醒";
  if (kind === "todoist-brief") return "Todoist 日报";
  if (kind === "rss-digest") return "RSS 资讯";
  if (kind === "skill") return "定时技能";
  return "定时安排";
}

function scheduleFamily(kind: string | undefined): "reminder" | "schedule" {
  return kind === "reminder" ? "reminder" : "schedule";
}

/**
 * The 定时任务 tab lists every arrangement in this overview, reminders and
 * otherwise. `other` stays 0 because nothing in the payload is held back for 设置.
 */
export function scheduledTaskRows(input: Parameters<typeof reminderRows>[0], clock: ReminderSpeechClock): { rows: ScheduledTaskRow[]; other: number } {
  const atById = new Map<string, string>();
  const kindByKey = new Map<string, string | undefined>();
  for (const task of input.scheduled) {
    atById.set(task.id, task.runAt);
    kindByKey.set(`once:${task.id}`, task.arrangement?.kind);
  }
  for (const task of input.recurring) {
    if (task.nextRunAt) atById.set(task.id, task.nextRunAt);
    kindByKey.set(`recurring:${task.id}`, task.arrangement?.kind);
  }
  const reminders = reminderRows(input, clock);
  const seen = new Set(reminders.rows.map(row => `${row.kind}:${row.id}`));
  const extras: ReminderDisplayRow[] = [];
  for (const task of input.scheduled) {
    if (seen.has(`once:${task.id}`)) continue;
    extras.push({
      id: task.id,
      subject: task.promptPreview,
      when: localWhen(task.runAt, clock),
      status: scheduleStatusLabel(task.status, task.runAt, clock.now, task.arrangement?.kind),
      kind: "once",
      canCancel: task.status === "pending",
    });
  }
  for (const task of input.recurring) {
    if (seen.has(`recurring:${task.id}`)) continue;
    const phrase = reminderWhen({ recurrence: task.recurrence, clock }).phrase;
    const next = task.nextRunAt === null ? null : localWhen(task.nextRunAt, clock);
    extras.push({
      id: task.id,
      subject: task.promptPreview,
      when: next === null ? phrase : `${phrase} · 下次 ${next}`,
      status: scheduleStatusLabel(task.status, task.nextRunAt, clock.now, task.arrangement?.kind),
      kind: "recurring",
      canCancel: task.status !== "cancelled",
    });
  }
  return {
    other: 0,
    rows: [...reminders.rows, ...extras].map(row => {
      const arrangementKind = kindByKey.get(`${row.kind}:${row.id}`);
      const family = scheduleFamily(arrangementKind);
      const kindLabel = scheduleKindLabel(arrangementKind);
      return {
        ...row,
        at: atById.get(row.id) ?? "",
        title: humanFacingTitle(row.subject, family === "reminder" ? "提醒" : kindLabel),
        family,
        kindLabel,
        resultText: null,
      };
    }),
  };
}

/** Unacknowledged reminder results belong on the same task entry as the schedule. */
export function settledReminderRows(tasks: readonly {
  id: string;
  promptPreview: string;
  resultPreview: string | null;
  status: string;
  runAt: string;
  arrangement?: { kind?: string } | null;
}[], clock: ReminderSpeechClock): ScheduledTaskRow[] {
  return tasks.flatMap(task => {
    if (task.arrangement?.kind !== "reminder" || task.status !== "completed") return [];
    const subject = task.promptPreview;
    return [{
      id: task.id,
      subject,
      when: localWhen(task.runAt, clock),
      status: scheduleStatusLabel(task.status, task.runAt, clock.now, "reminder"),
      kind: "once" as const,
      canCancel: false,
      at: task.runAt,
      title: humanFacingTitle(subject, "提醒"),
      family: "reminder" as const,
      kindLabel: "提醒",
      resultText: task.resultPreview,
    }];
  });
}
