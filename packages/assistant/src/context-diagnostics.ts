import type { ContextBudgetConfig } from "./context-budget.js";
import type { CompactionMetrics } from "./context-compaction.js";

export type ContextResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/** Read-only display evidence, not a tokenizer result or recovery authority. */
export interface ContextDiagnostics {
  modelCallLogWriteFailures?: number;
  background?: { queued: boolean; running: boolean; error: string | null; failure?: { name: string; code: string; finishReason?: string; schemaPaths: string[] } };
  threadId: string;
  enabled: boolean;
  budget: ContextBudgetConfig;
  /** Operator intent for CAS; budget above is the actual process projection. */
  requestedBudget?: ContextBudgetConfig;
  modelCapacity?: import("./context-budget.js").ModelCapacityEvidence;
  estimatorVersion: "char-half/v1";
  latestValidCompaction: {
    id: string;
    createdAt: string;
    modelId: string;
    firstKeptMessageIndex: number;
    firstKeptMessageId: string | null;
    metrics: CompactionMetrics;
  } | null;
  /** Process-only identity for actual primary preparation; manual compact/restart has no binding. */
  lastPreparationSource?: { messageId: string; workTaskId: string | null; runId?: string } | null;
  /** Only an actual preparation in this process sets this field. */
  lastPreparation: {
    at: string;
    outcome: "passthrough" | "reused" | "written" | "noop" | "failed";
    compactionId: string | null;
    estimatedInputTokens: number | null;
    summaryLayer?: { tokens: number; checklistTokens: number; budget: number; summaryOmitted: boolean };
    degradation?: { reason: "checklist_overflow"; checklistTokens: number; sectionBudget: number; maskedThroughMessageId: string | null };
    error: { code: string; message: string } | null;
  } | null;
}
