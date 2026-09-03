import type {
  ActionState,
  AttemptResolution,
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

/** Retry eligibility before stop/deadline and retryAt checks are applied. */
export function isAttemptRetryEligible(
  action: ActionState,
  attempt: AttemptState,
  resolution: Exclude<AttemptResolution, { kind: "completed" | "safely_aborted" }>,
): boolean {
  return (
    resolution.failure.retryable &&
    (resolution.kind === "not_applied" || isReplaySafe(action, attempt)) &&
    action.attemptCount < action.retryPolicy.maxAttempts
  );
}
