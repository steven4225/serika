import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { V6MemoryStore, type V6Document } from "./memory-v6-store.js";
import { bindMemoryWrite } from "./memory-write.js";
import { mergeMemory } from "./memory-merge.js";
import { createMemoryExtraction } from "./memory-extraction.js";
import { defaultContextBudget, effectiveContextBudget } from "./context-budget.js";
import { readMemoryFactReceipts } from "./memory-factual-receipts.js";

const text = "我希望所有项目的输出都保留完整原因和具体证据".repeat(20) + "；如果有不确定内容请明确标出；请使用中文";
const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], finishReason: { unified: "stop" as const, raw: undefined },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] });
const budgets = [effectiveContextBudget(defaultContextBudget(), { provider: "test", modelId: "32k", source: "configuration", contextWindowTokens: 32768 }), defaultContextBudget()];
async function seed(store: V6MemoryStore) {
  for (let i = 0; i < 4; i++) {
    const user = { id: `u${i}`, role: "user" as const, parts: [{ type: "text" as const, text }] };
    const saved = await store.writeV6([bindMemoryWrite({ operation: "add", category: "preference", text, sourceQuote: text,
      identity: { subject: "用户", attribute: "回复偏好", value: "中文" } }, { messages: [user], user, threadId: "t" })]);
    assert.ok(saved.ok);
    if (i === 1) assert.ok((await store.update(saved.value[0]!.id, { expectedRevision: 1, pinned: true })).ok);
  }
  const loaded = await store.readV6(); assert.ok(loaded.ok); return loaded.value;
}
const members = (document: V6Document) => document.entries.map(({ id, revision }) => ({ id, revision }));
const settle = async (condition: () => boolean) => { const end = Date.now() + 5000; while (!condition()) { if (Date.now() > end) throw new Error("Background did not settle"); await new Promise(resolve => setImmediate(resolve)); } };

test("overflow merge inherits real bound sources and pin state; cold undo restores every original", async () => {
  for (const budget of budgets) {
    const root = await mkdtemp(join(tmpdir(), "cm7-merge-"));
    try {
      const store = new V6MemoryStore(join(root, ".runloom/memory.json")), before = await seed(store); let calls = 0;
      const model = new MockLanguageModelV3({ doGenerate: async input => {
        calls++; assert.equal(input.tools, undefined); assert.equal(input.maxOutputTokens, budget.summaryMaxOutputTokens);
        assert.match(JSON.stringify(input.prompt), /Preserve every distinct literal clause/);
        return response({ merge: { members: members(before), text } });
      } });
      assert.equal(await mergeMemory({ store, document: before, model, budget, signal: new AbortController().signal }), true);
      assert.equal(calls, 1);
      const reopened = new V6MemoryStore(join(root, ".runloom/memory.json")), after = await reopened.readV6(); assert.ok(after.ok);
      const merged = after.value.entries.find(entry => entry.state === "active")!;
      assert.equal(after.value.entries.filter(entry => entry.state === "active").length, 1);
      assert.equal(merged.pinned, true); assert.equal(merged.sources.length, 4); assert.deepEqual(merged.replaces, before.entries.map(entry => entry.id));
      const receipts = await readMemoryFactReceipts(reopened, "t"); assert.ok(receipts.ok);
      assert.equal(receipts.value.filter(receipt => receipt.text === "已取代旧记忆").length, 4);
      assert.ok((await reopened.writeV6([{ operation: "undo", id: merged.id, expectedRevision: merged.revision, source: { kind: "manual" } }])).ok);
      const undone = await new V6MemoryStore(join(root, ".runloom/memory.json")).readV6(); assert.ok(undone.ok);
      for (const original of before.entries) {
        const restored: V6Document["entries"][number] = undone.value.entries.find(entry => entry.id === original.id)!;
        assert.equal(restored.state, "active"); assert.equal(restored.pinned, original.pinned);
        assert.deepEqual(restored.sources.slice(0, original.sources.length), original.sources);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("merge rejects stale revisions and omitted conditions; cancelled inference never writes or retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm7-merge-reject-"));
  try {
    const store = new V6MemoryStore(join(root, ".runloom/memory.json")), before = await seed(store), budget = budgets[0]!;
    const file = join(root, ".runloom/memory.json"), original = await readFile(file, "utf8");
    const invalid = await store.mergeV6({ members: members(before), text: text.split("；")[0]! });
    assert.equal(invalid.ok, false); assert.equal(await readFile(file, "utf8"), original);
    const cancel = new AbortController(); let calls = 0;
    const cancelled = new MockLanguageModelV3({ doGenerate: async () => { calls++; cancel.abort(); return response({ merge: { members: members(before), text } }); } });
    await assert.rejects(mergeMemory({ store, document: before, model: cancelled, budget, signal: cancel.signal }));
    assert.equal(calls, 1); assert.equal(await readFile(file, "utf8"), original);
    const stale = new MockLanguageModelV3({ doGenerate: async () => {
      assert.ok((await store.update(before.entries[0]!.id, { expectedRevision: before.entries[0]!.revision, pinned: true })).ok);
      return response({ merge: { members: members(before), text } });
    } });
    await assert.rejects(mergeMemory({ store, document: before, model: stale, budget, signal: new AbortController().signal }), /MEMORY_REVISION_CONFLICT/);
    const after = await store.readV6(); assert.ok(after.ok); assert.equal(after.value.entries.length, before.entries.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the extraction lifecycle settles its backlog before one merge and does not repeat unchanged work", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm7-merge-queue-"));
  try {
    const store = new V6MemoryStore(join(root, ".runloom/memory.json")), before = await seed(store), order: string[] = [];
    const model = new MockLanguageModelV3({ doGenerate: async input => {
      if (JSON.stringify(input.prompt).includes("Consolidate redundant")) { order.push("merge"); return response({ merge: null }); }
      order.push("extract"); return response({ proposals: [], outcomes: [{ messageId: "latest", status: "no_memory" }] });
    } });
    const extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => [{ id: "latest", role: "user", parts: [{ type: "text", text: "继续" }] }], model, budget: budgets[0]!, updated() {} });
    try {
      extraction.afterMask("latest"); extraction.idle(); await settle(() => order.length === 2 && !extraction.diagnostics().running);
      assert.deepEqual(order, ["extract", "merge"]);
      extraction.idle(); await settle(() => !extraction.diagnostics().running); assert.deepEqual(order, ["extract", "merge"]);
      const after = await store.readV6(); assert.ok(after.ok); assert.deepEqual(after.value.entries, before.entries);
    } finally { await extraction.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an uncertain merge commit is rereadable and the lifecycle never retries it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm7-merge-unknown-"));
  try {
    let fault = false, calls = 0;
    const store = new V6MemoryStore(join(root, ".runloom/memory.json"), phase => { if (fault && phase === "after-rename") throw new Error("lost acknowledgement"); });
    const before = await seed(store); fault = true;
    const model = new MockLanguageModelV3({ doGenerate: async () => { calls++; return response({ merge: { members: members(before), text } }); } });
    const extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => [], model, budget: budgets[0]!, updated() {} });
    try {
      extraction.idle(); await settle(() => !extraction.diagnostics().running);
      assert.match(extraction.diagnostics().error ?? "", /MEMORY_COMMIT_UNCERTAIN/); assert.equal(calls, 1);
      extraction.idle(); await settle(() => !extraction.diagnostics().running); assert.equal(calls, 1);
      const saved = await new V6MemoryStore(join(root, ".runloom/memory.json")).readV6(); assert.ok(saved.ok);
      assert.equal(saved.value.entries.filter(entry => entry.state === "active").length, 1);
    } finally { await extraction.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
