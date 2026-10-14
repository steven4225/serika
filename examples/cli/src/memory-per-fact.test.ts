import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryConsolidation } from "./memory-consolidation.js";
import { createMemoryStore } from "./memory-store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-per-fact-"));
  const messages: UIMessage[] = [];
  let ids = 0, now = new Date("2026-10-14T01:00:00Z");
  const reopen = () => createMemoryStore(directory);
  const service = () => createMemoryConsolidation({ store: reopen(), threadId: "thread", getMessages: async () => messages,
    writePolicy: "automatic", now: () => new Date(now), generateId: () => `batch-${++ids}` });
  const message = (id: string, text: string) => messages.push({ id, role: "user", parts: [{ type: "text", text }] });
  const stage = async (proposals: unknown[], status = "extracted") => {
    now = new Date(now.getTime() + 1000);
    const consolidation = service(); consolidation.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await consolidation.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    const staged = await consolidation.stage({ batchId: prepared.value.batchId, proposals,
      outcomes: prepared.value.turns.map(turn => ({ messageId: "user" in turn ? turn.user.messageId : turn.messages[0]!.id, status })) });
    return { consolidation, staged };
  };
  const extract = async (proposals: unknown[]) => {
    const { consolidation, staged } = await stage(proposals);
    assert.ok(staged.ok, staged.ok ? "" : staged.error.message);
    const finalized = await consolidation.finalize({ status: "completed" });
    assert.ok(finalized.ok, finalized.ok ? "" : finalized.error.message);
    return finalized.value;
  };
  const proposal = (sourceMessageId: string, sourceQuote: string, extra: Record<string, unknown> = {}) => ({
    action: "add", text: sourceQuote, kind: "fact", sourceMessageId, sourceQuote, reason: "明确事实",
    eligibility: "durable_self_statement", ...extra,
  });
  return { directory, reopen, service, message, stage, extract, proposal, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("per-fact: an independent residence is not mistaken for the coffee identity in the same quote", async () => {
  const f = await fixture();
  try {
    const quote = "我喝咖啡不加糖；我住在杭州。";
    f.message("u1", quote);
    const result = await f.extract([
      f.proposal("u1", quote, { text: "我喝咖啡不加糖。", kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }),
      f.proposal("u1", quote, { text: "我住在杭州。", factIdentity: { attribute: "residence", scenario: "general", value: "杭州" } }),
    ]);
    const stored = await f.reopen().list(); assert.ok(stored.ok);
    assert.deepEqual(stored.entries.map(entry => entry.assertion?.factIdentity?.attribute).sort(), ["coffee", "residence"]);
    assert.equal(result.processedCount, 1);
    const pending = await f.reopen().listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0);
  } finally { await f.cleanup(); }
});

test("per-fact: a comma-connected coffee and language observation validate independently", async () => {
  const f = await fixture();
  try {
    const quote = "我喝咖啡不加糖，我的回复语言偏好是中文。";
    f.message("u1", quote);
    await f.extract([
      f.proposal("u1", quote, { text: "我喝咖啡不加糖。", kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }),
      f.proposal("u1", quote, { text: "我的回复语言偏好是中文。", kind: "preference", factIdentity: { attribute: "response_language", scenario: "general", value: "zh" } }),
    ]);
    const stored = await f.reopen().list(); assert.ok(stored.ok);
    assert.deepEqual(stored.entries.map(entry => entry.assertion?.factIdentity?.attribute).sort(), ["coffee", "response_language"]);
  } finally { await f.cleanup(); }
});

test("per-fact: an explicitly ignored content error never becomes a review or a saved fact", async () => {
  const f = await fixture();
  try {
    f.message("u1", "我喝咖啡不加糖。");
    const result = await f.extract([f.proposal("u1", "我喝咖啡不加糖。", { kind: "invalid", eligibility: "ignore" })]);
    assert.equal(result.processedCount, 1);
    const stored = await f.reopen().list(); assert.ok(stored.ok); assert.equal(stored.entries.length, 0);
    const pending = await f.reopen().listCandidates({}, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok); assert.equal(pending.value.candidates.length, 0);
    const receipt = await f.reopen().getConsolidationReceipt!("thread"); assert.ok(receipt.ok); assert.equal(receipt.value?.outcomes[0]?.status, "no_memory");
  } finally { await f.cleanup(); }
});

for (const [label, invalid] of [
  ["invalid kind", { kind: "invented_kind" }],
  ["invalid residence body", { text: "我住在上海。", factIdentity: { attribute: "residence", scenario: "general", value: "杭州" } }],
] as const) test(`per-fact: ${label} retains source-bound review without blocking the valid fact or later messages`, async () => {
  const f = await fixture();
  try {
    f.message("u1", "我喝咖啡不加糖；我住在杭州。");
    const result = await f.extract([
      f.proposal("u1", "我喝咖啡不加糖", { kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }),
      f.proposal("u1", "我住在杭州。", invalid),
    ]);
    const reopened = f.reopen();
    const stored = await reopened.list(); assert.ok(stored.ok);
    assert.equal(stored.entries.length, 1);
    assert.equal(stored.entries[0]!.assertion?.factIdentity?.attribute, "coffee");
    const pending = await reopened.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    const candidate = pending.value.candidates[0]!;
    assert.equal(candidate.change.text, "我住在杭州。");
    assert.equal(candidate.source.kind, "conversation"); assert.ok(candidate.source.kind === "conversation");
    assert.equal(candidate.source.messageId, "u1");
    assert.equal(candidate.source.quote, "我住在杭州。");
    assert.equal(result.processedCount, 1, "all proposed facts are now stored or actionable review");
    const approved = await reopened.resolveCandidate({ candidateId: candidate.id, expectedCandidateRevision: candidate.revision, decision: "accept" }, undefined,
      { boundThreadId: "thread", now: new Date("2026-10-14T01:00:02Z") });
    assert.ok(approved.ok, approved.ok ? "" : approved.error.message);
    f.message("u2", "我的回复语言偏好是中文。");
    const next = await f.extract([f.proposal("u2", "我的回复语言偏好是中文。", { kind: "preference",
      factIdentity: { attribute: "response_language", scenario: "general", value: "zh" } })]);
    assert.equal(next.processedCount, 1);
    const again = await f.reopen().list(); assert.ok(again.ok);
    assert.equal(again.entries.length, 3);
  } finally { await f.cleanup(); }
});

test("per-fact: drinking Hangzhou coffee is not evidence of living in Hangzhou", async () => {
  const f = await fixture();
  try {
    f.message("u1", "我喝杭州咖啡。我的回复语言偏好是中文。");
    await f.extract([
      f.proposal("u1", "我喝杭州咖啡。", { text: "我住在杭州。", factIdentity: { attribute: "residence", scenario: "general", value: "杭州" } }),
      f.proposal("u1", "我的回复语言偏好是中文。", { kind: "preference", factIdentity: { attribute: "response_language", scenario: "general", value: "zh" } }),
    ]);
    const stored = await f.reopen().list(); assert.ok(stored.ok);
    assert.deepEqual(stored.entries.map(entry => entry.assertion?.factIdentity?.attribute), ["response_language"]);
    const pending = await f.reopen().listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    assert.equal(pending.value.candidates[0]!.change.text, "我喝杭州咖啡。");
    assert.equal("factIdentity" in pending.value.candidates[0]!.change, false);
  } finally { await f.cleanup(); }
});

test("per-fact: storing one fact and its source review does not override explicit deferred coverage", async () => {
  const f = await fixture();
  try {
    f.message("u1", "我喝咖啡不加糖；我住在杭州。");
    const { consolidation, staged } = await f.stage([
      f.proposal("u1", "我喝咖啡不加糖", { kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }),
      f.proposal("u1", "我住在杭州。", { kind: "invalid" }),
    ], "deferred");
    assert.ok(staged.ok);
    const result = await consolidation.finalize({ status: "completed" }); assert.ok(result.ok);
    assert.equal(result.value.processedCount, 0);
    const cursor = await f.reopen().getConsolidationCursor("thread"); assert.ok(cursor.ok);
    assert.equal(cursor.value, null);
    const receipt = await f.reopen().getConsolidationReceipt!("thread"); assert.ok(receipt.ok);
    assert.equal(receipt.value?.outcomes[0]?.status, "deferred");
    const listed = await f.reopen().list(); assert.ok(listed.ok);
    assert.equal(listed.entries.length, 1);
  } finally { await f.cleanup(); }
});

for (const [label, invalid] of [
  ["invented quote", { sourceQuote: "伪造来源", kind: "invalid" }],
  ["foreign source", { sourceMessageId: "another-thread-user", kind: "invalid" }],
  ["foreign Thread scope", { scope: { kind: "thread", threadId: "foreign" }, kind: "invalid" }],
  ["missing target revision", { action: "update", memoryId: "unknown-target", kind: "invalid" }],
  ["forged authority field", { pinned: true, kind: "invalid" }],
  ["invalid eligibility", { eligibility: "certain", kind: "invalid" }],
] as const) test(`per-fact: ${label} still rejects the entire batch without writes`, async () => {
  const f = await fixture();
  try {
    f.message("u1", "我喝咖啡不加糖；我住在杭州。");
    const { consolidation, staged } = await f.stage([
      f.proposal("u1", "我喝咖啡不加糖", { kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }),
      f.proposal("u1", "我住在杭州。", invalid),
    ]);
    assert.equal(staged.ok, false);
    assert.equal((await consolidation.finalize({ status: "completed" })).ok, false);
    const reopened = f.reopen();
    const listed = await reopened.list(); assert.ok(listed.ok);
    assert.equal(listed.entries.length, 0);
    const pending = await reopened.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0);
    const cursor = await reopened.getConsolidationCursor("thread"); assert.ok(cursor.ok);
    assert.equal(cursor.value, null);
  } finally { await f.cleanup(); }
});

test("per-fact: pending capacity rejects atomically rather than swallowing the remaining fact", async () => {
  const f = await fixture();
  try {
    const store = f.reopen();
    f.message("u1", "我喝咖啡不加糖；我住在杭州。");
    const consolidation = f.service(); consolidation.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await consolidation.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    for (let start = 0; start < 64; start += 5) {
      const fill = await store.commitCandidateBatch({ batchId: `fill-${start}`, originThreadId: "thread", expectedCursor: null, nextCursor: null,
        candidates: Array.from({ length: Math.min(5, 64 - start) }, (_, offset) => {
          const text = `保留待审 ${start + offset}`;
          return { change: { operation: "add" as const, text, scope: { kind: "workspace" as const }, kind: "note" as const, expiresAt: null },
            source: { kind: "conversation" as const, threadId: "thread", messageId: `fixture-${start + offset}`, quote: text }, reason: "隔离容量测试" };
        }) }, undefined, { boundThreadId: "thread", now: new Date("2026-10-14T01:00:00Z") });
      assert.ok(fill.ok, fill.ok ? "" : fill.error.message);
    }
    const staged = await consolidation.stage({ batchId: prepared.value.batchId, proposals: [
      f.proposal("u1", "我喝咖啡不加糖", { kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }),
      f.proposal("u1", "我住在杭州。", { kind: "invalid" }),
    ], outcomes: [{ messageId: "u1", status: "extracted" }] });
    assert.ok(staged.ok);
    assert.equal((await consolidation.finalize({ status: "completed" })).ok, false);
    const reopened = f.reopen();
    const capacity = await reopened.checkCandidateCapacity(); assert.ok(capacity.ok);
    assert.equal(capacity.value.pendingCount, 64);
    const listed = await reopened.list(); assert.ok(listed.ok);
    assert.equal(listed.entries.length, 0);
    const cursor = await reopened.getConsolidationCursor("thread"); assert.ok(cursor.ok);
    assert.equal(cursor.value, null);
  } finally { await f.cleanup(); }
});

for (const text of [undefined, "我住在杭州。"])
test(`per-fact: over-limit exact source for invalid content defers only that source without blocking a short fact (${text ?? "long body"})`, async () => {
  const f = await fixture();
  try {
    const longQuote = "我住在杭州。" + "这是待核对的补充材料。".repeat(100);
    assert.ok(Buffer.byteLength(longQuote) > 2048);
    f.message("u1", longQuote); f.message("u2", "我的回复语言偏好是中文。");
    const result = await f.extract([
      f.proposal("u1", longQuote, { kind: "invalid", ...(text ? { text } : {}) }),
      f.proposal("u2", "我的回复语言偏好是中文。", { kind: "preference", factIdentity: { attribute: "response_language", scenario: "general", value: "zh" } }),
    ]);
    assert.equal(result.processedCount, 0);
    const stored = await f.reopen().list(); assert.ok(stored.ok);
    assert.deepEqual(stored.entries.map(entry => entry.assertion?.factIdentity?.attribute), ["response_language"]);
    const receipt = await f.reopen().getConsolidationReceipt!("thread"); assert.ok(receipt.ok);
    assert.equal(receipt.value?.outcomes[0]?.status, "deferred");
    const pending = await f.reopen().listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0, "never clip an over-limit source into review");
  } finally { await f.cleanup(); }
});
