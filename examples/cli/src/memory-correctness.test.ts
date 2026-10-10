import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryConsolidation, prepareConsolidationExtraction, stageConsolidationExtraction, type MemoryProposal } from "./memory-consolidation.js";
import { createMemoryStore } from "./memory-store.js";
import type { MemoryFactIdentity } from "./memory-fact-identity.js";

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const coffee = (value = "unsweetened", scenario: MemoryFactIdentity["scenario"] = "general"): MemoryFactIdentity => ({ attribute: "coffee", scenario, value });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-correctness-"));
  let messages: UIMessage[] = [], sequence = 0;
  let clock = new Date("2026-10-10T00:00:00.000Z");
  const store = createMemoryStore(directory);
  const service = () => createMemoryConsolidation({ store: createMemoryStore(directory), threadId: "thread",
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

test("selected history cannot overwrite pending incremental coverage and old reviews never become automatic", async () => {
  const f = await fixture();
  try {
    const item = f.statement("u1", "我喜欢中文回答。", { attribute: "response_language", scenario: "general", value: "zh" });
    const first = await f.extract([{ ...item, eligibility: "needs_review" }], [{ messageId: "u1", status: "deferred" }]);
    const before = await f.store.getConsolidationReceipt!("thread"); assert.ok(before.ok && before.value);
    const history = f.service(); history.begin(AUTO_CONSOLIDATION_AGENT_ID, { mode: "history", messageIds: ["u1"] });
    const batch = await history.prepare({ mode: "incremental" }); assert.ok(batch.ok);
    assert.ok((await history.stage({ batchId: batch.value.batchId, proposals: [], outcomes: [{ messageId: "u1", status: "no_memory" }] })).ok);
    assert.ok((await history.finalize({ status: "completed" })).ok);
    assert.deepEqual(await f.store.getConsolidationReceipt!("thread"), before);
    const retry = await f.extract([f.statement("u2", "Please respond in Mandarin.", item.factIdentity!)],
      [{ messageId: "u1", status: "deferred" }, { messageId: "u2", status: "extracted" }]);
    assert.equal(retry.result.accepted?.length, 0);
    assert.deepEqual(retry.result.pendingCandidateIds, first.result.pendingCandidateIds);
    const entries = await f.store.list(); assert.ok(entries.ok); assert.equal(entries.entries.length, 0);
  } finally { await f.cleanup(); }
});
