import type { MemoryResult } from "./memory-candidates.js";
import { formalMemory, type FormalMemory } from "./memory-management.js";
import {
  MEMORY_FILE_MAX_BYTES, MEMORY_MAX_ENTRIES,
  type MemoryAssertion, type MemoryKind, type MemoryRecord,
  type MemoryRecordVersion, type MemoryStoreActionPreview, type MemoryValidTime,
  type TemporalWorkspaceMemoryStore, type WorkspaceMemoryStore,
} from "./memory-store.js";
import { MEMORY_ASSERTIONS_MAX, validateRecallTerms, validateTemporalTimestamp, validateValidTime } from "./memory-temporal.js";

type MemoryActionIdentity = { id: string; expectedRevision: number };
/** Deliberately excludes source, scope, assertion ids and system timestamps. */
export type MemoryAction = MemoryActionIdentity & (
  | { operation: "correct"; text: string; kind?: MemoryKind; recallTerms?: string[]; validTime?: MemoryValidTime }
  | { operation: "change"; text: string; effectiveAt: string; recallTerms?: string[] }
  | { operation: "retract" }
  | { operation: "metadata"; pinned?: boolean; status?: "disabled"; expiresAt?: string | null }
  | { operation: "restore"; targetAssertionId: string; status?: "active" | "disabled"; expiresAt?: string | null }
  | { operation: "delete" }
);
export interface MemoryHistoryInput { id: string; offset?: number; limit?: number }
export interface MemoryHistoryPage {
  id: string; revision: number; historyCoverage: MemoryRecord["historyCoverage"];
  /** Newest-first; sources contain verified saved quotes, never a transcript availability promise. */
  assertions: MemoryAssertion[]; versions: MemoryRecordVersion[]; nextOffset: number | null;
}
export interface MemoryActionPreview {
  input: MemoryAction; current: FormalMemory; proposedAssertion: MemoryAssertion | null; warnings: string[];
}
export interface MemoryTemporalInput { id: string; validAt?: string; knownAt?: string; includeDisabled?: boolean }
export interface MemoryMaintenance {
  /** Visible workspace/current Thread records. Limits are shared workspace limits. */
  stored: number; capacity: { entries: number; bytes: number; assertionsPerEntry: number };
  pending: number; expired: number; disabled: number; duplicateSuggestions: number;
  consolidation: {
    enabled: boolean; state: "off" | "backlog" | "running" | "failed" | "awaiting_review" | "idle";
    error?: string; backlogCount?: number;
    lastAttempt?: { mode: "incremental" | "history"; runId: string; status: "completed" | "failed"; processedCount: number; candidateCount: number; accepted?: Array<{ candidateId: string; memoryId: string; revision: number; operation?: "add" | "update" | "correct" | "change" | "retract" | "disable" }> };
    lastSkippedReason?: string;
  };
}
export const memoryCapacity: MemoryMaintenance["capacity"] = {
  entries: MEMORY_MAX_ENTRIES, bytes: MEMORY_FILE_MAX_BYTES, assertionsPerEntry: MEMORY_ASSERTIONS_MAX,
};
export const memoryControlFailure = (code: string, message: string): { ok: false; error: { code: string; message: string } } => ({ ok: false, error: { code, message } });

export function temporalMemoryStore(store: WorkspaceMemoryStore): TemporalWorkspaceMemoryStore | undefined {
  const temporal = store as Partial<TemporalWorkspaceMemoryStore>;
  return typeof temporal.inspectMemory === "function" && typeof temporal.previewMemoryMutation === "function" &&
    typeof temporal.reviseMemory === "function" && typeof temporal.restoreMemory === "function" &&
    typeof temporal.deleteMemory === "function" && typeof temporal.queryMemory === "function" &&
    typeof temporal.inspectMemoryMaintenance === "function" ? temporal as TemporalWorkspaceMemoryStore : undefined;
}

/** IPC validation happens before any read, write, or controller state change. */
export function validateMemoryAction(value: unknown): MemoryResult<MemoryAction> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return memoryControlFailure("INVALID_INPUT", "Invalid memory action");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || !input.id || input.id.length > 256 || !Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 1) return memoryControlFailure("INVALID_INPUT", "Memory action requires id and current expectedRevision");
  const fields: Record<string, string[]> = {
    correct: ["text", "kind", "recallTerms", "validTime"], change: ["text", "effectiveAt", "recallTerms"],
    retract: [], metadata: ["pinned", "status", "expiresAt"], restore: ["targetAssertionId", "status", "expiresAt"], delete: [],
  };
  if (typeof input.operation !== "string" || !Object.hasOwn(fields, input.operation) || Object.keys(input).some(key => !["id", "expectedRevision", "operation", ...fields[input.operation as string]!].includes(key))) return memoryControlFailure("INVALID_INPUT", "Memory action contains unsupported fields");
  try {
    if (input.operation === "correct" || input.operation === "change") {
      if (typeof input.text !== "string" || !input.text.trim()) return memoryControlFailure("MEMORY_TEXT_EMPTY", "Memory text must not be blank");
      if (Buffer.byteLength(input.text, "utf8") > 2048) return memoryControlFailure("MEMORY_TEXT_TOO_LARGE", "Memory text exceeds 2 KiB");
    }
    if (input.kind !== undefined && !["fact", "preference", "event", "note"].includes(input.kind as string)) return memoryControlFailure("INVALID_INPUT", "Invalid memory kind");
    if (input.recallTerms !== undefined) validateRecallTerms(input.recallTerms);
    if (input.validTime !== undefined) {
      validateValidTime(input.validTime);
      if (Object.keys(input.validTime as object).some(key => !["from", "to", "basis"].includes(key))) return memoryControlFailure("INVALID_INPUT", "Valid time contains unsupported fields");
    }
    if (input.operation === "change") validateTemporalTimestamp(input.effectiveAt, "Memory effectiveAt");
    if (input.operation === "metadata" && !["pinned", "status", "expiresAt"].some(key => Object.hasOwn(input, key))) return memoryControlFailure("INVALID_INPUT", "Metadata action must change a field");
    if (Object.hasOwn(input, "pinned") && typeof input.pinned !== "boolean") return memoryControlFailure("INVALID_INPUT", "Pinned must be boolean");
    if (Object.hasOwn(input, "status") && (input.status !== "disabled" && !(input.operation === "restore" && input.status === "active"))) return memoryControlFailure("INVALID_INPUT", "Only restore may explicitly reactivate memory");
    if (Object.hasOwn(input, "expiresAt") && input.expiresAt !== null) validateTemporalTimestamp(input.expiresAt, "Memory expiry");
    if (input.operation === "restore" && (typeof input.targetAssertionId !== "string" || !input.targetAssertionId || input.targetAssertionId.length > 256)) return memoryControlFailure("INVALID_INPUT", "Restore requires a saved assertion id");
    return { ok: true, value: structuredClone(input) as MemoryAction };
  } catch (error) {
    return memoryControlFailure("INVALID_INPUT", error instanceof Error ? error.message : "Invalid memory action");
  }
}

export function validateMemoryHistoryInput(value: unknown): value is MemoryHistoryInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as MemoryHistoryInput;
  return typeof input.id === "string" && input.id.length > 0 && input.id.length <= 256 &&
    Object.keys(input).every(key => ["id", "offset", "limit"].includes(key)) &&
    (input.offset === undefined || Number.isSafeInteger(input.offset) && input.offset >= 0) &&
    (input.limit === undefined || Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 10);
}

export function memoryHistoryPage(record: MemoryRecord, input: MemoryHistoryInput): MemoryResult<MemoryHistoryPage> {
  const offset = input.offset ?? 0, limit = input.limit ?? 5;
  const assertions = record.assertions.slice().reverse(), versions = record.versions.slice().reverse();
  const page: MemoryHistoryPage = { id: record.id, revision: record.revision, historyCoverage: record.historyCoverage, assertions: [], versions: [], nextOffset: null };
  let index = offset;
  for (; index < Math.max(assertions.length, versions.length) && index - offset < limit; index++) {
    const next = { ...page, assertions: assertions[index] ? [...page.assertions, assertions[index]!] : page.assertions, versions: versions[index] ? [...page.versions, versions[index]!] : page.versions, nextOffset: index + 1 };
    if (Buffer.byteLength(JSON.stringify(next), "utf8") > 64 * 1024) break;
    page.assertions = next.assertions; page.versions = next.versions;
  }
  if (index === offset && index < Math.max(assertions.length, versions.length)) return memoryControlFailure("MEMORY_CONTEXT_TOO_LARGE", "One history item exceeds the 64 KiB detail budget");
  page.nextOffset = index < Math.max(assertions.length, versions.length) ? index : null;
  return { ok: true, value: page };
}

export function memoryActionPreview(input: MemoryAction, preview: MemoryStoreActionPreview): MemoryResult<MemoryActionPreview> {
  const warnings = ["预览不写入。确认时会重新核对 revision，并使用实际确认时的系统时间。"];
  if (input.operation === "correct") warnings.push("纠正此前的认识，不代表现实在此刻发生变化；来源记为本次人工编辑。");
  if (input.operation === "correct" && input.validTime !== undefined) warnings.push("将按所选适用区间替换当前已知片段；区间外不再作为当前适用内容，先前认识仍保留在 knownAt 历史中。请核对起止时间。");
  if (input.operation === "change") warnings.push("真实变化会保留变化前的适用内容；来源记为本次人工编辑。");
  if (input.operation === "retract") warnings.push("撤回当前认识，保留历史；不删除原记录，也不证明旧事实从未发生。");
  if (input.operation === "restore") warnings.push("恢复会创建新 revision，默认从实际确认时适用；不会恢复任何工具授权。");
  if (input.operation === "delete") warnings.push("永久删除整条记忆、历史与相关候选正文，无法通过恢复入口找回；现有对话中的旧引用不会被改写。");
  if (input.operation === "metadata" && input.expiresAt != null && Date.parse(input.expiresAt) <= Date.now()) warnings.push("该有效期已过去，确认后这条记忆不再进入检索。");
  const value: MemoryActionPreview = { input, current: formalMemory(preview.current), proposedAssertion: preview.proposedAssertion, warnings };
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 64 * 1024 ? { ok: true, value } : memoryControlFailure("MEMORY_CONTEXT_TOO_LARGE", "Memory action preview exceeds 64 KiB");
}
