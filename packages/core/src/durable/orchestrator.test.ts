import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DurableDomainError } from "./errors.js";
import { assertRuntimeSnapshot } from "./invariants.js";
import { applyDecision, decide } from "./orchestrator.js";
import {
  DEFAULT_MODEL_RETRY_POLICY,
  normalizeToolExecutionPolicy,
} from "./policies.js";
import type {
  ApprovalState,
  AttemptResolution,
  RuntimeSnapshot,
  ToolActionInput,
} from "./types.js";

const T0 = "2026-08-13T00:00:00.000Z";
const T1 = "2026-08-13T00:00:01.000Z";
const T2 = "2026-08-13T00:00:02.000Z";
const T3 = "2026-08-13T00:00:03.000Z";

function modelSnapshot(): RuntimeSnapshot {
  return {
    thread: {
      id: "thread-1",
      activeRunId: "run-1",
      headMessageId: "message-0",
      version: 0,
    },
    run: {
      id: "run-1",
      threadId: "thread-1",
      status: "ready",
      version: 0,
      createdAt: T0,
      updatedAt: T0,
      baseHeadMessageId: "message-0",
      triggerMessageId: "message-1",
      execution: {
        agentId: "assistant",
        agentVersion: "1",
        modelId: "model-1",
        instructionVersion: "instructions-1",
        toolsetVersion: "tools-1",
      },
      limits: {
        deadlineAt: "2026-08-13T00:10:00.000Z",
        maxTurns: 8,
        maxActions: 16,
      },
      stopRequest: null,
      laterStopRequests: [],
      terminalError: null,
    },
    turn: {
      id: "turn-1",
      runId: "run-1",
      sequence: 1,
      version: 0,
    },
    action: {
      id: "action-1",
      runId: "run-1",
      turnId: "turn-1",
      sequence: 1,
      status: "ready",
      version: 0,
      input: {
        kind: "invoke_model",
        modelId: "model-1",
        messageSnapshotId: "snapshot-1",
      },
      retryPolicy: { ...DEFAULT_MODEL_RETRY_POLICY },
      attemptTimeoutMs: 30_000,
      attemptCount: 0,
      retryAt: null,
      resolution: null,
    },
    attempt: null,
    approval: null,
    reconciliation: null,
  };
}

function toolSnapshot(input?: {
  replaySafety?: ToolActionInput["replaySafety"];
  approval?: boolean;
}): RuntimeSnapshot {
  const snapshot = modelSnapshot();
  const replaySafety = input?.replaySafety ?? "non_idempotent";
  snapshot.action.input = {
    kind: "execute_tool",
    toolName: "charge_card",
    toolCallId: "tool-call-1",
    input: { amount: 42 },
    inputHash: "sha256:input-1",
    replaySafety,
    businessIdempotencyKey:
      replaySafety === "idempotency_keyed" ? "payment-1" : null,
  };
  snapshot.action.retryPolicy = {
    ...DEFAULT_MODEL_RETRY_POLICY,
    maxAttempts: replaySafety === "non_idempotent" ? 1 : 3,
  };

  if (input?.approval) {
    snapshot.run.status = "waiting_approval";
    snapshot.action.status = "waiting_approval";
    snapshot.approval = approval();
  }
  return snapshot;
}

function approval(): ApprovalState {
  return {
    id: "approval-1",
    runId: "run-1",
    actionId: "action-1",
    status: "pending",
    requestedAt: T0,
    expiresAt: null,
    resolvedAt: null,
    resolvedBy: null,
    reason: null,
    actionInputHash: "sha256:input-1",
    version: 0,
  };
}

function start(snapshot: RuntimeSnapshot, attemptId = "attempt-1") {
  return applyDecision(
    snapshot,
    decide(snapshot, { type: "start_action", now: T1, attemptId }),
  );
}

function retryableFailure(): AttemptResolution {
  return {
    kind: "not_applied",
    failure: {
      code: "MODEL_RATE_LIMIT",
      message: "rate limited",
      retryable: true,
    },
  };
}

describe("durable Orchestrator", () => {
  it("starts one persisted Attempt and describes exactly one model effect", () => {
    const snapshot = modelSnapshot();
    const decision = decide(snapshot, {
      type: "start_action",
      now: T1,
      attemptId: "attempt-1",
    });

    assert.equal(decision.events[0]?.type, "action_started");
    assert.deepEqual(decision.effects, [
      {
        kind: "invoke_model",
        runId: "run-1",
        turnId: "turn-1",
        actionId: "action-1",
        attemptId: "attempt-1",
        modelId: "model-1",
        messageSnapshotId: "snapshot-1",
        timeoutMs: 30_000,
      },
    ]);

    const next = applyDecision(snapshot, decision);
    assert.equal(next.run.status, "executing");
    assert.equal(next.action.attemptCount, 1);
    assert.equal(next.attempt?.dispatchState, "not_dispatched");
  });

  it("commits a final model answer and atomically clears the active Run", () => {
    const executing = start(modelSnapshot());
    const decision = decide(executing, {
      type: "resolve_attempt",
      now: T2,
      attemptId: "attempt-1",
      resolution: {
        kind: "completed",
        output: {
          kind: "model",
          outcome: "final_answer",
          value: { messageId: "message-2", text: "done" },
        },
      },
    });
    const completed = applyDecision(executing, decision);

    assert.equal(completed.run.status, "completed");
    assert.equal(completed.thread.activeRunId, null);
    assert.equal(completed.action.status, "resolved");
    assert.equal(completed.attempt?.status, "resolved");
  });

  it("persists retryAt, wakes the same Action, then creates a new Attempt", () => {
    const executing = start(modelSnapshot());
    const scheduled = applyDecision(
      executing,
      decide(executing, {
        type: "resolve_attempt",
        now: T2,
        attemptId: "attempt-1",
        resolution: retryableFailure(),
        retryAt: T3,
      }),
    );
    assert.equal(scheduled.run.status, "waiting_retry");
    assert.equal(scheduled.action.retryAt, T3);

    const early = decide(scheduled, {
      type: "wake_retry",
      now: "2026-08-13T00:00:02.500Z",
      actionId: "action-1",
    });
    assert.deepEqual(early, { events: [], effects: [] });

    const woken = applyDecision(
      scheduled,
      decide(scheduled, {
        type: "wake_retry",
        now: T3,
        actionId: "action-1",
      }),
    );
    assert.equal(woken.action.id, "action-1");
    assert.equal(woken.action.status, "ready");
    assert.equal(woken.action.retryAt, null);

    const second = start(woken, "attempt-2");
    assert.equal(second.action.attemptCount, 2);
    assert.equal(second.attempt?.id, "attempt-2");
    assert.equal(second.attempt?.sequence, 2);
  });

  it("uses an absolute Run deadline before dispatching an effect", () => {
    const snapshot = modelSnapshot();
    snapshot.run.limits.deadlineAt = T1;

    const decision = decide(snapshot, {
      type: "start_action",
      now: T1,
      attemptId: "attempt-never-created",
    });
    const timedOut = applyDecision(snapshot, decision);

    assert.deepEqual(decision.effects, []);
    assert.equal(timedOut.run.status, "timed_out");
    assert.equal(timedOut.thread.activeRunId, null);
    assert.equal(timedOut.attempt, null);
  });

  it("fails with RUN_LIMIT_EXCEEDED instead of misreporting a timeout", () => {
    const snapshot = modelSnapshot();
    snapshot.run.limits.maxActions = 1;
    snapshot.action.sequence = 2;

    const decision = decide(snapshot, {
      type: "start_action",
      now: T1,
      attemptId: "attempt-never-created",
    });
    const failed = applyDecision(snapshot, decision);

    assert.deepEqual(decision.effects, []);
    assert.equal(failed.run.status, "failed");
    assert.equal(failed.run.terminalError?.code, "RUN_LIMIT_EXCEEDED");
    assert.equal(failed.thread.activeRunId, null);
    assert.equal(failed.attempt, null);
  });

  it("approves without executing in the approval transaction and is idempotent", () => {
    const waiting = toolSnapshot({ approval: true });
    const decision = decide(waiting, {
      type: "resolve_approval",
      now: T1,
      approvalId: "approval-1",
      decision: "approved",
      resolvedBy: "user-1",
    });

    assert.deepEqual(decision.effects, []);
    const approved = applyDecision(waiting, decision);
    assert.equal(approved.run.status, "ready");
    assert.equal(approved.action.status, "ready");
    assert.equal(approved.attempt, null);

    assert.deepEqual(
      decide(approved, {
        type: "resolve_approval",
        now: T2,
        approvalId: "approval-1",
        decision: "approved",
        resolvedBy: "user-1",
      }),
      { events: [], effects: [] },
    );
  });

  it("turns approval rejection into a known not_executed observation", () => {
    const waiting = toolSnapshot({ approval: true });
    const rejected = applyDecision(
      waiting,
      decide(waiting, {
        type: "resolve_approval",
        now: T1,
        approvalId: "approval-1",
        decision: "rejected",
        resolvedBy: "user-1",
        reason: "too risky",
      }),
    );

    assert.equal(rejected.run.status, "ready");
    assert.deepEqual(rejected.action.resolution, {
      kind: "not_executed",
      reason: "approval_rejected",
    });
    assert.equal(rejected.attempt, null);
  });

  it("does not fail the Run for a definitive tool business error", () => {
    const executing = start(toolSnapshot({ replaySafety: "read_only" }));
    const resolved = applyDecision(
      executing,
      decide(executing, {
        type: "resolve_attempt",
        now: T2,
        attemptId: "attempt-1",
        resolution: {
          kind: "completed",
          output: {
            kind: "tool",
            isError: true,
            value: { code: "FILE_NOT_FOUND" },
          },
        },
      }),
    );

    assert.equal(resolved.run.status, "ready");
    assert.deepEqual(resolved.action.resolution, {
      kind: "tool_result",
      isError: true,
      output: { code: "FILE_NOT_FOUND" },
      source: "attempt",
    });
  });

  it("blocks an unknown non-idempotent effect for reconciliation", () => {
    let executing = start(toolSnapshot());
    executing = applyDecision(
      executing,
      decide(executing, {
        type: "record_dispatch",
        now: T1,
        attemptId: "attempt-1",
        dispatchState: "dispatched",
      }),
    );

    const unknown: AttemptResolution = {
      kind: "outcome_unknown",
      failure: {
        code: "TOOL_RESPONSE_LOST",
        message: "request was sent but no response was durably observed",
        retryable: true,
      },
    };
    const blocked = applyDecision(
      executing,
      decide(executing, {
        type: "resolve_attempt",
        now: T2,
        attemptId: "attempt-1",
        resolution: unknown,
        reconciliationId: "reconciliation-1",
      }),
    );

    assert.equal(blocked.run.status, "requires_reconciliation");
    assert.equal(blocked.reconciliation?.status, "open");
    assert.equal(blocked.attempt?.resolution?.kind, "outcome_unknown");
    assert.equal(blocked.thread.activeRunId, "run-1");
  });

  it("records cancel during reconciliation, then preserves confirmed success before cancelling", () => {
    let executing = start(toolSnapshot());
    executing = applyDecision(
      executing,
      decide(executing, {
        type: "record_dispatch",
        now: T1,
        attemptId: "attempt-1",
        dispatchState: "unknown",
      }),
    );
    let blocked = applyDecision(
      executing,
      decide(executing, {
        type: "resolve_attempt",
        now: T2,
        attemptId: "attempt-1",
        resolution: {
          kind: "outcome_unknown",
          failure: {
            code: "TOOL_RESPONSE_LOST",
            message: "unknown",
            retryable: true,
          },
        },
        reconciliationId: "reconciliation-1",
      }),
    );
    blocked = applyDecision(
      blocked,
      decide(blocked, {
        type: "request_stop",
        request: {
          reason: "cancel",
          requestedAt: T3,
          requestedBy: "user-1",
          detail: "stop now",
        },
      }),
    );
    assert.equal(blocked.run.status, "requires_reconciliation");

    const reconciled = applyDecision(
      blocked,
      decide(blocked, {
        type: "resolve_reconciliation",
        now: "2026-08-13T00:00:04.000Z",
        reconciliationId: "reconciliation-1",
        resolvedBy: "operator-1",
        evidence: { providerReceipt: "receipt-1" },
        outcome: {
          kind: "effect_succeeded",
          output: { chargeId: "charge-1" },
        },
      }),
    );

    assert.equal(reconciled.run.status, "cancelled");
    assert.equal(reconciled.thread.activeRunId, null);
    assert.deepEqual(reconciled.action.resolution, {
      kind: "tool_result",
      isError: false,
      output: { chargeId: "charge-1" },
      source: "reconciliation",
    });
    assert.equal(reconciled.attempt?.resolution?.kind, "outcome_unknown");
  });

  it("keeps the first stop reason and audits later competing requests", () => {
    let executing = start(modelSnapshot());
    executing = applyDecision(
      executing,
      decide(executing, {
        type: "request_stop",
        request: {
          reason: "cancel",
          requestedAt: T2,
          requestedBy: "user-1",
          detail: null,
        },
      }),
    );
    executing = applyDecision(
      executing,
      decide(executing, {
        type: "request_stop",
        request: {
          reason: "deadline",
          requestedAt: T3,
          requestedBy: "runtime",
          detail: null,
        },
      }),
    );

    assert.equal(executing.run.stopRequest?.reason, "cancel");
    assert.equal(executing.run.laterStopRequests[0]?.reason, "deadline");

    const stopped = applyDecision(
      executing,
      decide(executing, {
        type: "resolve_attempt",
        now: "2026-08-13T00:00:04.000Z",
        attemptId: "attempt-1",
        resolution: { kind: "safely_aborted", reason: "deadline" },
      }),
    );
    assert.equal(stopped.run.status, "cancelled");
  });

  it("defaults undeclared tools to non-idempotent with one attempt", () => {
    const policy = normalizeToolExecutionPolicy({});
    assert.equal(policy.replaySafety, "non_idempotent");
    assert.equal(policy.retryPolicy.maxAttempts, 1);
  });

  it("rejects a snapshot that creates a Tool Attempt before approval", () => {
    const invalid = toolSnapshot({ approval: true });
    invalid.attempt = {
      id: "attempt-1",
      actionId: "action-1",
      sequence: 1,
      status: "started",
      dispatchState: "not_dispatched",
      startedAt: T1,
      resolvedAt: null,
      resolution: null,
      version: 0,
    };
    invalid.action.attemptCount = 1;

    assert.throws(
      () => assertRuntimeSnapshot(invalid),
      (error: unknown) =>
        error instanceof DurableDomainError &&
        error.code === "INVALID_SNAPSHOT",
    );
  });
});
