/** User-facing failure text. Codes stay available as collapsed detail. */
const MACHINE_CODE = /\b((?:SKILL|MEMORY)_[A-Z0-9_]+)\b/g;
const LEADING_CODE = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]+)$/;

const REASONS: Record<string, string> = {
  SKILL_EXECUTION_FAILED: "这次没有做完。",
  SKILL_CANCELLED: "已取消，没有继续。",
  SKILL_CHANGED: "内容已经变了，请重新确认后再试。",
  SKILL_INVALID_INPUT: "这次的内容没法用。",
  SKILL_UNAVAILABLE: "这个能力现在不可用。",
  SKILL_NO_MATERIAL: "没有新的内容可以处理。",
  MEMORY_DISABLED: "记忆还没开启。",
  MEMORY_CANDIDATE_NOT_FOUND: "这条待确认的内容已经不在了。",
  MEMORY_CANDIDATE_STALE: "内容已经变了，请重新看过再决定。",
  MEMORY_CANDIDATE_CONFLICT: "内容已经变了，请重新看过再决定。",
  MEMORY_REVISION_CONFLICT: "这条记忆刚刚被改过，请先看现在的内容。",
  MEMORY_COMMIT_UNCERTAIN: "是否已经记住还不确定。请先查看记忆，不要马上再试一次。",
  MEMORY_ENTRY_NOT_FOUND: "找不到这条记忆。",
  MEMORY_LIMIT_EXCEEDED: "内容太长，这次没有保存。",
  MEMORY_TEXT_EMPTY: "没有可记住的内容。",
  MEMORY_TEXT_TOO_LARGE: "内容太长，这次没有保存。",
  MEMORY_BATCH_INVALID: "这次没能整理成记忆，原来记住的还在。",
  MEMORY_FILE_INVALID: "记忆暂时读不出来，不能当作什么都没记住。",
  MEMORY_READ_FAILED: "记忆暂时读不出来，不能当作什么都没记住。",
  MEMORY_CONTEXT_TOO_LARGE: "一次看不了这么多，请缩小范围再试。",
};

function reasonFor(code: string): string {
  return REASONS[code] ?? (code.startsWith("MEMORY_") ? "记忆这次没有保存成功。" : "这次没有做完。");
}

function hasChinese(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

/** Short human reason. A machine code is never the only visible sentence. */
export function presentFailure(input: string): { summary: string; detail: string | null } {
  const text = input.trim();
  if (!text) return { summary: "这次没有做完。", detail: null };
  const codes = [...text.matchAll(MACHINE_CODE)].map(match => match[1]!);
  if (codes.length > 0) {
    const summary = reasonFor(codes[0]!);
    return { summary, detail: text === summary ? null : text };
  }
  const leading = LEADING_CODE.exec(text);
  if (leading && hasChinese(leading[2]!)) {
    const summary = leading[2]!.trim();
    return { summary, detail: text === summary ? null : text };
  }
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(text)) return { summary: "这次没有做完。", detail: text };
  return { summary: text, detail: null };
}
