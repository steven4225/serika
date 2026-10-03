import type { MemoryEntry } from "./memory-store.js";
import type { MemoryResult } from "./memory-candidates.js";

export type FormalMemory = Omit<MemoryEntry, "history">;
export interface MemoryListInput { offset?: number; limit?: number }
export interface MemoryPage { entries: Array<Omit<FormalMemory, "text" | "source"> & { preview: string; truncated: boolean }>; nextOffset: number | null }
export interface MemoryEditInput { id: string; expectedRevision: number; text?: string; pinned?: boolean; status?: "disabled" }

export function visibleMemory(entry: MemoryEntry, threadId: string): boolean {
  return entry.scope?.kind !== "thread" || entry.scope.threadId === threadId;
}
export function formalMemory(entry: MemoryEntry): FormalMemory {
  const { history: _history, ...current } = entry;
  return current;
}
export function memoryPage(entries: MemoryEntry[], threadId: string, input: MemoryListInput = {}): MemoryResult<MemoryPage> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: { code: "INVALID_INPUT", message: "Invalid Memory page" } };
  const { offset = 0, limit = 20 } = input;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return { ok: false, error: { code: "INVALID_INPUT", message: "Memory page requires offset >=0 and limit 1..50" } };
  const visible = entries.filter(entry => visibleMemory(entry, threadId));
  const page: MemoryPage["entries"] = [];
  for (const entry of visible.slice(offset, offset + limit)) {
    const { text, source: _source, ...current } = formalMemory(entry);
    const item = { ...current, preview: Array.from(text).slice(0, 120).join(""), truncated: Array.from(text).length > 120 };
    if (Buffer.byteLength(JSON.stringify([...page, item])) > 16 * 1024) break;
    page.push(item);
  }
  return { ok: true, value: { entries: page, nextOffset: offset + page.length < visible.length ? offset + page.length : null } };
}
/** Renderer may edit only these fields; it cannot forge scope, sources, history or revisions. */
export function validMemoryEdit(input: MemoryEditInput): boolean {
  return typeof input?.id === "string" && input.id.length > 0 && input.id.length <= 256 && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision > 0 &&
    Object.keys(input).every(key => ["id", "expectedRevision", "text", "pinned", "status"].includes(key)) &&
    (input.text === undefined || typeof input.text === "string") && (input.pinned === undefined || typeof input.pinned === "boolean") &&
    (input.status === undefined || input.status === "disabled") && (input.text !== undefined || input.pinned !== undefined || input.status !== undefined);
}
