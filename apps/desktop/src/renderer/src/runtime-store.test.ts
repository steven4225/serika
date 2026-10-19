import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppInfo, MainToRenderer, PendingApproval, UiSnapshot } from "../../shared/ui-contract.js";
import { createRuntimeStore, initialRuntimeState, OUTPUT_MAX_CHARS, type RuntimeStore } from "./app/runtime-store.js";

type Payload<K extends MainToRenderer["type"], F extends string> = Extract<MainToRenderer, { type: K }> extends infer M ? M extends Record<F, infer V> ? V : never : never;
const approval = (approvalId: string): PendingApproval => ({ approvalId, toolCallId: `call-${approvalId}`, toolName: "write_file", input: { path: "a.txt" }, preview: "写入 a.txt" });
const running = { kind: "running", runId: "run-1", phase: "primary" } as const;
const counters = (store: RuntimeStore) => {
  const { memoryRefresh, contextRefresh, taskRefresh } = store.getState();
  return { memoryRefresh, contextRefresh, taskRefresh };
};
const watched = () => {
  const store = createRuntimeStore();
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  return { store, notifications: () => notified };
};

test("runtime store starts from the values AssistantPage used to start with", () => {
  assert.deepEqual(createRuntimeStore().getState(), {
    info: null, state: { kind: "idle" }, output: "", approval: null, homeSnapshot: null, memoryRefresh: 0, contextRefresh: 0, taskRefresh: 0,
  });
  assert.equal(createRuntimeStore().getState(), initialRuntimeState);
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
  const store = createRuntimeStore();
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
  const store = createRuntimeStore();
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
  const store = createRuntimeStore();
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
  store.applySnapshot({ state: running, pendingApproval: approval("a"), recentOutput: "recent" } as UiSnapshot);
  const after = store.getState();
  assert.deepEqual(after.state, running);
  assert.equal(after.approval?.approvalId, "a");
  assert.equal(after.output, "recent", "the snapshot output replaces, it does not append");
  assert.equal(after.info, info);
  assert.equal(after.memoryRefresh, 1);
  assert.equal(notifications(), 4, "the snapshot is one notification");
});

test("setInfo stores the info read at startup", () => {
  const store = createRuntimeStore();
  const info = { threadId: "thread-1" } as AppInfo;
  store.setInfo(info);
  assert.equal(store.getState().info, info);
});

test("getState keeps its identity between changes and unsubscribe stops notifications", () => {
  const store = createRuntimeStore();
  let notified = 0;
  const stop = store.subscribe(() => { notified += 1; });
  assert.equal(store.getState(), store.getState());
  store.receive({ type: "output", text: "a" });
  stop();
  store.receive({ type: "output", text: "b" });
  assert.equal(notified, 1);
  assert.equal(store.getState().output, "ab");
});
