import { formatOnceWhen, reminderWhen, type ReminderSpeechClock } from "@aisdk-agent/example-cli/dist/reminder-speech.js";
import type { Recurrence } from "@aisdk-agent/example-cli/dist/recurrence.js";
import type { PendingApproval } from "../../shared/ui-contract.js";

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

/** Full-text signals. A later clause must count even when an earlier line says 已定. */
const degradedSignal = /失败|没有设成|没有改成|保存失败|不可用|未运行|尚未就绪|不能保证执行|不要重复创建|\b(?:unavailable|failed|failure|error|backend|cannot|unable)\b/i;
const englishFailure = /\b(?:fail(?:ed|ure)?|cannot|unable|error)\b/i;

/** Drop English status tokens without eating a warning that follows them. */
function withoutEnglishStatus(text: string): string {
  return text
    .replace(/\bstatus\s*:\s*scheduled\b/gi, "")
    .replace(/\bscheduled\b/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function presentDegradedReply(text: string): { primary: string; aside: string | null } {
  if (englishFailure.test(text) && /\btask_reschedule\b/i.test(text)) return { primary: "这次提醒没有改成。", aside: text };
  if (englishFailure.test(text) && (/\btask_(?:repeat_)?create\b/i.test(text) || /\bcannot create\b/i.test(text))) {
    return { primary: "这次提醒没有设成。", aside: text };
  }
  const primary = withoutEnglishStatus(text).replace(/已(?:定|记下)：/g, "").replace(/[ \t]{2,}/g, " ").trim();
  return { primary: primary.length > 0 ? primary : "这次提醒没有设成。", aside: primary === text.trim() ? null : text };
}

export function presentReminderReply(text: string): { primary: string; aside: string | null } {
  if (degradedSignal.test(text)) return presentDegradedReply(text);
  if (!/\bscheduled\b/i.test(text)) return { primary: text, aside: null };
  const speech = reminderSpeechLine(text);
  if (speech !== null) return { primary: speech, aside: text.trim() === speech ? null : text };
  const shortStatus = text.trim().length <= 500 && /\b(?:runAt|task_create|task_reschedule|task id|status)\b/i.test(text);
  if (!shortStatus) return { primary: text, aside: null };
  return { primary: "这段英文不能说明提醒已经设好。", aside: text };
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

function labeledLine(lines: readonly string[], label: string): string | null {
  const prefix = `${label}：`;
  const line = lines.find(item => item.startsWith(prefix));
  if (line === undefined) return null;
  const value = line.slice(prefix.length).trim();
  return value.length > 0 ? value : null;
}

function confirmationVerb(toolName: string): { title: string; allowLabel: string; safety: string } {
  switch (toolName) {
    case "task_create":
    case "task_repeat_create":
      return { title: "设置提醒", allowLabel: "确认保存", safety: "确认后才会保存。保存不等于已经提醒到你。" };
    case "task_reschedule":
      return { title: "调整提醒", allowLabel: "确认改期", safety: "确认后才会改时间。改期不等于已经送达。" };
    case "task_cancel":
    case "task_repeat_cancel":
      return { title: "取消提醒", allowLabel: "确认取消", safety: "确认后才会取消。已经弹出的通知不会撤回。" };
    case "task_repeat_pause":
      return { title: "暂停提醒", allowLabel: "确认暂停", safety: "确认后暂停以后的提醒，不会重做已经发生的。" };
    case "task_repeat_resume":
      return { title: "恢复提醒", allowLabel: "确认恢复", safety: "确认后恢复以后的提醒。恢复不等于已经送达。" };
    default:
      return { title: "提醒", allowLabel: "确认", safety: "确认后才会保存。保存不等于已经提醒到你。" };
  }
}

/** Turn the existing reminder confirmation text into a short Chinese card. */
export function presentReminderConfirmation(approval: Pick<PendingApproval, "toolName" | "preview">): ReminderConfirmationCard | null {
  const preview = approval.preview.replace(/(?:Allow this call\?|允许这次[^\n]*？)\s*\[y\/n\]\s*$/i, "").trim();
  const lines = preview.split("\n").map(line => line.trim()).filter(line => line.length > 0);
  if (lines[0] !== "提醒确认") return null;
  const time = labeledLine(lines, "时间");
  const subject = labeledLine(lines, "内容");
  if (time === null || subject === null) return null;
  const repeat = labeledLine(lines, "重复") ?? "不重复";
  const previous = labeledLine(lines, "原时间");
  const structured = new Set([
    "提醒确认",
    `时间：${time}`,
    `重复：${repeat}`,
    `内容：${subject}`,
    ...(previous === null ? [] : [`原时间：${previous}`]),
  ]);
  const details = lines.filter(line => !structured.has(line)).join("\n");
  const verb = confirmationVerb(approval.toolName);
  const when = repeat === "不重复" ? time : `${repeat} ${time}`;
  return {
    title: `${verb.title}：${when} ${subject}`,
    time,
    repeat,
    subject,
    previous,
    safety: verb.safety,
    details,
    allowLabel: verb.allowLabel,
  };
}

/** Future reminders stay "set"; a due reminder must not still sound unscheduled. */
export function scheduleStatusLabel(status: string, runAt: string | null | undefined, now: Date, kind?: string): string {
  if (status === "scheduled") {
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
      canCancel: task.status === "scheduled",
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

const homeTaskLine = /^(scheduled|running|completed|failed|cancelled|interrupted)\s·\s(\S+)\s·\s(.*?)\s·\srunAt\s(\S+)(?:\s·\s([\s\S]+))?$/;

/** The workspace home snapshot prints English status, ids and UTC. Show the reminder instead. */
export function presentHomeTaskItem(text: string, clock: ReminderSpeechClock): { primary: string; detail: string | null } {
  const trimmed = text.trim();
  if (trimmed.includes("最近创建的 scheduled/running")) {
    return { primary: trimmed.replaceAll("最近创建的 scheduled/running", "即将到来的提醒"), detail: null };
  }
  const match = homeTaskLine.exec(trimmed);
  if (match === null) return { primary: text, detail: null };
  const status = match[1] ?? "";
  const id = match[2] ?? "";
  const prompt = match[3] ?? "";
  const runAt = match[4] ?? "";
  const extra = match[5];
  const primary = `${prompt} · ${formatOnceWhen(runAt, clock)} · ${scheduleStatusLabel(status, runAt, clock.now, "reminder")}`;
  const detail = [`编号 ${id}`, extra?.trim() ?? ""].filter(part => part.length > 0).join(" · ");
  return { primary, detail };
}
