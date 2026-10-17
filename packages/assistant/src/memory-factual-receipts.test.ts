import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { UIMessage } from "ai";
import { createRuntimeApp } from "./app.js";
import { createDemoModel } from "./demo-model.js";
import { createAssistantController } from "./assistant-controller.js";
import { createMemoryConsolidation } from "./memory-consolidation.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { readMemoryFactReceipts } from "./memory-factual-receipts.js";
import { temporalMemoryStore } from "./memory-controls.js";
import { createMemoryStore } from "./memory-store.js";

test("real Controller projects persisted saved, pending, deferred and too-large outcomes beside their exact source; restart does not duplicate", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-factual-receipts-"));
  let controller: ReturnType<typeof createAssistantController> | undefined;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    // Store is finalized under explicit automatic fixture policy below; prevent
    // the real Controller from starting an unrelated background extraction.
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } } }));
    const open = () => createRuntimeApp({ directory: join(root, "history"), assistant: { threadId: "receipts", configPath: config },
      model: createDemoModel(), modelAlias: "mock/default", output: new PassThrough(), cwd: root });
    let app = await open(); controller = createAssistantController(app);
    const texts = ["以后请用中文回答我。", "我喜欢喝茶。", "我的咖啡偏好是加糖。" + "补充说明。".repeat(200), "尚未处理的事实", "今天天气怎样？"];
    const messages: UIMessage[] = texts.map((text, i) => ({ id: `u${i}`, role: "user", parts: [{ type: "text", text }] }));
    await app.store.save("receipts", messages);
    const service = createMemoryConsolidation({ store: app.memoryStore!, threadId: "receipts", writePolicy: "automatic", getMessages: async () => messages });
    service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [
      { action: "add", kind: "preference", text: texts[0], sourceMessageId: "u0", sourceQuote: texts[0], reason: "明确偏好", eligibility: "durable_self_statement",
        factIdentity: { attribute: "response_language", scenario: "general", value: "zh" } },
      { action: "add", kind: "preference", text: texts[1], sourceMessageId: "u1", sourceQuote: texts[1], reason: "需要确认", eligibility: "needs_review" },
    ], outcomes: [ { messageId: "u0", status: "extracted" }, { messageId: "u1", status: "extracted" },
      { messageId: "u2", status: "no_memory" }, { messageId: "u3", status: "deferred" }, { messageId: "u4", status: "no_memory" } ] }); assert.ok(staged.ok, JSON.stringify(staged));
    const finalized = await service.finalize({ status: "completed" }); assert.ok(finalized.ok);
    const response = await controller.getMemoryReceipts(); assert.ok(response.ok);
    assert.equal(response.value.length, 4);
    assert.match(response.value.find(r => r.sourceMessageId === "u0")!.text, /当时已保存.*中文/);
    assert.match(response.value.find(r => r.sourceMessageId === "u1")!.text, /需要.*确认.*喝茶.*原记忆没有被覆盖/);
    assert.match(response.value.find(r => r.sourceMessageId === "u2")!.text, /没保存.*内容太长.*分段/);
    assert.match(response.value.find(r => r.sourceMessageId === "u3")!.text, /尚未.*完成/);
    assert.equal(response.value.some(r => r.sourceMessageId === "u4"), false, "no_memory stays silent");
    assert.deepEqual(await controller.getMemoryReceipts(), response, "repeated projection has stable keys");
    assert.deepEqual(await app.store.getMessages("receipts"), messages, "host receipts never become transcript/memory sources");
    await controller.shutdown();
    app = await open(); controller = createAssistantController(app);
    try {
      assert.deepEqual(await controller.getMemoryReceipts(), response);
      const pending = await app.memoryStore!.listCandidates({}, undefined, { boundThreadId: "receipts" }); assert.ok(pending.ok);
      const rejected = await app.memoryStore!.resolveCandidate({ candidateId: pending.value.candidates[0]!.id,
        expectedCandidateRevision: pending.value.candidates[0]!.revision, decision: "reject" }, undefined, { boundThreadId: "receipts" }); assert.ok(rejected.ok);
      const afterReject = await controller.getMemoryReceipts(); assert.ok(afterReject.ok);
      assert.equal(afterReject.value.some(r => r.sourceMessageId === "u1"), false, "rejected candidates are not a live review");
      const formal = await app.memoryStore!.list(); assert.ok(formal.ok);
      const old = formal.entries[0]!;
      assert.equal(typeof old.revision, "number");
      const temporal = temporalMemoryStore(app.memoryStore!); assert.ok(temporal);
      const retract = await temporal.reviseMemory({ id: old.id, expectedRevision: old.revision!, operation: "retract" }, undefined, { boundThreadId: "receipts" }); assert.ok(retract.ok);
      const afterRetract = await controller.getMemoryReceipts(); assert.ok(afterRetract.ok);
      assert.match(afterRetract.value.find(r => r.sourceMessageId === "u0")!.text, /当时已保存/, "historical save is not current applicability");
      const foreign = await readMemoryFactReceipts(app.memoryStore, "foreign", messages); assert.ok(foreign.ok); assert.deepEqual(foreign.value, []);
      const changed = structuredClone(messages); changed[0]!.parts = [{ type: "text", text: "已替换来源" }];
      assert.equal((await readMemoryFactReceipts(app.memoryStore, "receipts", changed)).ok, false, "changed prefix cannot reuse old success");
      await writeFile(join(workspace, ".runloom", "memory.json"), "{invalid");
      assert.equal((await controller.getMemoryReceipts()).ok, false, "unreadable storage is not a saved receipt");
    } finally { await controller.shutdown(); }
  } finally { await controller?.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("a completed extraction with a failed durable commit cannot produce a saved or pending receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-receipt-write-failure-"));
  try {
    const store = createMemoryStore(root), text = "我喝咖啡不加糖。";
    const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text }] }];
    const failure = new Proxy(store, { get(target, property) {
      if (property === "commitCandidateBatch") return async () => ({ ok: false, error: { code: "WRITE_FAILED", message: "fixture disk failure" } });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const service = createMemoryConsolidation({ store: failure, threadId: "receipts", writePolicy: "automatic", getMessages: async () => messages });
    service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: "add", text, kind: "preference",
      sourceMessageId: "u1", sourceQuote: text, reason: "明确偏好", eligibility: "durable_self_statement",
      factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }], outcomes: [{ messageId: "u1", status: "extracted" }] }); assert.ok(staged.ok);
    assert.equal((await service.finalize({ status: "completed" })).ok, false);
    const projected = await readMemoryFactReceipts(store, "receipts", messages); assert.ok(projected.ok);
    assert.deepEqual(projected.value, [], "extracted and attempted write never stand in for a persistent receipt");
    const formal = await store.list(); assert.ok(formal.ok); assert.deepEqual(formal.entries, []);
    const pending = await store.listCandidates({}, undefined, { boundThreadId: "receipts" }); assert.ok(pending.ok); assert.deepEqual(pending.value.candidates, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a reopened exhausted extraction receipt tells the remaining truth instead of calling it too-large", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-receipt-retry-exhausted-"));
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "尚未确定的偏好。" }] }];
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const store = createMemoryStore(root);
      const service = createMemoryConsolidation({ store, threadId: "receipts", getMessages: async () => messages });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID); assert.ok((await service.prepare({ mode: "incremental" })).ok);
      assert.ok((await service.finalize({ status: "completed", extractionFailed: true })).ok);
    }
    const read = await readMemoryFactReceipts(createMemoryStore(root), "receipts", messages); assert.ok(read.ok);
    assert.equal(read.value.length, 1);
    assert.match(read.value[0]!.text, /剩余记忆没保存.*3 次.*原话仍保留/);
    assert.doesNotMatch(read.value[0]!.text, /内容太长|已记住|以后会继续处理/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
