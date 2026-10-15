import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryConsolidation } from "./memory-consolidation.js";
import { createMemoryStore, type WorkspaceMemoryStore } from "./memory-store.js";
import type { CandidateBatchInput } from "./memory-candidates.js";

const oldTime = new Date("2026-10-01T00:00:00.000Z");
const now = new Date("2026-10-02T00:00:00.000Z");
const quote = "从现在起，我喝咖啡改成加糖。";
async function setup(text = quote, policy: "automatic" | "review" = "automatic", targetInput = {}) {
  const directory = await mkdtemp(join(tmpdir(), "memory-explicit-change-"));
  const store = createMemoryStore(directory);
  const seeded = await store.add({ text: "我喝咖啡不加糖", kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" }, ...targetInput }, undefined, { now: oldTime });
  assert.ok(seeded.ok);
  const message: UIMessage = { id: "u1", role: "user", parts: [{ type: "text", text }] };
  const service = createMemoryConsolidation({ store, threadId: "thread", getMessages: async () => [message], now: () => now, writePolicy: policy });
  const proposal = { action: "change", text: "我喝咖啡加糖", kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "sweetened" },
    sourceMessageId: "u1", sourceQuote: text, reason: "用户明确从现在开始更改偏好", eligibility: "explicit_request", memoryId: seeded.entry.id,
    expectedRevision: seeded.entry.revision, changeIntent: { type: "replace_from_now", sourceQuote: text } };
  const cleanup = () => rm(directory, { recursive: true, force: true });
  return { directory, store, service, proposal, target: seeded.entry, cleanup };
}
async function stage(f: Awaited<ReturnType<typeof setup>>, proposal: unknown = f.proposal, history = false) {
  f.service.begin(AUTO_CONSOLIDATION_AGENT_ID, history ? { mode: "history", messageIds: ["u1"] } : undefined);
  const prepared = await f.service.prepare(history ? {} : { mode: "incremental" }); assert.ok(prepared.ok);
  return f.service.stage({ batchId: prepared.value.batchId, proposals: [proposal], outcomes: [{ messageId: "u1", status: "extracted" }] });
}
describe("source-bound from-now preference changes", () => {
  it("accepts everyday explicit self-change expressions, not just one from-now template", async () => {
    for (const text of [
      "从现在起咖啡改成加糖。",
      "以后，我喝咖啡改成加糖。",
      "我以后喝咖啡改成加糖。",
      "今后我的咖啡偏好改为加糖。",
      "我现在喝咖啡改成加糖。",
      "把我的咖啡偏好改成加糖。",
      "请把我的咖啡偏好改为加糖。",
    ]) {
      const f = await setup(text);
      try {
        assert.ok((await stage(f)).ok);
        const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
        assert.equal(committed.value.accepted?.length, 1, text);
        assert.equal(committed.value.pendingCandidateIds?.length, 0, text);
        const reopened = createMemoryStore(f.directory);
        const current = await reopened.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.assertion?.factIdentity?.value, "sweetened", text);
        assert.equal(current.entry.revision, 2, text);
        assert.equal(current.entry.assertion?.validTime.from, now.toISOString(), text);
      } finally { await f.cleanup(); }
    }
  });

  it("does not expand current-change permission to future, uncertain, quoted or third-person speech", async () => {
    for (const text of [
      "以后，我可能喝咖啡改成加糖。",
      "我以后再把咖啡改成加糖。",
      "请把我的咖啡偏好改成加糖？",
      "把我的咖啡偏好改成加糖只是举例。",
      "我现在不想喝咖啡改成加糖。",
      "我现在打算明年喝咖啡改成加糖。",
      "以后，我的朋友喝咖啡改成加糖。",
      "今后我的咖啡偏好改成加糖，但还没决定。",
      "我以后喝咖啡改成加糖是假话。",
    ]) {
      const f = await setup(text);
      try {
        assert.ok((await stage(f)).ok);
        const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
        assert.equal(committed.value.accepted?.length ?? 0, 0, text);
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.text, f.target.text, text);
      } finally { await f.cleanup(); }
    }
  });
  it("preserves the new value and source for unsweetened coffee, review format and response language", async () => {
    for (const [source, oldText, text, attribute, oldValue, value] of [
      ["以后，我喝咖啡改成不加糖。", "我喝咖啡加糖", "我喝咖啡不加糖", "coffee", "sweetened", "unsweetened"],
      ["以后，我复盘改成先说步骤。", "复盘先说结论", "复盘先说步骤", "review_format", "conclusion_first", "steps_first"],
      ["请把我的回复语言改为英文。", "用中文回复", "用英文回复", "response_language", "zh", "en"],
    ] as const) {
      const f = await setup(source, "automatic", { text: oldText, factIdentity: { attribute, scenario: "general", value: oldValue } });
      try {
        assert.ok((await stage(f, { ...f.proposal, text, factIdentity: { attribute, scenario: "general", value } })).ok);
        const result = await f.service.finalize({ status: "completed" }); assert.ok(result.ok);
        assert.equal(result.value.accepted?.length, 1, source);
        const current = await createMemoryStore(f.directory).get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.assertion?.factIdentity?.value, value);
        assert.equal(current.entry.source?.kind, "conversation");
        assert.equal(current.entry.source?.kind === "conversation" && current.entry.source.quote, source);
        const old = await f.store.queryMemory(f.target.id, { validAt: oldTime.toISOString(), knownAt: now.toISOString() }, undefined, { now }); assert.ok(old.ok);
        assert.equal(old.value.assertions[0]?.text, oldText);
      } finally { await f.cleanup(); }
    }
  });
  it("automatically updates an explicit current transition and retains old applicability and identity", async () => {
    const f = await setup(quote, "automatic", { pinned: true });
    try {
      const staged = await stage(f); assert.ok(staged.ok, staged.ok ? "" : staged.error.message);
      const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok, committed.ok ? "" : committed.error.message);
      assert.equal(committed.value.accepted?.length, 1);
      assert.equal(committed.value.pendingCandidateIds?.length, 0);
      const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
      assert.equal(current.entry.text, "我喝咖啡加糖");
      assert.equal(current.entry.assertion?.validTime.from, now.toISOString());
      assert.equal(current.entry.assertion?.factIdentity?.value, "sweetened");
      assert.equal(current.entry.pinned, true);
      assert.deepEqual(current.entry.scope, f.target.scope);
      const old = await f.store.queryMemory(f.target.id, { validAt: oldTime.toISOString(), knownAt: now.toISOString() }, undefined, { now }); assert.ok(old.ok);
      assert.equal(old.value.assertions[0]?.text, "我喝咖啡不加糖");
      assert.equal((await f.service.finalize({ status: "completed" })).ok, true);
      const afterReplay = await f.store.get(f.target.id, undefined, { now }); assert.ok(afterReplay.ok);
      assert.equal(afterReplay.entry.revision, current.entry.revision);
    } finally { await f.cleanup(); }
  });
  it("keeps plain contradiction, missing intent, selected history and review policy pending", async () => {
    for (const mode of ["plain", "legacy", "history", "review"] as const) {
      const f = await setup(mode === "plain" ? "我喝咖啡加糖。" : quote, mode === "review" ? "review" : "automatic");
      try {
        const { changeIntent: _intent, ...legacy } = f.proposal;
        const staged = await stage(f, mode === "legacy" ? legacy : f.proposal, mode === "history"); assert.ok(staged.ok);
        const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
        assert.equal(committed.value.accepted?.length ?? 0, 0);
        const candidates = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread", now }); assert.ok(candidates.ok);
        assert.equal(candidates.value.candidates.length, 1);
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.text, f.target.text);
      } finally { await f.cleanup(); }
    }
  });
  it("does not turn quoted, conditional, negated, future, other-person or contradictory clauses into automatic updates", async () => {
    for (const text of [
      "如果从现在起我喝咖啡改成加糖，就好了。",
      "从现在起，我可能喝咖啡改成加糖。",
      "从现在起，我不要改成咖啡加糖。",
      "从现在起，我不想喝咖啡改成加糖。",
      "从现在起，我不希望咖啡改成加糖。",
      "从现在起，我的朋友喝咖啡改成加糖。",
      "从现在起，我明天喝咖啡改成加糖。",
      "从现在起，我喝咖啡改成加糖，只是举例。",
      "从现在起，我假装喝咖啡改成加糖。",
      "从现在起，我妈妈喝咖啡改成加糖。",
      "从现在起，我喝咖啡改成加糖；我喝咖啡不加糖。",
      "“从现在起，我喝咖啡改成加糖。”",
    ]) {
      const f = await setup(text);
      try {
        const staged = await stage(f); assert.ok(staged.ok, `${text}: ${staged.ok ? "" : staged.error.message}`);
        const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
        assert.equal(committed.value.accepted?.length ?? 0, 0, text);
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.text, f.target.text, text);
      } finally { await f.cleanup(); }
    }
  });
  it("rejects invented intent quotes, clocks, unknown fields and target revisions without writes", async () => {
    for (const patch of [
      { changeIntent: { type: "replace_from_now", sourceQuote: "从现在起，我喜欢咖啡加糖" } },
      { effectiveAt: "2026-01-01T00:00:00Z" },
      { changeIntent: { type: "replace_from_now", sourceQuote: quote, approve: true } },
      { expectedRevision: 999 },
    ]) {
      const f = await setup();
      try {
        assert.equal((await stage(f, { ...f.proposal, ...patch })).ok, false);
        assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.revision, f.target.revision);
        assert.equal((await f.store.getConsolidationCursor("thread")).ok, true);
      } finally { await f.cleanup(); }
    }
  });
  it("keeps stripped qualifiers, thread-only, different scene and legacy target identities out of automatic replacement", async () => {
    for (const mode of ["stripped", "scope", "scene", "legacy"] as const) {
      const text = mode === "scope" ? "从现在起，我喝咖啡改成加糖，仅当前对话有效。" : mode === "stripped" ? `如果可以，${quote}` : quote;
      const f = await setup(text, "automatic", mode === "legacy" ? { factIdentity: undefined } : {});
      try {
        const patch = mode === "stripped" ? { sourceQuote: quote, changeIntent: { type: "replace_from_now", sourceQuote: quote } } :
          mode === "scene" ? { factIdentity: { attribute: "coffee", scenario: "work", value: "sweetened" } } : {};
        const staged = await stage(f, { ...f.proposal, ...patch }); assert.ok(staged.ok);
        const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
        assert.equal(committed.value.accepted?.length ?? 0, 0, mode);
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.text, f.target.text);
      } finally { await f.cleanup(); }
    }
  });
  it("can update an existing current-thread preference without widening its scope", async () => {
    const f = await setup("从现在起，我喝咖啡改成加糖，仅当前对话有效。", "automatic", { scope: { kind: "thread", threadId: "thread" } });
    try {
      const staged = await stage(f); assert.ok(staged.ok);
      const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
      assert.equal(committed.value.accepted?.length, 1);
      const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
      assert.deepEqual(current.entry.scope, { kind: "thread", threadId: "thread" });
    } finally { await f.cleanup(); }
  });
  it("accepts an explicit current transition with a leading or interposed current-thread qualifier", async () => {
    for (const text of [
      "从现在起，仅在当前对话里，我的咖啡改成加糖。",
      "以后，只在本次聊天里，我喝咖啡改成加糖。",
      "仅当前对话有效，从现在起，我的咖啡改成加糖。",
      "只在这个对话中，请把我的咖啡偏好改为加糖。",
    ]) {
      const f = await setup(text, "automatic", { scope: { kind: "thread", threadId: "thread" } });
      try {
        assert.ok((await stage(f)).ok, text);
        const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
        assert.equal(committed.value.accepted?.length, 1, text);
        assert.equal(committed.value.pendingCandidateIds?.length, 0, text);
        const current = await createMemoryStore(f.directory).get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.revision, 2, text);
        assert.equal(current.entry.assertion?.factIdentity?.value, "sweetened", text);
        assert.equal(current.entry.assertion?.validTime.from, now.toISOString(), text);
        assert.deepEqual(current.entry.scope, { kind: "thread", threadId: "thread" }, text);
        assert.equal(current.entry.source?.kind === "conversation" && current.entry.source.quote, text);
      } finally { await f.cleanup(); }
    }
  });
  it("does not strip unsafe qualifiers or widen a scoped transition to a workspace target", async () => {
    for (const text of [
      "从现在起，仅在当前对话里，我的咖啡改成加糖。",
      "从现在起，仅在当前对话里，如果可以，我的咖啡改成加糖。",
      "从现在起，仅在当前对话里，我的朋友喝咖啡改成加糖。",
      "仅当前对话有效，从现在起，我不想喝咖啡改成加糖。",
      "仅当前对话有效，从现在起，我明天喝咖啡改成加糖。",
      "从现在起，仅在当前对话里，我的咖啡改成加糖？",
      "从现在起，仅在当前对话里，我的咖啡改成加糖；我喝咖啡不加糖。",
      "仅当前对话有效，朋友说从现在起我的咖啡改成加糖。",
      "从现在起，仅在当前对话里，“我的咖啡改成加糖”。",
    ]) {
      // The first source is valid only for a thread target. All others remain
      // non-authorizing even for that target: the full original is still checked.
      const f = await setup(text, "automatic", text === "从现在起，仅在当前对话里，我的咖啡改成加糖。"
        ? {} : { scope: { kind: "thread", threadId: "thread" } });
      try {
        assert.ok((await stage(f)).ok, text);
        const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
        assert.equal(committed.value.accepted?.length ?? 0, 0, text);
        assert.equal(committed.value.pendingCandidateIds?.length, 1, text);
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.revision, f.target.revision, text);
        assert.equal(current.entry.text, f.target.text, text);
      } finally { await f.cleanup(); }
    }
  });
  it("does not accept a scoped transition after the model strips the complete-source requirement", async () => {
    const text = "从现在起，仅在当前对话里，如果可以，我的咖啡改成加糖。";
    const f = await setup(text, "automatic", { scope: { kind: "thread", threadId: "thread" } });
    try {
      const stripped = "我的咖啡改成加糖。";
      assert.ok((await stage(f, { ...f.proposal, sourceQuote: stripped,
        changeIntent: { type: "replace_from_now", sourceQuote: stripped } })).ok);
      const committed = await f.service.finalize({ status: "completed" }); assert.ok(committed.ok);
      assert.equal(committed.value.accepted?.length ?? 0, 0);
      const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
      assert.equal(current.entry.revision, f.target.revision);
    } finally { await f.cleanup(); }
  });
  it("does not overwrite expired, disabled or not-yet-effective targets", async () => {
    for (const targetInput of [
      { enabled: false },
      { expiresAt: "2026-10-01T01:00:00.000Z" },
      { validTime: { from: "2026-10-03T00:00:00.000Z", to: null, basis: "explicit" } },
    ]) {
      const f = await setup(quote, "automatic", targetInput);
      try {
        const staged = await stage(f);
        if (staged.ok) {
          const committed = await f.service.finalize({ status: "completed" });
          assert.ok(!committed.ok || (committed.value.accepted?.length ?? 0) === 0);
        }
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.revision, f.target.revision);
      } finally { await f.cleanup(); }
    }
  });
  it("rechecks cancellation and CAS before commit, preserving facts and cursor", async () => {
    for (const mode of ["cancel", "cas"] as const) {
      const f = await setup();
      try {
        assert.ok((await stage(f)).ok);
        if (mode === "cancel") {
          const signal = AbortSignal.abort(new Error("cancel"));
          await assert.rejects(f.service.finalize({ status: "completed" }, signal), /cancel/);
        } else {
          assert.ok((await f.store.update(f.target.id, { pinned: true, expectedRevision: f.target.revision! }, undefined, { now })).ok);
          const result = await f.service.finalize({ status: "completed" }); assert.ok(!result.ok);
          assert.equal(result.error.code, "MEMORY_REVISION_CONFLICT");
        }
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.text, f.target.text);
        const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value, null);
      } finally { await f.cleanup(); }
    }
  });
  it("retains the updated identity so a later ordinary conflict stays pending without double-active facts", async () => {
    const f = await setup();
    try {
      assert.ok((await stage(f)).ok); assert.ok((await f.service.finalize({ status: "completed" })).ok);
      const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
      const nextText = "我喝咖啡不加糖。";
      const service = createMemoryConsolidation({ store: f.store, threadId: "other", getMessages: async () => [{ id: "u2", role: "user", parts: [{ type: "text", text: nextText }] }], now: () => now, writePolicy: "automatic" });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      assert.ok((await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: "add", text: nextText, kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" }, sourceMessageId: "u2", sourceQuote: nextText, reason: "普通矛盾", eligibility: "durable_self_statement" }], outcomes: [{ messageId: "u2", status: "extracted" }] })).ok);
      const committed = await service.finalize({ status: "completed" }); assert.ok(committed.ok);
      assert.equal(committed.value.accepted?.length, 0); assert.equal(committed.value.pendingCandidateIds?.length, 1);
      const listed = await f.store.list(undefined, { now }); assert.ok(listed.ok);
      assert.equal(listed.entries.filter(entry => entry.enabled).length, 1);
      assert.equal(listed.entries[0]?.text, current.entry.text);
    } finally { await f.cleanup(); }
  });
  it("captures from-now applicability only after acquiring write ownership, not during extraction", async () => {
    const f = await setup();
    try {
      let clock = now;
      let arrived!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { arrived = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      const proxy = new Proxy(f.store, { get(target, property) {
        if (property === "commitCandidateBatch") return async (...args: Parameters<WorkspaceMemoryStore["commitCandidateBatch"]>) => { arrived(); await released; return target.commitCandidateBatch(...args); };
        const value: unknown = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      const service = createMemoryConsolidation({ store: proxy, threadId: "thread", getMessages: async () => [{ id: "u1", role: "user", parts: [{ type: "text", text: quote }] }], now: () => clock, writePolicy: "automatic" });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      assert.ok((await service.stage({ batchId: prepared.value.batchId, proposals: [f.proposal], outcomes: [{ messageId: "u1", status: "extracted" }] })).ok);
      const finalizing = service.finalize({ status: "completed" }); await waiting;
      clock = new Date(now.getTime() + 5_000); release();
      const committed = await finalizing; assert.ok(committed.ok);
      const current = await f.store.get(f.target.id, undefined, { now: clock }); assert.ok(current.ok);
      assert.equal(current.entry.assertion?.validTime.from, clock.toISOString());
      assert.equal(current.entry.assertion?.systemTime.from, clock.toISOString());
    } finally { await f.cleanup(); }
  });
  it("keeps store undated guards and binds the trusted resolve-now capability to replay payload", async () => {
    const f = await setup();
    try {
      const prefixHash = "a".repeat(64);
      const input: CandidateBatchInput = { batchId: "trusted-batch", originThreadId: "thread", expectedCursor: null,
        nextCursor: { threadId: "thread", throughMessageId: "u1", prefixHash, lastBatchId: "trusted-batch", updatedAt: now.toISOString() },
        incremental: true, autoAcceptIndexes: [0], outcomes: [{ messageId: "u1", status: "extracted" }], sourcePrefix: { throughMessageId: "u1", prefixHash },
        candidates: [{ change: { operation: "change", memoryId: f.target.id, expectedRevision: f.target.revision!, text: "我喝咖啡加糖", kind: "preference", expiresAt: null,
          effectiveAt: null, factIdentity: { attribute: "coffee", scenario: "general", value: "sweetened" } }, reason: "明确变更",
          source: { kind: "conversation", threadId: "thread", messageId: "u1", quote } }] };
      assert.equal((await f.store.commitCandidateBatch(input, undefined, { boundThreadId: "thread", now })).ok, false);
      assert.equal((await f.store.commitCandidateBatch({ ...input, autoAcceptIndexes: [] }, undefined, { boundThreadId: "thread", now, automaticResolveNowIndexes: [0] })).ok, false);
      const { incremental: _incremental, ...nonIncremental } = input;
      assert.equal((await f.store.commitCandidateBatch(nonIncremental, undefined, { boundThreadId: "thread", now, automaticResolveNowIndexes: [0] })).ok, false);
      const opts = { boundThreadId: "thread", now, automaticResolveNowIndexes: [0] };
      const committed = await f.store.commitCandidateBatch(input, undefined, opts); assert.ok(committed.ok);
      assert.equal(committed.value.accepted?.length, 1);
      const replay = await f.store.commitCandidateBatch(input, undefined, opts); assert.ok(replay.ok); assert.equal(replay.value.replayed, true);
      const changedCapability = await f.store.commitCandidateBatch(input, undefined, { ...opts, automaticResolveNowIndexes: [] }); assert.equal(changedCapability.ok, false);
      const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
      assert.equal(current.entry.revision, 2);
      const oldAssertion = f.target.assertion!;
      const undone = await f.store.restoreMemory({ id: f.target.id, expectedRevision: current.entry.revision!, targetAssertionId: oldAssertion.assertionId }, undefined, { now: new Date(now.getTime() + 1_000) }); assert.ok(undone.ok);
      assert.equal(undone.entry.text, f.target.text);
      assert.equal(undone.entry.assertion?.factIdentity?.value, "unsweetened");
    } finally { await f.cleanup(); }
  });
  it("bootstrap source reinforcement plus explicit transition preserves both sources without blocking unrelated facts", async () => {
    for (const reverse of [false, true]) {
      const f = await setup();
      try {
        const messages: UIMessage[] = [
          { id: "old-observation", role: "user", parts: [{ type: "text", text: "我喝咖啡不加糖" }] },
          { id: "u1", role: "user", parts: [{ type: "text", text: quote }] },
          { id: "language", role: "user", parts: [{ type: "text", text: "我希望回复用中文" }] },
        ];
        const service = createMemoryConsolidation({ store: f.store, threadId: "thread", getMessages: async () => messages, now: () => now, writePolicy: "automatic" });
        service.begin(AUTO_CONSOLIDATION_AGENT_ID); const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
        const support = { action: "add", text: "我喝咖啡不加糖", kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" },
          sourceMessageId: "old-observation", sourceQuote: "我喝咖啡不加糖", reason: "重复观察", eligibility: "durable_self_statement" };
        const language = { action: "add", text: "我希望回复用中文", kind: "preference", factIdentity: { attribute: "response_language", scenario: "general", value: "zh" },
          sourceMessageId: "language", sourceQuote: "我希望回复用中文", reason: "独立偏好", eligibility: "durable_self_statement" };
        const proposals = reverse ? [f.proposal, language, support] : [support, f.proposal, language];
        assert.ok((await service.stage({ batchId: prepared.value.batchId, proposals, outcomes: messages.map(message => ({ messageId: message.id, status: "extracted" })) })).ok);
        const committed = await service.finalize({ status: "completed" }); assert.ok(committed.ok, committed.ok ? "" : committed.error.message);
        assert.equal(committed.value.accepted?.length, 3);
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok);
        assert.equal(current.entry.text, "我喝咖啡加糖"); assert.equal(current.entry.revision, 3);
        const history = await f.store.queryMemory(f.target.id, { validAt: oldTime.toISOString(), knownAt: now.toISOString() }, undefined, { now }); assert.ok(history.ok);
        assert.ok(history.value.assertions[0]?.sources.some(source => source.kind === "conversation" && source.messageId === "old-observation"));
        assert.equal(history.value.assertions[0]?.sources.some(source => source.kind === "conversation" && source.messageId === "u1"), false);
        assert.deepEqual(current.entry.assertion?.sourceIds, [{ kind: "conversation", threadId: "thread", messageId: "u1" }]);
        const listed = await f.store.list(undefined, { now }); assert.ok(listed.ok); assert.equal(listed.entries.length, 2);
        assert.equal(listed.entries.some(entry => entry.assertion?.factIdentity?.attribute === "response_language"), true);
      } finally { await f.cleanup(); }
    }
  });
  it("still rejects arbitrary two automatic target mutations and modified source-reuse bodies", async () => {
    for (const mode of ["ordinary", "modified-support"] as const) {
      const f = await setup();
      try {
        const source = { kind: "conversation" as const, threadId: "thread", messageId: "u1", quote };
        const prefixHash = "a".repeat(64);
        const change = { operation: "change" as const, memoryId: f.target.id, expectedRevision: f.target.revision!, text: "我喝咖啡加糖", kind: "preference" as const,
          expiresAt: null, effectiveAt: mode === "ordinary" ? now.toISOString() : null, factIdentity: { attribute: "coffee" as const, scenario: "general", value: "sweetened" } };
        const support = { operation: "correct" as const, memoryId: f.target.id, expectedRevision: f.target.revision!, text: mode === "ordinary" ? f.target.text : "我喝咖啡无糖",
          kind: "preference" as const, expiresAt: null, factIdentity: f.target.assertion!.factIdentity!, validTime: f.target.assertion!.validTime,
          ...(mode === "ordinary" ? {} : { reuseSources: true as const }) };
        const input: CandidateBatchInput = { batchId: "two-mutations", originThreadId: "thread", expectedCursor: null,
          nextCursor: { threadId: "thread", throughMessageId: "u1", prefixHash, lastBatchId: "two-mutations", updatedAt: now.toISOString() },
          incremental: true, autoAcceptIndexes: [0, 1], outcomes: [{ messageId: "u1", status: "extracted" }], sourcePrefix: { throughMessageId: "u1", prefixHash },
          candidates: [{ change: support, source, reason: "旧观察" }, { change, source, reason: "新偏好" }] };
        const result = await f.store.commitCandidateBatch(input, undefined, { boundThreadId: "thread", now,
          ...(mode === "ordinary" ? {} : { automaticResolveNowIndexes: [1] }) }); assert.ok(!result.ok);
        assert.equal(result.error.code, "MEMORY_BATCH_INVALID");
        const current = await f.store.get(f.target.id, undefined, { now }); assert.ok(current.ok); assert.equal(current.entry.revision, f.target.revision);
        const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value, null);
      } finally { await f.cleanup(); }
    }
  });
});
