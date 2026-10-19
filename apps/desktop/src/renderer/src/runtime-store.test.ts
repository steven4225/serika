import assert from "node:assert/strict";
import { mock, test } from "node:test";
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
/** Each message the store's error banner changes to, in order (the banner is the store's `error` field). */
const recordErrors = (store: RuntimeStore, errors: string[]): void => {
  let shown = store.getState().error;
  store.subscribe(() => {
    const next = store.getState().error;
    if (next === shown) return;
    shown = next;
    if (next !== null) errors.push(next);
  });
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
  const store = createRuntimeStore({ bridge: () => bridge });
  recordErrors(store, errors);
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
    history: { rows: [], runId: null }, historyBefore: null, historyLoading: false,
    records: { status: "loading" }, recordDetail: { status: "idle" }, traceFocusTool: null,
    conversationTitle: "当前对话", threads: [], threadsRefresh: 0, error: null, reconnecting: false,
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

/** A store whose history reads wait for the test: each historyPage/listRuns/info call is queued in call order. */
const historyHarness = () => {
  const calls: string[] = [];
  const pending: Array<{ name: string; resolve: (value: unknown) => void; reject: (cause: unknown) => void }> = [];
  const wait = <T,>(name: string) => new Promise<T>((resolve, reject) => { calls.push(name); pending.push({ name, resolve: resolve as (value: unknown) => void, reject }); });
  const errors: string[] = [];
  const bridge: RuntimeBridge = {
    snapshot: () => new Promise(() => {}),
    getRun: async () => ({ ok: true, run: null }),
    historyPage: input => wait(input?.beforeId ? `historyPage:${input.beforeId}` : "historyPage"),
    listRuns: () => wait("listRuns"),
    info: () => wait("info"),
  };
  const store = createRuntimeStore({ bridge: () => bridge });
  recordErrors(store, errors);
  const answer = (name: string, value: unknown) => {
    const index = pending.findIndex(item => item.name === name);
    assert.notEqual(index, -1, `no pending ${name}`);
    pending.splice(index, 1)[0]!.resolve(value);
  };
  const fail = (name: string, cause: unknown) => {
    const index = pending.findIndex(item => item.name === name);
    pending.splice(index, 1)[0]!.reject(cause);
  };
  return { store, calls, errors, answer, fail };
};
const userMessage = (id: string, text: string) => ({ id, role: "user", parts: [{ type: "text", text }] });
const page = (messages: unknown[], beforeId: string | null, extra: Record<string, unknown> = {}) => ({ threadId: "thread-1", messages, beforeId, ...extra });
const threadInfo = { threadId: "thread-1" };
const historyTexts = (store: RuntimeStore) => store.getState().history.rows.map(row => (row as { text?: string }).text);

test("reloadHistory: reads page, receipts and info together (in that order) and stores rows, cursor and the completed run", async () => {
  const { store, calls, answer } = historyHarness();
  store.finishPrimaryRun(result("run-1"));
  const loading = store.reloadHistory();
  assert.deepEqual(calls, ["historyPage", "listRuns", "info"]);
  answer("historyPage", page([userMessage("m1", "你好")], "m1"));
  answer("listRuns", { ok: true, runs: [] });
  answer("info", threadInfo);
  await loading;
  assert.deepEqual(historyTexts(store), ["你好"]);
  assert.equal(store.getState().history.runId, "run-1");
  assert.equal(store.getState().historyBefore, "m1");
});

test("reloadHistory: stale when a newer read, a newly admitted run or invalidateHistory came first; a foreign thread is ignored", async () => {
  for (const interrupt of ["newer read", "admitted", "invalidate", "other thread"] as const) {
    const { store, answer } = historyHarness();
    const first = store.reloadHistory();
    if (interrupt === "newer read") void store.reloadHistory();
    if (interrupt === "admitted") assert.equal(store.onRunState({ kind: "running", runId: null, phase: "primary" }, () => false), true);
    if (interrupt === "invalidate") store.invalidateHistory();
    answer("historyPage", page([userMessage("m1", "旧")], "m1", interrupt === "other thread" ? { threadId: "thread-2" } : {}));
    answer("listRuns", { ok: true, runs: [] });
    answer("info", threadInfo);
    await first;
    assert.deepEqual(store.getState().history, { rows: [], runId: null }, interrupt);
    assert.equal(store.getState().historyBefore, null, interrupt);
  }
});

test("reloadHistory: a receipts failure still shows rows; a memory receipt error goes to onError; a page failure rejects", async () => {
  const { store, answer, fail, errors } = historyHarness();
  const loading = store.reloadHistory();
  answer("historyPage", page([userMessage("m1", "你好")], null, { memoryReceiptError: "记忆回执读取失败" }));
  fail("listRuns", new Error("closed"));
  answer("info", threadInfo);
  await loading;
  assert.deepEqual(historyTexts(store), ["你好"]);
  assert.deepEqual(errors, ["记忆回执读取失败"]);
  const failing = store.reloadHistory();
  fail("historyPage", new Error("bridge closed"));
  answer("listRuns", { ok: true, runs: [] });
  answer("info", threadInfo);
  await assert.rejects(failing, /bridge closed/);
});

test("loadOlderHistory: page, info, receipts in that order; loading flag; older rows first; view hooks around the rows; failure copy", async () => {
  const { store, calls, answer, fail, errors } = historyHarness();
  const steps: string[] = [];
  const view = () => { steps.push("capture"); return { beforeShow: () => steps.push(`before:${historyTexts(store).length}`), afterShow: () => steps.push(`after:${historyTexts(store).length}`) }; };
  await store.loadOlderHistory(view); // No cursor yet: nothing happens.
  assert.deepEqual([calls, steps], [[], []]);
  const reload = store.reloadHistory();
  answer("historyPage", page([userMessage("m2", "新")], "m2"));
  answer("listRuns", { ok: true, runs: [] });
  answer("info", threadInfo);
  await reload;
  calls.length = 0;

  const older = store.loadOlderHistory(view);
  assert.equal(store.getState().historyLoading, true);
  await store.loadOlderHistory(view); // Already loading: nothing happens.
  assert.deepEqual(calls, ["historyPage:m2", "info", "listRuns"]);
  answer("historyPage:m2", page([userMessage("m1", "旧")], null));
  answer("info", threadInfo);
  answer("listRuns", { ok: true, runs: [] });
  await older;
  assert.deepEqual(historyTexts(store), ["旧", "新"]);
  assert.deepEqual(steps, ["capture", "before:1", "after:2"]);
  assert.equal(store.getState().historyBefore, null);
  assert.equal(store.getState().historyLoading, false);

  const again = harnessWithCursor();
  await again.ready;
  const failing = again.store.loadOlderHistory(view);
  again.fail("historyPage:m9", new Error("closed"));
  again.answer("info", threadInfo);
  again.answer("listRuns", { ok: true, runs: [] });
  await failing;
  assert.deepEqual(again.errors, ["更早的对话读取失败；当前内容仍保留，可以重试"]);
  assert.equal(again.store.getState().historyLoading, false);
  assert.deepEqual(errors, []);
});

function harnessWithCursor() {
  const harness = historyHarness();
  const reload = harness.store.reloadHistory();
  harness.answer("historyPage", page([userMessage("m9", "x")], "m9"));
  harness.answer("listRuns", { ok: true, runs: [] });
  harness.answer("info", threadInfo);
  return { ...harness, ready: reload };
}

test("records: list ready (with model usage) or unavailable; a newer list read or invalidateRecords makes a read stale", async () => {
  const { store, calls, answer } = historyHarness();
  const first = store.loadRecords();
  const second = store.loadRecords();
  answer("listRuns", { ok: true, runs: [record("run-old")] });
  await first;
  assert.deepEqual(store.getState().records, { status: "loading" });
  answer("listRuns", { ok: true, runs: [record("run-1")], modelUsage: { calls: 1 } });
  await second;
  assert.deepEqual(store.getState().records, { status: "ready", runs: [record("run-1")], modelUsage: { calls: 1 } });
  const third = store.loadRecords();
  store.invalidateRecords();
  answer("listRuns", { ok: false, reason: "unavailable", message: "回执库不可用" });
  await third;
  assert.equal(store.getState().records.status, "ready");
  const fourth = store.loadRecords();
  answer("listRuns", { ok: false, reason: "unavailable", message: "回执库不可用" });
  await fourth;
  assert.deepEqual(store.getState().records, { status: "unavailable", message: "回执库不可用" });
  assert.deepEqual(calls, ["listRuns", "listRuns", "listRuns", "listRuns"]);
});

test("records: open shows loading then the run, missing or unavailable; close drops a read in flight; reloadOpenRecords rereads the opened one", async () => {
  const { store, calls, runs } = harness();
  runs.set("run-1", { ok: true, run: record("run-1") });
  runs.set("run-2", { ok: true, run: null });
  runs.set("run-3", { ok: false, reason: "unavailable", message: "读不到" } as GetRunResponse);
  const opening = store.openRecord("run-1", "call-7");
  assert.deepEqual([store.getState().recordDetail, store.getState().traceFocusTool], [{ status: "loading", runId: "run-1" }, "call-7"]);
  await opening;
  assert.deepEqual(store.getState().recordDetail, { status: "ready", run: record("run-1") });
  await store.openRecord("run-2");
  assert.deepEqual([store.getState().recordDetail, store.getState().traceFocusTool], [{ status: "missing", runId: "run-2" }, null]);
  await store.openRecord("run-3");
  assert.deepEqual(store.getState().recordDetail, { status: "unavailable", runId: "run-3", message: "读不到" });
  const closing = store.openRecord("run-1", "call-7");
  store.closeRecord();
  await closing;
  assert.deepEqual([store.getState().recordDetail, store.getState().traceFocusTool], [{ status: "idle" }, null]);
  assert.deepEqual(calls, ["getRun:run-1", "getRun:run-2", "getRun:run-3", "getRun:run-1"]);
});

test("records: refreshOpenTrace reloads once, 250 ms after the first call, only while the tab is visible; invalidateRecords cancels it", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { store, calls } = historyHarness();
    store.refreshOpenTrace(); // Not visible: nothing.
    mock.timers.tick(300);
    assert.deepEqual(calls, []);
    store.setTraceVisible(true);
    store.refreshOpenTrace();
    store.refreshOpenTrace();
    mock.timers.tick(249);
    assert.deepEqual(calls, []);
    mock.timers.tick(1);
    assert.deepEqual(calls, ["listRuns"]);
    store.refreshOpenTrace();
    store.setTraceVisible(false); // Hidden before the timer fires: no read.
    mock.timers.tick(250);
    assert.deepEqual(calls, ["listRuns"]);
    store.setTraceVisible(true);
    store.refreshOpenTrace();
    store.invalidateRecords();
    mock.timers.tick(250);
    assert.deepEqual(calls, ["listRuns"]);
    store.refreshOpenTrace(); // The cancelled timer no longer blocks a new one.
    mock.timers.tick(250);
    assert.deepEqual(calls, ["listRuns", "listRuns"]);
  } finally { mock.timers.reset(); }
});

test("threads: the title follows every read, the list only a read started while idle; a cleaned-up or failed read changes nothing", async () => {
  const reads: Array<{ resolve: (threads: unknown) => void; reject: (cause: unknown) => void }> = [];
  const bridge = { snapshot: () => new Promise(() => {}), getRun: async () => ({ ok: true, run: null }),
    listThreads: () => new Promise((resolve, reject) => { reads.push({ resolve, reject }); }) } as unknown as RuntimeBridge;
  const store = createRuntimeStore({ bridge: () => bridge });
  store.subscribe(() => assert.equal(store.getState().error, null, "no error for a thread list read"));
  const info = { threadId: "thread-1" } as AppInfo;
  const thread = (threadId: string, title: string) => ({ threadId, title });
  const listed = [thread("thread-0", "旧对话"), thread("thread-1", "周末计划")];

  store.readThreads(info, false);
  reads.shift()!.resolve(listed);
  await flush();
  assert.deepEqual([store.getState().conversationTitle, store.getState().threads], ["周末计划", []]);

  store.readThreads(info, true);
  reads.shift()!.resolve(listed);
  await flush();
  assert.deepEqual([store.getState().conversationTitle, store.getState().threads], ["周末计划", listed]);

  const cleanup = store.readThreads(info, true);
  cleanup();
  reads.shift()!.resolve([thread("thread-1", "改过的标题")]);
  store.readThreads(info, true);
  reads.shift()!.reject(new Error("closed"));
  await flush();
  assert.deepEqual([store.getState().conversationTitle, store.getState().threads], ["周末计划", listed]);

  store.readThreads(info, true);
  reads.shift()!.resolve([thread("thread-0", "旧对话")]); // The current thread is not listed: the default title.
  await flush();
  assert.equal(store.getState().conversationTitle, "当前对话");

  store.refreshThreads();
  store.refreshThreads();
  assert.equal(store.getState().threadsRefresh, 2);
});

/** A bridge that answers every startup read at once and records the calls in order. */
const startupHarness = (overrides: Partial<Record<string, unknown>> = {}) => {
  const calls: string[] = [];
  const errors: string[] = [];
  const listeners = new Set<(message: MainToRenderer) => void>();
  const answers: Record<string, unknown> = {
    info: { threadId: "thread-1", workspaceRoot: "/w", configPath: "/c" },
    loadConversationDraft: { draft: { text: "草稿", excludeFromMemory: false }, uncertainSteer: null },
    takeTaskResultOpen: null,
    snapshot: snapshotOf({}),
    historyPage: page([], null),
    listRuns: { ok: true, runs: [] },
    home: { ok: true },
    ...overrides,
  };
  const answer = (name: string) => async () => {
    calls.push(name);
    const value = answers[name];
    if (value instanceof Error) throw value;
    return value;
  };
  const bridge = {
    onMessage: (listener: (message: MainToRenderer) => void) => { calls.push("onMessage"); listeners.add(listener); return () => { calls.push("unsubscribe"); listeners.delete(listener); }; },
    info: answer("info"), loadConversationDraft: answer("loadConversationDraft"), takeTaskResultOpen: answer("takeTaskResultOpen"),
    snapshot: answer("snapshot"), historyPage: answer("historyPage"), listRuns: answer("listRuns"), home: answer("home"),
    getRun: async (runId: string) => { calls.push(`getRun:${runId}`); return { ok: true, run: null }; },
  } as unknown as RuntimeBridge;
  const store = createRuntimeStore({ bridge: () => bridge });
  recordErrors(store, errors);
  const host: string[] = [];
  const hostApi = {
    applyDraft: (_info: AppInfo, saved: { draft: { text: string } }) => { host.push(`applyDraft:${saved.draft.text}`); },
    draftUnreadable: () => { host.push("draftUnreadable"); },
    openTaskResult: (route: { taskId: string }) => { host.push(`openTaskResult:${route.taskId}`); },
    settleSentAttachments: (result: RunResult) => { host.push(`settle:${result.runId}`); },
  };
  const send = (message: MainToRenderer) => { for (const listener of [...listeners]) listener(message); };
  return { store, calls, errors, host, hostApi, send, listeners };
};
const settle = async () => { for (let index = 0; index < 20; index += 1) await flush(); };

test("start: subscribes, then info → draft → task route → snapshot ×2 → history → snapshot → records → Home, each after the previous", async () => {
  const { store, calls, host, hostApi, errors } = startupHarness();
  store.start(hostApi as never);
  assert.deepEqual(calls, ["onMessage", "info"]);
  await settle();
  assert.deepEqual(calls, ["onMessage", "info", "loadConversationDraft", "takeTaskResultOpen", "snapshot", "snapshot", "historyPage", "listRuns", "info", "snapshot", "listRuns", "home"]);
  assert.deepEqual(host, ["applyDraft:草稿"]);
  assert.deepEqual(errors, []);
  assert.equal(store.getState().info?.threadId, "thread-1");
  assert.equal(store.getState().records.status, "ready");
});

test("start: a finished primary result loads its final receipt before history; a task route opens; Home failure copy", async () => {
  const { store, calls, host, hostApi, errors } = startupHarness({
    snapshot: snapshotOf({ lastPrimaryResult: result("run-9") }), takeTaskResultOpen: { taskId: "task-1", workspaceRoot: "/w" }, home: { ok: false, reason: "failed", message: "Home 读取失败" },
  });
  store.start(hostApi as never);
  await settle();
  assert.deepEqual(calls.slice(3, 8), ["takeTaskResultOpen", "snapshot", "snapshot", "getRun:run-9", "historyPage"]);
  assert.deepEqual(host, ["applyDraft:草稿", "openTaskResult:task-1"]);
  assert.deepEqual(errors, ["最终执行回执缺失，不能据此确认动作结果", "Home 读取失败"]);
});

test("start: an unreadable draft goes to the host and startup continues; runtime recovery stops after its notice; a busy Home is silent", async () => {
  const unreadable = startupHarness({ loadConversationDraft: new Error("bad"), home: { ok: false, reason: "busy" } });
  unreadable.store.start(unreadable.hostApi as never);
  await settle();
  assert.deepEqual(unreadable.host, ["draftUnreadable"]);
  assert.equal(unreadable.calls.at(-1), "home");
  assert.deepEqual(unreadable.errors, []);

  const recovering = startupHarness({ info: { threadId: "thread-1", runtimeRecovery: { message: "运行时正在恢复" } } });
  recovering.store.start(recovering.hostApi as never);
  await settle();
  assert.deepEqual(recovering.calls, ["onMessage", "info", "loadConversationDraft"]);
  assert.deepEqual(recovering.errors, ["运行时正在恢复"]);
});

test("dispose: stops the startup at its next check, unsubscribes; a second start (StrictMode) runs on its own", async () => {
  const { store, calls, hostApi, host, errors } = startupHarness();
  store.start(hostApi as never);
  store.dispose();
  await settle();
  assert.deepEqual(calls, ["onMessage", "info", "unsubscribe"]);
  assert.equal(store.getState().info, null);
  store.start(hostApi as never);
  await settle();
  assert.equal(calls.at(-1), "home");
  assert.deepEqual(host, ["applyDraft:草稿"]);
  assert.deepEqual(errors, []);
});

test("messages after start: result settles attachments before finishing the run; error and failed rereads go to onError", async () => {
  const { store, calls, host, hostApi, errors, send } = startupHarness({ getRun: undefined });
  store.start(hostApi as never);
  await settle();
  calls.length = 0;
  send({ type: "state", state: { kind: "running", runId: null, phase: "primary" } } as MainToRenderer);
  send({ type: "result", phase: "primary", result: result("run-2") } as MainToRenderer);
  assert.deepEqual(host.slice(1), ["settle:run-2"]);
  assert.equal(store.latestCompletedPrimaryId(), "run-2");
  send({ type: "result", phase: "background", result: result("run-3") } as MainToRenderer);
  assert.deepEqual(host.slice(1), ["settle:run-2"]);
  send({ type: "error", message: "主进程出错" } as MainToRenderer);
  send({ type: "state", state: { kind: "idle" } } as MainToRenderer);
  await settle();
  assert.deepEqual(calls, ["getRun:run-2", "historyPage", "listRuns", "info", "listRuns"]);
  assert.deepEqual(errors, ["主进程出错", "最终执行回执缺失，不能据此确认动作结果"]);
  store.dispose();
  send({ type: "error", message: "卸载后" } as MainToRenderer);
  assert.equal(errors.includes("卸载后"), false);
});

test("error: the banner is a store field; setError shows and clears it, and the store's own failures land there too", async () => {
  const { store, runs } = harness();
  assert.equal(store.getState().error, null);
  store.setError("请先处理上方确认");
  assert.equal(store.getState().error, "请先处理上方确认");
  store.setError(null);
  assert.equal(store.getState().error, null);
  runs.set("run-1", { ok: true, run: null });
  store.finishPrimaryRun(result("run-1"));
  await flush();
  assert.equal(store.getState().error, "最终执行回执缺失，不能据此确认动作结果");
});

test("retryConnection: one retry at a time, the flag clears when it settles, and a failure shows the banner", async () => {
  let calls = 0;
  const retries: Array<{ resolve: () => void; reject: (cause: unknown) => void }> = [];
  const bridge = { snapshot: () => new Promise(() => {}), getRun: async () => ({ ok: true, run: null }),
    retryConnection: () => { calls += 1; return new Promise<void>((resolve, reject) => { retries.push({ resolve, reject }); }); } } as unknown as RuntimeBridge;
  const store = createRuntimeStore({ bridge: () => bridge });
  const first = store.retryConnection();
  assert.equal(store.getState().reconnecting, true);
  await store.retryConnection(); // Already reconnecting: nothing happens.
  assert.equal(calls, 1);
  retries.shift()!.resolve();
  await first;
  assert.deepEqual([store.getState().reconnecting, store.getState().error], [false, null]);
  const failing = store.retryConnection();
  retries.shift()!.reject(new Error("closed"));
  await failing;
  assert.deepEqual([calls, store.getState().reconnecting, store.getState().error], [2, false, "连接恢复失败。请修正配置后重试；不会重放之前的任务。"]);
});
