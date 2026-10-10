import type { Recurrence } from "./recurrence.js";

/**
 * Display speech for a reminder the model has already turned into a task-tool
 * call. This formats a saved timestamp or recurrence. It does not classify
 * user text or parse phrases such as 「过会儿」.
 */

export type ReminderSpeechClock = {
  now: Date;
  timeZone: string;
};

export type ReminderSpeechAction = "schedule" | "reschedule" | "cancel" | "pause" | "resume";

export type ReminderConfirmAction = "save" | "reschedule" | "cancel" | "pause" | "resume";

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"] as const;

export function reminderSubject(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/g, " ");
  const stripped = compact.replace(/^(?:请)?提醒(?:我|一下)?/, "").trim();
  return stripped.length > 0 ? stripped : compact.length > 0 ? compact : "这件事";
}

export function readRecurrence(value: unknown): Recurrence | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const recurrence = value as Record<string, unknown>;
  if (recurrence.kind === "daily" && typeof recurrence.time === "string" && typeof recurrence.utcOffset === "string") {
    return { kind: "daily", time: recurrence.time, utcOffset: recurrence.utcOffset };
  }
  if (
    recurrence.kind === "weekly" &&
    typeof recurrence.time === "string" &&
    typeof recurrence.utcOffset === "string" &&
    typeof recurrence.weekday === "number" &&
    Number.isInteger(recurrence.weekday) &&
    recurrence.weekday >= 1 &&
    recurrence.weekday <= 7
  ) {
    return {
      kind: "weekly",
      weekday: recurrence.weekday,
      time: recurrence.time,
      utcOffset: recurrence.utcOffset,
    };
  }
  return undefined;
}

function localParts(instant: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? "");
  const hour = read("hour") === 24 ? 0 : read("hour");
  return { year: read("year"), month: read("month"), day: read("day"), hour, minute: read("minute") };
}

function clockText(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, "0")}`;
}

function clockFromHHMM(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return value;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return value;
  return clockText(hour, minute);
}

function dayIndex(parts: { year: number; month: number; day: number }): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

function weekdayName(parts: { year: number; month: number; day: number }): string {
  return WEEKDAY[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()] ?? "日";
}

export function formatOnceWhen(runAt: string, clock: ReminderSpeechClock): string {
  const time = Date.parse(runAt);
  if (!Number.isFinite(time)) return runAt;
  const target = localParts(new Date(time), clock.timeZone);
  const today = localParts(clock.now, clock.timeZone);
  const delta = dayIndex(target) - dayIndex(today);
  const hm = clockText(target.hour, target.minute);
  if (delta === 0) return `今天 ${hm}`;
  if (delta === 1) return `明天 ${hm}`;
  if (delta >= 2 && delta <= 6) return `周${weekdayName(target)} ${hm}`;
  return `${target.month}月${target.day}日 ${hm}`;
}

export function repeatLabel(recurrence: Recurrence): string {
  switch (recurrence.kind) {
    case "daily":
      return "每天";
    case "weekly": {
      const names = ["", "一", "二", "三", "四", "五", "六", "日"] as const;
      return `每周${names[recurrence.weekday] ?? ""}`;
    }
    default: {
      const exhaustive: never = recurrence;
      return exhaustive;
    }
  }
}

export function reminderWhen(input: {
  runAt?: string | undefined;
  recurrence?: Recurrence | undefined;
  clock: ReminderSpeechClock;
}): { time: string; repeat: string; phrase: string } {
  if (input.recurrence !== undefined) {
    const hm = clockFromHHMM(input.recurrence.time);
    const repeat = repeatLabel(input.recurrence);
    return { time: hm, repeat, phrase: `${repeat} ${hm}` };
  }
  const when = input.runAt === undefined ? "时间未定" : formatOnceWhen(input.runAt, input.clock);
  return { time: when, repeat: "不重复", phrase: when };
}

function actionPrefix(action: ReminderSpeechAction): string {
  switch (action) {
    case "schedule":
      return "已定";
    case "reschedule":
      return "已改到";
    case "cancel":
      return "已取消";
    case "pause":
      return "已暂停";
    case "resume":
      return "已恢复";
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function reminderReadback(
  action: ReminderSpeechAction,
  input: {
    prompt: string;
    runAt?: string | undefined;
    recurrence?: Recurrence | undefined;
    clock: ReminderSpeechClock;
  },
): string {
  const spoken = reminderWhen(input);
  return `${actionPrefix(action)}：${spoken.phrase} 提醒${reminderSubject(input.prompt)}`;
}

function confirmQuestion(action: ReminderConfirmAction): string {
  switch (action) {
    case "save":
      return "允许这次保存？ [y/n] ";
    case "reschedule":
      return "允许这次改期？ [y/n] ";
    case "cancel":
      return "允许这次取消？ [y/n] ";
    case "pause":
      return "允许这次暂停？ [y/n] ";
    case "resume":
      return "允许这次恢复？ [y/n] ";
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function formatReminderConfirmation(input: {
  action: ReminderConfirmAction;
  prompt: string;
  runAt?: string | undefined;
  recurrence?: Recurrence | undefined;
  previousRunAt?: string | undefined;
  clock: ReminderSpeechClock;
  footnote?: string | undefined;
}): string {
  const spoken = reminderWhen({
    ...(input.runAt === undefined ? {} : { runAt: input.runAt }),
    ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
    clock: input.clock,
  });
  const lines = [
    "提醒确认",
    `时间：${spoken.time}`,
    `重复：${spoken.repeat}`,
    `内容：${reminderSubject(input.prompt)}`,
  ];
  if (input.previousRunAt !== undefined) {
    lines.push(`原时间：${formatOnceWhen(input.previousRunAt, input.clock)}（预览，不锁定这条提醒）`);
  }
  if (input.footnote !== undefined && input.footnote.length > 0) lines.push(input.footnote);
  lines.push(confirmQuestion(input.action));
  return `\n${lines.join("\n")}\n`;
}
