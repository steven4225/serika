import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ActiveAttemptRegistry,
  EffectDispatcher,
  RunStopCoordinator,
  type EffectTickResult,
  type ModelInvoker,
  type ToolExecutor,
} from "./effect-dispatcher.js";
import { InMemoryDurableRepository } from "./in-memory-repository.js";
import type { DurableRepository, PendingEffect } from "./repository.js";
import { createContractRunInput } from "./repository-contract.js";
import { DurableRuntimeCoordinator } from "./runtime-coordinator.js";
import type { ExternalEffect, IsoTimestamp, JsonValue } from "./types.js";

const T0 = "2026-08-20T00:00:00.000Z";
const T1 = "2026-08-20T00:00:01.000Z";

describe("EffectDispatcher", () => {
  it("commits dispatch before invoking an SDK-independent Model port", async () => {
    const repository = await startedModelRepository();
    const dispatcher = createDispatcher(repository, {
      modelInvoker: {
        async invoke(request, context) {
          assert.deepEqual(request, {
            modelId: "model-1",
            messageSnapshotId: "snapshot-1",
          });
          assert.deepEqual(context.identity, {
            runId: "contract-run-1",
            turnId: "contract-turn-1",
            actionId: "contract-action-1",
            attemptId: "attempt-1",
          });
          assert.deepEqual(await repository.findPendingEffects(10), []);
          assert.equal(
            repository.readSnapshot(context.identity.runId)?.attempt
              ?.dispatchState,
            "dispatched",
          );
          return {
            kind: "completed",
            outcome: "final_answer",
            output: { text: "done" },
          };
        },
      },
    });

    const report = completedReport(await dispatcher.tick());

    assert.deepEqual(report, {
      scanned: 1,
      invoked: 1,
      settledWithoutInvocation: 0,
      stale: 0,
      failures: [],
    });
    assert.equal(repository.readSnapshot("contract-run-1")?.run.status, "completed");
  });

  it("passes the pinned Toolset, Tool call identity, input and business key", async () => {
    const repository = await startedToolRepository({
      replaySafety: "idempotency_keyed",
      businessIdempotencyKey: "email-42",
    });
    const dispatcher = createDispatcher(repository, {
      toolExecutor: {
        async execute(request, context) {
          assert.deepEqual(request, {
            toolsetVersion: "tools-1",
            toolName: "send_email",
            toolCallId: "tool-call-1",
            input: { to: "person@example.com" },
            businessIdempotencyKey: "email-42",
          });
          assert.equal(context.identity.attemptId, "attempt-1");
          return { kind: "completed", isError: false, output: { sent: true } };
        },
      },
    });

    assert.equal(completedReport(await dispatcher.tick()).invoked, 1);
    assert.deepEqual(
      repository.readSnapshot("contract-run-1")?.action.resolution,
      {
        kind: "tool_result",
        isError: false,
        output: { sent: true },
        source: "attempt",
      },
    );
  });

  it("returns busy instead of queuing an overlapping tick", async () => {
    const repository = await startedModelRepository();
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher = createDispatcher(repository, {
      modelInvoker: {
        async invoke() {
          started();
          await blocked;
          return { kind: "completed", outcome: "final_answer", output: null };
        },
      },
    });

    const first = dispatcher.tick();
    await invoked;
    assert.deepEqual(await dispatcher.tick(), { kind: "busy" });
    release();
    assert.equal(completedReport(await first).invoked, 1);
  });

  it("retries a non-idempotent Tool only when not_applied is proven", async () => {
    const repository = await startedToolRepository({ maxAttempts: 2 });
    const dispatcher = createDispatcher(repository, {
      toolExecutor: {
        async execute() {
          return {
            kind: "not_applied",
            failure: {
              code: "TOOL_CONNECTION_UNAVAILABLE",
              message: "request was not sent",
              retryable: true,
            },
          };
        },
      },
    });

    await dispatcher.tick();

    const snapshot = repository.readSnapshot("contract-run-1");
    assert.equal(snapshot?.run.status, "waiting_retry");
    assert.equal(snapshot?.action.retryAt, T1);
    assert.equal(snapshot?.attempt?.resolution?.kind, "not_applied");
  });

  it("opens reconciliation for an unknown non-idempotent Tool outcome", async () => {
    const repository = await startedToolRepository({ timeoutMs: 5 });
    const dispatcher = createDispatcher(repository, {
      toolExecutor: {
        async execute() {
          return new Promise(() => undefined);
        },
      },
    });

    await dispatcher.tick();

    const snapshot = repository.readSnapshot("contract-run-1");
    assert.equal(snapshot?.run.status, "requires_reconciliation");
    assert.equal(snapshot?.reconciliation?.id, "reconciliation-attempt-1");
    assert.equal(snapshot?.attempt?.resolution?.kind, "outcome_unknown");
    assert.equal(
      snapshot?.attempt?.resolution?.kind === "outcome_unknown"
        ? snapshot.attempt.resolution.failure.code
        : null,
      "ATTEMPT_TIMEOUT",
    );
  });

  it("does not retry an unclassified Adapter exception", async () => {
    const repository = await startedModelRepository();
    const dispatcher = createDispatcher(repository, {
      modelInvoker: {
        async invoke() {
          throw new Error("provider secret detail");
        },
      },
    });

    await dispatcher.tick();

    const snapshot = repository.readSnapshot("contract-run-1");
    assert.equal(snapshot?.run.status, "failed");
    assert.equal(snapshot?.run.terminalError?.code, "EXTERNAL_EFFECT_UNCLASSIFIED");
    assert.doesNotMatch(snapshot?.run.terminalError?.message ?? "", /secret/);
  });

  it("persists cancellation before aborting and ignores a late result", async () => {
    const repository = await startedModelRepository();
    const activeAttempts = new ActiveAttemptRegistry();
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const late = new Promise<{
      kind: "completed";
      outcome: "final_answer";
      output: JsonValue;
    }>((resolve) => {
      release = () => resolve({
        kind: "completed",
        outcome: "final_answer",
        output: { text: "late" },
      });
    });
    const dispatcher = createDispatcher(repository, {
      activeAttempts,
      modelInvoker: {
        async invoke() {
          started();
          return late;
        },
      },
    });

    const ticking = dispatcher.tick();
    await invoked;
    await new RunStopCoordinator({ repository, activeAttempts }).request({
      runId: "contract-run-1",
      reason: "cancel",
      requestedBy: "test",
      detail: "cancelled by test",
    });
    await ticking;
    assert.equal(repository.readSnapshot("contract-run-1")?.run.status, "cancelled");
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(repository.readSnapshot("contract-run-1")?.run.status, "cancelled");
    assert.equal(activeAttempts.has("attempt-1"), false);
  });

  it("gives the absolute Run deadline priority when timeout budgets are equal", async () => {
    const repository = await startedModelRepository({
      deadlineAt: "2026-08-20T00:00:00.005Z",
      timeoutMs: 5,
    });
    const dispatcher = createDispatcher(repository, {
      modelInvoker: {
        async invoke() {
          return new Promise(() => undefined);
        },
      },
    });

    await dispatcher.tick();

    const snapshot = repository.readSnapshot("contract-run-1");
    assert.equal(snapshot?.run.stopRequest?.reason, "deadline");
    assert.equal(snapshot?.run.status, "timed_out");
  });

  it("rejects a candidate whose payload differs from authoritative state", async () => {
    const base = await startedModelRepository();
    const pending = (await base.findPendingEffects(1))[0]!;
    assert.equal(pending.effect.kind, "invoke_model");
    if (pending.effect.kind !== "invoke_model") {
      throw new Error("Fixture must contain a Model Effect");
    }
    const tampered: PendingEffect = {
      ...pending,
      effect: { ...pending.effect, modelId: "tampered-model" },
    };
    const repository = overridePending(base, [tampered]);
    const dispatcher = createDispatcher(repository);

    const report = completedReport(await dispatcher.tick());

    assert.equal(report.failures[0]?.code, "OUTBOX_PAYLOAD_MISMATCH");
    assert.equal(base.readSnapshot("contract-run-1")?.attempt?.dispatchState, "not_dispatched");
    assert.equal((await base.findPendingEffects(10)).length, 1);
  });

  it("settles a stopped undispatched Attempt without invoking a port", async () => {
    const repository = await startedModelRepository();
    await new DurableRuntimeCoordinator(repository).transact(
      "contract-run-1",
      ({ databaseNow }) => ({
        type: "request_stop",
        request: {
          reason: "cancel",
          requestedAt: databaseNow,
          requestedBy: "test",
          detail: null,
        },
      }),
    );
    const report = completedReport(await createDispatcher(repository).tick());

    assert.equal(report.settledWithoutInvocation, 1);
    assert.equal(repository.readSnapshot("contract-run-1")?.run.status, "cancelled");
    assert.deepEqual(await repository.findPendingEffects(10), []);
  });
});

async function startedModelRepository(options: {
  deadlineAt?: IsoTimestamp | null;
  timeoutMs?: number;
} = {}): Promise<InMemoryDurableRepository> {
  const repository = new InMemoryDurableRepository({ now: () => T0 });
  const input = createContractRunInput();
  input.run.limits.deadlineAt = options.deadlineAt ?? null;
  input.action.attemptTimeoutMs = options.timeoutMs ?? 30_000;
  await repository.createRun(input);
  await start(repository);
  return repository;
}

async function startedToolRepository(options: {
  timeoutMs?: number;
  maxAttempts?: number;
  replaySafety?: "read_only" | "naturally_idempotent" | "idempotency_keyed" | "non_idempotent";
  businessIdempotencyKey?: string | null;
} = {}): Promise<InMemoryDurableRepository> {
  const repository = new InMemoryDurableRepository({ now: () => T0 });
  const input = createContractRunInput();
  input.action.input = {
    kind: "execute_tool",
    toolName: "send_email",
    toolCallId: "tool-call-1",
    input: { to: "person@example.com" },
    inputHash: "jcs-sha256:v1:tool-input",
    replaySafety: options.replaySafety ?? "non_idempotent",
    businessIdempotencyKey: options.businessIdempotencyKey ?? null,
  };
  input.action.retryPolicy = {
    ...input.action.retryPolicy,
    maxAttempts: options.maxAttempts ?? 1,
  };
  input.action.attemptTimeoutMs = options.timeoutMs ?? 30_000;
  await repository.createRun(input);
  await start(repository);
  return repository;
}

async function start(repository: DurableRepository): Promise<void> {
  await new DurableRuntimeCoordinator(repository).transact(
    "contract-run-1",
    ({ databaseNow }) => ({
      type: "start_action",
      now: databaseNow,
      attemptId: "attempt-1",
    }),
  );
}

function createDispatcher(
  repository: DurableRepository,
  overrides: {
    modelInvoker?: ModelInvoker;
    toolExecutor?: ToolExecutor;
    activeAttempts?: ActiveAttemptRegistry;
  } = {},
): EffectDispatcher {
  return new EffectDispatcher({
    repository,
    modelInvoker: overrides.modelInvoker ?? rejectingModelInvoker(),
    toolExecutor: overrides.toolExecutor ?? rejectingToolExecutor(),
    ...(overrides.activeAttempts
      ? { activeAttempts: overrides.activeAttempts }
      : {}),
    scheduleRetryAt: () => T1,
    createReconciliationId: (effect: ExternalEffect) =>
      `reconciliation-${effect.attemptId}`,
  });
}

function completedReport(result: EffectTickResult) {
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") throw new Error("tick was busy");
  return result.report;
}

function rejectingModelInvoker(): ModelInvoker {
  return {
    async invoke() {
      throw new Error("Unexpected Model invocation");
    },
  };
}

function rejectingToolExecutor(): ToolExecutor {
  return {
    async execute() {
      throw new Error("Unexpected Tool invocation");
    },
  };
}

function overridePending(
  base: InMemoryDurableRepository,
  pending: readonly PendingEffect[],
): DurableRepository {
  return {
    createRun: (input) => base.createRun(input),
    withLockedRun: (runId, operation) =>
      base.withLockedRun(runId, operation),
    locateApproval: (approvalId) => base.locateApproval(approvalId),
    locateReconciliation: (reconciliationId) =>
      base.locateReconciliation(reconciliationId),
    findDueRetries: (limit) => base.findDueRetries(limit),
    findExpiredApprovals: (limit) => base.findExpiredApprovals(limit),
    findRecoverableAttempts: (limit) =>
      base.findRecoverableAttempts(limit),
    findPendingEffects: async () => pending,
  };
}
