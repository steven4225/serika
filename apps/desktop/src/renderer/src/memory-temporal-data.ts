import type { FormalMemory } from "@serika/assistant";
import type { MemoryAction } from "@serika/assistant";
import type { MemoryKind } from "@serika/assistant";

export type MemoryActionMode = "correct" | "change" | "retract" | "pin" | "disable" | "expiry" | "restore" | "delete";
export interface MemoryActionDraft {
  mode: MemoryActionMode;
  text: string;
  kind: MemoryKind;
  recallTerms: string;
  effectiveAt: string;
  expiresAt: string;
  expiryChoice: "" | "keep" | "none" | "date";
  targetAssertionId: string;
  restoreStatus: "" | "active" | "disabled";
}

export const memoryKindLabel: Record<MemoryKind, string> = { preference: "偏好", fact: "事实", event: "事件", note: "记录" };
export const memoryActionLabel: Record<MemoryActionMode, string> = {
  correct: "纠正记录", change: "记录实际变化", retract: "撤回断言", pin: "调整固定", disable: "停用", expiry: "设置有效期", restore: "恢复历史内容", delete: "永久删除",
};

export function memoryAvailabilityLabel(current: Pick<FormalMemory, "temporalState" | "assertion" | "status" | "enabled" | "expiresAt">): string {
  if (current.temporalState === "retracted" || current.assertion?.state === "retracted") return "已撤回";
  if (current.status === "disabled") return "已停用";
  if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) return "已过期";
  if (current.temporalState === "not_applicable") return "当前不适用";
  return current.enabled ? "启用" : "已停用";
}

/** A local-time input would silently depend on the desktop's timezone. Require a complete explicit ISO instant. */
export function explicitTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31];
  const zone = match[8]!;
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0) &&
    Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59 &&
    (zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4, 6)) <= 59)) && Number.isFinite(Date.parse(value));
}

export function createMemoryActionDraft(current: FormalMemory): MemoryActionDraft {
  return {
    mode: "correct", text: current.text, kind: current.assertion?.kind ?? "note",
    recallTerms: current.assertion?.recallTerms.join("\n") ?? "",
    effectiveAt: "", expiresAt: current.expiresAt ?? "", expiryChoice: "", targetAssertionId: "", restoreStatus: "",
  };
}

type DraftResult = { ok: true; input: MemoryAction } | { ok: false; message: string };
function draftError(message: string): DraftResult { return { ok: false, message }; }

/** The renderer cannot supply sources, scope, assertion IDs for new facts, or system timestamps. */
export function memoryActionFromDraft(current: FormalMemory, draft: MemoryActionDraft, options: { now?: Date } = {}): DraftResult {
  const base = { id: current.id, expectedRevision: current.revision ?? 1 };
  switch (draft.mode) {
    case "correct":
    case "change": {
      if (!draft.text.trim()) return draftError("正文不能为空。");
      const recallTerms = draft.recallTerms.split(/\r?\n/).map(term => term.trim()).filter(Boolean);
      if (recallTerms.length > 3 || recallTerms.some(term => new TextEncoder().encode(term).length > 96)) return draftError("检索词最多三条，每条最多 96 UTF-8 字节。");
      if (draft.mode === "change") {
        const effectiveAt = draft.effectiveAt.trim() || (options.now ?? new Date()).toISOString();
        if (!explicitTimestamp(effectiveAt)) return draftError("实际变化时间须含秒与时区，例如 2026-10-04T09:00:00+08:00；留空表示现在。");
        return { ok: true, input: { ...base, operation: "change", text: draft.text, effectiveAt, recallTerms } };
      }
      return { ok: true, input: { ...base, operation: "correct", text: draft.text, kind: draft.kind, recallTerms } };
    }
    case "pin": return { ok: true, input: { ...base, operation: "metadata", pinned: !current.pinned } };
    case "disable": return { ok: true, input: { ...base, operation: "metadata", status: "disabled" } };
    case "expiry":
      if (draft.expiryChoice !== "none" && draft.expiryChoice !== "date") return draftError("请选择清除有效期或指定新的有效期。");
      if (draft.expiryChoice === "date" && !explicitTimestamp(draft.expiresAt)) return draftError("有效期须含秒与时区。");
      return { ok: true, input: { ...base, operation: "metadata", expiresAt: draft.expiryChoice === "none" ? null : draft.expiresAt } };
    case "restore": {
      if (!draft.targetAssertionId) return draftError("请先从历史中选择要恢复的内容。");
      if (!draft.restoreStatus || !draft.expiryChoice) return draftError("恢复前，请明确选择启用状态和有效期。");
      const expiresAt = draft.expiryChoice === "keep" ? current.expiresAt ?? null : draft.expiryChoice === "none" ? null : draft.expiresAt;
      if (expiresAt !== null && !explicitTimestamp(expiresAt)) return draftError("恢复有效期须含秒与时区。");
      return { ok: true, input: { ...base, operation: "restore", targetAssertionId: draft.targetAssertionId, status: draft.restoreStatus, expiresAt } };
    }
    case "retract": return { ok: true, input: { ...base, operation: "retract" } };
    case "delete": return { ok: true, input: { ...base, operation: "delete" } };
  }
}

export function timestampLabel(timestamp: string | null | undefined, empty: string): string {
  if (!timestamp) return empty;
  // Preserve the represented instant and timezone instead of guessing the viewer's locale.
  return timestamp.replace("T", " ");
}
