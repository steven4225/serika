import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent, RunResult } from "@serika/core";
import type { AppInfo, AssistantSteerRecord, ExecutionRunRecord, GetRunResponse, MainToRenderer, PendingApproval, UiSnapshot } from "../../shared/ui-contract.js";
import { createRuntimeStore, initialRuntimeState, OUTPUT_MAX_CHARS, type RuntimeBridge, type RuntimeStore } from "./app/runtime-store.js";
import { emptyLiveRun, finishRun, resultRow } from "./conversation.js";

type Payload<K extends MainToRenderer["type"], F extends string> = Extract<MainToRenderer, { type: K }> extends infer M ? M extends Record<F, infer V> ? V : never : never;
const approval = (approvalId: string): PendingApproval => ({ approvalId, toolCallId: `call-${approvalId}`, toolName: "write_file", input: { path: "a.txt" }, preview: "写入 a.txt" });
const running = { kind: "running", runId: "run-1", phase: "primary" } as const;
const counters = (store: RuntimeStore) => {
  const { memoryRefresh, contextRefresh, taskRefresh } = store.getState();
  return { memoryRefresh, contextRefresh, taskRefresh };
};
/** A store over a fake bridge: `snapshot()` waits for the test to answer it; `getRun` answers from `runs`. */
const harness = () => {
  const calls: string[] = [];
  const pendingSnapshots: Array<{ resolve: (snapshot: UiSnapshot) => void; reject: (cause: unknown) => void }> = [];
  const runs = new Map<string, GetRunResponse | Error>();
  const errors: string[] = [];
  const bridge: RuntimeBridge = {
    snapshot: () => { calls.push("snapshot"); return new Promise((resolve, reject) => { pendingSnapshots.push({ resolve, reject }); }); },
    getRun: async runId => {
      calls.push(`getRun:${runId}`);
      const response = runs.get(runId);
      if (response instanceof Error) throw response;
      return response ?? { ok: true, run: null };
    },
  };
  const store = createRuntimeStore({ bridge: () => bridge, onError: message => { errors.push(message); } });
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  return { store, calls, pendingSnapshots, runs, errors, notifications: () => notified };
};
const newStore = () => harness().store;
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshotOf = (fields: Partial<UiSnapshot>): UiSnapshot => ({
  state: { kind: "idle" }, canSubmit: true, canSteer: false, steers: [], pendingApproval: null, recentOutput: "", outputTruncated: false,
  toolActivity: [], lastPrimaryResult: null, lastConsolidationResult: null, resultTextTruncated: false, shellProgress: [], ...fields,
});
const result = (runId: string, status: RunResult["status"] = "completed"): RunResult =>
  ({ runId, threadId: "thread-1", status, text: "完成", steps: 1, usage: {} as RunResult["usage"] });
const steer = (id: string, runId: string, status: AssistantSteerRecord["status"] = "accepted"): AssistantSteerRecord =>
  ({ id, runId, text: `补充 ${id}`, status, receivedAt: "2026-01-01T00:00:00Z" });
const stepEvent = (runId: string, sequence: number): AgentEvent =>
  ({ type: "step.started", runId, sequence, occurredAt: "2026-01-01T00:00:00Z", data: { stepNumber: sequence } }) as unknown as AgentEvent;
const record = (runId: string, steers: AssistantSteerRecord[] = []): ExecutionRunRecord => ({ runId, steers, tools: [] }) as unknown as ExecutionRunRecord;
const shellChunk = (toolCallId: string, sequence: number, text: string) => ({ toolCallId, sequence, stream: "stdout" as const, text, truncated: false });

const watched = () => {
  const store = newStore();
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  return { store, notifications: () => notified };
};

test("runtime store starts from the values AssistantPage used to start with", () => {
  const store = newStore();
  assert.deepEqual(store.getState(), {
    info: null, state: { kind: "idle" }, output: "", approval: null, homeSnapshot: null, memoryRefresh: 0, contextRefresh: 0, taskRefresh: 0,
    live: emptyLiveRun, lastResult: null, canSteer: false, finalRecord: null, steers: [], uncertainSteer: null,
  });
  assert.equal(store.getState(), initialRuntimeState);
  assert.equal(store.getState().live, emptyLiveRun);
  assert.equal(store.latestPrimaryId(), null);
  assert.equal(store.latestCompletedPrimaryId(), null);
});

test("state: a non-idle state only replaces state; idle also bumps memory, context and task refresh once", () => {
  const { store, notifications } = watched();
  store.receive({ type: "state", state: running });
  assert.deepEqual(store.getState().state, running);
  assert.deepEqual(counters(store), { memoryRefresh: 0, contextRefresh: 0, taskRefresh: 0 });
  store.receive({ type: "state", state: { kind: "idle" } });
  assert.deepEqual(store.getState().state, { kind: "idle" });
  assert.deepEqual(counters(store), { memoryRefresh: 1, contextRefresh: 1, taskRefresh: 1 });
  assert.equal(notifications(), 2, "one notification per message, even when four fields change");
});

test("output appends and keeps only the last OUTPUT_MAX_CHARS characters", () => {
  const store = newStore();
  store.receive({ type: "output", text: "abc" });
  store.receive({ type: "output", text: "def" });
  assert.equal(store.getState().output, "abcdef");
  store.receive({ type: "output", text: "x".repeat(OUTPUT_MAX_CHARS) });
  assert.equal(store.getState().output, "x".repeat(OUTPUT_MAX_CHARS));
  store.receive({ type: "output", text: "yz" });
  assert.equal(store.getState().output, "x".repeat(OUTPUT_MAX_CHARS - 2) + "yz");
  assert.equal(OUTPUT_MAX_CHARS, 64 * 1024);
});

test("home replaces the snapshot and null clears it", () => {
  const store = newStore();
  const snapshot = { sections: [] } as unknown as NonNullable<Payload<"home", "snapshot">>;
  store.receive({ type: "home", snapshot });
  assert.equal(store.getState().homeSnapshot, snapshot);
  store.receive({ type: "home", snapshot: null });
  assert.equal(store.getState().homeSnapshot, null);
});

test("approval: a new approval replaces the current one; clearing only removes the matching approval", () => {
  const { store, notifications } = watched();
  store.receive({ type: "approval", approval: approval("a") });
  store.receive({ type: "approval", approval: approval("b") });
  assert.equal(store.getState().approval?.approvalId, "b");
  const before = store.getState();
  store.receive({ type: "approval-cleared", approvalId: "a" });
  assert.equal(store.getState(), before, "a stale clear changes nothing");
  assert.equal(notifications(), 2);
  store.receive({ type: "approval-cleared", approvalId: "b" });
  assert.equal(store.getState().approval, null);
  assert.equal(notifications(), 3);
});

test("refresh counters: result and memory-references-changed bump context; memory-updated bumps memory; work-task-updated bumps task", () => {
  const store = newStore();
  const result = {} as Payload<"result", "result">;
  store.receive({ type: "result", phase: "primary", result });
  store.receive({ type: "result", phase: "consolidation", result });
  assert.deepEqual(counters(store), { memoryRefresh: 0, contextRefresh: 2, taskRefresh: 0 }, "every result, not only the current primary one");
  store.receive({ type: "memory-references-changed" });
  assert.deepEqual(counters(store), { memoryRefresh: 0, contextRefresh: 3, taskRefresh: 0 });
  store.receive({ type: "memory-updated", reason: "write" });
  assert.deepEqual(counters(store), { memoryRefresh: 1, contextRefresh: 3, taskRefresh: 0 });
  store.receive({ type: "work-task-updated", task: {} as Payload<"work-task-updated", "task"> });
  assert.deepEqual(counters(store), { memoryRefresh: 1, contextRefresh: 3, taskRefresh: 1 });
});

test("messages outside the store leave it unchanged and do not notify", () => {
  const { store, notifications } = watched();
  const before = store.getState();
  const ignored: MainToRenderer[] = [
    { type: "task-result-available" },
    { type: "identity-changed", info: {} as AppInfo },
    { type: "module-notification", moduleId: "m", message: "hi" },
    { type: "steer", steer: {} as Payload<"steer", "steer"> },
    { type: "event", phase: "primary", event: { type: "message.delta" } as Payload<"event", "event"> },
    { type: "shell-progress", phase: "primary", runId: "run-1", progress: {} as Payload<"shell-progress", "progress"> },
    { type: "error", message: "boom" },
  ];
  for (const message of ignored) store.receive(message);
  assert.equal(store.getState(), before);
  assert.equal(notifications(), 0);
});

test("applySnapshot replaces state, approval and output together and keeps the rest", () => {
  const { store, notifications } = watched();
  const info = { threadId: "thread-1" } as AppInfo;
  store.setInfo(info);
  store.receive({ type: "memory-updated", reason: "write" });
  store.receive({ type: "output", text: "old" });
  store.applySnapshot(snapshotOf({ state: running, pendingApproval: approval("a"), recentOutput: "recent" }));
  const after = store.getState();
  assert.deepEqual(after.state, running);
  assert.equal(after.approval?.approvalId, "a");
  assert.equal(after.output, "recent", "the snapshot output replaces, it does not append");
  assert.equal(after.info, info);
  assert.equal(after.memoryRefresh, 1);
  assert.equal(notifications(), 4, "the snapshot is one notification");
});

test("setInfo stores the info read at startup", () => {
  const store = newStore();
  const info = { threadId: "thread-1" } as AppInfo;
  store.setInfo(info);
  assert.equal(store.getState().info, info);
});

test("getState keeps its identity between changes and unsubscribe stops notifications", () => {
  const store = newStore();
  let notified = 0;
  const stop = store.subscribe(() => { notified += 1; });
  assert.equal(store.getState(), store.getState());
  store.receive({ type: "output", text: "a" });
  stop();
  store.receive({ type: "output", text: "b" });
  assert.equal(notified, 1);
  assert.equal(store.getState().output, "ab");
});

test("applySnapshot, idle after a completed run: the result row, no live rows, and that run is the completed one", () => {
  const { store, notifications } = harness();
  store.onRunShellProgress({ type: "shell-progress", phase: "primary", runId: "x", progress: shellChunk("t", 0, "ignored") });
  const steers = [steer("s1", "run-1", "applied")];
  store.applySnapshot(snapshotOf({ canSteer: true, steers, lastPrimaryResult: result("run-1"), shellProgress: [shellChunk("tool-1", 0, "out")] }));
  const after = store.getState();
  assert.deepEqual(after.lastResult, resultRow(result("run-1")));
  assert.equal(after.live, emptyLiveRun);
  assert.equal(after.canSteer, true);
  assert.equal(after.steers, steers);
  assert.equal(store.latestPrimaryId(), "run-1");
  assert.equal(store.latestCompletedPrimaryId(), "run-1");
  assert.equal(store.shellBuffer().view("tool-1")?.stdout, "out", "the buffer is refilled from the snapshot");
  assert.equal(notifications(), 1);

  store.applySnapshot(snapshotOf({ lastPrimaryResult: result("run-2", "failed") }));
  assert.equal(store.latestPrimaryId(), "run-2");
  assert.equal(store.latestCompletedPrimaryId(), null, "only a completed run counts as completed");
  assert.equal(store.shellBuffer().view("tool-1"), undefined, "the buffer is cleared first");
});

test("applySnapshot, primary run active: live rows from tool activity with Shell output, no result row", () => {
  const store = newStore();
  store.applySnapshot(snapshotOf({ lastPrimaryResult: result("run-0") }));
  store.applySnapshot(snapshotOf({
    state: running,
    lastPrimaryResult: result("run-0"),
    toolActivity: [{ toolCallId: "tool-1", toolName: "shell_exec", status: "completed", summary: "", truncated: true }],
    shellProgress: [shellChunk("tool-1", 0, "hello")],
  }));
  const after = store.getState();
  assert.equal(after.lastResult, null);
  assert.equal(after.live.streaming, "");
  assert.equal(after.live.rows.length, 1);
  const row = after.live.rows[0]!;
  assert.equal(row.kind, "tool");
  assert.equal(row.kind === "tool" ? row.runId : undefined, "run-1");
  assert.equal(row.kind === "tool" ? row.stdout : undefined, "hello");
  assert.equal(store.latestPrimaryId(), "run-1");
  assert.equal(store.latestCompletedPrimaryId(), null);

  store.applySnapshot(snapshotOf({ state: { kind: "running", runId: "c-1", phase: "consolidation" } as UiSnapshot["state"], lastPrimaryResult: result("run-0") }));
  assert.equal(store.latestPrimaryId(), "run-0", "a consolidation run is not the primary run");
  assert.equal(store.latestCompletedPrimaryId(), "run-0");
});

test("onRunState: an admitted primary run (no id yet) clears the previous run and returns true", async () => {
  const { store, notifications, runs } = harness();
  runs.set("run-0", { ok: true, run: record("run-0", [steer("s0", "run-0", "applied")]) });
  store.finishPrimaryRun(result("run-0"));
  await flush();
  store.onRunShellProgress({ type: "shell-progress", phase: "primary", runId: "run-0", progress: shellChunk("tool-1", 0, "out") });
  store.setCanSteer(true);
  const before = notifications();
  assert.equal(store.onRunState({ kind: "running", runId: null, phase: "primary" } as UiSnapshot["state"], () => false), true);
  const after = store.getState();
  assert.equal(after.live, emptyLiveRun);
  assert.equal(after.lastResult, null);
  assert.equal(after.finalRecord, null);
  assert.deepEqual(after.steers, []);
  assert.equal(after.canSteer, false);
  assert.equal(store.latestPrimaryId(), null);
  assert.equal(store.latestCompletedPrimaryId(), null);
  assert.equal(store.shellBuffer().view("tool-1"), undefined);
  assert.equal(notifications() - before, 1, "one notification");
});

test("onRunState: other states only turn Steer off and return false", () => {
  const { store, calls } = harness();
  store.finishPrimaryRun(result("run-0"));
  store.setCanSteer(true);
  const kept = store.getState();
  assert.equal(store.onRunState({ kind: "idle" }, () => false), false);
  assert.equal(store.getState().canSteer, false);
  assert.equal(store.getState().lastResult, kept.lastResult);
  assert.equal(store.getState().live, kept.live);
  assert.equal(store.latestPrimaryId(), "run-0");
  assert.equal(store.onRunState({ kind: "running", runId: "c-1", phase: "consolidation" } as UiSnapshot["state"], () => false), false);
  assert.equal(store.latestPrimaryId(), "run-0");
  assert.deepEqual(calls, ["getRun:run-0"], "no snapshot read outside a primary run with an id");
});

test("onRunState: a primary run id becomes current, then a fresh snapshot confirms Steer for that run only", async () => {
  const { store, calls, pendingSnapshots } = harness();
  assert.equal(store.onRunState(running, () => false), false);
  assert.equal(store.latestPrimaryId(), "run-1");
  assert.deepEqual(calls, ["snapshot"]);
  pendingSnapshots[0]!.resolve(snapshotOf({ state: running, canSteer: true }));
  await flush();
  assert.equal(store.getState().canSteer, true);

  const ignored = async (cancelled: boolean, answer: UiSnapshot, between?: () => void) => {
    store.setCanSteer(false);
    store.onRunState(running, () => cancelled);
    between?.();
    pendingSnapshots.at(-1)!.resolve(answer);
    await flush();
    assert.equal(store.getState().canSteer, false);
  };
  await ignored(true, snapshotOf({ state: running, canSteer: true }));
  await ignored(false, snapshotOf({ state: { kind: "running", runId: "run-2", phase: "primary" } as UiSnapshot["state"], canSteer: true }));
  await ignored(false, snapshotOf({ state: { kind: "idle" }, canSteer: true }));
  await ignored(false, snapshotOf({ state: running, canSteer: true }), () => store.finishPrimaryRun(result("run-3")));

  store.onRunState({ kind: "running", runId: "run-4", phase: "primary" } as UiSnapshot["state"], () => false);
  pendingSnapshots.at(-1)!.reject(new Error("bridge closed"));
  await flush();
  assert.equal(store.getState().canSteer, false, "a failed snapshot read is ignored");
});

test("mergeSteer and onRunSteer: only receipts for the latest primary run, never downgraded", () => {
  const { store, notifications } = harness();
  store.onRunState(running, () => true);
  const before = notifications();
  assert.equal(store.mergeSteer(steer("s1", "other")), false);
  store.onRunSteer(steer("s2", "other"));
  assert.equal(notifications(), before, "nothing changed, no notification");
  assert.equal(store.mergeSteer(steer("s1", "run-1", "applied")), true);
  assert.equal(store.mergeSteer(steer("s1", "run-1", "accepted")), false, "accepted does not replace applied");
  assert.deepEqual(store.getState().steers.map(item => `${item.id}:${item.status}`), ["s1:applied"]);
  assert.equal(store.getState().live, emptyLiveRun, "mergeSteer alone adds no row");
  store.onRunSteer(steer("s2", "run-1"));
  assert.deepEqual(store.getState().steers.map(item => item.id), ["s1", "s2"]);
  assert.deepEqual(store.getState().live.rows.map(row => row.key), ["steer:run-1:s2"]);
  store.replaceSteers([]);
  assert.deepEqual(store.getState().steers, []);
});

test("onRunEvent: primary events for the current run (or any run before the id is known)", () => {
  const store = newStore();
  store.onRunEvent({ type: "event", phase: "consolidation", event: stepEvent("run-1", 1) });
  assert.equal(store.getState().live, emptyLiveRun);
  store.onRunEvent({ type: "event", phase: "primary", event: stepEvent("run-1", 1) });
  assert.deepEqual(store.getState().live.rows.map(row => row.key), ["s:1"], "no current id yet: accepted");
  store.onRunState(running, () => true);
  store.onRunEvent({ type: "event", phase: "primary", event: stepEvent("run-9", 2) });
  store.onRunEvent({ type: "event", phase: "primary", event: stepEvent("run-1", 3) });
  assert.deepEqual(store.getState().live.rows.map(row => row.key), ["s:1", "s:3"]);
});

test("isCurrentPrimaryResult: primary results for the current run, or any before the id is known", () => {
  const store = newStore();
  const message = (runId: string, phase: "primary" | "consolidation" = "primary") => ({ type: "result" as const, phase, result: result(runId) });
  assert.equal(store.isCurrentPrimaryResult(message("run-1")), true);
  assert.equal(store.isCurrentPrimaryResult(message("run-1", "consolidation")), false);
  store.onRunState(running, () => true);
  assert.equal(store.isCurrentPrimaryResult(message("run-1")), true);
  assert.equal(store.isCurrentPrimaryResult(message("run-2")), false);
});

test("finishPrimaryRun: result row and finished live rows at once, then the final receipt and its Steer records", async () => {
  const { store, runs, calls, notifications } = harness();
  store.onRunState(running, () => true);
  store.onRunEvent({ type: "event", phase: "primary", event: stepEvent("run-1", 1) });
  const live = store.getState().live;
  const steers = [steer("s1", "run-1", "applied")];
  runs.set("run-1", { ok: true, run: record("run-1", steers) });
  const before = notifications();
  store.finishPrimaryRun(result("run-1"));
  assert.equal(notifications() - before, 1, "result row and live rows in one notification");
  assert.deepEqual(store.getState().lastResult, resultRow(result("run-1")));
  assert.deepEqual(store.getState().live, { rows: finishRun(live, result("run-1")), streaming: "" });
  assert.equal(store.latestPrimaryId(), "run-1");
  assert.equal(store.latestCompletedPrimaryId(), "run-1");
  assert.deepEqual(calls, ["snapshot", "getRun:run-1"]);
  await flush();
  assert.equal(store.getState().finalRecord?.runId, "run-1");
  assert.equal(store.getState().steers, steers);

  store.finishPrimaryRun(result("run-2", "cancelled"));
  assert.equal(store.latestCompletedPrimaryId(), null);
});

test("loadFinalRun: error wording, and a receipt for a run that is no longer current is dropped", async () => {
  const { store, runs, errors } = harness();
  runs.set("run-1", { ok: false, reason: "unavailable", message: "存储不可用" });
  store.finishPrimaryRun(result("run-1"));
  await flush();
  runs.set("run-2", { ok: true, run: null });
  store.finishPrimaryRun(result("run-2"));
  await flush();
  runs.set("run-3", new Error("ipc lost"));
  store.finishPrimaryRun(result("run-3"));
  await flush();
  assert.deepEqual(errors, ["最终执行回执不可用：存储不可用", "最终执行回执缺失，不能据此确认动作结果", "Error: ipc lost"]);
  assert.equal(store.getState().finalRecord, null);

  runs.set("run-4", { ok: true, run: record("run-4") });
  store.finishPrimaryRun(result("run-4"));
  store.onRunState({ kind: "running", runId: null, phase: "primary" } as UiSnapshot["state"], () => false);
  await flush();
  assert.equal(store.getState().finalRecord, null, "stale receipt ignored");
  await store.loadFinalRun("run-5");
  assert.equal(errors.length, 3, "a missing receipt is reported only for the current run");
});

test("onRunShellProgress: only the current primary run, buffered and shown on a shell_exec row", () => {
  const store = newStore();
  const progress = (runId: string, phase: "primary" | "consolidation", text: string, sequence = 0) =>
    ({ type: "shell-progress" as const, phase, runId, progress: shellChunk("tool-1", sequence, text) });
  store.onRunShellProgress(progress("run-1", "primary", "early"));
  assert.equal(store.getState().live, emptyLiveRun, "no current run id: dropped");
  store.onRunState(running, () => true);
  store.onRunShellProgress(progress("run-1", "consolidation", "x"));
  store.onRunShellProgress(progress("run-2", "primary", "x"));
  assert.equal(store.getState().live, emptyLiveRun);
  store.onRunShellProgress(progress("run-1", "primary", "a"));
  store.onRunShellProgress(progress("run-1", "primary", "b", 1));
  const rows = store.getState().live.rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind === "tool" ? `${rows[0].toolName}:${rows[0].stdout}` : "", "shell_exec:ab");
});

test("setUncertainSteer stores and clears the Steer awaiting a receipt", () => {
  const store = newStore();
  const uncertain = { id: "s1", text: "补充", expectedRunId: "run-1" } as unknown as NonNullable<ReturnType<RuntimeStore["getState"]>["uncertainSteer"]>;
  store.setUncertainSteer(uncertain);
  assert.equal(store.getState().uncertainSteer, uncertain);
  store.setUncertainSteer(null);
  assert.equal(store.getState().uncertainSteer, null);
});
