import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryConsolidation, prepareConsolidationExtraction, stageConsolidationExtraction, type MemoryProposal } from "./memory-consolidation.js";
import { createMemoryStore, type WorkspaceMemoryStore } from "./memory-store.js";
import type { MemoryFactIdentity } from "./memory-fact-identity.js";
import { retrieveMemories } from "./memory-retrieval.js";

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const coffee = (value = "unsweetened", scenario: MemoryFactIdentity["scenario"] = "general"): MemoryFactIdentity => ({ attribute: "coffee", scenario, value });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-correctness-"));
  let messages: UIMessage[] = [], sequence = 0;
  let clock = new Date("2026-10-10T00:00:00.000Z");
  const store = createMemoryStore(directory);
  const service = (override?: WorkspaceMemoryStore) => createMemoryConsolidation({ store: override ?? createMemoryStore(directory), threadId: "thread",
    getMessages: async () => messages, writePolicy: "automatic", now: () => new Date(clock), generateId: () => `batch-${++sequence}` });
  const extract = async (proposals: MemoryProposal[], outcomes?: Array<{ messageId: string; status: string }>) => {
    clock = new Date(clock.getTime() + 1000);
    const consolidation = service(); consolidation.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await consolidation.prepare({ mode: "incremental" }); assert.ok(prepared.ok, prepared.ok ? "" : prepared.error.message);
    const stage = await consolidation.stage({ batchId: prepared.value.batchId, proposals,
      outcomes: outcomes ?? prepared.value.turns.map(turn => ({ messageId: "user" in turn ? turn.user.messageId : turn.messages[0]!.id, status: "extracted" })) });
    assert.ok(stage.ok, stage.ok ? "" : stage.error.message);
    const result = await consolidation.finalize({ status: "completed" }); assert.ok(result.ok, result.ok ? "" : result.error.message);
    return { prepared: prepared.value, result: result.value };
  };
  const statement = (id: string, text: string, identity = coffee()): MemoryProposal => {
    messages.push(user(id, text));
    return { action: "add", text, kind: "preference", factIdentity: identity, sourceMessageId: id, sourceQuote: text,
      reason: "明确偏好", eligibility: "durable_self_statement" };
  };
  return { directory, store, extract, service, statement, addMessage: (id: string, text: string) => messages.push(user(id, text)),
    replaceMessage: (id: string, text: string) => { messages = messages.map(message => message.id === id ? user(id, text) : message); },
    now: () => new Date(clock), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

for (const proposedScope of [undefined, { kind: "workspace" as const }]) test(`current-thread scope is host-bound despite model scope ${proposedScope?.kind ?? "omitted"}`, async () => {
  const f = await fixture();
  try {
    const quote = "我喝咖啡不加糖。";
    f.addMessage("u1", `请仅在当前对话记住：${quote}不要存到工作区。`);
    const result = await f.extract([{ action: "add", text: quote, kind: "preference", factIdentity: coffee(),
      sourceMessageId: "u1", sourceQuote: quote, reason: "明确偏好", eligibility: "explicit_request",
      ...(proposedScope ? { scope: proposedScope } : {}) }]);
    assert.equal(result.result.accepted?.length, 1, "an explicit current-thread request can be saved without a scope review");
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.deepEqual(listed.entries[0]?.scope, { kind: "thread", threadId: "thread" });
    assert.equal(retrieveMemories(listed.entries, { query: "咖啡", threadId: "thread", now: f.now() }).entries.length, 1);
    for (const threadId of ["another-thread", "telegram-thread", undefined]) {
      assert.equal(retrieveMemories(listed.entries, { query: "咖啡", ...(threadId ? { threadId } : {}), now: f.now() }).entries.length, 0);
    }
  } finally { await f.cleanup(); }
});

test("current-thread scope also bounds a rejected guessed scenario and cannot correct a workspace fact", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡加糖。", coffee("sweetened"))]);
    const id = first.result.accepted![0]!.memoryId;
    const quote = "我喝咖啡不加糖。";
    f.addMessage("u2", `仅当前对话有效：${quote}`);
    await f.extract([{ action: "correct", memoryId: id, expectedRevision: 1, text: quote, kind: "preference",
      factIdentity: coffee("unsweetened", "work"), sourceMessageId: "u2", sourceQuote: quote,
      reason: "偏好", eligibility: "explicit_request" }]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(listed.entries[0]?.text, "我喝咖啡加糖。");
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    const change = pending.value.candidates[0]!.change;
    assert.equal(change.operation, "add");
    assert.ok(change.operation === "add");
    assert.deepEqual(change.scope, { kind: "thread", threadId: "thread" });
    assert.equal(change.factIdentity?.scenario === "work", false, "a work scenario not stated in the body cannot be retained");
  } finally { await f.cleanup(); }
});

test("eval captured RM03 unrelated extraction cannot be saved and the original preference stays reviewable", async () => {
  const f = await fixture();
  try {
    const quote = "以后复盘请先说结论，再说过程。这是我的长期复盘偏好。";
    f.addMessage("u1", quote);
    await f.extract([{ action: "add", text: "用户喜欢喝茶。", kind: "preference", reason: "用户明确陈述了长期持续的偏好。",
      eligibility: "durable_self_statement", sources: [{ sourceMessageId: "u1", sourceQuote: quote }], recallTerms: ["喝茶", "喜欢喝茶"] }],
    [{ messageId: "u1", status: "deferred" }]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(listed.entries.some(entry => entry.text.includes("喝茶")), false, "matching a quote does not validate an unrelated extraction");
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.ok(pending.value.candidates.some(candidate => candidate.change.text.includes("复盘") && !candidate.change.text.includes("喝茶")),
      "retain a source-bound review rather than dropping the real preference");
  } finally { await f.cleanup(); }
});

test("eval captured RM03 mixed-source conflict does not discard the independent language fact", async () => {
  const f = await fixture();
  try {
    await f.extract([f.statement("u1", "我的咖啡偏好是无糖。")]);
    const quote = "我喝咖啡喜欢加糖；另外我的回复语言偏好是中文。";
    f.addMessage("u2", quote);
    const sources = [{ sourceMessageId: "u2", sourceQuote: quote }];
    const result = await f.extract([
      { action: "add", text: "用户喝咖啡喜欢加糖。", kind: "preference", factIdentity: coffee("sweetened"),
        reason: "冲突需审核", eligibility: "needs_review", sources, recallTerms: ["咖啡加糖", "喝咖啡放糖"] },
      { action: "add", text: "用户的回复语言偏好是中文。", kind: "preference",
        factIdentity: { attribute: "response_language", scenario: "general", value: "zh" },
        reason: "明确的回复语言偏好", eligibility: "durable_self_statement", sources, recallTerms: ["用中文回复", "回复语言中文"] },
    ]);
    assert.equal(result.result.processedCount, 1, "both facts from this source were retained");
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.ok(listed.entries.some(entry => entry.assertion?.factIdentity?.attribute === "response_language" && entry.assertion.factIdentity.value === "zh"));
    assert.equal(listed.entries.filter(entry => entry.assertion?.factIdentity?.attribute === "coffee").length, 1);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    assert.equal(pending.value.candidates[0]!.status, "pending");
    assert.equal(pending.value.candidates[0]!.source.messageId, "u2");
    const next = await f.extract([f.statement("u3", "以后复盘请先说结论，再说过程。这是我的长期复盘偏好。",
      { attribute: "review_format", scenario: "general", value: "conclusion_first" })]);
    assert.equal(next.result.processedCount, 1);
    const again = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(again.ok);
    assert.equal(again.value.candidates.length, 1, "completed mixed source must not be reprocessed into a duplicate review");
  } finally { await f.cleanup(); }
});

test("eval repair mixed-source validation still rejects an invented language value", async () => {
  const f = await fixture();
  try {
    const quote = "我喝咖啡不加糖；另外我的回复语言偏好是中文。";
    f.addMessage("u1", quote);
    await f.extract([
      { action: "add", text: "用户喝咖啡不加糖。", kind: "preference", factIdentity: coffee(),
        sourceMessageId: "u1", sourceQuote: quote, reason: "明确偏好", eligibility: "durable_self_statement" },
      { action: "add", text: "用户的回复语言偏好是英文。", kind: "preference",
        factIdentity: { attribute: "response_language", scenario: "general", value: "en" },
        sourceMessageId: "u1", sourceQuote: quote, reason: "错误提取", eligibility: "durable_self_statement" },
    ]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0]!.assertion?.factIdentity?.attribute, "coffee");
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok && receipt.value);
    assert.equal(receipt.value.outcomes[0]!.status, "extracted", "the rejected body now has an actionable source-only review");
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    assert.equal(pending.value.candidates[0]!.change.text, quote);
    assert.equal("factIdentity" in pending.value.candidates[0]!.change, false);
  } finally { await f.cleanup(); }
});

for (const quote of ["我喝咖啡加糖。", "我喜欢加糖的咖啡。", "请记住：我的咖啡偏好是加糖。"]) {
  test(`eval captured RM09 empty no_memory retains new preference after retraction: ${quote}`, async () => {
    const f = await fixture();
    try {
      const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
      const withdrawn = await f.store.reviseMemory({ id: first.result.accepted![0]!.memoryId, expectedRevision: 1,
        operation: "retract" }, undefined, { now: new Date(f.now().getTime() + 100) });
      assert.ok(withdrawn.ok);
      f.addMessage("u2", quote);
      await f.extract([], [{ messageId: "u2", status: "no_memory" }]);
      const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
      assert.equal(pending.value.candidates.length, 1, "an explicit supported preference must not disappear as no_memory");
      const candidate = pending.value.candidates[0]!;
      assert.equal(candidate.change.operation, "add"); assert.ok(candidate.change.operation === "add");
      assert.deepEqual(candidate.change.factIdentity, coffee("sweetened"));
      assert.equal(candidate.source.kind, "conversation"); assert.ok(candidate.source.kind === "conversation");
      assert.equal(candidate.source.messageId, "u2"); assert.equal(candidate.source.quote, quote);
      const listed = await f.store.list(); assert.ok(listed.ok);
      assert.equal(listed.entries.filter(entry => entry.enabled).length, 0, "fallback must await explicit review, not auto-save");
    } finally { await f.cleanup(); }
  });
}

test("eval captured RM09 change aimed at a retracted fact becomes an independent review, not a stale batch", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const id = first.result.accepted![0]!.memoryId;
    const withdrawn = await f.store.reviseMemory({ id, expectedRevision: 1, operation: "retract" }, undefined,
      { now: new Date(f.now().getTime() + 100) }); assert.ok(withdrawn.ok);
    const quote = "请记住：我的咖啡偏好是加糖。"; f.addMessage("u2", quote);
    await f.extract([{ action: "change", memoryId: id, expectedRevision: withdrawn.entry.revision!, text: "用户喜欢喝加糖的咖啡。",
      kind: "preference", eligibility: "explicit_request", factIdentity: coffee("sweetened"), reason: "未给出生效时间，需复核。",
      sources: [{ sourceMessageId: "u2", sourceQuote: quote }], recallTerms: ["咖啡加糖", "甜咖啡"] }]);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    assert.equal(pending.value.candidates[0]!.change.operation, "add");
    assert.equal(pending.value.candidates[0]!.staleReason, null);
  } finally { await f.cleanup(); }
});

for (const status of ["no_memory", "deferred"]) test(`eval captured RM11 ${status} cannot hide a later ordinary conflict`, async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    f.addMessage("u2", "咖啡口味改成加糖。");
    await f.extract([{ action: "change", memoryId: first.result.accepted![0]!.memoryId, expectedRevision: 1,
      text: "用户喝咖啡加糖。", kind: "preference", factIdentity: coffee("sweetened"), reason: "明确变更", eligibility: "explicit_request",
      sourceMessageId: "u2", sourceQuote: "咖啡口味改成加糖。", effectiveAt: new Date(f.now().getTime() + 1000).toISOString() }]);
    f.addMessage("u3", "我喜欢咖啡不加糖。");
    await f.extract([], [{ messageId: "u3", status }]);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1, "ordinary conflict requires an actionable persisted review");
    const candidate = pending.value.candidates[0]!; assert.ok(candidate.change.operation === "add");
    assert.deepEqual(candidate.change.factIdentity, coffee());
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.deepEqual(listed.entries.filter(entry => entry.enabled).map(entry => entry.assertion?.factIdentity), [coffee("sweetened")]);
  } finally { await f.cleanup(); }
});

test("eval captured RM11 changed identity does not inherit old-value recall terms", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([{ ...f.statement("u1", "我喝咖啡不加糖。"), recallTerms: ["咖啡不加糖", "无糖咖啡"] }]);
    f.addMessage("u2", "咖啡口味改成加糖。");
    await f.extract([{ action: "change", memoryId: first.result.accepted![0]!.memoryId, expectedRevision: 1,
      text: "用户喝咖啡加糖。", kind: "preference", factIdentity: coffee("sweetened"), reason: "明确变更", eligibility: "explicit_request",
      sourceMessageId: "u2", sourceQuote: "咖啡口味改成加糖。", effectiveAt: new Date(f.now().getTime() + 1000).toISOString() }]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.deepEqual(listed.entries[0]!.assertion?.factIdentity, coffee("sweetened"));
    assert.equal(listed.entries[0]!.assertion?.recallTerms.some(term => /无糖|不加糖/.test(term)), false);
  } finally { await f.cleanup(); }
});

for (const quote of [
  "我喝咖啡加糖吗？", "比如：我喝咖啡加糖。", "朋友说：我喝咖啡加糖。", "张三喜欢加糖的咖啡。",
  "今天我喝咖啡加糖。", "如果我喝咖啡加糖，请提醒我。", "三分钟后提醒我喝加糖的咖啡。",
  "不要记住：我喜欢咖啡加糖。", "我的密码是 fixture-secret；我喝咖啡加糖。", '例句："我喝咖啡加糖。"',
  "我的咖啡偏好不是加糖。", "我的长期复盘偏好是不要先说结论。", "我喝咖啡不要加糖。",
]) test(`eval repair boundary: no fallback memory for ${quote}`, async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", quote);
    const extracted = await f.extract([], [{ messageId: "u1", status: "no_memory" }]);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(pending.value.candidates.length, 0); assert.equal(listed.entries.length, 0);
    assert.equal(extracted.result.processedCount, 1, "intentional no-memory sources remain processable");
  } finally { await f.cleanup(); }
});

test("eval repair boundary: fallback keeps current-thread scope and uncertain scenes require review without a general identity", async () => {
  const f = await fixture();
  try {
    const quote = "请仅在当前对话记住：我喝咖啡加糖。";
    f.addMessage("u1", quote);
    await f.extract([], [{ messageId: "u1", status: "no_memory" }]);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    const candidate = pending.value.candidates[0]!; assert.ok(candidate.change.operation === "add");
    assert.deepEqual(candidate.change.scope, { kind: "thread", threadId: "thread" });
    const resolved = await f.store.resolveCandidate({ candidateId: candidate.id, expectedCandidateRevision: candidate.revision, decision: "accept" },
      undefined, { boundThreadId: "thread", now: new Date(f.now().getTime() + 100) }); assert.ok(resolved.ok);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(retrieveMemories(listed.entries, { query: "咖啡", threadId: "another-thread", now: f.now() }).entries.length, 0);
    assert.equal(retrieveMemories(listed.entries, { query: "咖啡", threadId: "telegram-thread", now: f.now() }).entries.length, 0);
    f.addMessage("u2", "我的咖啡偏好只有旅行的时候才加糖。");
    await f.extract([], [{ messageId: "u2", status: "no_memory" }]);
    const next = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(next.ok);
    assert.equal(next.value.candidates.length, 1);
    assert.ok(next.value.candidates[0]!.change.operation === "add");
    assert.equal(next.value.candidates[0]!.change.factIdentity, undefined, "an unknown scene is not general");
  } finally { await f.cleanup(); }
});

test("eval repair boundary: deferred fallback reuses the existing pending review instead of duplicating it", async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", "我喜欢咖啡加糖。");
    const first = await f.extract([], [{ messageId: "u1", status: "deferred" }]);
    const second = await f.extract([], [{ messageId: "u1", status: "deferred" }]);
    assert.equal(first.result.processedCount, 0); assert.equal(second.result.processedCount, 0);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    assert.deepEqual(first.result.candidateIds, second.result.candidateIds);
  } finally { await f.cleanup(); }
});

test("oversized fallback records an explicit unsaved disposition and advances later sources across restart", async () => {
  const f = await fixture();
  try {
    const text = `我的咖啡偏好是加糖。${"补充说明。".repeat(200)}`;
    f.addMessage("u1", text);
    const residence = f.statement("u2", "我住在杭州。", { attribute: "residence", scenario: "general", value: "杭州" });
    const extracted = await f.extract([residence], [{ messageId: "u1", status: "no_memory" }, { messageId: "u2", status: "extracted" }]);
    assert.equal(extracted.result.processedCount, 2);
    assert.ok(JSON.stringify(extracted.prepared).includes(text), "the source is not clipped or replaced");
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value?.throughMessageId, "u2");
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok);
    assert.deepEqual(receipt.value?.outcomes[0], { messageId: "u1", status: "not_saved", reason: "too_large" });
    const reopened = createMemoryStore(f.directory);
    assert.deepEqual(await reopened.getConsolidationReceipt!("thread"), receipt);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0);
    const next = await f.extract([f.statement("u3", "我喝咖啡不加糖。")]);
    assert.equal(next.result.processedCount, 1);
    assert.equal("user" in next.prepared.turns[0]! && next.prepared.turns[0].user.messageId, "u3");
  } finally { await f.cleanup(); }
});

test("oversized source with a valid short exact quote is saved normally", async () => {
  const f = await fixture();
  try {
    const quote = "我的咖啡偏好是加糖。";
    f.addMessage("u1", `${quote}${"补充说明。".repeat(200)}`);
    const result = await f.extract([{ action: "add", text: quote, sourceMessageId: "u1", sourceQuote: quote,
      kind: "preference", factIdentity: coffee("sweetened"), reason: "明确偏好", eligibility: "durable_self_statement" }]);
    assert.equal(result.result.processedCount, 1); assert.equal(result.result.accepted?.length, 1);
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok);
    assert.deepEqual(receipt.value?.outcomes, [{ messageId: "u1", status: "extracted" }]);
  } finally { await f.cleanup(); }
});

test("oversized fallback does not turn a transient deferred outcome into a terminal disposition", async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", `我喝咖啡加糖。${"补充说明。".repeat(200)}`);
    const result = await f.extract([], [{ messageId: "u1", status: "deferred" }]);
    assert.equal(result.result.processedCount, 0);
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok);
    assert.deepEqual(receipt.value?.outcomes, [{ messageId: "u1", status: "deferred", attempts: 1 }]);
  } finally { await f.cleanup(); }
});

test("oversized disposition and cursor do not survive a failed commit or cancelled extraction", async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", `我喝咖啡加糖。${"补充说明。".repeat(200)}`);
    const failing = new Proxy(f.store, { get(target, property) {
      if (property === "commitCandidateBatch") return async () => ({ ok: false, error: { code: "MEMORY_WRITE_FAILED", message: "injected" } });
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    for (const status of ["completed", "cancelled"]) {
      const service = f.service(failing); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const batch = await service.prepare({ mode: "incremental" }); assert.ok(batch.ok);
      assert.ok((await service.stage({ batchId: batch.value.batchId, proposals: [], outcomes: [{ messageId: "u1", status: "no_memory" }] })).ok);
      assert.equal((await service.finalize({ status })).ok, status === "cancelled");
      const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value, null);
      const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok); assert.equal(receipt.value, null);
    }
  } finally { await f.cleanup(); }
});

test("model cannot forge an oversized terminal disposition", async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", "我喝咖啡加糖。");
    const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const batch = await service.prepare({ mode: "incremental" }); assert.ok(batch.ok);
    const staged = await service.stage({ batchId: batch.value.batchId, proposals: [],
      outcomes: [{ messageId: "u1", status: "not_saved", reason: "too_large" }] });
    assert.equal(staged.ok, false); assert.equal((await service.finalize({ status: "completed" })).ok, false);
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value, null);
  } finally { await f.cleanup(); }
});

test("eval repair boundary: five proposals leave a missing preference deferred and the next batch keeps it reviewable", async () => {
  const f = await fixture();
  try {
    const proposals = Array.from({ length: 5 }, (_, index): MemoryProposal => {
      const id = `u${index + 1}`, text = `我长期使用工具 ${index + 1}。`; f.addMessage(id, text);
      return { action: "add", text, kind: "fact", sourceMessageId: id, sourceQuote: text, reason: "明确陈述", eligibility: "durable_self_statement" };
    });
    f.addMessage("u6", "我喜欢咖啡加糖。");
    const first = await f.extract(proposals, [...proposals.map(proposal => ({ messageId: proposal.sourceMessageId!, status: "extracted" })),
      { messageId: "u6", status: "no_memory" }]);
    assert.equal(first.result.processedCount, 5); assert.equal(first.result.accepted?.length, 5);
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value?.throughMessageId, "u5");
    const second = await f.extract([], [{ messageId: "u6", status: "no_memory" }]);
    assert.equal(second.result.processedCount, 1);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1); assert.equal(pending.value.candidates[0]!.source.messageId, "u6");
  } finally { await f.cleanup(); }
});

test("eval repair boundary: rejected unrelated extraction cannot block same-batch or later legitimate facts", async () => {
  const f = await fixture();
  try {
    const quote = "以后复盘请先说结论，再说过程。这是我的长期复盘偏好。"; f.addMessage("u1", quote);
    const language = f.statement("u2", "以后请用中文回答。", { attribute: "response_language", scenario: "general", value: "zh" });
    const first = await f.extract([{ action: "add", text: "用户喜欢喝茶。", kind: "preference", reason: "明确陈述", eligibility: "durable_self_statement",
      sourceMessageId: "u1", sourceQuote: quote }, language], [{ messageId: "u1", status: "deferred" }, { messageId: "u2", status: "extracted" }]);
    assert.equal(first.result.accepted?.length, 1); assert.equal(first.result.processedCount, 0);
    const previous = await f.store.listCandidates({}, undefined, { boundThreadId: "thread" }); assert.ok(previous.ok);
    const reviewId = previous.value.candidates[0]!.id;
    const residence = f.statement("u3", "我住在上海。", { attribute: "residence", scenario: "general", value: "上海" });
    await f.extract([residence], [{ messageId: "u1", status: "extracted" }, { messageId: "u2", status: "no_memory" }, { messageId: "u3", status: "extracted" }]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.deepEqual(listed.entries.map(entry => entry.assertion?.factIdentity?.attribute).sort(), ["residence", "response_language"]);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1); assert.equal(pending.value.candidates[0]!.source.messageId, "u1");
    assert.equal(pending.value.candidates[0]!.id, reviewId, "exact original reuses the existing actionable review");
  } finally { await f.cleanup(); }
});

test("eval repair boundary: a retracted target with a stale revision is still rejected without writes", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const id = first.result.accepted![0]!.memoryId;
    const withdrawn = await f.store.reviseMemory({ id, expectedRevision: 1, operation: "retract" }, undefined, { now: f.now() }); assert.ok(withdrawn.ok);
    const quote = "我喝咖啡加糖。"; f.addMessage("u2", quote);
    const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const batch = await service.prepare({ mode: "incremental" }); assert.ok(batch.ok);
    const before = await readFile(join(f.directory, ".runloom/memory.json"), "utf8");
    const staged = await service.stage({ batchId: batch.value.batchId, proposals: [{ action: "correct", memoryId: id, expectedRevision: 1,
      text: quote, kind: "preference", factIdentity: coffee("sweetened"), sourceMessageId: "u2", sourceQuote: quote, reason: "新观察" }] });
    assert.equal(staged.ok, false); assert.equal((await service.finalize({ status: "completed" })).ok, false);
    assert.equal(await readFile(join(f.directory, ".runloom/memory.json"), "utf8"), before);
  } finally { await f.cleanup(); }
});

test("eval repair boundary: synonymous observations retain old recall terms but conflicting proposals use the new terms", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([{ ...f.statement("u1", "我喝咖啡不加糖。"), recallTerms: ["无糖咖啡"] }]);
    const id = first.result.accepted![0]!.memoryId;
    await f.extract([f.statement("u2", "我喜欢不放糖的咖啡。")]);
    const inspected = await f.store.inspectMemory(id); assert.ok(inspected.ok);
    assert.deepEqual(inspected.value.assertions.at(-1)!.recallTerms, ["无糖咖啡"]);
    await f.extract([{ ...f.statement("u3", "我喝咖啡加糖。", coffee("sweetened")), recallTerms: ["甜咖啡"] }]);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1); assert.ok(pending.value.candidates[0]!.change.operation === "correct");
    assert.deepEqual(pending.value.candidates[0]!.change.recallTerms, ["甜咖啡"]);
  } finally { await f.cleanup(); }
});

test("eval repair restore Demo: omitted extraction → explicit fixture approval → conflict restore → retract current → restore old", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const oldId = first.result.accepted![0]!.memoryId;
    const original = await f.store.inspectMemory(oldId); assert.ok(original.ok);
    const withdrawn = await f.store.reviseMemory({ id: oldId, expectedRevision: 1, operation: "retract" }, undefined,
      { now: new Date(f.now().getTime() + 100) }); assert.ok(withdrawn.ok);
    const quote = "请记住：我的咖啡偏好是加糖。"; f.addMessage("u2", quote);
    await f.extract([], [{ messageId: "u2", status: "no_memory" }]);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    const candidate = pending.value.candidates[0]!;
    assert.equal(candidate.source.messageId, "u2"); assert.equal(candidate.source.quote, quote);
    const accepted = await f.store.resolveCandidate({ candidateId: candidate.id, expectedCandidateRevision: candidate.revision, decision: "accept" },
      undefined, { boundThreadId: "thread", now: new Date(f.now().getTime() + 100) }); assert.ok(accepted.ok);
    const input = { id: oldId, expectedRevision: withdrawn.entry.revision!, targetAssertionId: original.value.assertions[0]!.assertionId };
    const blocked = await f.store.restoreMemory(input, undefined, { boundThreadId: "thread", now: new Date(f.now().getTime() + 200) });
    assert.equal(blocked.ok, false); if (!blocked.ok) assert.equal(blocked.error.code, "MEMORY_TEMPORAL_CONFLICT");
    const currentId = accepted.value.memoryId!;
    const retractedCurrent = await f.store.reviseMemory({ id: currentId, expectedRevision: accepted.value.memoryRevision!, operation: "retract" },
      undefined, { boundThreadId: "thread", now: new Date(f.now().getTime() + 300) }); assert.ok(retractedCurrent.ok);
    const restored = await f.store.restoreMemory(input, undefined, { boundThreadId: "thread", now: new Date(f.now().getTime() + 400) }); assert.ok(restored.ok);
    const final = await f.store.list(undefined, { now: new Date(f.now().getTime() + 400) }); assert.ok(final.ok);
    assert.deepEqual(final.entries.filter(entry => entry.enabled).map(entry => ({ id: entry.id, identity: entry.assertion?.factIdentity })),
      [{ id: oldId, identity: coffee() }]);
  } finally { await f.cleanup(); }
});

test("M03 captured correct proposal cannot invent correction intent or block the same-batch language fact", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const oldId = first.result.accepted![0]!.memoryId;
    f.addMessage("u2", "我喜欢咖啡加糖。另外，以后请用中文回答我。");
    await f.extract([
      { action: "correct", memoryId: oldId, expectedRevision: 1, text: "用户喜欢咖啡加糖。", kind: "preference",
        factIdentity: coffee("sweetened"), sourceMessageId: "u2", sourceQuote: "我喜欢咖啡加糖。",
        reason: "模型声称这是明确更正", eligibility: "explicit_request" },
      { action: "add", text: "以后请用中文回答我。", kind: "preference", sourceMessageId: "u2", sourceQuote: "以后请用中文回答我。",
        factIdentity: { attribute: "response_language", scenario: "general", value: "zh" }, reason: "语言偏好", eligibility: "explicit_request" },
    ]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(listed.entries.find(entry => entry.id === oldId)?.assertion?.factIdentity?.value, "unsweetened");
    assert.ok(listed.entries.some(entry => entry.assertion?.factIdentity?.attribute === "response_language"));
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    assert.equal(pending.value.candidates[0]!.change.operation, "correct");
  } finally { await f.cleanup(); }
});

for (const reverse of [false, true]) test(`RM05 mixed-scene review survives synonymous source acceptance, reverse=${reverse}`, async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "在工作场景中，我喝咖啡不加糖。", coffee("unsweetened", "work"))]);
    const oldId = first.result.accepted![0]!.memoryId;
    const quote = "我的休息日咖啡偏好是加糖，工作时依旧不加糖。";
    f.addMessage("u2", quote);
    const proposals: MemoryProposal[] = [
      { action: "add", text: "用户在休息日喝咖啡加糖。", kind: "preference", factIdentity: coffee("sweetened", "休息日"),
        sourceMessageId: "u2", sourceQuote: quote, reason: "休息日偏好", eligibility: "durable_self_statement" },
      { action: "add", text: "在工作场景中，我喝咖啡不加糖。", kind: "preference", factIdentity: coffee("unsweetened", "work"),
        sourceMessageId: "u2", sourceQuote: quote, reason: "同义观察增加来源", eligibility: "durable_self_statement" },
    ];
    await f.extract(reverse ? proposals.reverse() : proposals);
    const listed = await f.store.list(); assert.ok(listed.ok);
    const old = listed.entries.find(entry => entry.id === oldId)!;
    assert.deepEqual(old.assertion?.factIdentity, coffee("unsweetened", "work"));
    const inspected = await f.store.inspectMemory(oldId); assert.ok(inspected.ok);
    assert.equal(inspected.value.assertions.at(-1)!.sources.length, 2);
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    const rest = pending.value.candidates.find(candidate => candidate.change.text.includes("休息日"));
    assert.ok(rest, "rest-day evidence must remain actionable, not stale after the old work fact gains a source");
    assert.equal(rest.change.operation, "add", "a different/ambiguous scene must not be rebound to the work fact");
    assert.ok(rest.change.operation === "add");
    assert.notEqual(rest.change.factIdentity?.scenario, "work", "the host must not invent a work scene from a different clause");
    assert.ok((rest.sources ?? [rest.source]).some(source => source.kind === "conversation" && source.messageId === "u2" && source.quote === quote));
    await f.extract([f.statement("u3", "以后请用中文回答。", { attribute: "response_language", scenario: "general", value: "zh" })]);
    const later = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(later.ok);
    assert.ok(later.value.candidates.some(candidate => candidate.id === rest.id));
    const formal = await f.store.list(); assert.ok(formal.ok);
    assert.ok(formal.entries.some(entry => entry.assertion?.factIdentity?.attribute === "response_language"));
  } finally { await f.cleanup(); }
});

for (const action of ["change", "correct", "update"] as const) test(`identified ${action} without a new identity cannot silently erase conflict protection`, async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const oldId = first.result.accepted![0]!.memoryId;
    const quote = action === "change" ? "咖啡口味改成加糖。" : "更正之前的咖啡偏好：我喝咖啡加糖。";
    f.addMessage("u2", quote);
    await f.extract([{ action, memoryId: oldId, expectedRevision: 1, text: "用户喝咖啡加糖。", kind: "preference",
      sourceMessageId: "u2", sourceQuote: quote, reason: "明确修改", eligibility: "explicit_request",
      ...(action === "change" ? { effectiveAt: new Date(f.now().getTime() + 1000).toISOString() } : {}) }]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.deepEqual(listed.entries.find(entry => entry.id === oldId)?.assertion?.factIdentity, coffee());
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1, "missing new identity needs review, never copying the stale old value");
  } finally { await f.cleanup(); }
});

test("unchanged identified correction preserves its verified identity without guessing a new value", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    f.addMessage("u2", "我喝咖啡不加糖。");
    await f.extract([{ action: "correct", memoryId: first.result.accepted![0]!.memoryId, expectedRevision: 1,
      text: "我喝咖啡不加糖。", kind: "preference", sourceMessageId: "u2", sourceQuote: "我喝咖啡不加糖。",
      reason: "原正文不变", eligibility: "explicit_request" }]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.deepEqual(listed.entries[0]?.assertion?.factIdentity, coffee());
  } finally { await f.cleanup(); }
});

test("explicit identified change preserves the new slot and a later ordinary conflict remains review-only", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    f.addMessage("u2", "咖啡口味改成加糖。");
    await f.extract([{ action: "change", memoryId: first.result.accepted![0]!.memoryId, expectedRevision: 1,
      text: "用户喝咖啡加糖。", kind: "preference", factIdentity: coffee("sweetened"),
      sourceMessageId: "u2", sourceQuote: "咖啡口味改成加糖。", reason: "明确变更", eligibility: "explicit_request",
      effectiveAt: new Date(f.now().getTime() + 1000).toISOString() }]);
    await f.extract([f.statement("u3", "我喝咖啡不加糖。")]);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(listed.entries.length, 1);
    assert.deepEqual(listed.entries[0]?.assertion?.factIdentity, coffee("sweetened"));
    const pending = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    assert.ok("factIdentity" in pending.value.candidates[0]!.change);
    assert.deepEqual(pending.value.candidates[0]!.change.factIdentity, coffee());
  } finally { await f.cleanup(); }
});

test("synonymous observations reuse one fact, preserve wording/time, and accumulate verified sources", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const id = first.result.accepted![0]!.memoryId;
    const before = await f.store.inspectMemory(id); assert.ok(before.ok);
    const second = await f.extract([f.statement("u2", "咖啡甜味我不喜欢。")]);
    assert.equal(second.result.accepted?.[0]?.memoryId, id);
    const listed = await f.store.list(); assert.ok(listed.ok); assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0]?.text, "我喝咖啡不加糖。");
    const record = await f.store.inspectMemory(id); assert.ok(record.ok);
    assert.equal(record.value.revision, 2);
    assert.deepEqual(record.value.assertions.at(-1)!.sources.map(source => source.kind === "conversation" ? source.messageId : ""), ["u1", "u2"]);
    assert.deepEqual(record.value.assertions.at(-1)!.validTime, before.value.assertions[0]!.validTime);
    assert.equal(record.value.assertions[0]!.systemTime.to, record.value.assertions[1]!.systemTime.from);
    assert.deepEqual(record.value.assertions[1]!.factIdentity, coffee());
  } finally { await f.cleanup(); }
});

test("restore identity Demo: preview and restore preserve verified identity, while edited text does not inherit it", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const id = first.result.accepted![0]!.memoryId;
    const original = await f.store.inspectMemory(id); assert.ok(original.ok);
    const withdrawn = await f.store.reviseMemory({ id, expectedRevision: 1, operation: "retract" }, undefined,
      { now: new Date(f.now().getTime() + 100) });
    assert.ok(withdrawn.ok);
    const input = { id, expectedRevision: withdrawn.entry.revision!, targetAssertionId: original.value.assertions[0]!.assertionId };
    const options = { now: new Date(f.now().getTime() + 200) };
    const disk = await readFile(join(f.directory, ".runloom/memory.json"), "utf8");
    const preview = await f.store.previewMemoryMutation({ operation: "restore", ...input }, undefined, options);
    assert.ok(preview.ok);
    assert.deepEqual(preview.value.proposedAssertion?.factIdentity, coffee());
    assert.equal(await readFile(join(f.directory, ".runloom/memory.json"), "utf8"), disk);
    const restored = await f.store.restoreMemory(input, undefined, options); assert.ok(restored.ok);
    assert.equal(restored.entry.text, "我喝咖啡不加糖。");
    assert.deepEqual(restored.entry.assertion?.factIdentity, coffee());

    const edited = await f.store.reviseMemory({ id, expectedRevision: restored.entry.revision!,
      operation: "correct", text: "我喝咖啡加糖。" }, undefined, { now: new Date(f.now().getTime() + 300) });
    assert.ok(edited.ok);
    assert.equal(edited.entry.assertion?.factIdentity, undefined);
    const restoredEdit = await f.store.restoreMemory({ id, expectedRevision: edited.entry.revision!,
      targetAssertionId: edited.entry.assertion!.assertionId }, undefined, { now: new Date(f.now().getTime() + 400) });
    assert.ok(restoredEdit.ok);
    assert.equal(restoredEdit.entry.text, "我喝咖啡加糖。");
    assert.equal(restoredEdit.entry.assertion?.factIdentity, undefined);
  } finally { await f.cleanup(); }
});

test("restore conflict Demo: retract → conflicting new fact → restore is blocked until the current fact is retracted", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const oldId = first.result.accepted![0]!.memoryId;
    const original = await f.store.inspectMemory(oldId); assert.ok(original.ok);
    const withdrawn = await f.store.reviseMemory({ id: oldId, expectedRevision: 1, operation: "retract" }, undefined,
      { now: new Date(f.now().getTime() + 100) });
    assert.ok(withdrawn.ok);
    const second = await f.extract([f.statement("u2", "我喝咖啡加糖。", coffee("sweetened"))]);
    const currentId = second.result.accepted![0]!.memoryId;
    assert.notEqual(currentId, oldId);
    const input = { id: oldId, expectedRevision: withdrawn.entry.revision!, targetAssertionId: original.value.assertions[0]!.assertionId };
    const options = { now: new Date(f.now().getTime() + 100), boundThreadId: "thread" };
    const path = join(f.directory, ".runloom/memory.json");
    const before = await readFile(path, "utf8");
    const preview = await f.store.previewMemoryMutation({ operation: "restore", ...input }, undefined, options);
    assert.equal(await readFile(path, "utf8"), before, "preview must not write");
    const blocked = await f.store.restoreMemory(input, undefined, options);
    const listed = await f.store.list(undefined, options); assert.ok(listed.ok);
    assert.equal(listed.entries.filter(entry => entry.enabled).length, 1, "restoration must not activate opposite preferences together");
    assert.equal(preview.ok, false); assert.equal(blocked.ok, false);
    if (!preview.ok && !blocked.ok) {
      assert.equal(preview.error.code, "MEMORY_TEMPORAL_CONFLICT");
      assert.equal(blocked.error.code, "MEMORY_TEMPORAL_CONFLICT");
      assert.match(blocked.error.message, /retract/i);
    }
    assert.equal(await readFile(path, "utf8"), before, "rejected restoration must not change any record");
    assert.equal(listed.entries.find(entry => entry.enabled)?.text, "我喝咖啡加糖。");

    const retractCurrent = await f.store.reviseMemory({ id: currentId, expectedRevision: 1, operation: "retract" }, undefined,
      { now: new Date(f.now().getTime() + 200), boundThreadId: "thread" });
    assert.ok(retractCurrent.ok);
    const restored = await f.store.restoreMemory(input, undefined,
      { now: new Date(f.now().getTime() + 300), boundThreadId: "thread" });
    assert.ok(restored.ok);
    const final = await f.store.list(undefined, { now: new Date(f.now().getTime() + 300) }); assert.ok(final.ok);
    assert.deepEqual(final.entries.filter(entry => entry.enabled).map(entry => ({ id: entry.id, text: entry.text,
      identity: entry.assertion?.factIdentity })), [{ id: oldId, text: "我喝咖啡不加糖。", identity: coffee() }]);
  } finally { await f.cleanup(); }
});

for (const [label, blocked, other] of [
  ["future overlapping fact", true, { validTime: { from: "2026-10-11T00:00:00.000Z", to: null, basis: "explicit" as const } }],
  ["past nonoverlapping fact", false, { validTime: { from: null, to: "2026-10-10T00:00:01.200Z", basis: "explicit" as const } }],
  ["different scope", false, { scope: { kind: "thread" as const, threadId: "other-thread" } }],
  ["different scenario", false, { factIdentity: coffee("sweetened", "work") }],
  ["disabled fact", false, { status: "disabled" as const }],
  ["expired fact", false, { expiresAt: "2026-10-10T00:00:01.200Z" }],
] as const) {
  test(`restore conflict boundary: ${label}`, async () => {
    const f = await fixture();
    try {
      const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
      const id = first.result.accepted![0]!.memoryId;
      const original = await f.store.inspectMemory(id); assert.ok(original.ok);
      const withdrawn = await f.store.reviseMemory({ id, expectedRevision: 1, operation: "retract" }, undefined,
        { now: new Date(f.now().getTime() + 100) });
      assert.ok(withdrawn.ok);
      const added = await f.store.add({ text: "我喝咖啡加糖。", kind: "preference", factIdentity: coffee("sweetened"), ...other }, undefined,
        { now: new Date(f.now().getTime() + 150) });
      assert.ok(added.ok);
      const input = { id, expectedRevision: withdrawn.entry.revision!, targetAssertionId: original.value.assertions[0]!.assertionId };
      const options = { now: new Date(f.now().getTime() + 200), boundThreadId: "thread" };
      const preview = await f.store.previewMemoryMutation({ operation: "restore", ...input }, undefined, options);
      const restored = await f.store.restoreMemory(input, undefined, options);
      assert.equal(preview.ok, !blocked); assert.equal(restored.ok, !blocked);
      if (!preview.ok && !restored.ok) {
        assert.equal(preview.error.code, "MEMORY_TEMPORAL_CONFLICT");
        assert.equal(restored.error.code, "MEMORY_TEMPORAL_CONFLICT");
      }
    } finally { await f.cleanup(); }
  });
}

for (const [label, text, identity] of [
  ["synonym", "咖啡甜味我不喜欢。", coffee()],
  ["conflict", "我喝咖啡加糖。", coffee("sweetened")],
] as const) {
  test(`restore identity Demo: retract → restore → ${label} cannot create a second active fact`, async () => {
    const f = await fixture();
    try {
      const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
      const id = first.result.accepted![0]!.memoryId;
      const original = await f.store.inspectMemory(id); assert.ok(original.ok);
      const withdrawn = await f.store.reviseMemory({ id, expectedRevision: 1, operation: "retract" }, undefined,
        { now: new Date(f.now().getTime() + 100) });
      assert.ok(withdrawn.ok);
      const restored = await f.store.restoreMemory({ id, expectedRevision: withdrawn.entry.revision!,
        targetAssertionId: original.value.assertions[0]!.assertionId }, undefined, { now: new Date(f.now().getTime() + 200) });
      assert.ok(restored.ok);
      const next = await f.extract([f.statement("u2", text, identity)]);
      const listed = await f.store.list(undefined, { now: f.now() }); assert.ok(listed.ok);
      assert.equal(listed.entries.filter(entry => entry.enabled).length, 1);
      assert.equal(listed.entries[0]?.text, "我喝咖啡不加糖。");
      assert.deepEqual(listed.entries[0]?.assertion?.factIdentity, coffee());
      assert.equal(next.result.accepted?.length, label === "synonym" ? 1 : 0);
      assert.equal(next.result.pendingCandidateIds?.length, label === "synonym" ? 0 : 1);
      if (label === "synonym") assert.equal(next.result.accepted?.[0]?.memoryId, id);
      else {
        const pending = await f.store.getCandidate(next.result.pendingCandidateIds![0]!, undefined,
          { boundThreadId: "thread", now: f.now() });
        assert.ok(pending.ok);
        assert.equal(pending.value.candidate.change.operation, "change", "an undated conflict cannot retrospectively rewrite restored dated applicability");
        assert.ok(pending.value.candidate.change.operation === "change");
        assert.equal(pending.value.candidate.change.effectiveAt, null);
        assert.equal(pending.value.applicable, true, "the review can be explicitly confirmed from now");
        assert.equal("memoryId" in pending.value.candidate.change ? pending.value.candidate.change.memoryId : null, id);
      }
    } finally { await f.cleanup(); }
  });
}

test("same fact in one batch coalesces evidence; different scenarios coexist and ambiguous values need review", async () => {
  const f = await fixture();
  try {
    const result = await f.extract([f.statement("u1", "我一般喝无糖咖啡。"), f.statement("u2", "我一般不加糖。")]);
    assert.equal(result.result.accepted?.length, 1);
    const changed = await f.extract([f.statement("u3", "我一般喜欢甜咖啡。", coffee("sweetened"))]);
    assert.equal(changed.result.accepted?.length, 0);
    assert.equal(changed.result.pendingCandidateIds?.length, 1);
    const candidate = await f.store.getCandidate(changed.result.pendingCandidateIds![0]!, undefined, { boundThreadId: "thread", now: f.now() });
    assert.ok(candidate.ok); assert.equal(candidate.value.candidate.change.operation, "correct");
    const scoped = await f.extract([f.statement("u4", "工作时我偏好甜咖啡。", coffee("sweetened", "work"))]);
    assert.equal(scoped.result.accepted?.length, 1);
    const entries = await f.store.list(); assert.ok(entries.ok); assert.equal(entries.entries.length, 2);
    assert.deepEqual(entries.entries.map(entry => entry.assertion?.factIdentity?.scenario).sort(), ["general", "work"]);
  } finally { await f.cleanup(); }
});

test("support capacity Demo: the 65th observation stays pending without blocking unrelated or later facts", async () => {
  const f = await fixture();
  try {
    let id = "";
    for (let index = 1; index <= 64; index++) {
      const result = await f.extract([f.statement(`u${index}`, `我的咖啡一直不加糖（确认 ${index}）。`)]);
      id = result.result.accepted![0]!.memoryId;
    }
    const before = await f.store.inspectMemory(id); assert.ok(before.ok);
    const result = await f.extract([f.statement("u65", "我喝咖啡仍然不加糖。"),
      f.statement("u66", "回复用中文。", { attribute: "response_language", scenario: "general", value: "zh" })]);
    assert.equal(result.result.accepted?.length, 1);
    assert.equal(result.result.pendingCandidateIds?.length, 1);
    const options = { boundThreadId: "thread", now: f.now() };
    const pending = await f.store.getCandidate(result.result.pendingCandidateIds![0]!, undefined, options); assert.ok(pending.ok);
    assert.equal(pending.value.applicable, false);
    assert.match(pending.value.unavailableReason!, /历史|history/i);
    assert.equal(pending.value.candidate.source.messageId, "u65", "overflow evidence remains reviewable, not discarded");
    const after = await f.store.inspectMemory(id); assert.ok(after.ok);
    assert.deepEqual(after.value, before.value, "do not prune or rewrite old evidence to fit");
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok);
    assert.equal(cursor.value?.throughMessageId, "u66");
    const later = await f.extract([f.statement("u67", "我的咖啡不放糖。"),
      f.statement("u68", "工作时咖啡加糖。", coffee("sweetened", "work"))]);
    assert.equal(later.result.accepted?.length, 1);
    assert.deepEqual(later.result.pendingCandidateIds, result.result.pendingCandidateIds, "do not grow duplicate unresolvable reviews");
    const manual = await f.store.resolveCandidate({ candidateId: result.result.pendingCandidateIds![0]!, expectedCandidateRevision: 1, decision: "accept" },
      undefined, { ...options, now: f.now() });
    assert.equal(manual.ok, false);
    if (!manual.ok) assert.equal(manual.error.code, "MEMORY_HISTORY_FULL");
  } finally { await f.cleanup(); }
});

test("new-slot conflict Demo: both conflicting adds need review without blocking unrelated or later facts", async () => {
  const f = await fixture();
  try {
    const result = await f.extract([f.statement("u1", "咖啡不加糖。"),
      f.statement("u2", "咖啡加糖。", coffee("sweetened")),
      f.statement("u3", "回复用中文。", { attribute: "response_language", scenario: "general", value: "zh" })]);
    assert.equal(result.result.accepted?.length, 1);
    assert.equal(result.result.pendingCandidateIds?.length, 2, "do not silently pick either conflicting value");
    const listed = await f.store.list(undefined, { now: f.now() }); assert.ok(listed.ok);
    assert.deepEqual(listed.entries.map(entry => entry.assertion?.factIdentity?.attribute), ["response_language"]);
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok);
    assert.equal(cursor.value?.throughMessageId, "u3");
    const later = await f.extract([f.statement("u4", "工作时咖啡不加糖。", coffee("unsweetened", "work"))]);
    assert.equal(later.result.accepted?.length, 1);
    const options = { boundThreadId: "thread", now: f.now() };
    const accept = (candidateId: string) => f.store.resolveCandidate({ candidateId, expectedCandidateRevision: 1, decision: "accept" }, undefined, options);
    assert.ok((await accept(result.result.pendingCandidateIds![0]!)).ok);
    const preview = await f.store.getCandidate(result.result.pendingCandidateIds![1]!, undefined, options); assert.ok(preview.ok);
    assert.equal(preview.value.applicable, false, "preview must agree with locked conflict rejection");
    const blocked = await accept(result.result.pendingCandidateIds![1]!);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEMORY_REVISION_CONFLICT");
  } finally { await f.cleanup(); }
});

test("future-slot conflict Demo: a known future preference blocks overlapping automatic and reviewed adds", async () => {
  const f = await fixture();
  try {
    await f.extract([{ ...f.statement("u1", "十一月起咖啡加糖。", coffee("sweetened")),
      validTime: { from: "2026-11-01T00:00:00.000Z", to: null, basis: "explicit" } }]);
    const result = await f.extract([f.statement("u2", "咖啡不加糖。"),
      f.statement("u3", "回复用中文。", { attribute: "response_language", scenario: "general", value: "zh" })]);
    assert.equal(result.result.accepted?.length, 1);
    assert.equal(result.result.pendingCandidateIds?.length, 1);
    const preview = await f.store.getCandidate(result.result.pendingCandidateIds![0]!, undefined, { boundThreadId: "thread", now: f.now() });
    assert.ok(preview.ok); assert.equal(preview.value.applicable, false);
    const blocked = await f.store.resolveCandidate({ candidateId: result.result.pendingCandidateIds![0]!, expectedCandidateRevision: 1, decision: "accept" },
      undefined, { boundThreadId: "thread", now: f.now() });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error.code, "MEMORY_REVISION_CONFLICT");
    const listed = await f.store.list(undefined, { now: new Date("2026-11-02T00:00:00Z") }); assert.ok(listed.ok);
    assert.equal(listed.entries.filter(entry => entry.enabled && entry.assertion?.factIdentity?.attribute === "coffee").length, 1);
  } finally { await f.cleanup(); }
});

test("new-slot conflict: a review-only proposal cannot silently lose to the automatic proposal", async () => {
  const f = await fixture();
  try {
    const result = await f.extract([f.statement("u1", "咖啡不加糖。"),
      { ...f.statement("u2", "咖啡可能要加糖。", coffee("sweetened")), eligibility: "needs_review" }]);
    assert.equal(result.result.accepted?.length, 0);
    assert.equal(result.result.pendingCandidateIds?.length, 2);
  } finally { await f.cleanup(); }
});

for (const separateBatches of [false, true]) test(`fact-slot boundary: adjacent validity intervals and scopes remain automatic (separate batches: ${separateBatches})`, async () => {
  const f = await fixture();
  try {
    const first: MemoryProposal = { ...f.statement("u1", "十一月前咖啡不加糖。"), validTime: { from: null, to: "2026-11-01T00:00:00.000Z", basis: "explicit" } };
    if (separateBatches) assert.equal((await f.extract([first])).result.accepted?.length, 1);
    const result = await f.extract([
      ...(separateBatches ? [] : [first]),
      { ...f.statement("u2", "十一月起咖啡加糖。", coffee("sweetened")), validTime: { from: "2026-11-01T00:00:00.000Z", to: null, basis: "explicit" } },
      { ...f.statement("u3", "本会话咖啡加糖。", coffee("sweetened")), scope: { kind: "thread" } },
    ]);
    assert.equal(result.result.accepted?.length, separateBatches ? 2 : 3);
    assert.equal(result.result.pendingCandidateIds?.length, 0);
  } finally { await f.cleanup(); }
});

test("undated conflict Demo: pending conflict does not block same-batch or later facts across restart", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const id = first.result.accepted![0]!.memoryId;
    f.addMessage("u2", "我喝咖啡加糖。");
    const other = f.statement("u3", "回复请用中文。", { attribute: "response_language", scenario: "general", value: "zh" });
    const next = await f.extract([{ action: "change", memoryId: id, expectedRevision: 1,
      text: "我喝咖啡加糖。", kind: "preference", factIdentity: coffee("sweetened"),
      sourceMessageId: "u2", sourceQuote: "我喝咖啡加糖。", reason: "偏好不同但未说明生效日", eligibility: "explicit_request" }, other]);
    assert.equal(next.result.pendingCandidateIds?.length, 1);
    assert.equal(next.result.accepted?.length, 1, "unrelated same-batch fact must be saved");
    const listed = await f.store.list(undefined, { now: f.now() }); assert.ok(listed.ok);
    assert.equal(listed.entries.find(entry => entry.id === id)?.text, "我喝咖啡不加糖。");
    assert.equal(listed.entries.filter(entry => entry.assertion?.factIdentity?.attribute === "coffee" && entry.enabled).length, 1);
    const pending = await f.store.getCandidate(next.result.pendingCandidateIds![0]!, undefined, { now: f.now(), boundThreadId: "thread" });
    assert.ok(pending.ok);
    assert.match(pending.value.candidate.reason, /生效|时间|确认/);
    assert.equal(pending.value.candidate.change.operation, "change", "an ambiguous transition is not silently reclassified as correction");
    assert.equal("effectiveAt" in pending.value.candidate.change && pending.value.candidate.change.effectiveAt, null, "missing effective date must not be invented");
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok);
    assert.equal(cursor.value?.throughMessageId, "u3");
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok);
    assert.equal(receipt.value?.outcomes.find(outcome => outcome.messageId === "u2")?.status, "extracted");
    const later = await f.extract([f.statement("u4", "工作时我喝甜咖啡。", coffee("sweetened", "work"))]);
    assert.equal(later.result.accepted?.length, 1, "new service/store must still save later facts");
    const final = await f.store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread", now: f.now() });
    assert.ok(final.ok); assert.equal(final.value.candidates.length, 1);
    const review = { candidateId: pending.value.candidate.id, expectedCandidateRevision: 1, decision: "accept" as const };
    const options = { boundThreadId: "thread", now: new Date(f.now().getTime() + 100) };
    const before = await readFile(join(f.directory, ".runloom/memory.json"), "utf8");
    const notConfirmed = await f.store.resolveCandidate(review, undefined, options);
    assert.equal(notConfirmed.ok, false, "plain accept must not guess an effective date");
    assert.equal(await readFile(join(f.directory, ".runloom/memory.json"), "utf8"), before);
    const confirmed = await f.store.resolveCandidate({ ...review, effectiveAt: "now" }, undefined, options);
    assert.ok(confirmed.ok);
    const updated = await f.store.queryMemory(id, {}, undefined, options); assert.ok(updated.ok);
    assert.equal(updated.value.assertions[0]?.text, "我喝咖啡加糖。");
    assert.equal(updated.value.assertions[0]?.validTime.from, options.now.toISOString());
    const prior = await f.store.queryMemory(id, { validAt: f.now().toISOString() }, undefined, options); assert.ok(prior.ok);
    assert.equal(prior.value.assertions[0]?.text, "我喝咖啡不加糖。", "explicit from-now confirmation preserves prior applicability");
    const replay = await createMemoryStore(f.directory).resolveCandidate({ ...review, effectiveAt: "now" }, undefined,
      { ...options, now: new Date(options.now.getTime() + 100) });
    assert.ok(replay.ok); assert.equal(replay.value.replayed, true);
  } finally { await f.cleanup(); }
});

for (const [label, extra] of [
  ["malformed date", { effectiveAt: "not-a-date" }],
  ["invented source", { sourceQuote: "我明确说了从今天开始" }],
  ["stale target", { expectedRevision: 999 }],
  ["foreign target", { memoryId: "foreign" }],
] as const) test(`undated conflict safety: ${label} still rejects the whole batch without writing`, async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    f.addMessage("u2", "我喝咖啡加糖。");
    const other = f.statement("u3", "回复请用中文。", { attribute: "response_language", scenario: "general", value: "zh" });
    const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const batch = await service.prepare({ mode: "incremental" }); assert.ok(batch.ok);
    const path = join(f.directory, ".runloom/memory.json");
    const before = await readFile(path, "utf8");
    const staged = await service.stage({ batchId: batch.value.batchId, proposals: [other, { action: "change",
      memoryId: first.result.accepted![0]!.memoryId, expectedRevision: 1, text: "我喝咖啡加糖。", kind: "preference",
      factIdentity: coffee("sweetened"), sourceMessageId: "u2", sourceQuote: "我喝咖啡加糖。", reason: "待确认", eligibility: "explicit_request", ...extra }],
      outcomes: [{ messageId: "u2", status: "extracted" }, { messageId: "u3", status: "extracted" }] });
    assert.equal(staged.ok, false);
    assert.equal((await service.finalize({ status: "completed" })).ok, false);
    assert.equal(await readFile(path, "utf8"), before);
  } finally { await f.cleanup(); }
});

test("undated conflict safety: store refuses forged automatic acceptance indexes", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    const path = join(f.directory, ".runloom/memory.json");
    const before = await readFile(path, "utf8");
    const saved = await f.store.commitCandidateBatch({ batchId: "forged", originThreadId: "thread", expectedCursor: null, nextCursor: null,
      autoAcceptIndexes: [0], candidates: [{ change: { operation: "change", memoryId: first.result.accepted![0]!.memoryId,
        expectedRevision: 1, text: "咖啡加糖", expiresAt: null, effectiveAt: null, kind: "preference", factIdentity: coffee("sweetened") },
        source: { kind: "conversation", threadId: "thread", messageId: "u2", quote: "咖啡加糖" }, reason: "待确认" }] },
      undefined, { boundThreadId: "thread", now: f.now() });
    assert.equal(saved.ok, false);
    if (!saved.ok) assert.match(saved.error.message, /Undated changes require explicit review/);
    assert.equal(await readFile(path, "utf8"), before);
  } finally { await f.cleanup(); }
});

test("undated conflict safety: ignored material is not retained as a pending proposal", async () => {
  const f = await fixture();
  try {
    const first = await f.extract([f.statement("u1", "我喝咖啡不加糖。")]);
    f.addMessage("u2", "别人说咖啡要加糖。");
    const extracted = await f.extract([{ action: "change", memoryId: first.result.accepted![0]!.memoryId, expectedRevision: 1,
      text: "我喝咖啡加糖。", sourceMessageId: "u2", sourceQuote: "别人说咖啡要加糖。", reason: "第三方信息不应保留", eligibility: "ignore" }]);
    assert.equal(extracted.result.pendingCandidateIds?.length, 0);
    assert.equal(extracted.result.accepted?.length, 0);
    const listed = await f.store.list(); assert.ok(listed.ok);
    assert.equal(listed.entries[0]?.text, "我喝咖啡不加糖。");
  } finally { await f.cleanup(); }
});

test("real value changes retain bitemporal history, and later source reuse does not erase the old segment", async () => {
  const f = await fixture();
  try {
    const added = await f.extract([f.statement("u1", "我原本喜欢甜咖啡。", coffee("sweetened"))]);
    const id = added.result.accepted![0]!.memoryId;
    const text = "从 2026-10-01T00:00:00Z 起我改喝无糖咖啡，请记住。";
    f.addMessage("u2", text);
    await f.extract([{ action: "change", text: "现在我喝无糖咖啡。", kind: "preference", factIdentity: coffee(),
      effectiveAt: "2026-10-01T00:00:00Z", memoryId: id, expectedRevision: 1, sourceMessageId: "u2", sourceQuote: text,
      reason: "明确变更日期", eligibility: "explicit_request" }]);
    await f.extract([f.statement("u3", "我喝咖啡就是不放糖。")]);
    const old = await f.store.queryMemory(id, { validAt: "2026-09-30T00:00:00Z" }, undefined, { now: f.now() });
    const current = await f.store.queryMemory(id, { validAt: "2026-10-02T00:00:00Z" }, undefined, { now: f.now() });
    assert.ok(old.ok && current.ok);
    assert.equal(old.value.assertions[0]?.text, "我原本喜欢甜咖啡。");
    assert.equal(current.value.assertions[0]?.text, "现在我喝无糖咖啡。");
    assert.deepEqual(current.value.assertions[0]?.factIdentity, coffee());
    assert.equal(current.value.assertions[0]?.sources.length, 2);
  } finally { await f.cleanup(); }
});

test("a partially extracted source survives restart/new messages and commits the remainder without duplicating facts", async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", "我的六条长期偏好：甲、乙、丙、丁、戊、己。");
    const proposals = ["甲", "乙", "丙", "丁", "戊", "己"].map(text => ({ action: "add" as const, text: `偏好${text}`,
      sourceMessageId: "u1", sourceQuote: text, kind: "preference" as const, reason: "明确偏好", eligibility: "durable_self_statement" as const }));
    const first = await f.extract(proposals.slice(0, 5), [{ messageId: "u1", status: "deferred" }]);
    assert.equal(first.result.processedCount, 0); assert.equal(first.result.accepted?.length, 5);
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value, null);
    for (let i = 0; i < 10; i++) f.addMessage(`new${i}`, "一次性问题");
    const reopened = f.service(); reopened.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const batch = await reopened.prepare({ mode: "incremental" }); assert.ok(batch.ok);
    assert.equal("user" in batch.value.turns[0]! ? batch.value.turns[0].user.messageId : "", "u1");
    const outcomes = batch.value.turns.map(turn => ({ messageId: "user" in turn ? turn.user.messageId : "", status: "user" in turn && turn.user.messageId === "u1" ? "extracted" : "no_memory" }));
    assert.ok((await reopened.stage({ batchId: batch.value.batchId, proposals: [proposals[5]!], outcomes })).ok);
    const result = await reopened.finalize({ status: "completed" }); assert.ok(result.ok);
    const entries = await f.store.list(); assert.ok(entries.ok); assert.equal(entries.entries.length, 6);
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok && receipt.value);
    assert.deepEqual(receipt.value.outcomes, outcomes);
    const disk = JSON.parse(await readFile(join(f.directory, ".runloom/memory.json"), "utf8"));
    assert.equal(disk.consolidationReceipts.length, 1);
  } finally { await f.cleanup(); }
});

test("identified add without kind retains only the real source for review, never the model paraphrase", async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", "我喝咖啡不加糖。");
    const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    const staged = await stageConsolidationExtraction(service, JSON.stringify({ batchId: prepared.value.batchId,
      proposals: [{ action: "add", text: "用户喝咖啡不加糖。", reason: "用户明确自述持久偏好",
        eligibility: "durable_self_statement", sources: [{ sourceMessageId: "u1", sourceQuote: "我喝咖啡不加糖。" }],
        factIdentity: coffee() }], outcomes: [{ messageId: "u1", status: "extracted" }] }));
    assert.equal(staged.ok, true);
    assert.equal((await service.finalize({ status: "completed" })).ok, true);
    const listed = await f.store.list(); assert.ok(listed.ok); assert.equal(listed.entries.length, 0);
    const candidates = await f.store.listCandidates({}, undefined, { boundThreadId: "thread" }); assert.ok(candidates.ok); assert.equal(candidates.value.candidates.length, 1);
    assert.equal(candidates.value.candidates[0]!.change.text, "我喝咖啡不加糖。");
    assert.equal("factIdentity" in candidates.value.candidates[0]!.change, false);
    const cursor = await f.store.getConsolidationCursor("thread"); assert.ok(cursor.ok); assert.equal(cursor.value?.throughMessageId, "u1");
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok); assert.equal(receipt.value?.outcomes[0]?.status, "extracted");
  } finally { await f.cleanup(); }
});

test("structured extraction rejects missing/mismatched coverage, malformed/truncated JSON and invented quotes without a commit", async () => {
  const f = await fixture();
  try {
    f.addMessage("u1", "我偏好中文回答。");
    for (const value of ["not JSON", "{}", JSON.stringify({ batchId: "wrong", proposals: [], outcomes: [] })]) {
      const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      await prepareConsolidationExtraction(service, user("synthetic", "prepare"));
      assert.equal((await stageConsolidationExtraction(service, value)).ok, false);
      assert.equal((await service.finalize({ status: "completed" })).ok, false);
    }
    for (const outcomes of [[{ messageId: "foreign", status: "no_memory" }], [{ messageId: "u1", status: "extracted" }], [], [{ messageId: "u1", status: "no_memory", permission: true }]]) {
      const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      assert.equal((await service.stage({ batchId: prepared.value.batchId, proposals: [], outcomes })).ok, false);
      assert.equal((await service.finalize({ status: "completed" })).ok, false);
    }
    const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    assert.equal((await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: "add", text: "使用英文", reason: "猜测", sourceMessageId: "u1", sourceQuote: "invented" }], outcomes: [{ messageId: "u1", status: "extracted" }] })).ok, false);
    assert.equal((await service.finalize({ status: "completed" })).ok, false);
    assert.deepEqual(await f.store.list(), { ok: true, entries: [] });
    assert.deepEqual(await f.store.getConsolidationCursor("thread"), { ok: true, value: null });
    assert.deepEqual(await f.store.getConsolidationReceipt!("thread"), { ok: true, value: null });
  } finally { await f.cleanup(); }
});

test("legacy stages and failed/cancelled/aborted extraction never declare a source fully processed", async () => {
  const f = await fixture();
  try {
    const proposal = f.statement("u1", "我的长期偏好是用中文回答。", { attribute: "response_language", scenario: "general", value: "zh" });
    for (const status of ["failed", "cancelled", "timed_out"] as const) {
      const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      assert.ok((await service.stage({ batchId: prepared.value.batchId, proposals: [proposal], outcomes: [{ messageId: "u1", status: "extracted" }] })).ok);
      assert.ok((await service.finalize({ status })).ok);
      assert.deepEqual(await f.store.getConsolidationReceipt!("thread"), { ok: true, value: null });
    }
    const service = f.service(); service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    assert.ok((await service.stage({ batchId: prepared.value.batchId, proposals: [proposal] })).ok);
    const aborted = new AbortController(); aborted.abort(new Error("foreground"));
    await assert.rejects(service.finalize({ status: "completed" }, aborted.signal), /foreground/);
    assert.deepEqual(await f.store.list(), { ok: true, entries: [] });
    const finalized = await service.finalize({ status: "completed" }); assert.ok(finalized.ok);
    assert.equal(finalized.value.processedCount, 0);
    assert.deepEqual(await f.store.getConsolidationCursor("thread"), { ok: true, value: null });
    const receipt = await f.store.getConsolidationReceipt!("thread"); assert.ok(receipt.ok && receipt.value);
    assert.equal(receipt.value.outcomes[0]!.status, "deferred");
    f.replaceMessage("u1", "我的长期偏好改成英文回答。");
    const next = f.service(); next.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const mismatch = await next.prepare({ mode: "incremental" }); assert.ok(!mismatch.ok);
    assert.equal(mismatch.error.code, "MEMORY_CURSOR_MISMATCH");
  } finally { await f.cleanup(); }
});
