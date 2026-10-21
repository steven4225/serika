import type { UIMessage } from "ai";
import type { EverydayMemoryFactIdentity, LegacyMemoryFactIdentity } from "./memory-fact-identity.js";
import { formatLocalTaskTime, MODEL_TIME_ZONE } from "./task-instructions.js";

/** Capture at admission, not when a delayed consolidation happens to run. */
export function userMessageClock(now = new Date()): { sentAt: string; timeZone: string } {
  const timeZone = MODEL_TIME_ZONE;
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
export function statedThreadScope(text: string): "explicit" | "ambiguous" | undefined {
  if (/(?:不代表|不意味着|不是|并非).{0,8}(?:仅|只).{0,10}(?:对话|会话|聊天)|(?:不(?:仅|只)|不限于).{0,8}(?:对话|会话|聊天)/.test(text)) return "ambiguous";
  // Historical acceptance facts can spell out “验收” inside the scope label.
  // Questions/negations do not authorize binding that scope during extraction.
  if (/(?:当前|本次)验收对话(?:范围内|内|里)/.test(text)) {
    return /[?？]|(?:不代表|不意味着|不是|并非|不限定|不限于|不限在|不只|不仅).{0,8}(?:当前|本次)验收对话/.test(text) ? "ambiguous" : "explicit";
  }
  // Existing short-form declarations such as “本会话咖啡加糖。” express
  // applicability without a literal “仅”. Require a direct known preference,
  // not a mention/discussion/question about this conversation or another person.
  const declaration = /^(?:本(?:次|段)?|当前|这(?:个|次|段)?)(?:对话|会话|聊天)(?:里|内|中)?[，,:：\s]*([^。.!！?？；;，,\n]+)[。.!！]?$/.exec(text.trim());
  if (declaration && /^(?:咖啡|我(?:的|喝)|复盘|(?:用)?(?:中文|英文)(?:回复|回答)|回复|回答|语言)/.test(declaration[1]!) &&
    (statedPreference(declaration[1]!) || statedLanguagePreference(declaration[1]!))) return "explicit";
  if (/(?:仅|只|限定|限于).{0,10}(?:当前|本|这(?:个|次|段)?).{0,4}(?:对话|会话|聊天)|(?:当前|本|这(?:个|次|段)?)(?:对话|会话|聊天).{0,8}(?:有效|范围)|\b(?:only (?:in|for)|limited to) (?:this|the current) (?:thread|conversation|chat)\b/i.test(text)) return "explicit";
  if (/(?:仅|只|限定|限于).{0,10}(?:对话|会话|聊天|这里)|(?:不要|别).{0,8}(?:工作区|其他对话)|\bonly (?:here|in this scope)\b/i.test(text)) return "ambiguous";
  return undefined;
}

export function statedScenario(text: string): { limited: boolean; scenario?: string } {
  // A conversation scope is not a semantic work/personal scene. It is bound
  // independently by the host, even when the quoted fact omits the restriction.
  text = text.replace(/(?:仅|只|限定|限于).{0,10}(?:当前|本|这(?:个|次|段)?).{0,4}(?:对话|会话|聊天)(?:范围|里|内|中|有效)?/g, "")
    .replace(/\b(?:only (?:in|for)|limited to) (?:this|the current) (?:thread|conversation|chat)\b/gi, "");
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

/** Narrow evidence probes for the expressions reproduced in eval, not a
 * general fact extractor. Multiple values, quoted examples and questions are
 * deliberately not classified. Scope/scene binding remains a separate check.
 */
export function statedPreference(text: string): Pick<LegacyMemoryFactIdentity, "attribute" | "value"> | undefined {
  if (/[?？“”「」"]|如果|假如|假设|例如|比如|举例|转述|(?:他|她|朋友)说|不是|并非|不喜欢|讨厌|(?:不要|别|无需)(?:先|加糖|放糖)/.test(text)) return undefined;
  const observations: Array<Pick<LegacyMemoryFactIdentity, "attribute" | "value">> = [];
  if (/咖啡/.test(text)) {
    if (/咖啡[^。；;\n]{0,24}(?:不加糖|不放糖|无糖)|(?:不加糖|不放糖|无糖)[^。；;\n]{0,12}咖啡/.test(text)) observations.push({ attribute: "coffee", value: "unsweetened" });
    if (/咖啡[^。；;\n]{0,24}(?<!不)(?:加糖|放糖)|(?<!不)(?:加糖|放糖)[^。；;\n]{0,12}咖啡/.test(text)) observations.push({ attribute: "coffee", value: "sweetened" });
  }
  if (/先(?:说|讲|给|给出)?结论|结论优先/.test(text)) observations.push({ attribute: "review_format", value: "conclusion_first" });
  if (/先(?:说|讲|给|给出)?(?:步骤|过程)|(?:步骤|过程)优先/.test(text)) observations.push({ attribute: "review_format", value: "steps_first" });
  return observations.length === 1 ? observations[0] : undefined;
}
export function reviewablePreference(text: string): Pick<LegacyMemoryFactIdentity, "attribute" | "value"> | undefined {
  // Do not turn one-off observations or somebody else's statement into a user preference.
  if (!/(?:^|[:：。])\s*(?:我(?:的|喜欢|喝)|本人|(?:以后|今后)?复盘(?:请|先)|请记住)/.test(text)) return undefined;
  return statedPreference(text);
}

/** Validate a language proposal in mixed sources without expanding fallback extraction. */
export function statedLanguagePreference(text: string): Pick<LegacyMemoryFactIdentity, "attribute" | "value"> | undefined {
  if (/[?？“”「」"]|如果|假如|假设|例如|比如|举例|转述|(?:他|她|朋友)说|不是|并非|(?:不要|别|不用)/.test(text)) return undefined;
  const zh = /(?:回复|回答|语言)[^。；;\n]{0,16}(?:中文|汉语)|(?:中文|汉语)[^。；;\n]{0,12}(?:回复|回答)/.test(text);
  const en = /(?:回复|回答|语言)[^。；;\n]{0,16}(?:英文|英语)|(?:英文|英语)[^。；;\n]{0,12}(?:回复|回答)/.test(text);
  return zh !== en ? { attribute: "response_language", value: zh ? "zh" : "en" } : undefined;
}

/** Bounded pilot vocabulary, not a general dietary/notification classifier.
 * Only literal attribute/value declarations are verified; fuzzy synonyms stay review-only.
 * A notification preference is data, never permission to enable or send notifications.
 */
export const everydayPreferenceVocabulary = [
  { attribute: "diet_spiciness", label: "饮食辣度", values: { none: "不辣", mild: "微辣", medium: "中辣", hot: "重辣" } },
  { attribute: "notification_channel", label: "通知渠道", values: { in_app: "应用内", system: "系统通知", telegram: "telegram" } },
] as const;

export function statedEverydayPreference(text: string, presentation: "source" | "body" = "source"): Omit<EverydayMemoryFactIdentity, "scenario"> | undefined {
  // These exact scene labels remain part of the original source and are checked
  // separately by statedScenario; they are not examples/quoted third-party facts.
  let material = text.replace(/(?:在)?「([^」\n]{1,60})」\s*场景[，,\s]*/g, "")
    .replace(/(?:仅|只)(?:在)?(?:当前|本(?:次|段)?|这(?:个|次|段)?)(?:对话|会话|聊天)(?:范围|里|内|中)?(?:有效)?[，,\s]*/g, "")
    .normalize("NFKC").toLowerCase().trim();
  const prefixes = ["请记住:", "请记住,", "从现在起,", "从现在起", "从现在开始,", "从现在开始", "以后,", "以后", "今后,", "今后", "请把", "把"];
  // Consume only literal supported framing. Unrecognized qualifiers (including
  // natural scenes such as “工作日早餐”) never silently collapse to general.
  let prefix = prefixes.find(value => material.startsWith(value));
  while (prefix) { material = material.slice(prefix.length).trim(); prefix = prefixes.find(value => material.startsWith(value)); }
  material = material.replace(/[。.!！]$/, "").trim();
  // A saved summary may say “用户的” and add a space before a literal value.
  // This is presentation normalization only: source authority remains first-person.
  if (presentation === "body") material = material.replace(/(是|为|改成|改为)\s+/g, "$1");
  const subjects = presentation === "body" ? ["我的", "本人", "用户的"] : ["我的", "本人"];
  const observed: Array<Omit<EverydayMemoryFactIdentity, "scenario">> = [];
  for (const slot of everydayPreferenceVocabulary) for (const [value, word] of Object.entries(slot.values)) {
    if (["是", "为", "改成", "改为"].some(link => subjects.some(subject => material === `${subject}${slot.label}${link}${word}`))) {
      observed.push({ version: 2, subject: "user", attribute: slot.attribute, value });
    }
  }
  return observed.length === 1 ? observed[0] : undefined;
}
