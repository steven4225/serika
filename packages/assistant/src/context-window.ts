import type { UIMessage } from "ai";
import { AgentError } from "@serika/core";
import { CHECKPOINT_INJECTION_MAX_BYTES, createCheckpointContextMessage as makeCheckpointContextMessage } from "./checkpoint-context.js";
import type { CheckpointSnapshot } from "./checkpoint-store.js";
export {
  availableInputTokens,
  CONTEXT_ESTIMATOR_METHOD,
  CONTEXT_ESTIMATOR_VERSION,
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  estimateContextBudget,
  estimateContextInput,
  estimateMessageTokens,
  estimateSerializedTokens,
  keepRecentCompactionUnits,
  MESSAGE_OVERHEAD_TOKENS,
  partitionMessagesForCompaction,
  splitMessageCompactionUnits,
  validateContextBudgetConfig,
  type CompactionMessagePartition,
  type ContextBudgetConfig,
  type ContextBudgetEstimate,
  type ContextBudgetValidation,
  type ContextEstimate,
  type ContextEstimateBreakdown,
  type ContextInputParts,
  type MessageCompactionUnit,
} from "./context-budget.js";

export function createCheckpointContextMessage(
  checkpoint: CheckpointSnapshot | null | undefined,
): UIMessage | undefined {
  if (checkpoint == null) return undefined;
  const message = makeCheckpointContextMessage(checkpoint);
  if (Buffer.byteLength(JSON.stringify(message)) > CHECKPOINT_INJECTION_MAX_BYTES) {
    throw new AgentError({ code: "CONTEXT_PREPARE_FAILED", message: `Current checkpoint exceeds ${CHECKPOINT_INJECTION_MAX_BYTES} bytes`, retryable: false, phase: "runtime" });
  }
  return message;
}
