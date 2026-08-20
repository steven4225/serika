import type {
  ActionState,
  AttemptState,
  RetryPolicySnapshot,
  ToolReplaySafety,
} from "./types.js";

export const DEFAULT_MODEL_RETRY_POLICY: RetryPolicySnapshot = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffFactor: 2,
  jitterRatio: 0.2,
});

export function normalizeToolExecutionPolicy(input: {
  replaySafety?: ToolReplaySafety;
  retryPolicy?: RetryPolicySnapshot;
}): {
  replaySafety: ToolReplaySafety;
  retryPolicy: RetryPolicySnapshot;
} {
  const replaySafety = input.replaySafety ?? "non_idempotent";
  const retryPolicy = input.retryPolicy ?? {
    ...DEFAULT_MODEL_RETRY_POLICY,
    maxAttempts: replaySafety === "non_idempotent" ? 1 : 3,
  };
  return { replaySafety, retryPolicy };
}

export function isReplaySafe(
  action: ActionState,
  attempt: AttemptState,
): boolean {
  if (action.input.kind === "invoke_model") return true;
  if (action.input.replaySafety !== "non_idempotent") return true;
  return attempt.dispatchState === "not_dispatched";
}
