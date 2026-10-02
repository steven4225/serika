import type { ContextBudgetConfig } from "./context-budget.js";
import type { CompactionMetrics } from "./context-compaction.js";

export type ContextResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } };

/** Read-only display evidence, not a tokenizer result or recovery authority. */
export interface ContextDiagnostics {
  threadId: string;
  enabled: boolean;
  budget: ContextBudgetConfig;
  estimatorVersion: "char-half/v1";
  latestValidCompaction: {
    id: string;
    createdAt: string;
    modelId: string;
    firstKeptMessageIndex: number;
    firstKeptMessageId: string | null;
    metrics: CompactionMetrics;
  } | null;
  /** Only an actual preparation in this process sets this field. */
  lastPreparation: {
    at: string;
    outcome: "passthrough" | "reused" | "written" | "noop" | "failed";
    compactionId: string | null;
    estimatedInputTokens: number | null;
    error: { code: string; message: string } | null;
  } | null;
}
