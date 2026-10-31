import { formatOnceWhen, reminderWhen } from "@serika/assistant/browser";
import type { HomeItem, ReminderConfirmationFields, ReminderSpeechClock } from "@serika/assistant";
import type { Recurrence } from "@serika/assistant";
import type { PendingApproval } from "../../shared/ui-contract.js";
import type { ConversationRow, ToolRow } from "./conversation.js";

/**
 * Display copy for reminders the user already saved or is about to confirm.
 * It does not schedule, retry, or decide whether a notification was delivered.
 */

export type { ReminderSpeechClock };

export function reminderClock(now = new Date()): ReminderSpeechClock {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { now, timeZone: timeZone && timeZone.length > 0 ? timeZone : "UTC" };
}

export function localWhen(instant: string, clock: ReminderSpeechClock): string {
  return formatOnceWhen(instant, clock);
}

const speechPattern = /已(?:定|记下|改到|取消|暂停|恢复)：[^\n]+/;

/** The #123 reminder sentence, without a trailing English status word. */
export function reminderSpeechLine(text: string | undefined): string | null {
  if (text === undefined) return null;
  const match = speechPattern.exec(text);
  if (match === null) return null;
  const line = match[0]
    .replace(/\s*\b(?:scheduled|status|runAt)\b[\s\S]*$/i, "")
    .trim()
    .replace(/[。\s]+$/, "");
  return line.length > 0 ? line : null;
}

export type ReminderReplyResult = Pick<ToolRow, "toolName" | "status" | "reminder">;
const reminderWriteTools = new Set(["task_create", "task_repeat_create", "task_reschedule", "task_cancel", "task_repeat_cancel", "task_repeat_pause", "task_repeat_resume"]);

/** Associate only preceding calls in this user turn; reads and prior turns grant no context. */
export function reminderReplyContexts(rows: readonly ConversationRow[]): { byText: ReadonlyMap<string, ReminderReplyResult>; latest: ReminderReplyResult | undefined } {
  const byText = new Map<string, ReminderReplyResult>();
  let latest: ReminderReplyResult | undefined;
  let writes = 0;
  for (const row of rows) {
    if (row.kind === "text" && row.role === "user" && !row.steer) { latest = undefined; writes = 0; }
    else if (row.kind === "tool" && reminderWriteTools.has(row.toolName)) {
      writes++;
      latest = writes === 1 ? row : undefined; // A multi-operation report cannot be replaced by one receipt.
    }
    else if (row.kind === "text" && row.role === "assistant" && latest) byText.set(row.key, latest);
  }
  return { byText, latest };
}

/** Never infer execution failure from a user's subject or ordinary assistant prose. */
export function presentReminderReply(text: string, result?: ReminderReplyResult): { primary: string; aside: string | null } {
  const plain = { primary: text, aside: null };
  if (!result || !reminderWriteTools.has(result.toolName)) return plain;
  // A technical explanation after a call is still an explanation, not a readback.
  const receiptReply = /^\s*(?:已(?:定|记下|改到|取消|暂停|恢复)：|task_(?:repeat_)?(?:create|reschedule|cancel|pause|resume)\s+(?:failed|error)\b|\{\s*"(?:status|runAt)")/.test(text);
  if (!receiptReply) return plain;
  if (result.status === "failed" || result.status === "timed_out") {
    const primary = result.toolName === "task_reschedule" ? "这次提醒没有改成。"
      : result.toolName === "task_create" || result.toolName === "task_repeat_create" ? "这次提醒没有设成。" : "这次提醒操作没有完成。";
    return { primary, aside: text };
  }
  if (result.status === "unknown") return { primary: "这次提醒是否设好还不确定。请先核对，不要重复创建。", aside: text };
  if (result.status !== "ok") return plain;
  if (!result.reminder) return plain; // Incomplete/legacy receipts cannot justify a shorter success claim.
  let primary = result.reminder.readback;
  if (result.reminder.backgroundReady === false) {
    primary = primary.replace(/^已(?:定|记下)：/, "");
    if (!primary.includes("到点不能保证执行")) primary += "。但后台当前不可用或尚未就绪，到点不能保证执行；请核对后台服务，不要重复创建。";
  }
  return { primary, aside: text.trim() === primary ? null : text };
}

export interface ReminderConfirmationCard {
  title: string;
  time: string;
  repeat: string;
  subject: string;
  previous: string | null;
  safety: string;
  details: string;
  allowLabel: string;
}

/** Card copy for each reminder confirmation action. */
const CONFIRMATION_COPY: Record<ReminderConfirmationFields["action"], { title: string; allowLabel: string; safety: string }> = {
  save: { title: "设置提醒", allowLabel: "确认保存", safety: "确认后才会保存。保存不等于已经提醒到你。" },
  reschedule: { title: "调整提醒", allowLabel: "确认改期", safety: "确认后才会改时间。改期不等于已经送达。" },
  cancel: { title: "取消提醒", allowLabel: "确认取消", safety: "确认后才会取消。已经弹出的通知不会撤回。" },
  pause: { title: "暂停提醒", allowLabel: "确认暂停", safety: "确认后暂停以后的提醒，不会重做已经发生的。" },
  resume: { title: "恢复提醒", allowLabel: "确认恢复", safety: "确认后恢复以后的提醒。恢复不等于已经送达。" },
};

/** The short Chinese card for a reminder confirmation, from the fields the task module sent with it. */
export function presentReminderConfirmation(approval: Pick<PendingApproval, "reminder">): ReminderConfirmationCard | null {
  const fields = approval.reminder;
  if (fields === undefined) return null;
  const copy = CONFIRMATION_COPY[fields.action];
  const when = fields.repeat === "不重复" ? fields.time : `${fields.repeat} ${fields.time}`;
  return {
    title: `${copy.title}：${when} ${fields.subject}`,
    time: fields.time,
    repeat: fields.repeat,
    subject: fields.subject,
    previous: fields.previous ?? null,
    safety: copy.safety,
    // The note under the fields, one trimmed line per printed line, as the card text shows it.
    details: (fields.footnote ?? "").split("\n").map(line => line.trim()).filter(line => line.length > 0).join("\n"),
    allowLabel: copy.allowLabel,
  };
}

/** Future reminders stay "set"; a due reminder must not still sound unscheduled. */
export function scheduleStatusLabel(status: string, runAt: string | null | undefined, now: Date, kind?: string): string {
  if (status === "scheduled" || status === "pending") {
    const time = typeof runAt === "string" ? Date.parse(runAt) : Number.NaN;
    if (Number.isFinite(time) && time <= now.getTime()) return "已到点，尚未执行";
    return kind === "reminder" || kind === undefined ? "已设好，到点提醒" : "尚未到点";
  }
  switch (status) {
    case "running":
      return "正在执行";
    case "completed":
      return "执行结束";
    case "failed":
      return "执行失败";
    case "cancelled":
      return "已取消";
    case "interrupted":
      return "执行中断，结果未确定";
    case "active":
      return "按这个时间重复";
    case "paused":
      return "已暂停";
    case "skipped":
      return "已跳过";
    default:
      return "状态待核对";
  }
}

export interface ReminderDisplayRow {
  id: string;
  subject: string;
  when: string;
  status: string;
  kind: "once" | "recurring";
  canCancel: boolean;
}

export interface ScheduledReminderInput {
  id: string;
  promptPreview: string;
  status: string;
  runAt: string;
  arrangement?: { kind?: string } | undefined;
}

export interface RecurringReminderInput {
  id: string;
  promptPreview: string;
  status: string;
  nextRunAt: string | null;
  recurrence: Recurrence;
  arrangement?: { kind?: string } | undefined;
}

export function reminderRows(input: {
  scheduled: readonly ScheduledReminderInput[];
  recurring: readonly RecurringReminderInput[];
}, clock: ReminderSpeechClock): { rows: ReminderDisplayRow[]; other: number } {
  const rows: ReminderDisplayRow[] = [];
  let other = 0;
  for (const task of input.scheduled) {
    if (task.arrangement?.kind !== "reminder") {
      other += 1;
      continue;
    }
    rows.push({
      id: task.id,
      subject: task.promptPreview,
      when: formatOnceWhen(task.runAt, clock),
      status: scheduleStatusLabel(task.status, task.runAt, clock.now, "reminder"),
      kind: "once",
      canCancel: task.status === "pending",
    });
  }
  for (const task of input.recurring) {
    if (task.arrangement?.kind !== "reminder") {
      other += 1;
      continue;
    }
    const phrase = reminderWhen({ recurrence: task.recurrence, clock }).phrase;
    const next = task.nextRunAt === null ? null : formatOnceWhen(task.nextRunAt, clock);
    rows.push({
      id: task.id,
      subject: task.promptPreview,
      when: next === null ? phrase : `${phrase} · 下次 ${next}`,
      status: scheduleStatusLabel(task.status, task.nextRunAt, clock.now, "reminder"),
      kind: "recurring",
      canCancel: task.status !== "cancelled",
    });
  }
  return { rows, other };
}

export function inboxPrimaryLine(task: {
  promptPreview: string;
  status: string;
  runAt: string;
  finishedAt?: string | null;
  arrangement?: { kind?: string } | undefined;
}, clock: ReminderSpeechClock): { subject: string; when: string; status: string } {
  const finished = task.finishedAt !== undefined && task.finishedAt !== null && Number.isFinite(Date.parse(task.finishedAt))
    ? task.finishedAt
    : task.runAt;
  return {
    subject: task.promptPreview,
    when: formatOnceWhen(finished, clock),
    status: scheduleStatusLabel(task.status, task.runAt, clock.now, task.arrangement?.kind),
  };
}

/**
 * One item of the Home 本地任务 section. The workspace home snapshot prints
 * English status, ids and UTC; show the reminder instead, from the snapshot's
 * structured task fields (no text parsing).
 */
export function presentHomeTaskItem(item: Pick<HomeItem, "text" | "task" | "taskList">, clock: ReminderSpeechClock): { primary: string; detail: string | null } {
  if (item.taskList === "pending") {
    return { primary: item.text.trim().replaceAll("最近创建的 pending/running", "即将到来的提醒"), detail: null };
  }
  const task = item.task;
  if (task === undefined) return { primary: item.text, detail: null };
  const primary = `${task.prompt} · ${formatOnceWhen(task.runAt, clock)} · ${scheduleStatusLabel(task.status, task.runAt, clock.now, "reminder")}`;
  const detail = [`编号 ${task.id}`, task.detail ?? ""].filter(part => part.length > 0).join(" · ");
  return { primary, detail };
}
