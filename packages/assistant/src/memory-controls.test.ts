import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunHandle, RunResult } from "@serika/core";
import type { UIMessage } from "ai";
import { PRIMARY_AGENT_ID, type RuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { validateMemoryAction, type MemoryAction } from "./memory-controls.js";
import { memoryConsolidationBacklog, consolidationPrefixHash } from "./memory-consolidation.js";
import { createMemoryStore, type TemporalWorkspaceMemoryStore } from "./memory-store.js";

function appWith(store: TemporalWorkspaceMemoryStore, root: string, overrides: Partial<RuntimeApp> = {}): RuntimeApp {
  return {
    tuiMode: true, agentId: PRIMARY_AGENT_ID,
    runtime: { run: async () => { throw new Error("Unexpected model Run"); } } as unknown as RuntimeApp["runtime"],
    store: { getMessages: async () => [] } as unknown as RuntimeApp["store"],
    executionRecords: {
      claimThread: async () => ({ release: async () => undefined }), recoverInterrupted: async () => 0,
      finishRun: async () => undefined, listRuns: async () => [], getRun: async () => null,
    } as unknown as RuntimeApp["executionRecords"],
    enableExecutionRecords: () => undefined, bindNextExecutionWorkTask: () => () => undefined,
    workTasks: undefined, workTaskContext: { begin: () => undefined, end: () => undefined },
    threadId: "thread-a", directory: join(root, "transcripts"), workspaceRoot: root,
    memoryStore: store, moduleConfig: undefined, toolConfirmation: undefined, commands: undefined,
    getContextDiagnostics: async () => ({ ok: false, error: { code: "TEST", message: "unused" } }),
    resume: undefined, autoConsolidationAgentId: undefined,
    renderHome: async () => undefined, registerNotificationRedraw: () => undefined, dispose: () => undefined,
    ...overrides,
  };
}

function result(runId: string): RunResult { return { runId, threadId: "thread-a", status: "completed", text: "Done", steps: 1, usage: {} }; }
function handle(runId: string): RunHandle {
  return { runId, events: (async function* () {})(), result: Promise.resolve(result(runId)), cancel: async () => undefined };
}
async function idle(controller: ReturnType<typeof createAssistantController>) {
  for (let index = 0; index < 500 && controller.getSnapshot().state.kind !== "idle"; index++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(controller.getSnapshot().state.kind, "idle");
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-controls-"));
  const store = createMemoryStore(root);
  const controller = createAssistantController(appWith(store, root));
  return { root, store, controller, cleanup: async () => { await controller.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
const since = { from: "2020-01-01T00:00:00.000Z", to: null, basis: "explicit" as const };

describe("desktop temporal Memory controls", () => {
  it("rejects renderer-owned sources, scope, system time and unrecognized fields", () => {
    const action = { id: "memory", expectedRevision: 1, operation: "correct", text: "My preference" };
    assert.ok(validateMemoryAction(action).ok);
    for (const extra of [{ sources: [{ kind: "manual" }] }, { scope: { kind: "workspace" } }, { systemTime: {} }, { assertionId: "forged" }, { pinned: true }]) assert.equal(validateMemoryAction({ ...action, ...extra }).ok, false);
    for (const invalid of [null, [], { ...action, operation: "__proto__" }, { ...action, expectedRevision: 0 }, { ...action, text: " " }, { ...action, recallTerms: ["a".repeat(97)] }, { ...action, validTime: { ...since, to: "2019-01-01T00:00:00.000Z" } }, { id: "memory", expectedRevision: 1, operation: "metadata" }, { id: "memory", expectedRevision: 1, operation: "metadata", status: "active" }]) assert.equal(validateMemoryAction(invalid).ok, false);
  });

  it("previews exact temporal transitions without disk writes, rejects stale confirms, and paginates full sources", async () => {
    const test = await fixture();
    try {
      const source = { kind: "conversation" as const, threadId: "thread-a", messageId: "source-a", quote: "我目前住在上海" };
      const added = await test.store.add({ text: "居住地上海", kind: "fact", validTime: since, source }); assert.ok(added.ok); if (!added.ok) return;
      const action: MemoryAction = { id: added.entry.id, expectedRevision: 1, operation: "change", text: "居住地杭州", effectiveAt: "2021-01-01T00:00:00.000Z" };
      const before = await readFile(join(test.root, ".runloom/memory.json"), "utf8");
      const preview = await test.controller.memory.previewAction(action); assert.ok(preview.ok); if (!preview.ok) return;
      assert.equal(preview.value.proposedAssertion?.text, "居住地杭州");
      assert.equal(preview.value.proposedAssertion?.validTime.from, action.effectiveAt);
      assert.equal(await readFile(join(test.root, ".runloom/memory.json"), "utf8"), before);
      assert.equal(test.controller.getSnapshot().state.kind, "idle");
      const applied = await test.controller.memory.applyAction(action); assert.ok(applied.ok && applied.value?.revision === 2);
      const replay = await test.controller.memory.applyAction(action); assert.ok(!replay.ok && replay.error.code === "MEMORY_REVISION_CONFLICT");
      const needsInterval = await test.controller.memory.previewAction({ id: action.id, expectedRevision: 2, operation: "correct", text: "居住地南京" });
      assert.ok(!needsInterval.ok && needsInterval.error.code === "MEMORY_TEMPORAL_CONFLICT", "preview must run semantic transition validation");
      const first = await test.controller.memory.getHistory({ id: action.id, limit: 1 }); assert.ok(first.ok); if (!first.ok) return;
      assert.equal(first.value.assertions.length, 1); assert.equal(first.value.versions.length, 1); assert.equal(first.value.nextOffset, 1);
      const second = await test.controller.memory.getHistory({ id: action.id, offset: 1, limit: 1 }); assert.ok(second.ok); if (!second.ok) return;
      assert.deepEqual(second.value.assertions[0]?.sources, [source]);
      const past = await test.controller.memory.query({ id: action.id, validAt: "2020-06-01T00:00:00.000Z" }); assert.ok(past.ok && past.value.assertions[0]?.text === "居住地上海");
      assert.ok(!(await test.controller.memory.query({ id: action.id, source: "forged" } as never)).ok);
      assert.equal((await test.controller.runs.list()).length, 0);
    } finally { await test.cleanup(); }
  });

  it("requires explicit disabled/expired restore choices, creates a revision and never revives deleted memory", async () => {
    const test = await fixture();
    try {
      const added = await test.store.add({ text: "写作先结论", kind: "preference", validTime: since }); assert.ok(added.ok); if (!added.ok) return;
      const history = await test.controller.memory.getHistory({ id: added.entry.id }); assert.ok(history.ok); if (!history.ok) return;
      const assertionId = history.value.assertions[0]!.assertionId;
      const disabled = await test.controller.memory.applyAction({ id: added.entry.id, expectedRevision: 1, operation: "metadata", status: "disabled", expiresAt: "2021-01-01T00:00:00.000Z", pinned: true });
      assert.ok(disabled.ok && disabled.value?.revision === 2 && disabled.value.pinned);
      const restore: MemoryAction = { id: added.entry.id, expectedRevision: 2, operation: "restore", targetAssertionId: assertionId };
      const omittedStatus = await test.controller.memory.previewAction(restore); assert.ok(!omittedStatus.ok && omittedStatus.error.code === "MEMORY_DISABLED");
      const omittedExpiry = await test.controller.memory.previewAction({ ...restore, status: "active" }); assert.ok(!omittedExpiry.ok && omittedExpiry.error.code === "MEMORY_EXPIRED");
      const explicit: MemoryAction = { ...restore, status: "active", expiresAt: null };
      const preview = await test.controller.memory.previewAction(explicit); assert.ok(preview.ok && preview.value.proposedAssertion?.validTime.basis === "reported");
      const restored = await test.controller.memory.applyAction(explicit); assert.ok(restored.ok && restored.value?.revision === 3 && restored.value.enabled);
      const remove: MemoryAction = { id: added.entry.id, expectedRevision: 3, operation: "delete" };
      const deletePreview = await test.controller.memory.previewAction(remove); assert.ok(deletePreview.ok && deletePreview.value.proposedAssertion === null);
      assert.deepEqual(await test.controller.memory.applyAction(remove), { ok: true, value: null });
      const missing = await test.controller.memory.previewAction({ ...explicit, expectedRevision: 3 }); assert.ok(!missing.ok && missing.error.code === "MEMORY_ENTRY_NOT_FOUND");
    } finally { await test.cleanup(); }
  });

  it("distinguishes retracted and out-of-range views from disabled or legacy records without exposing current facts", async () => {
    const test = await fixture();
    try {
      const added = await test.store.add({ text: "写作先结论", validTime: since }); assert.ok(added.ok); if (!added.ok) return;
      const retracted = await test.controller.memory.applyAction({ id: added.entry.id, expectedRevision: 1, operation: "retract" });
      assert.ok(retracted.ok && retracted.value);
      assert.equal(retracted.value.temporalState, "retracted");
      assert.equal(retracted.value.status, "active", "withdrawal is not administrative disablement");
      assert.equal(retracted.value.enabled, false);
      assert.equal(retracted.value.text, "");
      assert.equal(retracted.value.assertion, undefined);
      const query = await test.controller.memory.query({ id: added.entry.id }); assert.ok(query.ok && query.value.assertions.length === 0);
      const future = await test.store.add({ text: "未来事实", kind: "fact", validTime: { from: "2999-01-01T00:00:00.000Z", to: null, basis: "explicit" } });
      assert.ok(future.ok && future.entry.temporalState === "not_applicable" && !future.entry.enabled && future.entry.text === "");
      const page = await test.controller.memory.list(); assert.ok(page.ok); if (!page.ok) return;
      assert.equal(page.value.entries.find(entry => entry.id === added.entry.id)?.temporalState, "retracted");
    } finally { await test.cleanup(); }
  });

  it("keeps private historical scopes out of history, query, restore and maintenance", async () => {
    const test = await fixture();
    try {
      const privateEntry = await test.store.add({ text: "private old fact", scope: { kind: "thread", threadId: "thread-b" }, validTime: since }); assert.ok(privateEntry.ok); if (!privateEntry.ok) return;
      const privateHistory = await test.store.inspectMemory(privateEntry.entry.id); assert.ok(privateHistory.ok); if (!privateHistory.ok) return;
      const exposed = await test.store.update(privateEntry.entry.id, { expectedRevision: 1, text: "public new fact", scope: { kind: "workspace" } }); assert.ok(exposed.ok);
      const history = await test.controller.memory.getHistory({ id: privateEntry.entry.id }); assert.ok(history.ok); if (!history.ok) return;
      assert.equal(history.value.historyCoverage, "legacy_partial");
      assert.ok(!JSON.stringify(history.value).includes("private old fact"));
      const forbidden = await test.controller.memory.previewAction({ id: privateEntry.entry.id, expectedRevision: 2, operation: "restore", targetAssertionId: privateHistory.value.assertions[0]!.assertionId }); assert.ok(!forbidden.ok && forbidden.error.code === "MEMORY_ENTRY_NOT_FOUND");
      await test.store.add({ text: "private current fact", scope: { kind: "thread", threadId: "thread-b" }, status: "disabled" });
      await test.store.add({ text: "visible expired", expiresAt: "2020-01-01T00:00:00.000Z" });
      const maintenance = await test.controller.memory.getMaintenance(); assert.ok(maintenance.ok); if (!maintenance.ok) return;
      assert.equal(maintenance.value.stored, 2); assert.equal(maintenance.value.expired, 1); assert.equal(maintenance.value.disabled, 0); assert.equal(maintenance.value.consolidation.state, "off");
    } finally { await test.cleanup(); }
  });

  it("takes the idle mutation mutex before awaits and emits success only after store writes", async () => {
    const test = await fixture();
    try {
      const added = await test.store.add({ text: "preference" }); assert.ok(added.ok); if (!added.ok) return;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = test.store.reviseMemory.bind(test.store);
      test.store.reviseMemory = async (...args) => { await gate; return original(...args); };
      const updates: string[] = []; test.controller.subscribe(event => { if (event.type === "memory-updated") updates.push(event.reason); });
      const pending = test.controller.memory.applyAction({ id: added.entry.id, expectedRevision: 1, operation: "correct", text: "new preference" });
      assert.equal(test.controller.getSnapshot().state.kind, "command");
      const conflict = await test.controller.memory.applyAction({ id: added.entry.id, expectedRevision: 1, operation: "delete" }); assert.ok(!conflict.ok && conflict.error.code === "BUSY");
      assert.deepEqual(await test.controller.run("must not start"), { ok: false, reason: "busy" });
      assert.deepEqual(updates, []); release(); assert.ok((await pending).ok); assert.deepEqual(updates, ["write"]);
    } finally { await test.cleanup(); }
  });

  it("reports a failed candidate write even when its model Run completed, and preserves backlog after restart", async () => {
    const test = await fixture(); await test.controller.shutdown();
    let agent = "", runs = 0;
    const messages: UIMessage[] = [{ id: "ordinary", role: "user", parts: [{ type: "text", text: "I prefer concise reviews" }] }];
    const app = appWith(test.store, test.root, {
      autoConsolidationAgentId: "memory-consolidator",
      store: { getMessages: async () => messages } as unknown as RuntimeApp["store"],
      runtime: { run: async () => handle(`run-${++runs}`) } as unknown as RuntimeApp["runtime"],
      memoryConsolidation: {
        begin: id => { agent = id; }, discard: () => undefined,
        prepare: async () => { throw new Error("unused prepare"); }, stage: async () => { throw new Error("unused stage"); },
        canStart: async () => ({ ok: true, value: { canStart: true, pendingCount: 0 } }),
        finalize: async () => agent === "memory-consolidator" ? { ok: false, error: { code: "WRITE_FAILED", message: "disk full" } } : { ok: true, value: { candidateIds: [], replayed: false } },
      } as NonNullable<RuntimeApp["memoryConsolidation"]>,
    });
    const controller = createAssistantController(app);
    try {
      await controller.run("ordinary lasting preference"); await idle(controller);
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
      assert.equal(controller.getSnapshot().lastConsolidationResult?.status, "completed");
      const maintenance = await controller.memory.getMaintenance(); assert.ok(maintenance.ok); if (!maintenance.ok) return;
      assert.equal(maintenance.value.consolidation.state, "failed"); assert.match(maintenance.value.consolidation.error!, /disk full/); assert.equal(maintenance.value.consolidation.backlogCount, 1);
      assert.deepEqual(await test.store.getConsolidationCursor("thread-a"), { ok: true, value: null });
      assert.equal(runs, 2, "maintenance never calls the model");
      await controller.shutdown();
      const reopened = createAssistantController(appWith(test.store, test.root, { autoConsolidationAgentId: "memory-consolidator", store: app.store }));
      try { const status = await reopened.memory.getMaintenance(); assert.ok(status.ok && status.value.consolidation.state === "backlog"); }
      finally { await reopened.shutdown(); }
    } finally { await controller.shutdown(); await rm(test.root, { recursive: true, force: true }); }
  });

  it("counts only eligible ordinary backlog and fails closed on mismatched cursor", () => {
    const messages: UIMessage[] = [
      { id: "eligible", role: "user", parts: [{ type: "text", text: "ordinary fact" }] },
      { id: "excluded", role: "user", metadata: { memoryConsolidation: "exclude" }, parts: [{ type: "text", text: "excluded fact" }] },
      { id: "synthetic", role: "user", metadata: { source: "memory-auto-consolidation" }, parts: [{ type: "text", text: "synthetic" }] },
    ];
    assert.deepEqual(memoryConsolidationBacklog(messages.slice(0, 2), null), { ok: true, value: 1 });
    const cursor = { threadId: "thread-a", throughMessageId: "eligible", prefixHash: consolidationPrefixHash(messages, "eligible")!, lastBatchId: "old-batch", updatedAt: "2020-01-01T00:00:00.000Z" };
    assert.deepEqual(memoryConsolidationBacklog(messages.slice(0, 2), cursor), { ok: true, value: 0 });
    assert.ok(!memoryConsolidationBacklog(messages, { ...cursor, prefixHash: "different" }).ok);
  });
});
