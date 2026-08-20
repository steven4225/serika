import { DurableDomainError } from "./errors.js";
import {
  assertRuntimeSnapshot,
  hasDeadlinePassed,
  isTerminalRunStatus,
  timestampMs,
} from "./invariants.js";
import { isReplaySafe } from "./policies.js";
import type {
  ActionResolution,
  AttemptResolution,
  DurableCommand,
  DurableDecision,
  DurableEvent,
  ExternalEffect,
  IsoTimestamp,
  ReconciliationResolution,
  RuntimeFailure,
  RuntimeSnapshot,
  StopRequest,
  TerminalRunStatus,
} from "./types.js";

const NO_DECISION: DurableDecision = Object.freeze({ events: [], effects: [] });

export function decide(
  snapshot: RuntimeSnapshot,
  command: DurableCommand,
): DurableDecision {
  assertRuntimeSnapshot(snapshot);

  if (isTerminalRunStatus(snapshot.run.status)) {
    if (command.type === "request_stop") return NO_DECISION;
    throw new DurableDomainError("RUN_NOT_ACTIVE", "Run is already terminal");
  }

  let decision: DurableDecision;
  switch (command.type) {
    case "start_action":
      decision = decideStartAction(snapshot, command);
      break;
    case "record_dispatch":
      decision = decideRecordDispatch(snapshot, command);
      break;
    case "resume_undispatched_attempt":
      decision = decideResumeUndispatchedAttempt(snapshot, command);
      break;
    case "resolve_attempt":
      decision = decideResolveAttempt(snapshot, command);
      break;
    case "resolve_approval":
      decision = decideResolveApproval(snapshot, command);
      break;
    case "expire_approval":
      decision = decideExpireApproval(snapshot, command);
      break;
    case "wake_retry":
      decision = decideWakeRetry(snapshot, command);
      break;
    case "request_stop":
      decision = decideRequestStop(snapshot, command.request);
      break;
    case "resolve_reconciliation":
      decision = decideResolveReconciliation(snapshot, command);
      break;
  }

  assertRuntimeSnapshot(applyDecision(snapshot, decision));
  return decision;
}

export function applyDecision(
  snapshot: RuntimeSnapshot,
  decision: DurableDecision,
): RuntimeSnapshot {
  return decision.events.reduce(evolve, snapshot);
}

export function evolve(
  snapshot: RuntimeSnapshot,
  event: DurableEvent,
): RuntimeSnapshot {
  switch (event.type) {
    case "action_started":
      return {
        ...snapshot,
        run: touchRun(snapshot, event.at, "executing"),
        action: {
          ...snapshot.action,
          status: "executing",
          attemptCount: event.attempt.sequence,
          retryAt: null,
          version: snapshot.action.version + 1,
        },
        attempt: event.attempt,
      };

    case "attempt_dispatch_recorded":
      return {
        ...snapshot,
        attempt: {
          ...requireAttempt(snapshot, event.attemptId),
          dispatchState: event.dispatchState,
          version: requireAttempt(snapshot, event.attemptId).version + 1,
        },
      };

    case "retry_scheduled":
      return {
        ...snapshot,
        run: touchRun(snapshot, event.at, "waiting_retry"),
        action: {
          ...snapshot.action,
          status: "waiting_retry",
          retryAt: event.retryAt,
          version: snapshot.action.version + 1,
        },
        attempt: resolveAttempt(snapshot, event.attemptId, event.at, event.resolution),
      };

    case "reconciliation_opened":
      return {
        ...snapshot,
        run: touchRun(snapshot, event.at, "requires_reconciliation"),
        action: {
          ...snapshot.action,
          status: "requires_reconciliation",
          version: snapshot.action.version + 1,
        },
        attempt: resolveAttempt(snapshot, event.attemptId, event.at, event.resolution),
        reconciliation: event.reconciliation,
      };

    case "attempt_resolved": {
      const terminal = isTerminalRunStatus(event.nextRunStatus);
      return {
        ...snapshot,
        thread: terminal ? clearActiveRun(snapshot) : snapshot.thread,
        run: {
          ...touchRun(snapshot, event.at, event.nextRunStatus),
          terminalError: event.failure,
        },
        action: {
          ...snapshot.action,
          status: "resolved",
          retryAt: null,
          resolution: event.actionResolution,
          version: snapshot.action.version + 1,
        },
        attempt: resolveAttempt(snapshot, event.attemptId, event.at, event.resolution),
      };
    }

    case "approval_resolved": {
      const approved = event.status === "approved";
      return {
        ...snapshot,
        run: touchRun(snapshot, event.at, "ready"),
        action: {
          ...snapshot.action,
          status: approved ? "ready" : "resolved",
          resolution: event.actionResolution,
          version: snapshot.action.version + 1,
        },
        approval: {
          ...requireApproval(snapshot, event.approvalId),
          status: event.status,
          resolvedAt: event.at,
          resolvedBy: event.resolvedBy,
          reason: event.reason,
          version: requireApproval(snapshot, event.approvalId).version + 1,
        },
      };
    }

    case "approval_cancelled_by_stop":
      return {
        ...snapshot,
        thread: clearActiveRun(snapshot),
        run: touchRun(snapshot, event.at, event.terminalStatus),
        action: {
          ...snapshot.action,
          status: "resolved",
          resolution: notExecutedForTerminal(event.terminalStatus),
          version: snapshot.action.version + 1,
        },
        approval: {
          ...requireApproval(snapshot, event.approvalId),
          status: "cancelled",
          resolvedAt: event.at,
          resolvedBy: event.resolvedBy,
          reason: event.reason,
          version: requireApproval(snapshot, event.approvalId).version + 1,
        },
      };

    case "retry_woken":
      return {
        ...snapshot,
        run: touchRun(snapshot, event.at, "ready"),
        action: {
          ...snapshot.action,
          status: "ready",
          retryAt: null,
          version: snapshot.action.version + 1,
        },
      };

    case "stop_requested":
      return {
        ...snapshot,
        run: {
          ...snapshot.run,
          stopRequest: event.isPrimary ? event.request : snapshot.run.stopRequest,
          laterStopRequests: event.isPrimary
            ? snapshot.run.laterStopRequests
            : [...snapshot.run.laterStopRequests, event.request],
          updatedAt: event.at,
          version: snapshot.run.version + 1,
        },
      };

    case "run_stopped_without_execution":
      return {
        ...snapshot,
        thread: clearActiveRun(snapshot),
        run: touchRun(snapshot, event.at, event.terminalStatus),
        action: {
          ...snapshot.action,
          status: "resolved",
          retryAt: null,
          resolution: event.actionResolution,
          version: snapshot.action.version + 1,
        },
      };

    case "run_limit_exceeded":
      return {
        ...snapshot,
        thread: clearActiveRun(snapshot),
        run: {
          ...touchRun(snapshot, event.at, "failed"),
          terminalError: event.failure,
        },
        action: {
          ...snapshot.action,
          status: "resolved",
          retryAt: null,
          resolution: { kind: "runtime_failure", failure: event.failure },
          version: snapshot.action.version + 1,
        },
      };

    case "reconciliation_resolved": {
      const terminal = event.nextRunStatus !== "ready";
      return {
        ...snapshot,
        thread: terminal ? clearActiveRun(snapshot) : snapshot.thread,
        run: touchRun(snapshot, event.at, event.nextRunStatus),
        action: {
          ...snapshot.action,
          status: event.actionResolution === null ? "ready" : "resolved",
          resolution: event.actionResolution,
          version: snapshot.action.version + 1,
        },
        reconciliation: {
          ...requireReconciliation(snapshot, event.reconciliationId),
          status: "resolved",
          resolution: event.resolution,
          version:
            requireReconciliation(snapshot, event.reconciliationId).version + 1,
        },
      };
    }
  }
}

function decideStartAction(
  snapshot: RuntimeSnapshot,
  command: Extract<DurableCommand, { type: "start_action" }>,
): DurableDecision {
  const stop = stopAt(snapshot, command.now);
  if (stop !== null) return stopWithoutExecution(stop, command.now);

  const exceededLimit =
    snapshot.turn.sequence > snapshot.run.limits.maxTurns
      ? "max_turns"
      : snapshot.action.sequence > snapshot.run.limits.maxActions
        ? "max_actions"
        : null;
  if (exceededLimit !== null) {
    const failure: RuntimeFailure = {
      code: "RUN_LIMIT_EXCEEDED",
      message: `Run exceeded ${exceededLimit}`,
      retryable: false,
    };
    return {
      events: [
        {
          type: "run_limit_exceeded",
          at: command.now,
          limit: exceededLimit,
          failure,
        },
      ],
      effects: [],
    };
  }

  if (snapshot.run.status !== "ready" || snapshot.action.status !== "ready") {
    throw new DurableDomainError("ACTION_NOT_READY", "Action is not ready");
  }
  if (snapshot.attempt?.status === "started") {
    throw new DurableDomainError("ATTEMPT_NOT_ACTIVE", "Action already has an active Attempt");
  }
  if (
    snapshot.action.input.kind === "execute_tool" &&
    snapshot.approval !== null &&
    snapshot.approval.status !== "approved"
  ) {
    throw new DurableDomainError(
      "ACTION_NOT_READY",
      "Tool Action has not been approved",
    );
  }

  const attempt = {
    id: command.attemptId,
    actionId: snapshot.action.id,
    sequence: snapshot.action.attemptCount + 1,
    status: "started" as const,
    dispatchState: "not_dispatched" as const,
    startedAt: command.now,
    resolvedAt: null,
    resolution: null,
    version: 0,
  };
  const effect = effectFor(snapshot, attempt.id);

  return {
    events: [{ type: "action_started", at: command.now, attempt }],
    effects: [effect],
  };
}

function decideResumeUndispatchedAttempt(
  snapshot: RuntimeSnapshot,
  command: Extract<
    DurableCommand,
    { type: "resume_undispatched_attempt" }
  >,
): DurableDecision {
  const attempt = requireActiveAttempt(snapshot, command.attemptId);
  if (attempt.dispatchState !== "not_dispatched") {
    throw new DurableDomainError(
      "INVALID_COMMAND",
      "Only an undispatched Attempt can be resumed in place",
    );
  }

  const stop = stopAt(snapshot, command.now);
  if (stop !== null) {
    const resolution: AttemptResolution = {
      kind: "safely_aborted",
      reason: stop.terminalStatus === "timed_out" ? "deadline" : "cancel",
    };
    return resolvedDecision(
      command.now,
      attempt.id,
      resolution,
      notExecutedForTerminal(stop.terminalStatus),
      stop.terminalStatus,
      null,
      stop.events,
    );
  }

  // No state mutation is necessary. The existing Attempt remains active and
  // the caller must persist `record_dispatch` before performing this Effect.
  return { events: [], effects: [effectFor(snapshot, attempt.id)] };
}

function decideRecordDispatch(
  snapshot: RuntimeSnapshot,
  command: Extract<DurableCommand, { type: "record_dispatch" }>,
): DurableDecision {
  const attempt = requireActiveAttempt(snapshot, command.attemptId);
  if (attempt.dispatchState === command.dispatchState) return NO_DECISION;

  const rank = {
    not_dispatched: 0,
    dispatched: 1,
    response_received: 2,
    unknown: 2,
  } as const;
  if (rank[command.dispatchState] < rank[attempt.dispatchState]) {
    throw new DurableDomainError(
      "INVALID_COMMAND",
      "Attempt dispatch state cannot move backwards",
    );
  }
  return {
    events: [
      {
        type: "attempt_dispatch_recorded",
        at: command.now,
        attemptId: command.attemptId,
        dispatchState: command.dispatchState,
      },
    ],
    effects: [],
  };
}

function decideResolveAttempt(
  snapshot: RuntimeSnapshot,
  command: Extract<DurableCommand, { type: "resolve_attempt" }>,
): DurableDecision {
  const attempt = requireActiveAttempt(snapshot, command.attemptId);
  const resolution = command.resolution;

  if (resolution.kind === "completed") {
    const actionResolution = completedActionResolution(snapshot, resolution);
    const stop = stopAt(snapshot, command.now);
    const nextRunStatus =
      stop?.terminalStatus ??
      (actionResolution.kind === "model_result" &&
      actionResolution.outcome === "final_answer"
        ? "completed"
        : "ready");
    return resolvedDecision(
      command.now,
      attempt.id,
      resolution,
      actionResolution,
      nextRunStatus,
      null,
      stop?.events ?? [],
    );
  }

  if (resolution.kind === "safely_aborted") {
    const stop = stopAt(snapshot, command.now, resolution.reason);
    if (stop === null) throw new Error("safely_aborted must produce a stop");
    return resolvedDecision(
      command.now,
      attempt.id,
      resolution,
      notExecutedForTerminal(stop.terminalStatus),
      stop.terminalStatus,
      null,
      stop.events,
    );
  }

  const unknownNonReplayable =
    snapshot.action.input.kind === "execute_tool" &&
    !isReplaySafe(snapshot.action, attempt) &&
    (resolution.kind === "outcome_unknown" ||
      resolution.kind === "interrupted");
  if (unknownNonReplayable) {
    if (!command.reconciliationId) {
      throw new DurableDomainError(
        "INVALID_COMMAND",
        "reconciliationId is required for an unknown non-idempotent effect",
      );
    }
    const tool = snapshot.action.input;
    if (tool.kind !== "execute_tool") {
      throw new Error("reconciliation requires a Tool Action");
    }
    const dispatchState =
      attempt.dispatchState === "dispatched" ? "dispatched" : "unknown";
    return {
      events: [
        {
          type: "reconciliation_opened",
          at: command.now,
          attemptId: attempt.id,
          resolution:
            resolution.kind === "outcome_unknown"
              ? resolution
              : {
                  kind: "outcome_unknown",
                  failure: resolution.failure,
                },
          reconciliation: {
            id: command.reconciliationId,
            runId: snapshot.run.id,
            actionId: snapshot.action.id,
            attemptId: attempt.id,
            status: "open",
            dispatchState,
            actionInputHash: tool.inputHash,
            businessIdempotencyKey: tool.businessIdempotencyKey,
            openedAt: command.now,
            resolution: null,
            version: 0,
          },
        },
      ],
      effects: [],
    };
  }

  const stop = stopAt(snapshot, command.now);
  if (stop !== null) {
    return resolvedDecision(
      command.now,
      attempt.id,
      resolution,
      notExecutedForTerminal(stop.terminalStatus),
      stop.terminalStatus,
      null,
      stop.events,
    );
  }

  const failure = resolution.failure;
  const retryable =
    (resolution.kind === "interrupted" ||
      resolution.kind === "outcome_unknown" ||
      failure.retryable) &&
    isReplaySafe(snapshot.action, attempt) &&
    snapshot.action.attemptCount < snapshot.action.retryPolicy.maxAttempts;

  if (retryable) {
    if (!command.retryAt) {
      throw new DurableDomainError(
        "INVALID_COMMAND",
        "retryAt is required when scheduling a retry",
      );
    }
    timestampMs(command.retryAt, "retryAt");
    if (timestampMs(command.retryAt, "retryAt") < timestampMs(command.now, "now")) {
      throw new DurableDomainError(
        "INVALID_COMMAND",
        "retryAt cannot be before now",
      );
    }
    const deadlineAt = snapshot.run.limits.deadlineAt;
    if (
      deadlineAt !== null &&
      timestampMs(command.retryAt, "retryAt") >=
        timestampMs(deadlineAt, "deadlineAt")
    ) {
      const deadlineStop = stopAt(snapshot, command.now, "deadline");
      if (deadlineStop === null) throw new Error("deadline must produce a stop");
      return resolvedDecision(
        command.now,
        attempt.id,
        resolution,
        notExecutedForTerminal("timed_out"),
        "timed_out",
        null,
        deadlineStop.events,
      );
    }
    return {
      events: [
        {
          type: "retry_scheduled",
          at: command.now,
          attemptId: attempt.id,
          resolution,
          retryAt: command.retryAt,
        },
      ],
      effects: [],
    };
  }

  const terminalFailure: RuntimeFailure = {
    ...failure,
    retryable: false,
    code:
      snapshot.action.attemptCount >= snapshot.action.retryPolicy.maxAttempts &&
      failure.retryable
        ? "ACTION_ATTEMPTS_EXHAUSTED"
        : failure.code,
  };
  return resolvedDecision(
    command.now,
    attempt.id,
    resolution,
    { kind: "runtime_failure", failure: terminalFailure },
    "failed",
    terminalFailure,
  );
}

function decideResolveApproval(
  snapshot: RuntimeSnapshot,
  command: Extract<DurableCommand, { type: "resolve_approval" }>,
): DurableDecision {
  const approval = requireApproval(snapshot, command.approvalId);
  if (approval.status !== "pending") {
    if (approval.status === command.decision) return NO_DECISION;
    if (approval.status === "expired") {
      throw new DurableDomainError("APPROVAL_EXPIRED", "Approval has expired");
    }
    throw new DurableDomainError(
      "APPROVAL_ALREADY_RESOLVED",
      `Approval is already ${approval.status}`,
    );
  }
  assertWaitingApproval(snapshot);

  const stop = stopAt(snapshot, command.now);
  if (stop !== null) return cancelApproval(snapshot, command.now, stop, "runtime");

  if (
    approval.expiresAt !== null &&
    hasDeadlinePassed(approval.expiresAt, command.now)
  ) {
    return expireApprovalDecision(
      command.now,
      approval.id,
      command.resolvedBy,
    );
  }

  const approved = command.decision === "approved";
  return {
    events: [
      {
        type: "approval_resolved",
        at: command.now,
        approvalId: approval.id,
        status: command.decision,
        resolvedBy: command.resolvedBy,
        reason: command.reason ?? null,
        actionResolution: approved
          ? null
          : { kind: "not_executed", reason: "approval_rejected" },
      },
    ],
    effects: [],
  };
}

function decideExpireApproval(
  snapshot: RuntimeSnapshot,
  command: Extract<DurableCommand, { type: "expire_approval" }>,
): DurableDecision {
  const approval = requireApproval(snapshot, command.approvalId);
  if (approval.status === "expired") return NO_DECISION;
  if (approval.status !== "pending") {
    throw new DurableDomainError(
      "APPROVAL_ALREADY_RESOLVED",
      `Approval is already ${approval.status}`,
    );
  }
  assertWaitingApproval(snapshot);

  const stop = stopAt(snapshot, command.now);
  if (stop !== null) return cancelApproval(snapshot, command.now, stop, "runtime");
  if (
    approval.expiresAt === null ||
    !hasDeadlinePassed(approval.expiresAt, command.now)
  ) {
    return NO_DECISION;
  }
  return expireApprovalDecision(
    command.now,
    approval.id,
    command.resolvedBy,
  );
}

function decideWakeRetry(
  snapshot: RuntimeSnapshot,
  command: Extract<DurableCommand, { type: "wake_retry" }>,
): DurableDecision {
  if (
    snapshot.run.status !== "waiting_retry" ||
    snapshot.action.status !== "waiting_retry"
  ) {
    return NO_DECISION;
  }
  if (snapshot.action.id !== command.actionId) {
    throw new DurableDomainError("INVALID_COMMAND", "Action ID does not match");
  }
  const stop = stopAt(snapshot, command.now);
  if (stop !== null) return stopWithoutExecution(stop, command.now);
  if (
    timestampMs(command.now, "now") <
    timestampMs(snapshot.action.retryAt!, "retryAt")
  ) {
    return NO_DECISION;
  }
  if (snapshot.action.attemptCount >= snapshot.action.retryPolicy.maxAttempts) {
    const failure: RuntimeFailure = {
      code: "ACTION_ATTEMPTS_EXHAUSTED",
      message: "Action retry attempts are exhausted",
      retryable: false,
    };
    const resolution: AttemptResolution = snapshot.attempt?.resolution ?? {
      kind: "known_failure",
      failure,
    };
    return resolvedDecision(
      command.now,
      requireAttempt(snapshot, snapshot.attempt?.id ?? "").id,
      resolution,
      { kind: "runtime_failure", failure },
      "failed",
      failure,
    );
  }
  return {
    events: [
      { type: "retry_woken", at: command.now, actionId: command.actionId },
    ],
    effects: [],
  };
}

function decideRequestStop(
  snapshot: RuntimeSnapshot,
  request: StopRequest,
): DurableDecision {
  timestampMs(request.requestedAt, "stopRequest.requestedAt");
  const isPrimary = snapshot.run.stopRequest === null;
  const primary = snapshot.run.stopRequest ?? request;
  const events: DurableEvent[] = [
    {
      type: "stop_requested",
      at: request.requestedAt,
      request,
      isPrimary,
    },
  ];

  if (
    snapshot.run.status === "executing" ||
    snapshot.run.status === "requires_reconciliation"
  ) {
    return { events, effects: [] };
  }

  const terminalStatus = terminalForStop(primary);
  if (snapshot.run.status === "waiting_approval") {
    const approval = requirePendingApproval(snapshot);
    events.push({
      type: "approval_cancelled_by_stop",
      at: request.requestedAt,
      approvalId: approval.id,
      resolvedBy: request.requestedBy,
      reason: primary.detail ?? primary.reason,
      terminalStatus,
    });
  } else {
    events.push({
      type: "run_stopped_without_execution",
      at: request.requestedAt,
      terminalStatus,
      actionResolution: notExecutedForTerminal(terminalStatus),
    });
  }
  return { events, effects: [] };
}

function decideResolveReconciliation(
  snapshot: RuntimeSnapshot,
  command: Extract<DurableCommand, { type: "resolve_reconciliation" }>,
): DurableDecision {
  const reconciliation = requireReconciliation(
    snapshot,
    command.reconciliationId,
  );
  if (reconciliation.status === "resolved") {
    const existing = reconciliation.resolution!;
    if (
      existing.outcome === command.outcome.kind &&
      existing.disposition ===
        (command.outcome.kind === "effect_not_applied"
          ? command.outcome.disposition
          : null)
    ) {
      return NO_DECISION;
    }
    throw new DurableDomainError(
      "RECONCILIATION_ALREADY_RESOLVED",
      "Reconciliation already has a different conclusion",
    );
  }
  if (snapshot.run.status !== "requires_reconciliation") {
    throw new DurableDomainError(
      "INVALID_COMMAND",
      "Run is not waiting for reconciliation",
    );
  }

  const stop = stopAt(snapshot, command.now);
  const resolution: ReconciliationResolution = {
    outcome: command.outcome.kind,
    disposition:
      command.outcome.kind === "effect_not_applied"
        ? command.outcome.disposition
        : null,
    output:
      command.outcome.kind === "effect_succeeded"
        ? command.outcome.output
        : command.outcome.kind === "effect_failed"
          ? command.outcome.error
          : (command.outcome.error ?? null),
    evidence: command.evidence,
    resolvedAt: command.now,
    resolvedBy: command.resolvedBy,
  };

  let actionResolution: ActionResolution | null;
  if (command.outcome.kind === "effect_succeeded") {
    actionResolution = {
      kind: "tool_result",
      isError: false,
      output: command.outcome.output,
      source: "reconciliation",
    };
  } else if (command.outcome.kind === "effect_failed") {
    actionResolution = {
      kind: "tool_result",
      isError: true,
      output: command.outcome.error,
      source: "reconciliation",
    };
  } else if (command.outcome.disposition === "return_error") {
    actionResolution = {
      kind: "tool_result",
      isError: true,
      output: command.outcome.error ?? { code: "EFFECT_NOT_APPLIED" },
      source: "reconciliation",
    };
  } else {
    actionResolution = stop === null
      ? null
      : { kind: "not_executed", reason: "effect_not_applied" };
  }

  const nextRunStatus = stop?.terminalStatus ?? "ready";
  return {
    events: [
      ...(stop?.events ?? []),
      {
        type: "reconciliation_resolved",
        at: command.now,
        reconciliationId: reconciliation.id,
        resolution,
        actionResolution,
        nextRunStatus,
      },
    ],
    effects: [],
  };
}

function completedActionResolution(
  snapshot: RuntimeSnapshot,
  resolution: Extract<AttemptResolution, { kind: "completed" }>,
): ActionResolution {
  if (
    snapshot.action.input.kind === "invoke_model" &&
    resolution.output.kind === "model"
  ) {
    return {
      kind: "model_result",
      outcome: resolution.output.outcome,
      output: resolution.output.value,
    };
  }
  if (
    snapshot.action.input.kind === "execute_tool" &&
    resolution.output.kind === "tool"
  ) {
    return {
      kind: "tool_result",
      isError: resolution.output.isError,
      output: resolution.output.value,
      source: "attempt",
    };
  }
  throw new DurableDomainError(
    "INVALID_COMMAND",
    "Attempt output does not match Action kind",
  );
}

function effectFor(
  snapshot: RuntimeSnapshot,
  attemptId: string,
): ExternalEffect {
  return snapshot.action.input.kind === "invoke_model"
    ? {
        kind: "invoke_model",
        runId: snapshot.run.id,
        turnId: snapshot.turn.id,
        actionId: snapshot.action.id,
        attemptId,
        modelId: snapshot.action.input.modelId,
        messageSnapshotId: snapshot.action.input.messageSnapshotId,
        timeoutMs: snapshot.action.attemptTimeoutMs,
      }
    : {
        kind: "execute_tool",
        runId: snapshot.run.id,
        turnId: snapshot.turn.id,
        actionId: snapshot.action.id,
        attemptId,
        toolName: snapshot.action.input.toolName,
        input: snapshot.action.input.input,
        businessIdempotencyKey:
          snapshot.action.input.businessIdempotencyKey,
        timeoutMs: snapshot.action.attemptTimeoutMs,
      };
}

function resolvedDecision(
  at: IsoTimestamp,
  attemptId: string,
  resolution: AttemptResolution,
  actionResolution: ActionResolution,
  nextRunStatus:
    | "ready"
    | "completed"
    | "failed"
    | "cancelled"
    | "timed_out",
  failure: RuntimeFailure | null,
  precedingEvents: readonly DurableEvent[] = [],
): DurableDecision {
  return {
    events: [
      ...precedingEvents,
      {
        type: "attempt_resolved",
        at,
        attemptId,
        resolution,
        actionResolution,
        nextRunStatus,
        failure,
      },
    ],
    effects: [],
  };
}

function stopAt(
  snapshot: RuntimeSnapshot,
  now: IsoTimestamp,
  forcedReason?: "cancel" | "deadline",
): {
  terminalStatus: Extract<TerminalRunStatus, "cancelled" | "timed_out">;
  events: readonly DurableEvent[];
} | null {
  const existing = snapshot.run.stopRequest;
  if (existing !== null) {
    return { terminalStatus: terminalForStop(existing), events: [] };
  }
  const reason =
    forcedReason ??
    (hasDeadlinePassed(snapshot.run.limits.deadlineAt, now)
      ? "deadline"
      : null);
  if (reason === null) return null;
  const request: StopRequest = {
    reason,
    requestedAt: now,
    requestedBy: "runtime",
    detail: null,
  };
  return {
    terminalStatus: terminalForStop(request),
    events: [
      { type: "stop_requested", at: now, request, isPrimary: true },
    ],
  };
}

function stopWithoutExecution(
  stop: NonNullable<ReturnType<typeof stopAt>>,
  at: IsoTimestamp,
): DurableDecision {
  return {
    events: [
      ...stop.events,
      {
        type: "run_stopped_without_execution",
        at,
        terminalStatus: stop.terminalStatus,
        actionResolution: notExecutedForTerminal(stop.terminalStatus),
      },
    ],
    effects: [],
  };
}

function cancelApproval(
  snapshot: RuntimeSnapshot,
  at: IsoTimestamp,
  stop: NonNullable<ReturnType<typeof stopAt>>,
  resolvedBy: string,
): DurableDecision {
  return {
    events: [
      ...stop.events,
      {
        type: "approval_cancelled_by_stop",
        at,
        approvalId: requirePendingApproval(snapshot).id,
        resolvedBy,
        reason: snapshot.run.stopRequest?.detail ?? stop.terminalStatus,
        terminalStatus: stop.terminalStatus,
      },
    ],
    effects: [],
  };
}

function expireApprovalDecision(
  at: IsoTimestamp,
  approvalId: string,
  resolvedBy: string,
): DurableDecision {
  return {
    events: [
      {
        type: "approval_resolved",
        at,
        approvalId,
        status: "expired",
        resolvedBy,
        reason: "approval_expired",
        actionResolution: {
          kind: "not_executed",
          reason: "approval_expired",
        },
      },
    ],
    effects: [],
  };
}

function terminalForStop(
  request: StopRequest,
): Extract<TerminalRunStatus, "cancelled" | "timed_out"> {
  return request.reason === "deadline" ? "timed_out" : "cancelled";
}

function notExecutedForTerminal(
  status: Extract<TerminalRunStatus, "cancelled" | "timed_out">,
): ActionResolution {
  return {
    kind: "not_executed",
    reason: status === "timed_out" ? "run_timed_out" : "run_cancelled",
  };
}

function touchRun(
  snapshot: RuntimeSnapshot,
  at: IsoTimestamp,
  status: RuntimeSnapshot["run"]["status"],
): RuntimeSnapshot["run"] {
  return {
    ...snapshot.run,
    status,
    updatedAt: at,
    version: snapshot.run.version + 1,
  };
}

function clearActiveRun(snapshot: RuntimeSnapshot): RuntimeSnapshot["thread"] {
  return {
    ...snapshot.thread,
    activeRunId: null,
    version: snapshot.thread.version + 1,
  };
}

function resolveAttempt(
  snapshot: RuntimeSnapshot,
  attemptId: string,
  at: IsoTimestamp,
  resolution: AttemptResolution,
): NonNullable<RuntimeSnapshot["attempt"]> {
  const attempt = requireAttempt(snapshot, attemptId);
  return {
    ...attempt,
    status: "resolved",
    resolvedAt: at,
    resolution,
    version: attempt.version + 1,
  };
}

function requireAttempt(
  snapshot: RuntimeSnapshot,
  attemptId: string,
): NonNullable<RuntimeSnapshot["attempt"]> {
  if (snapshot.attempt === null || snapshot.attempt.id !== attemptId) {
    throw new DurableDomainError("ATTEMPT_NOT_ACTIVE", "Attempt does not match");
  }
  return snapshot.attempt;
}

function requireActiveAttempt(
  snapshot: RuntimeSnapshot,
  attemptId: string,
): NonNullable<RuntimeSnapshot["attempt"]> {
  const attempt = requireAttempt(snapshot, attemptId);
  if (
    snapshot.run.status !== "executing" ||
    snapshot.action.status !== "executing" ||
    attempt.status !== "started"
  ) {
    throw new DurableDomainError("ATTEMPT_NOT_ACTIVE", "Attempt is not active");
  }
  return attempt;
}

function requireApproval(
  snapshot: RuntimeSnapshot,
  approvalId: string,
): NonNullable<RuntimeSnapshot["approval"]> {
  if (snapshot.approval === null || snapshot.approval.id !== approvalId) {
    throw new DurableDomainError("INVALID_COMMAND", "Approval does not match");
  }
  return snapshot.approval;
}

function requirePendingApproval(
  snapshot: RuntimeSnapshot,
): NonNullable<RuntimeSnapshot["approval"]> {
  const approval = snapshot.approval;
  if (approval === null || approval.status !== "pending") {
    throw new DurableDomainError("INVALID_COMMAND", "Pending Approval is required");
  }
  return approval;
}

function assertWaitingApproval(snapshot: RuntimeSnapshot): void {
  if (
    snapshot.run.status !== "waiting_approval" ||
    snapshot.action.status !== "waiting_approval"
  ) {
    throw new DurableDomainError(
      "INVALID_COMMAND",
      "Run and Action are not waiting for approval",
    );
  }
}

function requireReconciliation(
  snapshot: RuntimeSnapshot,
  reconciliationId: string,
): NonNullable<RuntimeSnapshot["reconciliation"]> {
  if (
    snapshot.reconciliation === null ||
    snapshot.reconciliation.id !== reconciliationId
  ) {
    throw new DurableDomainError(
      "INVALID_COMMAND",
      "Reconciliation does not match",
    );
  }
  return snapshot.reconciliation;
}
