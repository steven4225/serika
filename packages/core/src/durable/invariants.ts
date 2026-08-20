import { DurableDomainError } from "./errors.js";
import type {
  ActionState,
  IsoTimestamp,
  RetryPolicySnapshot,
  RuntimeSnapshot,
} from "./types.js";

const terminalRunStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminalRunStatus(status: string): boolean {
  return terminalRunStatuses.has(status);
}

export function timestampMs(value: IsoTimestamp, field: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new DurableDomainError(
      "INVALID_COMMAND",
      `${field} must be an ISO timestamp`,
    );
  }
  return result;
}

export function hasDeadlinePassed(
  deadlineAt: IsoTimestamp | null,
  now: IsoTimestamp,
): boolean {
  if (deadlineAt === null) return false;
  return timestampMs(now, "now") >= timestampMs(deadlineAt, "deadlineAt");
}

export function assertRetryPolicy(policy: RetryPolicySnapshot): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    invalid("retryPolicy.maxAttempts must be a positive integer");
  }
  if (policy.baseDelayMs < 0 || policy.maxDelayMs < policy.baseDelayMs) {
    invalid("retryPolicy delays are inconsistent");
  }
  if (policy.backoffFactor < 1) {
    invalid("retryPolicy.backoffFactor must be at least 1");
  }
  if (policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    invalid("retryPolicy.jitterRatio must be between 0 and 1");
  }
}

export function assertAction(action: ActionState): void {
  assertRetryPolicy(action.retryPolicy);
  if (!Number.isInteger(action.attemptCount) || action.attemptCount < 0) {
    invalid("action.attemptCount must be a non-negative integer");
  }
  if (!Number.isFinite(action.attemptTimeoutMs) || action.attemptTimeoutMs <= 0) {
    invalid("action.attemptTimeoutMs must be positive");
  }
  if (action.status === "waiting_retry" && action.retryAt === null) {
    invalid("a waiting_retry Action must have retryAt");
  }
  if (action.status !== "waiting_retry" && action.retryAt !== null) {
    invalid("only a waiting_retry Action may have retryAt");
  }
  if (action.status === "resolved" && action.resolution === null) {
    invalid("a resolved Action must have a resolution");
  }
  if (action.status !== "resolved" && action.resolution !== null) {
    invalid("an unresolved Action cannot have a resolution");
  }
  if (
    action.input.kind === "execute_tool" &&
    action.input.replaySafety === "idempotency_keyed" &&
    action.input.businessIdempotencyKey === null
  ) {
    invalid("an idempotency_keyed Tool Action requires a business key");
  }
}

export function assertRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
  const { thread, run, turn, action, attempt, approval, reconciliation } =
    snapshot;

  assertAction(action);

  if (run.threadId !== thread.id) invalid("Run must belong to Thread");
  if (turn.runId !== run.id) invalid("Turn must belong to Run");
  if (action.runId !== run.id || action.turnId !== turn.id) {
    invalid("Action must belong to the current Run and Turn");
  }
  if (!Number.isInteger(turn.sequence) || turn.sequence < 1) {
    invalid("Turn sequence must be a positive integer");
  }
  if (!Number.isInteger(action.sequence) || action.sequence < 1) {
    invalid("Action sequence must be a positive integer");
  }
  if (
    !Number.isInteger(run.limits.maxTurns) ||
    run.limits.maxTurns < 1 ||
    !Number.isInteger(run.limits.maxActions) ||
    run.limits.maxActions < 1
  ) {
    invalid("Run maxTurns and maxActions must be positive integers");
  }

  if (isTerminalRunStatus(run.status)) {
    if (thread.activeRunId !== null) {
      invalid("a terminal Run must be cleared from Thread.activeRunId");
    }
  } else if (thread.activeRunId !== run.id) {
    invalid("a non-terminal Run must remain Thread.activeRunId");
  }

  if (attempt !== null) {
    if (attempt.actionId !== action.id) invalid("Attempt must belong to Action");
    if (attempt.sequence !== action.attemptCount) {
      invalid("latest Attempt sequence must equal Action.attemptCount");
    }
    if (attempt.status === "started" && attempt.resolution !== null) {
      invalid("a started Attempt cannot have a resolution");
    }
    if (
      attempt.status === "resolved" &&
      (attempt.resolution === null || attempt.resolvedAt === null)
    ) {
      invalid("a resolved Attempt requires resolution and resolvedAt");
    }
  } else if (action.attemptCount !== 0) {
    invalid("Action.attemptCount requires a latest Attempt projection");
  }

  if (run.status === "executing") {
    if (action.status !== "executing" || attempt?.status !== "started") {
      invalid("executing Run requires an executing Action and started Attempt");
    }
  }

  if (run.status === "waiting_retry") {
    if (action.status !== "waiting_retry" || attempt?.status !== "resolved") {
      invalid("waiting_retry Run requires a waiting Action and resolved Attempt");
    }
  }

  if (run.status === "waiting_approval") {
    if (action.status !== "waiting_approval" || approval?.status !== "pending") {
      invalid("waiting_approval Run requires a pending Approval");
    }
    if (attempt !== null) {
      invalid("Approval must be resolved before creating a Tool Attempt");
    }
  }

  if (approval !== null) {
    if (action.input.kind !== "execute_tool") {
      invalid("Approval can bind only to a Tool Action");
    }
    if (approval.runId !== run.id || approval.actionId !== action.id) {
      invalid("Approval must bind the current Run and Action");
    }
    if (approval.actionInputHash !== action.input.inputHash) {
      invalid("Approval input hash must match immutable Tool input");
    }
  }

  if (run.status === "requires_reconciliation") {
    if (
      action.status !== "requires_reconciliation" ||
      reconciliation?.status !== "open" ||
      attempt?.resolution?.kind !== "outcome_unknown"
    ) {
      invalid("requires_reconciliation Run requires an open unknown outcome");
    }
  }

  if (reconciliation !== null) {
    if (action.input.kind !== "execute_tool") {
      invalid("Reconciliation can bind only to a Tool Action");
    }
    if (
      reconciliation.runId !== run.id ||
      reconciliation.actionId !== action.id ||
      reconciliation.attemptId !== attempt?.id
    ) {
      invalid("Reconciliation must bind the current Run, Action and Attempt");
    }
    if (reconciliation.actionInputHash !== action.input.inputHash) {
      invalid("Reconciliation input hash must match immutable Tool input");
    }
    if (
      reconciliation.status === "resolved" &&
      reconciliation.resolution === null
    ) {
      invalid("resolved Reconciliation requires a resolution");
    }
  }
}

function invalid(message: string): never {
  throw new DurableDomainError("INVALID_SNAPSHOT", message);
}
