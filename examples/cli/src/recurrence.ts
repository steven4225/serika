export type Recurrence =
  | {
      kind: "daily";
      time: string;
      utcOffset: string;
    }
  | {
      kind: "weekly";
      weekday: number;
      time: string;
      utcOffset: string;
    };

interface ParsedRecurrence {
  kind: Recurrence["kind"];
  hour: number;
  minute: number;
  offsetMs: number;
  weekday?: number;
}

const timePattern = /^(\d{2}):(\d{2})$/;
const utcOffsetPattern = /^([+-])(\d{2}):(\d{2})$/;

function parseTime(value: unknown): { hour: number; minute: number } {
  if (typeof value !== "string") {
    throw new TypeError("Recurrence time must use HH:mm format");
  }

  const match = timePattern.exec(value);
  const hour = match === null ? Number.NaN : Number(match[1]);
  const minute = match === null ? Number.NaN : Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) {
    throw new RangeError("Recurrence time must be a valid HH:mm time");
  }

  return { hour, minute };
}

function parseUtcOffset(value: unknown): number {
  if (typeof value !== "string") {
    throw new TypeError("Recurrence utcOffset must use ±HH:mm format");
  }

  const match = utcOffsetPattern.exec(value);
  const hours = match === null ? Number.NaN : Number(match[2]);
  const minutes = match === null ? Number.NaN : Number(match[3]);
  if (
    match === null ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours > 14 ||
    minutes > 59 ||
    (hours === 14 && minutes !== 0)
  ) {
    throw new RangeError("Recurrence utcOffset must be between -14:00 and +14:00");
  }

  const sign = match[1] === "-" ? -1 : 1;
  return sign * (hours * 60 + minutes) * 60_000;
}

function parseRecurrence(value: Recurrence): ParsedRecurrence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Recurrence must be an object");
  }

  const recurrence = value as Record<string, unknown>;
  if (recurrence.kind !== "daily" && recurrence.kind !== "weekly") {
    throw new RangeError("Recurrence kind must be daily or weekly");
  }

  const { hour, minute } = parseTime(recurrence.time);
  const offsetMs = parseUtcOffset(recurrence.utcOffset);

  if (recurrence.kind === "daily") {
    return { kind: recurrence.kind, hour, minute, offsetMs };
  }

  if (
    typeof recurrence.weekday !== "number" ||
    !Number.isInteger(recurrence.weekday) ||
    recurrence.weekday < 1 ||
    recurrence.weekday > 7
  ) {
    throw new RangeError("Recurrence weekday must be an integer from 1 to 7");
  }

  return {
    kind: recurrence.kind,
    hour,
    minute,
    offsetMs,
    weekday: recurrence.weekday,
  };
}

function parseAfterUtc(value: string): number {
  if (typeof value !== "string") {
    throw new TypeError("afterUtc must be a date-time string");
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("afterUtc must be a valid date-time");
  }
  return timestamp;
}

function isoWeekday(date: Date): number {
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

/** Returns the next fixed-offset occurrence strictly later than afterUtc. */
export function nextOccurrence(recurrence: Recurrence, afterUtc: string): string {
  const parsed = parseRecurrence(recurrence);
  const afterMs = parseAfterUtc(afterUtc);
  const localNow = new Date(afterMs + parsed.offsetMs);
  const candidateLocal = new Date(localNow.getTime());
  candidateLocal.setUTCHours(parsed.hour, parsed.minute, 0, 0);

  let daysUntil: number;
  if (parsed.kind === "daily") {
    daysUntil = 0;
  } else {
    daysUntil = (parsed.weekday! - isoWeekday(localNow) + 7) % 7;
  }

  candidateLocal.setUTCDate(candidateLocal.getUTCDate() + daysUntil);
  let candidateMs = candidateLocal.getTime() - parsed.offsetMs;

  if (candidateMs <= afterMs) {
    candidateLocal.setUTCDate(candidateLocal.getUTCDate() + (parsed.kind === "daily" ? 1 : 7));
    candidateMs = candidateLocal.getTime() - parsed.offsetMs;
  }

  return new Date(candidateMs).toISOString();
}
