import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDecision, decide } from "./orchestrator.js";
import { InMemoryDurableRepository } from "./in-memory-repository.js";
import { DurableRepositoryError } from "./repository-errors.js";
import {
  ApprovalExpiryScheduler,
  AttemptRecoveryCoordinator,
  AttemptRecoveryScanner,
  DurableRuntimeCoordinator,
  RetryScheduler,
} from "./runtime-coordinator.js";
import { DEFAULT_MODEL_RETRY_POLICY } from "./policies.js";
import type {
  ActionState,
  ApprovalState,
  RunState,
  RuntimeSnapshot,
  ThreadState,
  TurnState,
} from "./types.js";
import type { CreateRunInput } from "./repository.js";

const T0 = "2026-08-20T00:00:00.000Z";
const T1 = "2026-08-20T00:00:01.000Z";
const T2 = "2026-08-20T00:00:02.000Z";
const T3 = "2026-08-20T00:00:03.000Z";

function readySnapshot(): RuntimeSnapshot {
  const thread: ThreadState = {
    id: "thread-1",
    activeRunId: "run-1",
    headMessageId: "message-1",
    version: 1,
  };
  const run: RunState = {
    id: "run-1",
    threadId: thread.id,
    status: "ready",
    version: 0,
    createdAt: T0,
    updatedAt: T0,
    baseHeadMessageId: "message-0",
    triggerMessageId: "message-1",
    execution: {
      agentId: "agent-1",
      agentVersion: "1",
      modelId: "model-1",
      instructionVersion: "instructions-1",
      toolsetVersion: "tools-1",
    },
    limits: {
      deadlineAt: "2026-08-20T01:00:00.000Z",
      maxTurns: 8,
      maxActions: 16,
    },
    stopRequest: null,
    laterStopRequests: [],
    terminalError: null,
  };
  const turn: TurnState = {
    id: "turn-1",
    runId: run.id,
    sequence: 1,
    version: 0,
  };
  const action: ActionState = {
    id: "action-1",
    runId: run.id,
    turnId: turn.id,
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
  };
  return {
    thread,
    run,
    turn,
    action,
    attempt: null,
    approval: null,
    reconciliation: null,
  };
}

function createRunInput(): CreateRunInput<{ text: string }> {
  const snapshot = readySnapshot();
  return {
    thread: {
      id: snapshot.thread.id,
      activeRunId: null,
      headMessageId: "message-0",
      version: 0,
    },
    triggerMessage: {
      id: "message-1",
      threadId: snapshot.thread.id,
      parentMessageId: "message-0",
      createdByRunId: snapshot.run.id,
      role: "user",
      content: { text: "hello" },
      createdAt: T0,
    },
    run: snapshot.run,
    turn: snapshot.turn,
    action: snapshot.action,
    clientIdempotencyKey: "client-request-1",
    requestHash: "sha256:request-1",
  };
}

function approvalSnapshot(): RuntimeSnapshot {
  const snapshot = readySnapshot();
  snapshot.run.status = "waiting_approval";
  snapshot.action.status = "waiting_approval";
  snapshot.action.input = {
    kind: "execute_tool",
    toolName: "send_email",
    toolCallId: "tool-call-1",
    input: { to: "person@example.com" },
    inputHash: "sha256:tool-input",
    replaySafety: "non_idempotent",
    businessIdempotencyKey: null,
  };
  const approval: ApprovalState = {
    id: "approval-1",
    runId: snapshot.run.id,
    actionId: snapshot.action.id,
    status: "pending",
    requestedAt: T0,
    expiresAt: T2,
    resolvedAt: null,
    resolvedBy: null,
    reason: null,
    actionInputHash: "sha256:tool-input",
    version: 0,
  };
  snapshot.approval = approval;
  return snapshot;
}

describe("Durable Repository contract", () => {
  it("atomically creates the initial aggregate and reuses an idempotent Run", async () => {
    const repository = new InMemoryDurableRepository<{ text: string }>({
      now: () => T0,
    });
    const input = createRunInput();

    assert.deepEqual(await repository.createRun(input), {
      kind: "created",
      runId: "run-1",
    });
    assert.deepEqual(await repository.createRun(input), {
      kind: "existing",
      runId: "run-1",
    });

    const stored = repository.readSnapshot("run-1")!;
    assert.equal(stored.thread.activeRunId, "run-1");
    assert.equal(stored.thread.headMessageId, "message-1");
    assert.equal(stored.run.status, "ready");
    assert.equal(stored.action.status, "ready");
  });

  it("rejects the same idempotency key with a different request hash", async () => {
    const repository = new InMemoryDurableRepository<{ text: string }>();
    const input = createRunInput();
    await repository.createRun(input);

    await assert.rejects(
      repository.createRun({ ...input, requestHash: "sha256:different" }),
      (error: unknown) =>
        error instanceof DurableRepositoryError &&
        error.code === "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("rolls back all transaction-local changes when the callback fails", async () => {
    const repository = new InMemoryDurableRepository({ now: () => T1 });
    repository.seed(readySnapshot());

    await assert.rejects(
      repository.withLockedRun("run-1", async (transaction) => {
        await transaction.apply({
          events: [{
            type: "action_started",
            at: T1,
            attempt: {
              id: "attempt-1",
              actionId: "action-1",
              sequence: 1,
              status: "started",
              dispatchState: "not_dispatched",
              startedAt: T1,
              resolvedAt: null,
              resolution: null,
              version: 0,
            },
          }],
          effects: [],
        });
        throw new Error("transaction failed");
      }),
      /transaction failed/,
    );

    assert.equal(repository.readSnapshot("run-1")?.run.status, "ready");
    assert.equal(repository.readSnapshot("run-1")?.attempt, null);
  });

  it("serializes competing transactions", async () => {
    const repository = new InMemoryDurableRepository({ now: () => T1 });
    repository.seed(readySnapshot());
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    const first = repository.withLockedRun("run-1", async () => {
      order.push("first-enter");
      firstEntered();
      await firstBlocked;
      order.push("first-exit");
    });
    await entered;
    const second = repository.withLockedRun("run-1", async () => {
      order.push("second-enter");
    });
    releaseFirst();
    await Promise.all([first, second]);

    assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
  });

  it("exposes Effects only after the state transaction commits", async () => {
    const repository = new InMemoryDurableRepository({ now: () => T1 });
    repository.seed(readySnapshot());
    const coordinator = new DurableRuntimeCoordinator(repository);

    const decision = await coordinator.transact(
      "run-1",
      ({ databaseNow }) => ({
        type: "start_action",
        now: databaseNow,
        attemptId: "attempt-1",
      }),
    );

    assert.equal(repository.readSnapshot("run-1")?.run.status, "executing");
    assert.equal(decision.effects[0]?.attemptId, "attempt-1");
  });

  it("wakes due retries through a fresh authoritative transaction", async () => {
    let now = T1;
    const repository = new InMemoryDurableRepository({ now: () => now });
    const coordinator = new DurableRuntimeCoordinator(repository);
    repository.seed(readySnapshot());

    await coordinator.transact("run-1", ({ databaseNow }) => ({
      type: "start_action",
      now: databaseNow,
      attemptId: "attempt-1",
    }));
    now = T2;
    await coordinator.transact("run-1", ({ databaseNow }) => ({
      type: "resolve_attempt",
      now: databaseNow,
      attemptId: "attempt-1",
      resolution: {
        kind: "not_applied",
        failure: {
          code: "MODEL_RATE_LIMIT",
          message: "rate limited",
          retryable: true,
        },
      },
      retryAt: T3,
    }));

    assert.deepEqual(await new RetryScheduler(repository).tick(), []);
    now = T3;
    const results = await new RetryScheduler(repository).tick();

    assert.equal(results[0]?.kind, "woken");
    assert.equal(repository.readSnapshot("run-1")?.run.status, "ready");

    now = "2026-08-20T00:00:04.000Z";
    await coordinator.transact("run-1", ({ databaseNow }) => ({
      type: "start_action",
      now: databaseNow,
      attemptId: "attempt-2",
    }));
    assert.deepEqual(
      repository.readAttempts("run-1").map((attempt) => attempt.id),
      ["attempt-1", "attempt-2"],
    );
  });

  it("expires approvals without creating a Tool Attempt", async () => {
    const repository = new InMemoryDurableRepository({ now: () => T3 });
    repository.seed(approvalSnapshot());

    const results = await new ApprovalExpiryScheduler({ repository }).tick();
    const stored = repository.readSnapshot("run-1")!;

    assert.equal(results[0]?.kind, "expired");
    assert.equal(stored.approval?.status, "expired");
    assert.equal(stored.run.status, "ready");
    assert.equal(stored.attempt, null);
  });

  it("discovers started Attempts after a simulated restart", async () => {
    const executing = applyDecision(
      readySnapshot(),
      decide(readySnapshot(), {
        type: "start_action",
        now: T1,
        attemptId: "attempt-1",
      }),
    );
    const repository = new InMemoryDurableRepository({ now: () => T2 });
    repository.seed(executing);
    const recovered: string[] = [];

    await new AttemptRecoveryScanner(repository).scan(async (candidate) => {
      recovered.push(candidate.attemptId);
    });

    assert.deepEqual(recovered, ["attempt-1"]);
  });

  it("resumes an undispatched Attempt in place after restart", async () => {
    const executing = applyDecision(
      readySnapshot(),
      decide(readySnapshot(), {
        type: "start_action",
        now: T1,
        attemptId: "attempt-1",
      }),
    );
    const repository = new InMemoryDurableRepository({ now: () => T2 });
    repository.seed(executing);
    const coordinator = new DurableRuntimeCoordinator(repository);

    const decision = await coordinator.transact(
      "run-1",
      ({ databaseNow }) => ({
        type: "resume_undispatched_attempt",
        now: databaseNow,
        attemptId: "attempt-1",
      }),
    );

    assert.equal(decision.effects[0]?.attemptId, "attempt-1");
    assert.equal(
      repository.readSnapshot("run-1")?.attempt?.dispatchState,
      "not_dispatched",
    );
  });

  it("never resumes a dispatched Attempt in place", async () => {
    let executing = applyDecision(
      readySnapshot(),
      decide(readySnapshot(), {
        type: "start_action",
        now: T1,
        attemptId: "attempt-1",
      }),
    );
    executing = applyDecision(
      executing,
      decide(executing, {
        type: "record_dispatch",
        now: T1,
        attemptId: "attempt-1",
        dispatchState: "dispatched",
      }),
    );
    const repository = new InMemoryDurableRepository({ now: () => T2 });
    repository.seed(executing);

    await assert.rejects(
      new DurableRuntimeCoordinator(repository).transact(
        "run-1",
        ({ databaseNow }) => ({
          type: "resume_undispatched_attempt",
          now: databaseNow,
          attemptId: "attempt-1",
        }),
      ),
      /Only an undispatched Attempt/,
    );
  });

  it("turns a dispatched replay-safe Attempt into a durable retry after restart", async () => {
    let executing = applyDecision(
      readySnapshot(),
      decide(readySnapshot(), {
        type: "start_action",
        now: T1,
        attemptId: "attempt-1",
      }),
    );
    executing = applyDecision(
      executing,
      decide(executing, {
        type: "record_dispatch",
        now: T1,
        attemptId: "attempt-1",
        dispatchState: "dispatched",
      }),
    );
    const repository = new InMemoryDurableRepository({ now: () => T2 });
    repository.seed(executing);

    await new AttemptRecoveryCoordinator({
      repository,
      scheduleRetryAt: () => T3,
      createReconciliationId: () => "unused",
    }).recoverAll();

    const stored = repository.readSnapshot("run-1")!;
    assert.equal(stored.run.status, "waiting_retry");
    assert.equal(stored.action.retryAt, T3);
    assert.equal(stored.attempt?.resolution?.kind, "interrupted");
  });

  it("opens reconciliation for a dispatched non-idempotent Tool after restart", async () => {
    const snapshot = readySnapshot();
    snapshot.action.input = {
      kind: "execute_tool",
      toolName: "send_email",
      toolCallId: "tool-call-1",
      input: { to: "person@example.com" },
      inputHash: "sha256:tool-input",
      replaySafety: "non_idempotent",
      businessIdempotencyKey: null,
    };
    snapshot.action.retryPolicy = {
      ...snapshot.action.retryPolicy,
      maxAttempts: 1,
    };
    let executing = applyDecision(
      snapshot,
      decide(snapshot, {
        type: "start_action",
        now: T1,
        attemptId: "attempt-1",
      }),
    );
    executing = applyDecision(
      executing,
      decide(executing, {
        type: "record_dispatch",
        now: T1,
        attemptId: "attempt-1",
        dispatchState: "unknown",
      }),
    );
    const repository = new InMemoryDurableRepository({ now: () => T2 });
    repository.seed(executing);

    await new AttemptRecoveryCoordinator({
      repository,
      scheduleRetryAt: () => T3,
      createReconciliationId: () => "reconciliation-1",
    }).recoverAll();

    const stored = repository.readSnapshot("run-1")!;
    assert.equal(stored.run.status, "requires_reconciliation");
    assert.equal(stored.reconciliation?.id, "reconciliation-1");
    assert.equal(stored.attempt?.resolution?.kind, "outcome_unknown");
  });
});
