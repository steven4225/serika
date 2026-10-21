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
    projectExecutionRuns: async runs => runs,
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
