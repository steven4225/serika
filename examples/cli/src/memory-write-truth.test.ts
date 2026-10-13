import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UIMessage } from "ai";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryConsolidation, type MemoryProposal } from "./memory-consolidation.js";
import { createMemoryStore } from "./memory-store.js";

async function fixture(text: string, metadata?: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "memory-write-truth-"));
  const store = createMemoryStore(directory);
  const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text }], ...(metadata ? { metadata } : {}) }];
  const service = createMemoryConsolidation({ store, threadId: "thread", getMessages: async () => messages,
    writePolicy: "automatic", now: () => new Date("2026-10-13T06:07:00Z") });
  service.begin(AUTO_CONSOLIDATION_AGENT_ID);
  const proposal = (extra: Partial<MemoryProposal> = {}): MemoryProposal => ({ action: "add", text, kind: "preference",
    sourceMessageId: "u1", sourceQuote: text, reason: "用户陈述", eligibility: "durable_self_statement", ...extra });
  return { store, service, proposal, async extract(proposals: MemoryProposal[], status = "extracted") {
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    const staged = await service.stage({ batchId: prepared.value.batchId, proposals, outcomes: [{ messageId: "u1", status }] });
    assert.ok(staged.ok, staged.ok ? "" : staged.error.message);
    const result = await service.finalize({ status: "completed" }); assert.ok(result.ok, result.ok ? "" : result.error.message);
    const pending = await store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread" }); assert.ok(pending.ok);
    const saved = await store.list(); assert.ok(saved.ok);
    return { prepared: prepared.value, result: result.value, pending: pending.value.candidates, saved: saved.entries };
  }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("write truth: scoped text cannot become general, unknown scope is review-only", async () => {
  const f = await fixture("仅在“Serika验收1013”场景中，回复语言使用中文。");
  try {
    const r = await f.extract([f.proposal({ factIdentity: { attribute: "response_language", scenario: "general", value: "zh" } })]);
    assert.equal(r.saved.length, 0);
    assert.equal(r.pending.length, 1);
    const change = r.pending[0]!.change;
    assert.ok("factIdentity" in change); assert.equal(change.factIdentity?.scenario, "Serika验收1013");
  } finally { await f.cleanup(); }
});

test("write truth: unknown conditional scope never falls back to general", async () => {
  const f = await fixture("只有做这个项目的时候，我才喜欢详细复盘。");
  try {
    const r = await f.extract([f.proposal({ factIdentity: { attribute: "review_format", scenario: "general", value: "detailed" } })]);
    assert.equal(r.saved.length, 0); assert.equal(r.pending.length, 1);
    assert.ok(!("factIdentity" in r.pending[0]!.change) || !r.pending[0]!.change.factIdentity);
  } finally { await f.cleanup(); }
});

test("write truth: a correct scene field cannot hide a dropped body qualifier", async () => {
  const f = await fixture("仅在“验收”场景中，回复语言使用中文。");
  try {
    const r = await f.extract([f.proposal({ text: "回复语言使用中文。", factIdentity: { attribute: "response_language", scenario: "验收", value: "zh" } })]);
    assert.equal(r.saved.length, 0); assert.equal(r.pending.length, 1);
    assert.match(r.pending[0]!.reason, /场景/);
  } finally { await f.cleanup(); }
});

test("write truth: an oversized scene label is reviewable, not a batch error", async () => {
  const f = await fixture(`仅在“${"验".repeat(40)}”场景中，回复语言使用中文。`);
  try {
    const r = await f.extract([f.proposal({ factIdentity: { attribute: "response_language", scenario: "general", value: "zh" } })]);
    assert.equal(r.saved.length, 0); assert.equal(r.pending.length, 1);
    assert.ok(!("factIdentity" in r.pending[0]!.change) || !r.pending[0]!.change.factIdentity);
  } finally { await f.cleanup(); }
});

test("write truth: conflicting values in separate explicit scenes do not conflict", async () => {
  const f = await fixture("仅在“验收”场景中，回复语言使用中文。");
  try {
    const old = await f.store.add({ text: "仅在工作场景中，回复语言使用英文。", factIdentity: { attribute: "response_language", scenario: "work", value: "en" }, kind: "preference" }, undefined, { now: new Date("2026-10-12T00:00:00Z") });
    assert.ok(old.ok);
    const r = await f.extract([f.proposal({ factIdentity: { attribute: "response_language", scenario: "验收", value: "zh" } })]);
    assert.equal(r.saved.length, 2); assert.equal(r.pending.length, 0);
  } finally { await f.cleanup(); }
});

test("write truth: one-message tea contradiction survives even a no_memory extraction", async () => {
  const text = "我喜欢喝茶；我讨厌喝茶";
  const f = await fixture(text);
  try {
    const r = await f.extract([], "no_memory");
    assert.equal(r.saved.length, 0); assert.equal(r.pending.length, 1);
    assert.equal(r.pending[0]!.change.text, text);
    assert.equal(r.pending[0]!.source.quote, text);
    assert.match(r.pending[0]!.reason, /矛盾/);
  } finally { await f.cleanup(); }
});

test("write truth: one-message contradiction cannot save only one side", async () => {
  const f = await fixture("我喜欢喝茶；我讨厌喝茶");
  try {
    const r = await f.extract([f.proposal({ text: "我喜欢喝茶", sourceQuote: "我喜欢喝茶" })]);
    assert.equal(r.saved.length, 0); assert.equal(r.pending.length, 1);
    assert.equal(r.pending[0]!.change.text, "我喜欢喝茶；我讨厌喝茶");
  } finally { await f.cleanup(); }
});

test("write truth: reminder request is not an event memory, independent preference survives", async () => {
  const f = await fixture("三分钟后提醒我喝水。另外，我喜欢先给结论。");
  try {
    const r = await f.extract([
      f.proposal({ text: "三分钟后喝水", kind: "event", sourceQuote: "三分钟后提醒我喝水", eligibility: "explicit_request" }),
      f.proposal({ text: "我喜欢先给结论", sourceQuote: "我喜欢先给结论" }),
    ]);
    assert.deepEqual(r.saved.map(x => x.text), ["我喜欢先给结论"]);
    assert.equal(r.pending.length, 0);
  } finally { await f.cleanup(); }
});

test("write truth: consolidation preserves the message clock 67 minutes before extraction", async () => {
  const f = await fixture("我今天搬到了杭州。", { sentAt: "2026-10-13T13:00:00.000+08:00", timeZone: "Asia/Shanghai" });
  try {
    const p = await f.service.prepare({ mode: "incremental" }); assert.ok(p.ok);
    assert.ok("user" in p.value.turns[0]!);
    assert.equal((p.value.turns[0].user as { sentAt?: string }).sentAt, "2026-10-13T13:00:00.000+08:00");
    assert.equal((p.value.turns[0].user as { timeZone?: string }).timeZone, "Asia/Shanghai");
  } finally { await f.cleanup(); }
});

test("write truth: legacy relative-time source cannot automatically install a guessed date", async () => {
  const f = await fixture("我昨天搬到了杭州。");
  try {
    const r = await f.extract([f.proposal({ kind: "fact", validTime: { from: "2026-10-12T05:00:00Z", to: null, basis: "explicit" } })]);
    assert.equal(r.saved.length, 0); assert.equal(r.pending.length, 1);
    assert.ok("validTime" in r.pending[0]!.change);
    assert.equal(r.pending[0]!.change.validTime?.from, null);
  } finally { await f.cleanup(); }
});
