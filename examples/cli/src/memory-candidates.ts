import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryScope, MemorySource } from "./memory-store.js";

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type CandidateChange =
  | { operation: "add"; text: string; scope: MemoryScope; expiresAt: string | null }
  | { operation: "update"; memoryId: string; expectedRevision: number; text: string; expiresAt: string | null };
export interface CandidateDraft {
  change: CandidateChange;
  source: Extract<MemorySource, { kind: "conversation" }>;
  reason: string;
}
export interface MemoryCandidate extends CandidateDraft {
  id: string; revision: number; batchId: string; originThreadId: string; fingerprint: string;
  createdAt: string; resolvedAt: string | null;
  status: "pending" | "accepted" | "rejected" | "stale";
  staleReason: "target_changed" | "target_missing" | "expired" | "duplicate" | null;
  appliedResult: { memoryId: string; revision: number } | null;
}
export interface ConsolidationCursor {
  threadId: string; throughMessageId: string; prefixHash: string; lastBatchId: string; updatedAt: string;
}
export interface CandidatePage { candidates: MemoryCandidate[]; nextOffset: number | null; truncated: boolean }
export interface CandidatePreview {
  candidate: MemoryCandidate;
  current: Omit<MemoryEntry, "history"> | null;
  proposed: { text: string; scope: MemoryScope; expiresAt: string | null; pinned: boolean; status: "active" } | null;
  applicable: boolean; unavailableReason: string | null;
}
export interface CandidateResolution {
  candidateId: string; status: "accepted" | "rejected"; memoryId: string | null; memoryRevision: number | null; replayed: boolean;
}
export interface CandidateListInput { status?: MemoryCandidate["status"] | undefined; offset?: number | undefined; limit?: number | undefined }
export interface CandidateResolveInput { candidateId: string; expectedCandidateRevision: number; decision: "accept" | "reject" }
export interface CandidateBatchInput {
  batchId: string; originThreadId: string; candidates: CandidateDraft[];
  expectedCursor: ConsolidationCursor | null; nextCursor: ConsolidationCursor | null;
}
export const MEMORY_PENDING_CANDIDATES_MAX = 64;
export const MEMORY_TERMINAL_CANDIDATES_MAX = 256;
export const MEMORY_BATCH_CANDIDATES_MAX = 5;
export const MEMORY_CURSORS_MAX = 1024;

/** Fixed field ordering; scope is program-bound before this hash is calculated. */
export function candidateFingerprint(originThreadId: string, draft: CandidateDraft): string {
  const change = draft.change;
  return createHash("sha256").update(JSON.stringify([
    "runloom-memory-candidate/v1", originThreadId,
    draft.source.threadId, draft.source.messageId, draft.source.quote,
    change.operation,
    change.operation === "add" ? [change.scope.kind, change.scope.kind === "thread" ? change.scope.threadId : null] : [change.memoryId, change.expectedRevision],
    change.text, change.expiresAt,
  ])).digest("hex");
}
