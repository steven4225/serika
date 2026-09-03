import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DEFAULT_MODEL_RETRY_POLICY } from "./policies.js";
import { DurableRepositoryError } from "./repository-errors.js";
import { DurableRuntimeCoordinator } from "./runtime-coordinator.js";
import type { CreateRunInput, DurableRepository } from "./repository.js";
import type { JsonValue, RuntimeSnapshot } from "./types.js";

const T0 = "2026-08-20T00:00:00.000Z";

export interface DurableRepositoryContractHarness {
  repository: DurableRepository<JsonValue>;
  readSnapshot(runId: string): Promise<RuntimeSnapshot | null>;
  close?(): Promise<void>;
}

export type DurableRepositoryContractFactory = (
  test: TestContext,
) => Promise<DurableRepositoryContractHarness>;

export function runDurableRepositoryContract(
  name: string,
  createHarness: DurableRepositoryContractFactory,
): void {
  describe(`${name} DurableRepository contract`, () => {
    it("atomically creates and reuses an idempotent Run", async (test) => {
      const harness = await useHarness(test, createHarness);
      const input = createContractRunInput();
      assert.deepEqual(await harness.repository.createRun(input), {
        kind: "created",
        runId: "contract-run-1",
      });
      assert.deepEqual(await harness.repository.createRun(input), {
        kind: "existing",
        runId: "contract-run-1",
      });
      const stored = await harness.readSnapshot("contract-run-1");
      assert.equal(stored?.thread.activeRunId, "contract-run-1");
      assert.equal(stored?.thread.headMessageId, "contract-message-1");
      assert.equal(stored?.run.status, "ready");
    });

    it("rejects an idempotency key reused with another hash", async (test) => {
      const harness = await useHarness(test, createHarness);
      const input = createContractRunInput();
      await harness.repository.createRun(input);
      await assert.rejects(
        harness.repository.createRun({
          ...input,
          requestHash: "jcs-sha256:v1:different",
        }),
        (error: unknown) =>
          error instanceof DurableRepositoryError &&
          error.code === "IDEMPOTENCY_KEY_REUSED",
      );
    });

    it("rolls back state and Outbox with its transaction", async (test) => {
      const harness = await useHarness(test, createHarness);
      await harness.repository.createRun(createContractRunInput());
      await assert.rejects(
        harness.repository.withLockedRun(
          "contract-run-1",
          async (transaction) => {
            await transaction.apply({
              events: [
                {
                  type: "action_started",
                  at: transaction.databaseNow,
                  attempt: {
                    id: "contract-attempt-1",
                    actionId: "contract-action-1",
                    sequence: 1,
                    status: "started",
                    dispatchState: "not_dispatched",
                    startedAt: transaction.databaseNow,
                    resolvedAt: null,
                    resolution: null,
                    version: 0,
                  },
                },
              ],
              effects: [
                {
                  kind: "invoke_model",
                  runId: "contract-run-1",
                  turnId: "contract-turn-1",
                  actionId: "contract-action-1",
                  attemptId: "contract-attempt-1",
                  modelId: "model-1",
                  messageSnapshotId: "snapshot-1",
                  timeoutMs: 30_000,
                },
              ],
            });
            throw new Error("contract rollback");
          },
        ),
        /contract rollback/,
      );
      assert.equal(
        (await harness.readSnapshot("contract-run-1"))?.run.status,
        "ready",
      );
      assert.deepEqual(await harness.repository.findPendingEffects(10), []);
    });

    it("serializes competing transactions for one Run", async (test) => {
      const harness = await useHarness(test, createHarness);
      await harness.repository.createRun(createContractRunInput());
      const order: string[] = [];
      let releaseFirst!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let enteredFirst!: () => void;
      const entered = new Promise<void>((resolve) => {
        enteredFirst = resolve;
      });
      const first = harness.repository.withLockedRun(
        "contract-run-1",
        async () => {
          order.push("first-enter");
          enteredFirst();
          await blocked;
          order.push("first-exit");
        },
      );
      await entered;
      const second = harness.repository.withLockedRun(
        "contract-run-1",
        async () => {
          order.push("second-enter");
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(order, ["first-enter"]);
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
    });

    it("keeps an Effect until its dispatch marker commits", async (test) => {
      const harness = await useHarness(test, createHarness);
      await harness.repository.createRun(createContractRunInput());
      const coordinator = new DurableRuntimeCoordinator(harness.repository);
      await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
        type: "start_action",
        now: databaseNow,
        attemptId: "contract-attempt-1",
      }));
      const pending = await harness.repository.findPendingEffects(10);
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.effect.attemptId, "contract-attempt-1");

      await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
        type: "record_dispatch",
        now: databaseNow,
        attemptId: "contract-attempt-1",
        dispatchState: "dispatched",
      }));
      assert.deepEqual(await harness.repository.findPendingEffects(10), []);
    });

    it("accepts an identical Effect replay but rejects conflicting Outbox content", async (test) => {
      const harness = await useHarness(test, createHarness);
      await harness.repository.createRun(createContractRunInput());
      const coordinator = new DurableRuntimeCoordinator(harness.repository);
      await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
        type: "start_action",
        now: databaseNow,
        attemptId: "contract-attempt-1",
      }));
      const pending = (await harness.repository.findPendingEffects(1))[0]!;

      await harness.repository.withLockedRun(
        "contract-run-1",
        (transaction) =>
          transaction.apply({ events: [], effects: [pending.effect] }),
      );
      assert.equal((await harness.repository.findPendingEffects(10)).length, 1);

      assert.equal(pending.effect.kind, "invoke_model");
      if (pending.effect.kind !== "invoke_model") {
        throw new Error("Contract fixture must start with a Model Effect");
      }
      const modelEffect = pending.effect;
      await assert.rejects(
        harness.repository.withLockedRun(
          "contract-run-1",
          (transaction) =>
            transaction.apply({
              events: [],
              effects: [{ ...modelEffect, modelId: "conflicting-model" }],
            }),
        ),
        (error: unknown) =>
          error instanceof DurableRepositoryError &&
          error.code === "OUTBOX_EFFECT_CONFLICT",
      );
      assert.deepEqual(
        (await harness.repository.findPendingEffects(1))[0]?.effect,
        pending.effect,
      );
    });

    it("removes an undispatched Effect when a stop settles its Attempt", async (test) => {
      const harness = await useHarness(test, createHarness);
      await harness.repository.createRun(createContractRunInput());
      const coordinator = new DurableRuntimeCoordinator(harness.repository);
      await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
        type: "start_action",
        now: databaseNow,
        attemptId: "contract-attempt-1",
      }));
      await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
        type: "request_stop",
        request: {
          reason: "cancel",
          requestedAt: databaseNow,
          requestedBy: "contract-test",
          detail: null,
        },
      }));
      await coordinator.transact("contract-run-1", ({ databaseNow }) => ({
        type: "resume_undispatched_attempt",
        now: databaseNow,
        attemptId: "contract-attempt-1",
      }));

      assert.deepEqual(await harness.repository.findPendingEffects(10), []);
      assert.equal(
        (await harness.readSnapshot("contract-run-1"))?.run.status,
        "cancelled",
      );
    });
  });
}

export function createContractRunInput(): CreateRunInput<JsonValue> {
  return {
    thread: {
      id: "contract-thread-1",
      activeRunId: null,
      headMessageId: null,
      version: 0,
    },
    triggerMessage: {
      id: "contract-message-1",
      threadId: "contract-thread-1",
      parentMessageId: null,
      createdByRunId: "contract-run-1",
      role: "user",
      content: { text: "hello" },
      createdAt: T0,
    },
    run: {
      id: "contract-run-1",
      threadId: "contract-thread-1",
      status: "ready",
      version: 0,
      createdAt: T0,
      updatedAt: T0,
      baseHeadMessageId: null,
      triggerMessageId: "contract-message-1",
      execution: {
        agentId: "agent-1",
        agentVersion: "1",
        modelId: "model-1",
        instructionVersion: "instructions-1",
        toolsetVersion: "tools-1",
      },
      limits: {
        deadlineAt: null,
        maxTurns: 8,
        maxActions: 16,
      },
      stopRequest: null,
      laterStopRequests: [],
      terminalError: null,
    },
    turn: {
      id: "contract-turn-1",
      runId: "contract-run-1",
      sequence: 1,
      version: 0,
    },
    action: {
      id: "contract-action-1",
      runId: "contract-run-1",
      turnId: "contract-turn-1",
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
    clientIdempotencyKey: "contract-client-request-1",
    requestHash: "jcs-sha256:v1:request-1",
  };
}

async function useHarness(
  test: TestContext,
  createHarness: DurableRepositoryContractFactory,
): Promise<DurableRepositoryContractHarness> {
  const harness = await createHarness(test);
  if (harness.close) test.after(() => harness.close!());
  return harness;
}
