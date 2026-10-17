import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunHandle } from "@serika/core";
import { createAssistantController } from "./assistant-controller.js";
import { PRIMARY_AGENT_ID, type RuntimeApp } from "./app.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => { resolve = next; });
  return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Controller condition timed out");
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
async function flush() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
function appWith(overrides: Partial<RuntimeApp> = {}): RuntimeApp {
  return {
    tuiMode: true, agentId: PRIMARY_AGENT_ID,
    runtime: { run: async () => { throw new Error("Unexpected Run"); } } as unknown as RuntimeApp["runtime"],
    store: { getMessages: async () => [] } as unknown as RuntimeApp["store"],
    executionRecords: {
      claimThread: async () => ({ release: async () => undefined }), recoverInterrupted: async () => 0,
      finishRun: async () => undefined, listRuns: async () => [], getRun: async () => null,
    } as unknown as RuntimeApp["executionRecords"],
    enableExecutionRecords: () => undefined, bindNextExecutionWorkTask: () => () => undefined,
    workTasks: undefined, workTaskContext: { begin: () => undefined, end: () => undefined },
    threadId: "index-controls", directory: "/private/tmp/index-controls-unused", workspaceRoot: "/private/tmp/index-controls-unused",
    moduleConfig: undefined, toolConfirmation: undefined, commands: undefined, compaction: undefined,
    getContextDiagnostics: async () => ({ ok: false, error: { code: "TEST", message: "unused" } }),
    resume: undefined, autoConsolidationAgentId: undefined, renderHome: async () => undefined,
    registerNotificationRedraw: () => undefined, dispose: () => undefined, ...overrides,
  };
}
function handle(): RunHandle {
  return { runId: "primary", events: (async function* () {})(), cancel: async () => undefined,
    result: Promise.resolve({ runId: "primary", threadId: "index-controls", status: "completed", text: "ok", steps: 1, usage: {} }) };
}

test("startup maintenance follows recovery, uses background state without Run, and never spins on idle", async () => {
  const gate = deferred(); let calls = 0, recovered = false;
  const app = appWith({ maintainMemoryIndex: async () => { assert.equal(recovered, true); calls++; await gate.promise; } });
  app.executionRecords.recoverInterrupted = async () => { recovered = true; return 0; };
  const controller = createAssistantController(app);
  try {
    await waitFor(() => calls === 1);
    assert.deepEqual(controller.getSnapshot().state, { kind: "running", runId: null, phase: "skill", background: true });
    gate.resolve(); await waitFor(() => controller.getSnapshot().state.kind === "idle"); await flush();
    assert.equal(calls, 1);
  } finally { gate.resolve(); await controller.shutdown(); }
});

test("successful memory edit and candidate review request fresh maintenance", async () => {
  let calls = 0;
  const saved = { id: "m", text: "updated", revision: 2, enabled: true, scope: { kind: "workspace" as const } };
  const controller = createAssistantController(appWith({
    maintainMemoryIndex: async () => { calls++; },
    memoryStore: {
      update: async () => ({ ok: true, entry: saved }),
      resolveCandidate: async () => ({ ok: true, value: { candidateId: "c", status: "accepted", memoryId: "m", memoryRevision: 2, replayed: false } }),
    } as unknown as NonNullable<RuntimeApp["memoryStore"]>,
  }));
  try {
    await waitFor(() => calls === 1 && controller.getSnapshot().state.kind === "idle");
    assert.equal((await controller.updateMemory({ id: "m", expectedRevision: 1, text: "updated" })).ok, true);
    await waitFor(() => calls === 2 && controller.getSnapshot().state.kind === "idle");
    assert.equal((await controller.resolveMemoryCandidate({ candidateId: "c", expectedCandidateRevision: 1, decision: "accept" })).ok, true);
    await waitFor(() => calls === 3 && controller.getSnapshot().state.kind === "idle");
    await flush(); assert.equal(calls, 3);
  } finally { await controller.shutdown(); }
});

test("foreground aborts maintenance and waits for actual settlement before starting chat", async () => {
  const gate = deferred(); let calls = 0, runs = 0, signal: AbortSignal | undefined;
  const controller = createAssistantController(appWith({
    maintainMemoryIndex: async next => { calls++; if (calls === 1) { signal = next; await gate.promise; next.throwIfAborted(); } },
    runtime: { run: async () => { runs++; return handle(); } } as unknown as RuntimeApp["runtime"],
  }));
  try {
    await waitFor(() => calls === 1);
    const started = controller.run("hello");
    await waitFor(() => signal!.aborted); await flush(); assert.equal(runs, 0);
    gate.resolve(); assert.equal((await started).ok, true);
    await waitFor(() => calls === 2 && controller.getSnapshot().state.kind === "idle");
    assert.equal(runs, 1); await flush(); assert.equal(calls, 2);
  } finally { gate.resolve(); await controller.shutdown(); }
});

test("shutdown cancels and settles maintenance before disposal without rescheduling", async () => {
  const gate = deferred(); let signal: AbortSignal | undefined, disposed = false, calls = 0;
  const controller = createAssistantController(appWith({
    maintainMemoryIndex: async next => { calls++; signal = next; await gate.promise; next.throwIfAborted(); },
    dispose: () => { disposed = true; },
  }));
  await waitFor(() => calls === 1);
  const stopped = controller.shutdown(); await waitFor(() => signal!.aborted);
  assert.equal(disposed, false); gate.resolve(); await stopped; await flush();
  assert.equal(disposed, true); assert.equal(calls, 1);
});

test("maintenance failure reports a bounded error and does not retry on idle", async () => {
  let calls = 0;
  const controller = createAssistantController(appWith({ maintainMemoryIndex: async () => { calls++; throw new Error("private upstream details"); } }));
  const errors: string[] = [];
  controller.subscribe(event => { if (event.type === "error") errors.push(event.message); });
  try {
    await waitFor(() => calls === 1 && controller.getSnapshot().state.kind === "idle"); await flush();
    assert.equal(calls, 1); assert.equal(errors.length, 1);
    assert.match(errors[0]!, /不会自动重试/); assert.doesNotMatch(errors[0]!, /private upstream/);
  } finally { await controller.shutdown(); }
});

test("startup automatic consolidation has priority and its committed proposals are indexed afterward", async () => {
  const order: string[] = [];
  const controller = createAssistantController(appWith({
    autoConsolidationAgentId: "memory-consolidator",
    getMemoryConsolidationBacklog: async () => ({ ok: true, value: 1 }),
    memoryStore: {} as NonNullable<RuntimeApp["memoryStore"]>,
    memoryConsolidation: {
      begin: () => undefined, discard: () => undefined,
      canStart: async () => ({ ok: true, value: { canStart: true } }),
      finalize: async () => { order.push("commit"); return { ok: true, value: { candidateIds: ["new"], processedCount: 1, replayed: false } }; },
    } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
    maintainMemoryIndex: async () => { order.push("index"); },
    runtime: { run: async () => { order.push("consolidate"); return handle(); } } as unknown as RuntimeApp["runtime"],
  }));
  try {
    await waitFor(() => order.includes("index") && controller.getSnapshot().state.kind === "idle");
    assert.deepEqual(order, ["consolidate", "commit", "index"]);
    await flush(); assert.deepEqual(order, ["consolidate", "commit", "index"]);
  } finally { await controller.shutdown(); }
});

test("chat admitted before recovery completes still schedules the initial index after the foreground Run", async () => {
  let calls = 0;
  const controller = createAssistantController(appWith({
    maintainMemoryIndex: async () => { calls++; },
    runtime: { run: async () => handle() } as unknown as RuntimeApp["runtime"],
  }));
  try {
    assert.equal((await controller.run("hello")).ok, true);
    await waitFor(() => calls === 1 && controller.getSnapshot().state.kind === "idle");
    await flush(); assert.equal(calls, 1);
  } finally { await controller.shutdown(); }
});
