import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunHandle, RunRequest, RunResult } from "@aisdk-agent/core";
import type {
  TaskFinish,
  TaskRecord,
  TaskRecordV3,
  TaskStore,
  TaskStoreResult,
} from "./task-store.js";
import { runTaskWorker } from "./task-worker.js";

function task(): TaskRecordV3 {
  return {
    id: "task-1",
    prompt: "Prepare a short study plan",
    runAt: "2026-09-10T00:00:00.000Z",
    status: "running",
    createdAt: "2026-09-09T00:00:00.000Z",
    startedAt: "2026-09-10T00:00:00.000Z",
    finishedAt: null,
    threadId: "thread-1",
    runId: null,
    resultText: null,
    error: null,
    acknowledgedAt: null,
    recurringTaskId: null,
  };
}

function completedResult(): RunResult {
  return {
    runId: "run-1",
    threadId: "thread-1",
    status: "completed",
    text: "Study plan",
    steps: 1,
    usage: {},
  };
}

function fakeStore(
  claimedTask: TaskRecordV3,
  options: {
    onFinish?: (outcome: TaskFinish) => void;
    finishResult?: TaskStoreResult<TaskRecordV3>;
  } = {},
): TaskStore {
  let claimed = false;
  return {
    async create() {
      return { ok: true, value: claimedTask };
    },
    async list() {
      return { ok: true, value: { tasks: [], truncated: false } };
    },
    async get() {
      return { ok: true, value: claimedTask };
    },
    async cancel() {
      return { ok: true, value: claimedTask };
    },
    async reschedule() {
      return { ok: true, value: claimedTask };
    },
    async acknowledge() {
      return { ok: true, value: claimedTask };
    },
    async claimNextDue(): Promise<TaskStoreResult<TaskRecordV3 | null>> {
      if (claimed) return { ok: true, value: null };
      claimed = true;
      return { ok: true, value: claimedTask };
    },
    async finish(
      _id: string,
      outcome: TaskFinish,
    ): Promise<TaskStoreResult<TaskRecordV3>> {
      options.onFinish?.(outcome);
      if (options.finishResult !== undefined) return options.finishResult;
      const finished: TaskRecordV3 = {
        ...claimedTask,
        status: outcome.status,
        finishedAt: "2026-09-10T00:00:01.000Z",
        runId: outcome.runId,
        resultText: outcome.status === "completed" ? outcome.resultText : null,
        error: outcome.status === "completed" ? null : outcome.error,
      };
      return { ok: true, value: finished };
    },
    async interruptRunning() {
      return { ok: true, value: 0 };
    },
    async createRecurring() {
      return {
        ok: false,
        error: { code: "RECURRING_TASK_NOT_FOUND", message: "unused" },
      };
    },
    async listRecurring() {
      return { ok: true, value: { recurringTasks: [], truncated: false } };
    },
    async getRecurring() {
      return {
        ok: false,
        error: { code: "RECURRING_TASK_NOT_FOUND", message: "unused" },
      };
    },
    async pauseRecurring() {
      return {
        ok: false,
        error: { code: "RECURRING_TASK_NOT_FOUND", message: "unused" },
      };
    },
    async resumeRecurring() {
      return {
        ok: false,
        error: { code: "RECURRING_TASK_NOT_FOUND", message: "unused" },
      };
    },
    async cancelRecurring() {
      return {
        ok: false,
        error: { code: "RECURRING_TASK_NOT_FOUND", message: "unused" },
      };
    },
  };
}

function emptyEvents(): RunHandle["events"] {
  return (async function* () {
    // No events are needed for the worker contract test.
  })();
}

describe("task worker", () => {
  it("runs one due task with a new plain-text request and finishes it", async () => {
    const controller = new AbortController();
    const requests: RunRequest[] = [];
    const finished: TaskFinish[] = [];
    const notified: TaskRecord[] = [];
    const store = fakeStore(task(), {
      onFinish: (outcome) => {
        finished.push(outcome);
        controller.abort("test-complete");
      },
    });
    const runtime = {
      async run(request: RunRequest): Promise<RunHandle> {
        requests.push(request);
        return {
          runId: "run-1",
          events: emptyEvents(),
          result: Promise.resolve(completedResult()),
          cancel: async () => undefined,
        };
      },
    };

    await runTaskWorker({
      store,
      runtime,
      signal: controller.signal,
      pollIntervalMs: 1,
      generateId: () => "message-1",
      onTaskFinished: (terminalTask) => notified.push(terminalTask),
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.agentId, "scheduled-responder");
    assert.equal(requests[0]?.threadId, "thread-1");
    assert.deepEqual(requests[0]?.messages, [
      {
        id: "message-1",
        role: "user",
        metadata: { source: "scheduled-task" },
        parts: [{ type: "text", text: "Prepare a short study plan" }],
      },
    ]);
    assert.deepEqual(finished, [
      { status: "completed", runId: "run-1", resultText: "Study plan" },
    ]);
    assert.equal(notified.length, 1);
    assert.equal(notified[0]?.status, "completed");
  });

  it("maps cancellation of the current run to interrupted without replay", async () => {
    const controller = new AbortController();
    const finished: TaskFinish[] = [];
    const notified: TaskRecord[] = [];
    const store = fakeStore(task(), {
      onFinish: (outcome) => {
        finished.push(outcome);
      },
    });
    let cancelCalls = 0;
    let resolveResult!: (result: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => {
      resolveResult = resolve;
    });
    const runtime = {
      async run(): Promise<RunHandle> {
        return {
          runId: "run-1",
          events: emptyEvents(),
          result,
          cancel: async () => {
            cancelCalls += 1;
            resolveResult({
              ...completedResult(),
              status: "cancelled",
              text: "",
              error: {
                code: "RUN_CANCELLED",
                message: "Agent run was cancelled",
                retryable: false,
                phase: "runtime",
              },
            });
          },
        };
      },
    };

    const running = runTaskWorker({
      store,
      runtime,
      signal: controller.signal,
      pollIntervalMs: 1,
      onTaskFinished: (terminalTask) => notified.push(terminalTask),
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort("test-stop");
    await running;

    assert.equal(cancelCalls, 1);
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.status, "interrupted");
    assert.equal(finished[0]?.runId, "run-1");
    assert.deepEqual(finished[0]?.error, {
      code: "TASK_INTERRUPTED",
      message: "Worker stopped while the task was running",
    });
    assert.equal(notified.length, 1);
    assert.equal(notified[0]?.status, "interrupted");
  });

  it("records runtime startup failure and continues only after terminal write", async () => {
    const controller = new AbortController();
    const finished: TaskFinish[] = [];
    const store = fakeStore(task(), {
      onFinish: (outcome) => {
        finished.push(outcome);
        controller.abort("test-complete");
      },
    });
    const runtime = {
      async run(): Promise<RunHandle> {
        throw new Error("model configuration failed");
      },
    };

    await runTaskWorker({
      store,
      runtime,
      signal: controller.signal,
      pollIntervalMs: 1,
      onTaskFinished: () => {
        throw new Error("desktop notification failed");
      },
    });

    assert.deepEqual(finished, [
      {
        status: "failed",
        runId: null,
        error: { code: "RUNTIME_ERROR", message: "model configuration failed" },
      },
    ]);
  });

  it("does not notify when the durable terminal write fails", async () => {
    const controller = new AbortController();
    let notifyCalls = 0;
    const store = fakeStore(task(), {
      finishResult: {
        ok: false,
        error: { code: "WRITE_FAILED", message: "disk unavailable" },
      },
    });
    const runtime = {
      async run(): Promise<RunHandle> {
        return {
          runId: "run-1",
          events: emptyEvents(),
          result: Promise.resolve(completedResult()),
          cancel: async () => undefined,
        };
      },
    };

    await assert.rejects(
      runTaskWorker({
        store,
        runtime,
        signal: controller.signal,
        pollIntervalMs: 1,
        onTaskFinished: () => {
          notifyCalls += 1;
        },
      }),
      /WRITE_FAILED: disk unavailable/,
    );
    assert.equal(notifyCalls, 0);
  });

  it("notifies once after a rejected run is durably marked failed", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const store = fakeStore(task(), {
      onFinish: (outcome) => {
        order.push(`finish:${outcome.status}`);
        controller.abort("test-complete");
      },
    });
    const runtime = {
      async run(): Promise<RunHandle> {
        return {
          runId: "run-rejected",
          events: emptyEvents(),
          result: Promise.reject(new Error("handle rejected")),
          cancel: async () => undefined,
        };
      },
    };

    await runTaskWorker({
      store,
      runtime,
      signal: controller.signal,
      pollIntervalMs: 1,
      onTaskFinished: (terminalTask) => {
        order.push(`notify:${terminalTask.status}`);
      },
    });

    assert.deepEqual(order, ["finish:failed", "notify:failed"]);
  });
});
