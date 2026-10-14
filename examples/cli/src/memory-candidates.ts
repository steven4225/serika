import { createHash } from "node:crypto";
import type { MemoryEntry, MemoryScope, MemorySource } from "./memory-store.js";
import type { MemoryKind, MemoryValidTime } from "./memory-temporal.js";
import type { MemoryFactIdentity } from "./memory-fact-identity.js";

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
type CandidateFact = { kind?: MemoryKind; recallTerms?: string[]; validTime?: MemoryValidTime; factIdentity?: MemoryFactIdentity; reuseSources?: true };
type CandidateTarget = { memoryId: string; expectedRevision: number; text: string; expiresAt: string | null };
export type CandidateChange =
  | ({ operation: "add"; text: string; scope: MemoryScope; expiresAt: string | null } & CandidateFact)
  | ({ operation: "update" | "correct" } & CandidateTarget & CandidateFact)
  // null is an unresolved proposal, never an effective formal assertion.
  | ({ operation: "change"; effectiveAt: string | null } & CandidateTarget & Omit<CandidateFact, "validTime">)
  | ({ operation: "retract" | "disable" } & CandidateTarget);
export interface CandidateDraft {
  change: CandidateChange;
  source: Extract<MemorySource, { kind: "conversation" }>;
  /** First source remains a compatibility alias; additional sources are approved together. */
  sources?: Array<Extract<MemorySource, { kind: "conversation" }>>;
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
export type ConsolidationOutcome =
  | { messageId: string; status: "extracted" | "no_memory" | "deferred"; attempts?: number }
  /** Host-only terminal disposition; the original remains in committed history. */
  | { messageId: string; status: "not_saved"; reason: "too_large" | "retry_exhausted"; attempts?: number };
/** Latest bounded coverage receipt per Thread, committed with candidates and cursor. */
export interface ConsolidationReceipt {
  threadId: string; batchId: string; payloadHash: string; outcomes: ConsolidationOutcome[];
  processedCount: number; committedAt: string;
  sourcePrefix: { throughMessageId: string; prefixHash: string } | null;
  candidateIds: string[];
}
export interface CandidatePage { candidates: MemoryCandidate[]; nextOffset: number | null; truncated: boolean }
export interface CandidatePreview {
  candidate: MemoryCandidate;
  current: Omit<MemoryEntry, "history"> | null;
  proposed: { text: string; scope: MemoryScope; expiresAt: string | null; pinned: boolean; status: "active" | "disabled"; kind?: MemoryKind; recallTerms?: string[]; validTime?: MemoryValidTime; effectiveAt?: string } | null;
  applicable: boolean; unavailableReason: string | null;
}
export interface CandidateResolution {
  candidateId: string; status: "accepted" | "rejected"; memoryId: string | null; memoryRevision: number | null; replayed: boolean;
}
export interface CandidateListInput { status?: MemoryCandidate["status"] | undefined; offset?: number | undefined; limit?: number | undefined }
export interface CandidateResolveInput {
  candidateId: string; expectedCandidateRevision: number; decision: "accept" | "reject";
  /** Explicit user choice for an undated proposal; the store captures now under lock. */
  effectiveAt?: "now";
}
export interface CandidateBatchInput {
  batchId: string; originThreadId: string; candidates: CandidateDraft[];
  expectedCursor: ConsolidationCursor | null; nextCursor: ConsolidationCursor | null;
  /** Trusted application policy only; the model stage tool never accepts this field. */
  autoAcceptIndexes?: number[];
  /** Host-validated source coverage. Missing on older/manual callers. */
  outcomes?: ConsolidationOutcome[];
  /** Trusted lifecycle flag; selected history never overwrites incremental retry coverage. */
  incremental?: true;
  sourcePrefix?: ConsolidationReceipt["sourcePrefix"];
  /** Host CAS for persisted retries even when the cursor has not advanced. */
  expectedReceiptHash?: string | null;
}
export interface CandidateBatchResult {
  /** All retained proposal identities, including existing reviews reused by deduplication. */
  candidateIds: string[];
  replayed: boolean;
  /** Present only for an automatic-policy batch. Old pending reviews are never auto-accepted. */
  accepted?: Array<{ candidateId: string; memoryId: string; revision: number; operation?: CandidateChange["operation"] }>;
  pendingCandidateIds?: string[];
}
export const MEMORY_PENDING_CANDIDATES_MAX = 64;
export const MEMORY_TERMINAL_CANDIDATES_MAX = 256;
export const MEMORY_BATCH_CANDIDATES_MAX = 5;
export const MEMORY_CURSORS_MAX = 1024;

/** Fixed field ordering; scope is program-bound before this hash is calculated. */
export function candidateFingerprint(originThreadId: string, draft: CandidateDraft): string {
  const change = draft.change;
  if ("factIdentity" in change || "reuseSources" in change) {
    const { factIdentity, reuseSources, ...legacyChange } = change;
    return createHash("sha256").update(JSON.stringify(["runloom-memory-candidate/v3", candidateFingerprint(originThreadId, { ...draft, change: legacyChange }), factIdentity ?? null, reuseSources ?? false])).digest("hex");
  }
  if (draft.sources !== undefined || change.operation !== "add" && change.operation !== "update" || "kind" in change || "recallTerms" in change || "validTime" in change || "effectiveAt" in change) {
    return createHash("sha256").update(JSON.stringify([
      "runloom-memory-candidate/v2", originThreadId,
      (draft.sources ?? [draft.source]).map(source => [source.threadId, source.messageId, source.quote]),
      change.operation,
      change.operation === "add" ? [change.scope.kind, change.scope.kind === "thread" ? change.scope.threadId : null] : [change.memoryId, change.expectedRevision],
      change.text, change.expiresAt, "kind" in change ? change.kind ?? null : null,
      "recallTerms" in change ? change.recallTerms ?? null : null,
      "validTime" in change ? change.validTime ?? null : null,
      "effectiveAt" in change ? change.effectiveAt ?? null : null,
    ])).digest("hex");
  }
  return createHash("sha256").update(JSON.stringify([
    "runloom-memory-candidate/v1", originThreadId,
    draft.source.threadId, draft.source.messageId, draft.source.quote,
    change.operation,
    change.operation === "add" ? [change.scope.kind, change.scope.kind === "thread" ? change.scope.threadId : null] : [change.memoryId, change.expectedRevision],
    change.text, change.expiresAt,
  ])).digest("hex");
}
