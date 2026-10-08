import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunHandle, RunRequest, RunResult } from "@aisdk-agent/core";
import type {
  TaskFinish,
  TaskRecord,
  TaskRecordV4,
  TaskStore,
  TaskStoreResult,
} from "./task-store.js";
import { runTaskWorker } from "./task-worker.js";

function task(): TaskRecordV4 {
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
    attempts: [{ number: 1, runId: null, startedAt: "2026-09-10T00:00:00.000Z", finishedAt: null, status: "running", error: null }],
    retryAt: null,
    notification: null,
    pendingOutcome: null,
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
  claimedTask: TaskRecordV4,
  options: {
    onFinish?: (outcome: TaskFinish) => void;
    finishResult?: TaskStoreResult<TaskRecordV4>;
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
    async claimNextDue(): Promise<TaskStoreResult<TaskRecordV4 | null>> {
      if (claimed) return { ok: true, value: null };
      claimed = true;
      return { ok: true, value: claimedTask };
    },
    async finish(
      _id: string,
      outcome: TaskFinish,
    ): Promise<TaskStoreResult<TaskRecordV4>> {
      options.onFinish?.(outcome);
      if (options.finishResult !== undefined) return options.finishResult;
      const finished: TaskRecordV4 = {
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
    async listRunning() { return { ok: true, value: [] }; },
    async getHealthCounts() { return { ok: true, value: { unacknowledgedCount: 0, notificationFailureCount: 0 } }; },
    async recordRunId() { return { ok: true, value: claimedTask }; },
    async recordOutcome() { return { ok: true, value: claimedTask }; },
    async retry() { return { ok: true, value: claimedTask }; },
    async listNotifications() { return { ok: true, value: [] }; },
    async recordNotification() { return { ok: true, value: claimedTask }; },
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
  it("rejects an unconfigured scheduled Skill instead of falling back to the responder", async () => {
    const controller = new AbortController(); let outcome: TaskFinish | undefined;
    const claimed = { ...task(), arrangement: { kind: "skill", source: "none", notification: "always", declarationVersion: 1, skillId: "brief", skillHash: "a".repeat(64) } as const };
    await runTaskWorker({ store: fakeStore(claimed, { onFinish: value => { outcome = value; controller.abort(); } }), signal: controller.signal,
      prepareTask: async () => { throw new Error("Skill must not use RSS fallback"); },
      loadWorkspaceContext: async () => { throw new Error("Skill must not read Memory/checkpoint"); },
      runtime: { run: async () => { throw new Error("unconfigured Skill must not run"); } } });
    assert(outcome?.status === "failed");
    assert.equal(outcome.error.code, "SKILL_UNAVAILABLE"); assert.equal(outcome.runId, null);
  });

  it("does not extend safe responder retries to scheduled Skills", async () => {
    const controller = new AbortController(); let outcome: TaskFinish | undefined;
    const claimed = { ...task(), arrangement: { kind: "skill", source: "none", notification: "always", declarationVersion: 1, skillId: "brief", skillHash: "a".repeat(64) } as const };
    const store = fakeStore(claimed, { onFinish: value => { outcome = value; controller.abort(); } });
    store.retry = async () => { throw new Error("Skill must not be retried"); };
    await runTaskWorker({ store, signal: controller.signal, safeRetry: true,
      prepareSkillTask: async () => ({ agentId: "skill:brief", prompt: claimed.prompt, formatResult: text => text }),
      runtime: { run: async () => { throw Object.assign(new Error("provider unavailable"), { code: "MODEL_UNAVAILABLE" }); } } });
    assert(outcome?.status === "failed"); assert.equal(outcome.error.code, "MODEL_UNAVAILABLE");
  });

  it("delivers a reminder deterministically without model or global source access", async () => {
    const controller = new AbortController();
    const claimed = { ...task(), prompt: "喝水", arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } as const };
    const outcomes: TaskFinish[] = [];
    const store = fakeStore(claimed, { onFinish: outcome => { outcomes.push(outcome); controller.abort(); } });
    const writes: string[] = [];
    store.recordOutcome = async (_id, outcome) => { writes.push("outcome"); assert.equal(outcome.runId, null); return { ok: true, value: claimed }; };
    await runTaskWorker({ store, signal: controller.signal, runtime: { run: async () => { throw new Error("model must not run"); } },
      prepareTask: async () => { throw new Error("RSS must not run"); },
      loadWorkspaceContext: async () => { throw new Error("Memory must not be read"); }, notify: async () => {} });
    assert.deepEqual(outcomes, [{ status: "completed", runId: null, execution: "deterministic", resultText: "喝水", notification: true }]);
    assert.deepEqual(writes, ["outcome"]);
  });

  it("binds Todoist to its declared source and never inherits workspace context", async () => {
    const controller = new AbortController();
    const claimed = { ...task(), arrangement: { kind: "todoist-brief", source: "todoist-planning", notification: "always", declarationVersion: 1 } as const };
    const requests: RunRequest[] = [];
    const store = fakeStore(claimed, { onFinish: () => controller.abort() });
    await runTaskWorker({ store, signal: controller.signal, todoistPlanningAvailable: true,
      prepareTask: async () => { throw new Error("RSS must not run"); },
      loadWorkspaceContext: async () => { throw new Error("Memory must not be read"); },
      runtime: { run: async request => { requests.push(request); return { runId: "run-1", events: emptyEvents(), result: Promise.resolve(completedResult()), cancel: async () => {} }; } } });
    assert.equal(requests[0]?.agentId, "scheduled-todoist");
    assert.equal(requests[0]?.context, undefined);
    const stopped = new AbortController(); let outcome: TaskFinish | undefined;
    await runTaskWorker({ store: fakeStore(claimed, { onFinish: value => { outcome = value; stopped.abort(); } }), signal: stopped.signal,
      runtime: { run: async () => { throw new Error("unauthorized model must not run"); } } });
    assert(outcome?.status === "failed");
    assert.equal(outcome.error.code, "TOOL_DENIED");
    assert.equal(outcome.runId, null);
  });

  it("finishes an empty RSS snapshot without model or successful notification", async () => {
    const controller = new AbortController(); let outcome: TaskFinish | undefined;
    const claimed = { ...task(), prompt: "[runloom:rss-digest:v1] 定期 RSS 资讯简报：仅整理程序提供的订阅快照，不猜测当前新闻。", recurringTaskId: "series-1" };
    await runTaskWorker({ store: fakeStore(claimed, { onFinish: value => { outcome = value; controller.abort(); } }), signal: controller.signal,
      runtime: { run: async () => { throw new Error("model must not run"); } }, notify: async () => {},
      prepareTask: async () => ({ agentId: "scheduled-rss", prompt: "empty", formatResult: text => text, deterministicResult: "没有新条目", notifyOnSuccess: false }) });
    assert.deepEqual(outcome, { status: "completed", runId: null, execution: "deterministic", resultText: "没有新条目" });
  });

  it("requires an actual successful planning receipt before delivering a typed Todoist report", async () => {
    const claimed = { ...task(), arrangement: { kind: "todoist-brief", source: "todoist-planning", notification: "always", declarationVersion: 1 } as const };
    for (const receipt of ["none", "failed", "planning"] as const) {
      const controller = new AbortController(); let outcome: TaskFinish | undefined;
      const events: RunHandle["events"] = (async function* () {
        if (receipt === "none") return;
        yield { id: "query-event", type: "tool.call.completed" as const, occurredAt: "2026-10-06T00:00:00Z", runId: "run-1", threadId: "thread-1", sequence: 1,
          data: { toolCallId: "query", toolName: "todoist_list_tasks", output: receipt === "planning" ? { ok: true, value: { view: "planning", tasks: [] } } : { ok: false, error: { code: "AUTH", message: "denied" } } } };
      })();
      await runTaskWorker({ store: fakeStore(claimed, { onFinish: value => { outcome = value; controller.abort(); } }), signal: controller.signal, todoistPlanningAvailable: true,
        runtime: { run: async () => ({ runId: "run-1", events, result: Promise.resolve(completedResult()), cancel: async () => {} }) } });
      assert(outcome);
      if (receipt === "planning") assert.equal(outcome.status, "completed");
      else { assert.equal(outcome.status, "failed"); assert(outcome.status === "failed"); assert.equal(outcome.error.code, "TASK_SOURCE_QUERY_FAILED"); }
    }
  });

  it("records the invocation id and outcome before the terminal write", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    const store = fakeStore(task(), { onFinish: () => { order.push("finish"); controller.abort(); } });
    store.recordRunId = async (_id, runId) => { order.push(runId); return { ok: true, value: task() }; };
    store.recordOutcome = async (_id, outcome) => { order.push(outcome.status); return { ok: true, value: task() }; };
    await runTaskWorker({ store, signal: controller.signal, runtime: {
      async run() { return { runId: "run-1", events: emptyEvents(), result: Promise.resolve(completedResult()), cancel: async () => {} }; },
    } });
    assert.deepEqual(order, ["run-1", "completed", "finish"]);
  });

  it("reconciles a durable outcome without executing the task again", async () => {
    const controller = new AbortController();
    const recovered = { ...task(), runId: "run-1", pendingOutcome: { status: "completed" as const, runId: "run-1", resultText: "Saved result", notification: true } };
    const store = fakeStore(recovered, { onFinish: () => controller.abort() });
    store.listRunning = async () => ({ ok: true, value: [recovered] });
    let calls = 0;
    await runTaskWorker({ store, signal: controller.signal, runtime: { async run() { calls++; throw new Error("must not execute"); } } });
    assert.equal(calls, 0);
  });

  it("only retries transient model failures for an explicit safe profile", async () => {
    for (const [safeRetry, code, attemptCount, expected] of [
      [true, "MODEL_UNAVAILABLE", 1, true],
      [false, "MODEL_UNAVAILABLE", 1, false],
      [true, "MODEL_AUTH", 1, false],
      [true, "TOOL_OUTCOME_UNKNOWN", 1, false],
      [true, "MODEL_UNAVAILABLE", 3, false],
    ] as const) {
      const controller = new AbortController();
      const claimed = task();
      claimed.attempts = Array.from({ length: attemptCount }, (_, index) => ({ ...claimed.attempts[0]!, number: index + 1 }));
      let retried = false;
      const store = fakeStore(claimed, { onFinish: () => controller.abort() });
      store.retry = async (_id, input) => {
        retried = true;
        assert.equal(input.nextRunAt, "2026-09-10T00:00:01.000Z");
        controller.abort();
        return { ok: true, value: claimed };
      };
      await runTaskWorker({ store, signal: controller.signal, safeRetry, now: () => Date.parse("2026-09-10T00:00:00.000Z"), runtime: {
        async run() { return { runId: "run-1", events: emptyEvents(), result: Promise.resolve({ ...completedResult(), status: "failed", error: { code, message: code, retryable: true, phase: "model" } }), cancel: async () => {} }; },
      } });
      assert.equal(retried, expected);
    }
  });

  it("retries only notification submission for an already terminal task", async () => {
    const controller = new AbortController();
    const terminal = { ...task(), status: "completed" as const, notification: { status: "pending" as const, attempts: 0, nextAttemptAt: null, error: null } };
    const store = fakeStore(terminal);
    store.listNotifications = async () => ({ ok: true, value: [terminal] });
    store.recordNotification = async (_id, outcome) => {
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.nextAttemptAt, "2026-09-10T00:00:01.000Z");
      controller.abort();
      return { ok: true, value: terminal };
    };
    let calls = 0;
    await runTaskWorker({ store, signal: controller.signal, now: () => Date.parse("2026-09-10T00:00:00.000Z"), notify: async () => { throw new Error("OS rejected"); }, runtime: { async run() { calls++; throw new Error("must not execute"); } } });
    assert.equal(calls, 0);
  });

  it("records OS acceptance as submitted without claiming user acknowledgement", async () => {
    const controller = new AbortController();
    const terminal = { ...task(), status: "completed" as const, notification: { status: "pending" as const, attempts: 0, nextAttemptAt: null, error: null } };
    const store = fakeStore(terminal);
    const order: string[] = [];
    store.listNotifications = async () => ({ ok: true, value: [terminal] });
    store.recordNotification = async (_id, outcome) => {
      order.push("submitted");
      assert.equal(outcome.ok, true);
      assert.equal(terminal.acknowledgedAt, null);
      controller.abort();
      return { ok: true, value: terminal };
    };
    await runTaskWorker({ store, signal: controller.signal, notify: async () => { order.push("OS accepted"); }, runtime: { async run() { throw new Error("must not execute"); } } });
    assert.deepEqual(order, ["OS accepted", "submitted"]);
  });

  it("stops the worker when linking a Run fails instead of silently executing untracked", async () => {
    const controller = new AbortController();
    const store = fakeStore(task());
    store.recordRunId = async () => ({ ok: false, error: { code: "WRITE_FAILED", message: "disk unavailable" } });
    let cancelled = false;
    await assert.rejects(runTaskWorker({ store, signal: controller.signal, runtime: {
      async run() { return { runId: "run-1", events: emptyEvents(), result: Promise.resolve(completedResult()), cancel: async () => { cancelled = true; } }; },
    } }), /WRITE_FAILED/);
    assert.equal(cancelled, true);
  });

  it("does not replay a crashed running task with no durable outcome", async () => {
    const controller = new AbortController();
    const store = fakeStore(task());
    store.listRunning = async () => ({ ok: true, value: [task()] });
    let interrupted = false;
    store.interruptRunning = async () => { interrupted = true; controller.abort(); return { ok: true, value: 1 }; };
    await runTaskWorker({ store, signal: controller.signal, safeRetry: true, runtime: { async run() { throw new Error("must not execute"); } } });
    assert.equal(interrupted, true);
  });

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

  it("loads workspace context once after claim and passes that snapshot to the run", async () => {
    const controller = new AbortController();
    const claimed = task();
    const requests: RunRequest[] = [];
    const loaded: TaskRecord[] = [];
    const snapshot = { referenceMessages: [{
      id: "workspace-observation",
      role: "assistant" as const,
      parts: [{ type: "text" as const, text: "Saved checkpoint v2" }],
    }] };
    const store = fakeStore(claimed, {
      onFinish: () => controller.abort("test-complete"),
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
      loadWorkspaceContext: async (record) => {
        loaded.push(record);
        return snapshot;
      },
    });

    assert.deepEqual(loaded, [claimed]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.context, snapshot);
  });

  it("fails a claimed task before model execution when workspace context cannot be read", async () => {
    const controller = new AbortController();
    const finished: TaskFinish[] = [];
    let runCalls = 0;
    const store = fakeStore(task(), {
      onFinish: (outcome) => {
        finished.push(outcome);
        controller.abort("test-complete");
      },
    });

    await runTaskWorker({
      store,
      runtime: {
        async run(): Promise<RunHandle> {
          runCalls += 1;
          throw new Error("model must not run");
        },
      },
      signal: controller.signal,
      pollIntervalMs: 1,
      loadWorkspaceContext: async () => {
        throw Object.assign(new Error("memory.json is damaged"), { code: "MEMORY_FILE_INVALID" });
      },
    });

    assert.equal(runCalls, 0);
    assert.deepEqual(finished, [{
      status: "failed",
      runId: null,
      error: { code: "MEMORY_FILE_INVALID", message: "memory.json is damaged" },
    }]);
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
