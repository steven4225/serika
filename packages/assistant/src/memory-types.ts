import { z } from "zod";
import type { MemoryLibrary, MemoryLibraryAction, MemoryLibraryView, MemoryLibraryDocument } from "./memory-library.js";
import type { MemoryImportEntry, MemoryImportConfirm, MemoryImportPreview, MemoryImportReceipt } from "./memory-import.js";
import type { V7Document, V7Entry, V7Change, V7Commit } from "./memory-v7-store.js";
export const MEMORY_MAX_ENTRIES = 512;
export const MEMORY_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const MEMORY_ENTRY_MAX_BYTES = 2048;
export const MEMORY_CONTEXT_MAX_BYTES = 8192;
export type MemoryKind = "fact" | "preference" | "event" | "note";
export const memoryScopeSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("user") }).strict(), z.object({ kind: z.literal("project"), projectId: z.string().min(1) }).strict()]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const sameMemoryScope = (left: MemoryScope, right: MemoryScope): boolean => left.kind === right.kind && (left.kind === "user" || right.kind === "project" && left.projectId === right.projectId);
export const visibleMemoryScope = (scope: MemoryScope, projectId: string | null): boolean => scope.kind === "user" || scope.projectId === projectId;
export type MemoryStatus = "active" | "disabled";
export type MemorySource = V7Entry["sources"][number];
export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export interface MemoryEntry {
  id: string; text: string; enabled: boolean; kind?: MemoryKind; uncertain?: boolean; pinned?: boolean;
  v7?: V7Entry; status?: MemoryStatus; scope?: MemoryScope; source?: MemorySource;
  createdAt?: string | null; updatedAt?: string | null; expiresAt?: string | null; revision?: number;
}
export interface MemoryAddInput {
  text: string; scope: MemoryScope; kind?: MemoryKind; pinned?: boolean; enabled?: boolean; status?: MemoryStatus;
  source?: MemorySource;
}
export interface MemoryUpdateInput {
  expectedRevision: number; text?: string; pinned?: boolean; enabled?: boolean; status?: MemoryStatus;
}
export interface MemoryWriteOptions { now?: Date }
export interface MemoryFailure { ok: false; error: { code: MemoryStoreErrorCode; message: string } }
export type MemoryListResult = { ok: true; entries: MemoryEntry[] } | MemoryFailure;
export type MemoryEntryResult = { ok: true; entry: MemoryEntry } | MemoryFailure;
export type MemoryDeleteResult = { ok: true; id: string } | MemoryFailure;
export type MemoryStoreErrorCode = string;
export class MemoryStoreError extends Error {
  readonly code: MemoryStoreErrorCode;
  constructor(code: MemoryStoreErrorCode, message: string) { super(message); this.name = "MemoryStoreError"; this.code = code; }
}
export interface ScopedMemoryStore {
  mergeV7?(input: { members: Array<{ id: string; revision: number }>; text: string }, signal?: AbortSignal): Promise<MemoryResult<MemoryEntry>>;
  excludeSources?(threadId: string, messageIds: string[], signal?: AbortSignal): Promise<MemoryResult<null>>;
  readV7?(signal?: AbortSignal): Promise<MemoryResult<V7Document>>;
  writeV7?(changes: V7Change[], signal?: AbortSignal, options?: V7Commit): Promise<MemoryResult<MemoryEntry[]>>;
  readReferenceMaterial?(signal: AbortSignal, now: Date): Promise<MemoryResult<{ entries: MemoryEntry[]; library: MemoryLibrary }>>;
  getLibrary?(signal?: AbortSignal): Promise<MemoryResult<MemoryLibraryView>>;
  readLibraryDocument?(id: string, signal?: AbortSignal): Promise<MemoryResult<MemoryLibraryDocument>>;
  changeLibrary?(input: MemoryLibraryAction, signal?: AbortSignal): Promise<MemoryResult<MemoryLibraryView>>;
  previewImport?(entries: MemoryImportEntry[], signal?: AbortSignal): Promise<MemoryResult<MemoryImportPreview>>;
  confirmImport?(input: MemoryImportConfirm, threadId: string, signal?: AbortSignal): Promise<MemoryResult<MemoryImportReceipt>>;
  importReceipt?(operationId: string, threadId: string, signal?: AbortSignal): Promise<MemoryResult<MemoryImportReceipt | null>>;
  list(signal?: AbortSignal, options?: MemoryWriteOptions): Promise<MemoryListResult>;
  get(id: string, signal?: AbortSignal, options?: MemoryWriteOptions): Promise<MemoryEntryResult>;
  add(input: MemoryAddInput, signal?: AbortSignal, options?: MemoryWriteOptions): Promise<MemoryEntryResult>;
  update(id: string, input: MemoryUpdateInput, signal?: AbortSignal, options?: MemoryWriteOptions): Promise<MemoryEntryResult>;
  delete(id: string, signal?: AbortSignal, options?: MemoryWriteOptions): Promise<MemoryDeleteResult>;
  deleteMemory(input: { id: string; expectedRevision: number }, signal?: AbortSignal, options?: MemoryWriteOptions): Promise<MemoryDeleteResult>;
}
export function selectInjectableMemoryEntries<T extends MemoryEntry>(entries: readonly T[], options: { now?: Date } = {}): T[] {
  const now = options.now?.getTime() ?? Date.now();
  return entries.filter(entry => entry.enabled === true && (entry.status === undefined || entry.status === "active") &&
    (entry.expiresAt === undefined || entry.expiresAt === null || Number.isFinite(Date.parse(entry.expiresAt)) && Date.parse(entry.expiresAt) > now));
}
