import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { resolveTuiModuleConfig } from "./tui-module-config.js";
import { memoryPage, validMemoryEdit } from "./memory-management.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
async function setup(rewrite = false) {
  const root = await mkdtemp(join(tmpdir(), "runloom-formal-memory-"));
  await mkdir(join(root, "workspace"));
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace: "./workspace", modules: { memory: { enabled: true, queryRewrite: { enabled: rewrite } } } }));
  let rewrites = 0; let primary = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async () => { rewrites++; return { content: [{ type: "text", text: '{"queries":["复盘格式"]}' }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }; },
    doStream: async options => {
      primary++; prompts.push(JSON.stringify(options.prompt));
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "收到" }, { type: "text-end" as const, id: "text" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ] }) };
    },
  });
  const open = async (thread = "thread-a") => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ demoTools: true, args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", config], modelAlias: "mock", model, output, env: {}, cwd: root });
    return { app, controller: createAssistantController(app) };
  };
  return { root, config, open, model, prompts, counts: () => ({ primary, rewrites }) };
}
async function idle(controller: ReturnType<typeof createAssistantController>) {
  for (let i = 0; i < 2000 && controller.getSnapshot().state.kind !== "idle"; i++) await delay(2);
  assert.equal(controller.getSnapshot().state.kind, "idle");
}

describe("formal Memory controller and actual reference preparation", () => {
  it("rewrites once across tool steps but rereads current Memory, and refuses busy editing", async () => {
    const test = await setup(true); const { app, controller } = await test.open();
    let next = 0; let sawNewVersion = false;
    const added = await app.memoryStore!.add({ text: "复盘原格式" }); assert.ok(added.ok); if (!added.ok) return;
    const original = test.model.doStream.bind(test.model);
    test.model.doStream = async options => {
      if (next++ === 0) {
        assert.ok(JSON.stringify(options.prompt).includes("复盘原格式"));
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: "calc", toolName: "add", input: '{"left":1,"right":2}' },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
        ] }) };
      }
      sawNewVersion = JSON.stringify(options.prompt).includes("复盘新格式");
      return original(options);
    };
    const approved = new Set<string>();
    const unsubscribe = controller.subscribe(event => {
      if (event.type === "approval" && !approved.has(event.approval.approvalId)) {
        approved.add(event.approval.approvalId);
        void (async () => {
        const busy = await controller.updateMemory({ id: added.entry.id, expectedRevision: 1, text: "forbidden busy edit" });
        assert.ok(!busy.ok && busy.error.code === "BUSY");
        const external = await app.memoryStore!.update(added.entry.id, { expectedRevision: 1, text: "复盘新格式" }); assert.ok(external.ok);
        controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
        })();
      }
    });
    try {
      await controller.run("复盘并计算1+2"); await idle(controller);
      assert.equal(next, 2); assert.equal(test.counts().rewrites, 1); assert.equal(sawNewVersion, true);
      assert.equal(controller.getMemoryReferences()?.selected[0]?.revision, 2);
    } finally { unsubscribe(); await controller.shutdown(); await rm(test.root, { recursive: true, force: true }); }
  });
  it("does not enable rewrite for WorkTask or read-only reference queries", async () => {
    const test = await setup(true); const { app, controller } = await test.open();
    try {
      await app.memoryStore!.add({ text: "复盘先给结论" });
      const task = await controller.createWorkTask({ goal: "复盘计划", acceptance: [{ id: "quality", description: "内容质量", method: "human", verification: { kind: "human" }, required: true }] });
      assert.ok(task.ok); if (!task.ok) return;
      await controller.runWorkTask({ id: task.value.id, expectedRevision: task.value.revision }); await idle(controller);
      assert.equal(test.counts().rewrites, 0);
      assert.equal(controller.getMemoryReferences()?.rewrite, "not_applicable");
      const count = test.counts();
      await controller.listMemories(); await controller.getContextDiagnostics(); controller.getMemoryReferences();
      assert.deepEqual(test.counts(), count);
    } finally { await controller.shutdown(); await rm(test.root, { recursive: true, force: true }); }
  });
  it("exposes current entries, CAS edits, explicit pin/disable, source semantics and Thread isolation without a Run", async () => {
    const test = await setup(); const { app, controller } = await test.open();
    try {
      const added = await app.memoryStore!.add({ text: "复盘先给结论", source: { kind: "conversation", threadId: "thread-a", messageId: "user-source", quote: "复盘先给结论" } });
      assert.ok(added.ok); if (!added.ok) return;
      await app.memoryStore!.add({ text: "hidden", scope: { kind: "thread", threadId: "thread-b" } });
      const listed = await controller.listMemories(); assert.ok(listed.ok); if (!listed.ok) return;
      assert.equal(listed.value.entries.length, 1); assert.ok(!("source" in listed.value.entries[0]!));
      const { history: _history, ...current } = added.entry;
      assert.deepEqual((await controller.getMemory(added.entry.id)), { ok: true, value: current });
      const edit = await controller.updateMemory({ id: added.entry.id, expectedRevision: 1, text: "复盘先给一句结论，再给行动" });
      assert.ok(edit.ok); if (!edit.ok) return;
      assert.deepEqual(edit.value.source, { kind: "manual" }); assert.equal(edit.value.revision, 2);
      const conflict = await controller.updateMemory({ id: added.entry.id, expectedRevision: 1, pinned: true });
      assert.ok(!conflict.ok && conflict.error.code === "MEMORY_REVISION_CONFLICT");
      const pinned = await controller.updateMemory({ id: added.entry.id, expectedRevision: 2, pinned: true });
      assert.ok(pinned.ok && pinned.value.pinned);
      const disabled = await controller.updateMemory({ id: added.entry.id, expectedRevision: 3, status: "disabled" });
      assert.ok(disabled.ok && disabled.value.status === "disabled");
      const hidden = (await app.memoryStore!.list()); assert.ok(hidden.ok); if (!hidden.ok) return;
      const privateId = hidden.entries.find(entry => entry.text === "hidden")!.id;
      assert.ok(!(await controller.getMemory(privateId)).ok);
      assert.ok(!(await controller.updateMemory({ id: privateId, expectedRevision: 1, pinned: true })).ok);
      assert.deepEqual(test.counts(), { primary: 0, rewrites: 0 });
      assert.equal((await controller.listRuns()).length, 0);
      assert.equal(controller.getMemoryReferences(), null);
    } finally { await controller.shutdown(); await rm(test.root, { recursive: true, force: true }); }
  });
  it("shows the selected version across Thread, updates next preparation, excludes disabled, and clears process snapshot on restart", async () => {
    const test = await setup(true); const first = await test.open();
    const added = await first.app.memoryStore!.add({ text: "复盘先给一行结论，再列两条可执行步骤。" });
    assert.ok(added.ok); if (!added.ok) return;
    await first.controller.shutdown();
    const second = await test.open("thread-b");
    try {
      await second.controller.run("回顾要怎样组织内容？"); await idle(second.controller);
      let references = second.controller.getMemoryReferences();
      assert.ok(references); assert.equal(references.rewrite, "succeeded");
      assert.equal(references.selected[0]?.id, added.entry.id); assert.equal(references.selected[0]?.reason, "rewritten");
      assert.equal(references.selected[0]?.revision, 1);
      assert.ok(test.prompts[0]?.includes(added.entry.id));
      const edit = await second.controller.updateMemory({ id: added.entry.id, expectedRevision: 1, text: "复盘只给三条行动。" }); assert.ok(edit.ok);
      // The old reference remains an explicitly time-bound preparation snapshot, not current truth.
      assert.equal(second.controller.getMemoryReferences()?.selected[0]?.revision, 1);
      await second.controller.run("复盘格式？"); await idle(second.controller);
      references = second.controller.getMemoryReferences();
      assert.equal(references?.selected[0]?.revision, 2); assert.equal(references?.selected[0]?.text, "复盘只给三条行动。");
      const stopped = await second.controller.updateMemory({ id: added.entry.id, expectedRevision: 2, status: "disabled" }); assert.ok(stopped.ok);
      await second.controller.run("复盘格式？"); await idle(second.controller);
      assert.equal(second.controller.getMemoryReferences()?.selected.length, 0);
      const primaryRuns = await second.controller.listRuns(); assert.equal(primaryRuns.length, 3);
      assert.deepEqual(test.counts(), { primary: 3, rewrites: 3 });
    } finally { await second.controller.shutdown(); }
    const restart = await test.open("thread-b");
    try { assert.equal(restart.controller.getMemoryReferences(), null); }
    finally { await restart.controller.shutdown(); await rm(test.root, { recursive: true, force: true }); }
  });
  it("default lexical mode makes zero rewrite calls and a corrupt source fails instead of returning stale references", async () => {
    const test = await setup(); const { app, controller } = await test.open();
    try {
      await app.memoryStore!.add({ text: "复盘先给一行结论" });
      await controller.run("复盘"); await idle(controller);
      assert.equal(controller.getMemoryReferences()?.rewrite, "off");
      await writeFile(join(test.root, "workspace", ".runloom", "memory.json"), "broken");
      assert.ok(!(await controller.listMemories()).ok);
      await controller.run("复盘"); await idle(controller);
      assert.equal(controller.getMemoryReferences(), null);
      assert.equal(test.counts().rewrites, 0);
    } finally { await controller.shutdown(); await rm(test.root, { recursive: true, force: true }); }
  });
  it("rewrite config remains default off and requires enabled Memory", async () => {
    const test = await setup();
    try {
      const resolved = await resolveTuiModuleConfig({ configPath: test.config }, { cwd: test.root });
      assert.equal(resolved.memoryQueryRewriteEnabled, false);
      await writeFile(test.config, JSON.stringify({ version: 1, workspace: "./workspace", modules: { memory: { enabled: false, queryRewrite: { enabled: true } } } }));
      await assert.rejects(resolveTuiModuleConfig({ configPath: test.config }, { cwd: test.root }), /requires memory.enabled/);
    } finally { await rm(test.root, { recursive: true, force: true }); }
  });
  it("bounds management pages and rejects forged fields", () => {
    const entries = Array.from({ length: 70 }, (_, i) => ({ id: String(i), text: "x".repeat(200), enabled: true, revision: 1 }));
    const page = memoryPage(entries, "current"); assert.ok(page.ok); if (!page.ok) return;
    assert.equal(page.value.entries.length, 20); assert.equal(page.value.nextOffset, 20); assert.equal(page.value.entries[0]?.truncated, true);
    assert.ok(!memoryPage(entries, "current", { offset: -1 }).ok);
    assert.ok(!validMemoryEdit({ id: "x", expectedRevision: 1, source: { kind: "manual" } } as never));
    assert.ok(!validMemoryEdit({ id: "x", expectedRevision: 1 }));
    assert.ok(!validMemoryEdit(null as never));
  });
});
