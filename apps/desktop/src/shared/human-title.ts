/**
 * Primary-surface copy. Raw thread, run, memory, task and revision tokens stay
 * out of titles, banners and confirmation headings. Callers that still need the
 * identifier render it under 详情 / 编号.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;
const PREFIXED_ID = /\b(?:mem|task|thread|run|approval|call|desktop-explicit)[_-][A-Za-z0-9_-]{4,}\b/g;
const LONG_HEX = /\b[0-9a-f]{32,}\b/gi;
const TOOL_NAME = /^(?:task_(?:create|reschedule|cancel|repeat_create|repeat_cancel|repeat_pause|repeat_resume)|memory_(?:add|update|apply_candidate|revise|query))$/;
const REVISION_TITLE = /^(?:revision|版本)\s*\d+$/i;

export function isRawIdentifier(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (TOOL_NAME.test(text) || REVISION_TITLE.test(text)) return true;
  const stripped = text.replace(UUID, "").replace(PREFIXED_ID, "").replace(LONG_HEX, "").replace(/[\s·:：,，._\-#/]+/g, "");
  return stripped.length === 0;
}

/** Returns fallback when the whole value is an identifier, otherwise drops embedded identifiers. */
export function humanFacingTitle(value: string | null | undefined, fallback: string): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text || isRawIdentifier(text)) return fallback;
  const cleaned = text
    .replace(UUID, "")
    .replace(PREFIXED_ID, "")
    .replace(LONG_HEX, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s·:：,，._\-#/]+|[\s·:：,，._\-#/]+$/g, "")
    .trim();
  if (!cleaned || isRawIdentifier(cleaned)) return fallback;
  return cleaned;
}

export function localScheduleLabel(value: string | null | undefined): string {
  if (!value || value.trim() === "" || value === "无") return "时间未记录";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return humanFacingTitle(value, "时间未记录");
  const date = new Date(parsed);
  const includeYear = date.getFullYear() !== new Date().getFullYear();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

export function recurrencePhrase(recurrence: { kind: string; time?: string; weekday?: number } | undefined): string | null {
  if (!recurrence?.time) return null;
  if (recurrence.kind === "daily") return `每天 ${recurrence.time}`;
  if (recurrence.kind === "weekly") {
    const names = ["", "一", "二", "三", "四", "五", "六", "日"];
    return `每周${names[recurrence.weekday ?? 0] ?? ""} ${recurrence.time}`;
  }
  return null;
}

export function taskNoticeTitle(task: {
  prompt: string;
  resultText: string | null;
  status: string;
  arrangementKind?: string | undefined;
}): string {
  const text = (task.resultText ?? "").replace(/\s+/g, " ").trim();
  const sentence = text.split(/(?<=[。！？])/)[0]?.trim() ?? "";
  const clipped = Array.from(sentence).slice(0, 42).join("");
  const fromResult = humanFacingTitle(clipped, "");
  if (fromResult) return Array.from(sentence).length > 42 ? `${fromResult}…` : fromResult;
  const kind = task.arrangementKind === "reminder" ? "提醒"
    : task.arrangementKind === "todoist-brief" ? "Todoist 日报"
      : task.arrangementKind === "rss-digest" ? "资讯"
        : "定时结果";
  const tail = task.status === "completed" ? "已保存"
    : task.status === "failed" ? "没有完成"
      : task.status === "cancelled" ? "已取消"
        : task.status === "interrupted" ? "需要查看"
          : "有更新";
  const fromPrompt = humanFacingTitle(task.prompt, "");
  if (task.arrangementKind === "reminder" && fromPrompt) return Array.from(fromPrompt).slice(0, 42).join("");
  return `${kind}${tail}`;
}

const MODULE_LABELS: Record<string, string> = { pomodoro: "番茄钟", task: "提醒", memory: "记忆" };

/** Title and body for a main-process module notification. The module id is not the title. */
export function moduleNotificationCopy(moduleId: string, message: string): { title: string; body: string } {
  const text = humanFacingTitle(message.replace(/\s+/g, " ").trim(), "");
  const sentence = (text.split(/(?<=[。！？])/)[0] ?? "").trim();
  const clipped = Array.from(sentence).slice(0, 42).join("");
  const fallback = MODULE_LABELS[moduleId] ?? "Serika";
  const title = clipped ? (Array.from(sentence).length > 42 ? `${clipped}…` : clipped) : fallback;
  return { title, body: text || fallback };
}
