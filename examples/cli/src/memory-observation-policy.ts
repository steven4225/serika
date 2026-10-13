import type { UIMessage } from "ai";
import { formatLocalTaskTime } from "./task-instructions.js";

/** Capture at admission, not when a delayed consolidation happens to run. */
export function userMessageClock(now = new Date()): { sentAt: string; timeZone: string } {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { sentAt: formatLocalTaskTime(now, timeZone), timeZone };
}
export function messageClock(message: UIMessage): { sentAt: string | null; timeZone: string | null } {
  const meta = message.metadata as Record<string, unknown> | undefined;
  const sentAt = meta?.sentAt;
  // Legacy messages have no clock. Never substitute extraction time or file mtime.
  if (typeof sentAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(sentAt) || !Number.isFinite(Date.parse(sentAt))) return { sentAt: null, timeZone: null };
  return { sentAt, timeZone: typeof meta?.timeZone === "string" ? meta.timeZone : null };
}

/** Conservative, source-verifiable qualifiers; not a general semantic classifier. */
export function statedScenario(text: string): { limited: boolean; scenario?: string } {
  const labels = [...text.matchAll(/[“「"]([^”」"\n]{1,60})[”」"]\s*场景/g)].map(match => match[1]!.trim());
  if (/(?:工作|上班)(?:时|中|场景)|\bat work\b/i.test(text)) labels.push("work");
  if (/(?:私人|个人|生活)(?:场景|中)|\bin my personal life\b/i.test(text)) labels.push("personal");
  const unique = [...new Set(labels)];
  if (unique.length === 1) return { limited: true, ...(Buffer.byteLength(unique[0]!) <= 96 ? { scenario: unique[0]! } : {}) };
  return { limited: unique.length > 1 || /仅在|只在|只有|限定|场景|的时候|当.+时|\bonly (?:when|in|for)\b/i.test(text) };
}

/** A narrow deterministic backstop for opposing self-statements about one object.
 * It keeps the entire source for review, rather than choosing a winning clause.
 * Other semantic ambiguities remain model-classified needs_review proposals.
 */
export function hasOpposingSelfStatements(text: string): boolean {
  const clauses = text.split(/[；;。.!！?？\n]/).map(value => value.trim());
  const observations = clauses.flatMap(clause => {
    const match = /^(?:我|本人)(喜欢|讨厌|不喜欢|不讨厌)(.{1,80})$/.exec(clause);
    return match ? [{ subject: match[2]!.trim(), positive: match[1] === "喜欢" || match[1] === "不讨厌" }] : [];
  });
  return observations.some(left => observations.some(right => left.subject === right.subject && left.positive !== right.positive));
}
export function isReminderInstruction(text: string): boolean {
  return /(?:提醒我|提醒一下|提醒喝|设置.{0,12}提醒|创建.{0,12}提醒|\bremind me\b|\bset (?:a |an )?reminder\b)/i.test(text);
}
export function hasRelativeTime(text: string): boolean {
  return /今天|明天|昨天|刚才|刚刚|上周|下周|\d+\s*(?:分钟|小时|天)[后前]|\b(?:today|tomorrow|yesterday|ago)\b/i.test(text);
}
