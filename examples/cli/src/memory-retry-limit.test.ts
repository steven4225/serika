import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { createMemoryStore, WorkspaceMemoryStoreImpl, type WorkspaceMemoryStore } from "./memory-store.js";
import { createMemoryConsolidation, stageConsolidationExtraction } from "./memory-consolidation.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";

for (const mode of ["deferred", "invalid_json", "oversized_invalid"] as const) test(`retry limit: ${mode} survives reopening and stops after three failed source attempts`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-retry-limit-"));
  const text = mode === "oversized_invalid" ? "我喝咖啡不加糖。" + "补充材料。".repeat(200) : "这一项暂时无法确定。";
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text }] }];
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let extractionFailed = false;
      const store = createMemoryStore(directory);
      const service = createMemoryConsolidation({ store, threadId: "t1", writePolicy: "automatic", getMessages: async () => messages });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      assert.equal(prepared.value.turns.length, 1);
      if (mode === "invalid_json") { assert.equal((await stageConsolidationExtraction(service, "not-json")).ok, false); extractionFailed = true; }
      else {
        const staged = await service.stage({ batchId: prepared.value.batchId, proposals: mode === "oversized_invalid" ? [{
          action: "add", text, kind: "invalid", sourceMessageId: "u1", sourceQuote: text, reason: "fixture", eligibility: "durable_self_statement",
        }] : [], outcomes: [{ messageId: "u1", status: "deferred" }] });
        if (mode === "deferred") assert.ok(staged.ok);
        extractionFailed = !staged.ok;
      }
      const finalized = await service.finalize({ status: "completed", extractionFailed }); assert.ok(finalized.ok);
      const receipt = await createMemoryStore(directory).getConsolidationReceipt!("t1"); assert.ok(receipt.ok && receipt.value);
      const outcome = receipt.value.outcomes[0]!;
      assert.equal((outcome as unknown as { attempts: number }).attempts, attempt);
      assert.equal(outcome.status, attempt < 3 ? "deferred" : "not_saved");
      if (outcome.status === "not_saved") assert.equal(outcome.reason, "retry_exhausted");
      const formal = await store.list(); assert.ok(formal.ok); assert.equal(formal.entries.length, 0);
      const pending = await store.listCandidates({}, undefined, { boundThreadId: "t1" }); assert.ok(pending.ok); assert.equal(pending.value.candidates.length, 0);
    }
    messages.push({ id: "u2", role: "user", parts: [{ type: "text", text: "我住在杭州。" }] });
    const reopened = createMemoryConsolidation({ store: createMemoryStore(directory), threadId: "t1", writePolicy: "automatic", getMessages: async () => messages });
    reopened.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const next = await reopened.prepare({ mode: "incremental" }); assert.ok(next.ok);
    assert.deepEqual(next.value.turns.map(turn => "user" in turn ? turn.user.messageId : turn.messages[0]!.id), ["u2"]);
    assert.equal(messages[0]!.parts[0]!.type === "text" && messages[0]!.parts[0]!.text, text, "original transcript never clipped or deleted");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retry limit: cancellation and changed source never consume a source attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-retry-cancel-"));
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "暂未确定。" }] }];
  const store = createMemoryStore(directory);
  const service = createMemoryConsolidation({ store, threadId: "t1", getMessages: async () => messages });
  try {
    service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    assert.ok((await service.prepare({ mode: "incremental" })).ok);
    assert.ok((await service.finalize({ status: "cancelled", extractionFailed: true })).ok);
    const cancelled = await store.getConsolidationReceipt!("t1"); assert.ok(cancelled.ok); assert.equal(cancelled.value, null);
    service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    assert.ok((await service.prepare({ mode: "incremental" })).ok);
    messages[0]!.parts = [{ type: "text", text: "已经变更的原文。" }];
    const changed = await service.finalize({ status: "completed", extractionFailed: true }); assert.equal(changed.ok, false);
    const receipt = await store.getConsolidationReceipt!("t1"); assert.ok(receipt.ok); assert.equal(receipt.value, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retry limit: stale concurrent preparation cannot overwrite persisted attempts, replay counts once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-retry-cas-"));
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "暂未确定。" }] }];
  const store = createMemoryStore(directory);
  const create = () => createMemoryConsolidation({ store, threadId: "t1", getMessages: async () => messages });
  try {
    const first = create(), stale = create();
    for (const service of [first, stale]) { service.begin(AUTO_CONSOLIDATION_AGENT_ID); assert.ok((await service.prepare({ mode: "incremental" })).ok); }
    assert.ok((await first.finalize({ status: "completed", extractionFailed: true })).ok);
    const replay = await first.finalize({ status: "completed", extractionFailed: true }); assert.ok(replay.ok && replay.value.replayed);
    const rejected = await stale.finalize({ status: "completed", extractionFailed: true }); assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "MEMORY_CURSOR_MISMATCH");
    const receipt = await store.getConsolidationReceipt!("t1"); assert.ok(receipt.ok && receipt.value); assert.equal(receipt.value.outcomes[0]!.attempts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retry limit: failed disk commit does not persist count or cursor and never repeats the write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-retry-write-"));
  const store = createMemoryStore(directory);
  let writes = 0;
  const failing = new Proxy(store, { get(target, key) {
    if (key === "commitCandidateBatch") return async () => { writes++; return { ok: false, error: { code: "WRITE_FAILED", message: "fixture" } }; };
    const member = Reflect.get(target, key); return typeof member === "function" ? member.bind(target) : member;
  } }) as WorkspaceMemoryStore;
  const service = createMemoryConsolidation({ store: failing, threadId: "t1", getMessages: async () => [{ id: "u1", role: "user", parts: [{ type: "text", text: "暂未确定。" }] }] });
  try {
    service.begin(AUTO_CONSOLIDATION_AGENT_ID); assert.ok((await service.prepare({ mode: "incremental" })).ok);
    for (let replay = 0; replay < 2; replay++) assert.equal((await service.finalize({ status: "completed", extractionFailed: true })).ok, false);
    assert.equal(writes, 1);
    const receipt = await store.getConsolidationReceipt!("t1"); assert.ok(receipt.ok); assert.equal(receipt.value, null);
    const cursor = await store.getConsolidationCursor("t1"); assert.ok(cursor.ok); assert.equal(cursor.value, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retry limit: post-rename uncertainty is retained as unknown and never repeats the write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-retry-uncertain-"));
  let writes = 0;
  const store = new WorkspaceMemoryStoreImpl(directory, phase => { if (phase === "after-rename") { writes++; throw new Error("lost acknowledgement"); } });
  const service = createMemoryConsolidation({ store, threadId: "t1", getMessages: async () => [{ id: "u1", role: "user", parts: [{ type: "text", text: "暂未确定。" }] }] });
  try {
    service.begin(AUTO_CONSOLIDATION_AGENT_ID); assert.ok((await service.prepare({ mode: "incremental" })).ok);
    for (let replay = 0; replay < 2; replay++) {
      const result = await service.finalize({ status: "completed", extractionFailed: true }); assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "MEMORY_COMMIT_UNCERTAIN");
    }
    assert.equal(writes, 1);
    // Rename may already have applied. Only this explicit read establishes it;
    // neither a success claim nor automatic retry is permitted from the error.
    const receipt = await createMemoryStore(directory).getConsolidationReceipt!("t1"); assert.ok(receipt.ok && receipt.value);
    assert.equal(receipt.value.outcomes[0]!.attempts, 1);
    const cursor = await store.getConsolidationCursor("t1"); assert.ok(cursor.ok); assert.equal(cursor.value, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retry limit: terminal remaining coverage preserves an already retained review", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-retry-partial-"));
  const quote = "我喜欢简洁的代码示例。";
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: quote + "其余还有待确定。" }] }];
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const store = createMemoryStore(directory);
      const service = createMemoryConsolidation({ store, threadId: "t1", writePolicy: "review", getMessages: async () => messages });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID); const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      assert.ok((await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: "add", text: quote,
        sourceMessageId: "u1", sourceQuote: quote, kind: "preference", reason: "fixture", eligibility: "needs_review" }],
        outcomes: [{ messageId: "u1", status: "deferred" }] })).ok);
      const result = await service.finalize({ status: "completed" }); assert.ok(result.ok);
      const pending = await store.listCandidates({}, undefined, { boundThreadId: "t1" }); assert.ok(pending.ok);
      assert.equal(pending.value.candidates.length, 1); assert.equal(pending.value.candidates[0]!.change.text, quote);
      const receipt = await store.getConsolidationReceipt!("t1"); assert.ok(receipt.ok && receipt.value);
      assert.equal(receipt.value.outcomes[0]!.status, attempt === 3 ? "not_saved" : "deferred");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
