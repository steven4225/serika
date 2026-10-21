import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import type { CandidateBatchInput, ConsolidationCursor } from "./memory-candidates.js";
import type { MemoryConsolidationEntry, MemoryEntry, WorkspaceMemoryStore } from "./memory-store.js";
import { AUTO_CONSOLIDATION_AGENT_ID, AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";
import { CONSOLIDATION_MATERIAL_MAX_BYTES, CONSOLIDATION_MEMORIES_MAX_BYTES, consolidationPrefixHash, createMemoryConsolidation } from "./memory-consolidation.js";
import { createAssertion } from "./memory-temporal.js";
import { createMemoryStore } from "./memory-store.js";

const user = (id: string, text = `用户 ${id}`): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
function fixture(initial: UIMessage[] = [user("u1", "复盘先结论，再给步骤")], writePolicy?: "review" | "automatic") {
  let messages = initial;
  let cursor: ConsolidationCursor | null = null;
  let entries: MemoryEntry[] = [];
  let pending = 0;
  const committed: CandidateBatchInput[] = [];
  const store = {
    list: async () => ({ ok: true as const, entries }),
    listCandidates: async () => ({ ok: true as const, value: { candidates: [], nextOffset: null, truncated: false } }),
    checkCandidateCapacity: async () => ({ ok: true as const, value: { canStart: pending < 64, pendingCount: pending } }),
    getConsolidationCursor: async () => ({ ok: true as const, value: cursor }),
    commitCandidateBatch: async (input: CandidateBatchInput, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      committed.push(structuredClone(input));
      if (input.nextCursor !== null) cursor = input.nextCursor;
      return { ok: true as const, value: { candidateIds: input.candidates.map((_, index) => `c${index}`), replayed: false } };
    },
  } as unknown as WorkspaceMemoryStore;
  let id = 0;
  const service = createMemoryConsolidation({ store, threadId: "thread", getMessages: async () => messages,
    now: () => new Date("2026-10-01T00:00:00Z"), generateId: () => `batch${++id}`, ...(writePolicy === undefined ? {} : { writePolicy }) });
  return { service, committed, setMessages(value: UIMessage[]) { messages = value; }, setCursor(value: ConsolidationCursor | null) { cursor = value; },
    setEntries(value: MemoryEntry[]) { entries = value; },
    setMaterial(value: MemoryConsolidationEntry[]) { entries = value; store.listConsolidationMaterial = async () => ({ ok: true, value }); },
    setPending(value: number) { pending = value; }, getCursor: () => cursor };
}
const proposal = (extra = {}) => ({ action: "add", text: "复盘先结论，再给步骤", sourceMessageId: "u1", sourceQuote: "复盘先结论，再给步骤", reason: "用户明确长期偏好", ...extra });
async function prepare(f: ReturnType<typeof fixture>, agent = AUTO_CONSOLIDATION_AGENT_ID) {
  f.service.begin(agent);
  const prepared = await f.service.prepare(agent === AUTO_CONSOLIDATION_AGENT_ID ? { mode: "incremental" } : {});
  assert.equal(prepared.ok, true);
  if (!prepared.ok) throw new Error("Expected successful preparation");
  return prepared.value;
}
function noMemoryOutcomes(batch: Awaited<ReturnType<typeof prepare>>) {
  return batch.turns.map(turn => ({ messageId: "user" in turn ? turn.user.messageId : turn.messages[0]!.id, status: "no_memory" }));
}

describe("native memory consolidation batch", () => {
  it("does not mark eight read sources complete after only five proposals", async () => {
    const messages = Array.from({ length: 8 }, (_, i) => user(`u${i + 1}`, `长期偏好 ${i + 1}`));
    const f = fixture(messages);
    const batch = await prepare(f);
    assert.ok((await f.service.stage({ batchId: batch.batchId, proposals: messages.slice(0, 5).map(message => ({
      action: "add", text: message.parts[0]!.type === "text" ? message.parts[0]!.text : "", reason: "明确偏好",
      sourceMessageId: message.id, sourceQuote: `长期偏好 ${message.id.slice(1)}`,
    })), outcomes: messages.map((message, index) => ({ messageId: message.id, status: index < 5 ? "extracted" : "deferred" })) })).ok);
    const result = await f.service.finalize({ status: "completed" });
    assert.ok(result.ok);
    assert.equal(f.getCursor()?.throughMessageId, "u5");
    const next = await prepare(f);
    assert.deepEqual("bootstrap" in next ? next.turns.map(turn => turn.user.messageId) : [], ["u6", "u7", "u8"]);
  });
  it("captures injected commit time after write ownership, not the earlier observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memory-commit-clock-"));
    try {
      const actual = createMemoryStore(directory);
      let clock = new Date("2026-10-01T00:00:00.000Z");
      let arrived!: () => void, release!: () => void;
      const waiting = new Promise<void>(r => { arrived = r; });
      const released = new Promise<void>(r => { release = r; });
      const proxy = new Proxy(actual, { get(target, property) {
        if (property === "commitCandidateBatch") return async (...args: Parameters<WorkspaceMemoryStore["commitCandidateBatch"]>) => { arrived(); await released; return target.commitCandidateBatch(...args); };
        const value: unknown = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      const service = createMemoryConsolidation({ store: proxy, threadId: "thread", getMessages: async () => [user("u1", "复盘先结论，再给步骤")], now: () => new Date(clock), generateId: () => "clock-batch" });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const batch = await service.prepare({ mode: "incremental" }); assert.ok(batch.ok);
      assert.ok((await service.stage({ batchId: batch.value.batchId, proposals: [proposal()] })).ok);
      const finalizing = service.finalize({ status: "completed" }); await waiting;
      clock = new Date("2026-10-01T00:00:01.000Z");
      assert.ok((await actual.add({ text: "concurrent independent fact" }, undefined, { now: clock })).ok);
      release(); const finalized = await finalizing; assert.ok(finalized.ok, finalized.ok ? "" : finalized.error.message);
      const listed = await actual.listCandidates({}, undefined, { boundThreadId: "thread", now: clock }); assert.ok(listed.ok);
      assert.equal(listed.value.candidates[0]?.createdAt, clock.toISOString());
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("host automatic policy selects only eligible incremental drafts; missing/ambiguous require review", async () => {
    const f = fixture(undefined, "automatic");
    const batch = await prepare(f);
    assert.ok((await f.service.stage({ batchId: batch.batchId, proposals: [
      proposal({ kind: "preference", eligibility: "durable_self_statement" }),
      proposal({ text: "复盘先结论（适用范围待确认）", eligibility: "needs_review" }),
      proposal({ text: "复盘先结论（旧格式）" }),
      proposal({ text: "not durable", eligibility: "ignore" }),
    ] })).ok);
    assert.ok((await f.service.finalize({ status: "completed" })).ok);
    assert.deepEqual(f.committed[0]!.autoAcceptIndexes, [0]);
    assert.equal(f.committed[0]!.candidates.length, 3);
  });

  it("model eligibility cannot grant automatic writes to review mode or manual runs", async () => {
    for (const mode of ["review", "manual"] as const) {
      const f = fixture(undefined, mode === "review" ? "review" : "automatic");
      const batch = await prepare(f, mode === "manual" ? "primary" : AUTO_CONSOLIDATION_AGENT_ID);
      assert.ok((await f.service.stage({ batchId: batch.batchId, proposals: [proposal({ kind: "preference", eligibility: "durable_self_statement" })] })).ok);
      assert.ok((await f.service.finalize({ status: "completed" })).ok);
      assert.equal(f.committed[0]!.autoAcceptIndexes, undefined);
    }
  });

  it("conservatively skips recognizable private material even when model requests autosave", async () => {
    for (const text of ["不要记住这句话：我偏好短答案", "Don't remember this: I prefer short answers", "API_KEY=sk-example-credential-123456789", "我的密码是123", "-----BEGIN PRIVATE KEY-----"]) {
      const f = fixture([user("u1", text)], "automatic");
      const batch = await prepare(f);
      assert.ok((await f.service.stage({ batchId: batch.batchId, proposals: [proposal({ text, sourceQuote: text, kind: "preference", eligibility: "durable_self_statement" })] })).ok);
      assert.ok((await f.service.finalize({ status: "completed" })).ok);
      assert.deepEqual(f.committed[0]!.candidates, []);
      assert.deepEqual(f.committed[0]!.autoAcceptIndexes, []);
    }
  });

  it("recognized proposal-only consent overrides model autosave classification without discarding the review", async () => {
    for (const text of ["我长期偏好短答案，可以提出候选，但不要保存", "未经我下一轮确认不得调用写入工具。我长期偏好短答案", "I prefer short answers. Proposal only; don't save."]) {
      const f = fixture([user("u1", text)], "automatic");
      const batch = await prepare(f);
      assert.ok((await f.service.stage({ batchId: batch.batchId, proposals: [proposal({ sourceQuote: text, kind: "preference", eligibility: "durable_self_statement" })] })).ok);
      assert.ok((await f.service.finalize({ status: "completed" })).ok);
      assert.equal(f.committed[0]!.candidates.length, 1);
      assert.deepEqual(f.committed[0]!.autoAcceptIndexes, []);
    }
  });

  it("recognized opt-out can explicitly retract/disable a supplied unique target but never add or rewrite a fact", async () => {
    const text = "不要记住我的复盘偏好了";
    for (const action of ["retract", "disable", "add", "correct"] as const) {
      const f = fixture([user("u1", text)], "automatic");
      f.setEntries([{ id: "old", text: "复盘先结论，再给步骤", enabled: true, revision: 1, scope: { kind: "workspace" } }]);
      const batch = await prepare(f);
      const item = proposal({ action, sourceQuote: text, eligibility: "explicit_request", ...(action === "add" ? { kind: "preference" } : { memoryId: "old", expectedRevision: 1 }) });
      assert.ok((await f.service.stage({ batchId: batch.batchId, proposals: [item] })).ok);
      assert.ok((await f.service.finalize({ status: "completed" })).ok);
      const withdrawal = action === "retract" || action === "disable";
      assert.equal(f.committed[0]!.candidates.length, withdrawal ? 1 : 0);
      assert.deepEqual(f.committed[0]!.autoAcceptIndexes, withdrawal ? [0] : []);
    }
  });

  it("automatic mode cannot source excluded messages or bypass strict eligibility/source schemas", async () => {
    const f = fixture([{ ...user("secret", "private preference"), metadata: { memoryConsolidation: "exclude" } }, user("u1")], "automatic");
    for (const extra of [{ eligibility: "certain" }, { eligibility: ["explicit_request"] }, { sourceMessageId: "secret", sourceQuote: "private preference", eligibility: "explicit_request" }, { sourceQuote: "invented", eligibility: "explicit_request" }, { pinned: true, eligibility: "explicit_request" }]) {
      const batch = await prepare(f);
      assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [proposal(extra)] })).ok, false);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
      assert.equal(f.committed.length, 0);
    }
  });

  it("ordinary event/note inference and non-explicit withdrawal remain review", async () => {
    const f = fixture(undefined, "automatic");
    f.setEntries([{ id: "old", text: "复盘先结论，再给步骤", enabled: true, revision: 1, scope: { kind: "workspace" } }]);
    const batch = await prepare(f);
    assert.ok((await f.service.stage({ batchId: batch.batchId, proposals: [
      proposal({ kind: "event", eligibility: "durable_self_statement" }),
      proposal({ action: "retract", memoryId: "old", expectedRevision: 1, eligibility: "durable_self_statement" }),
      proposal({ text: "复盘先结论，另存一条说明", kind: "note", eligibility: "explicit_request" }),
    ] })).ok);
    assert.ok((await f.service.finalize({ status: "completed" })).ok);
    assert.deepEqual(f.committed[0]!.autoAcceptIndexes, [2]);
  });

  it("retrieves visible disabled and expired current versions as conflict material, not active injection", async () => {
    const f = fixture([user("u1", "写作复盘偏好")]);
    f.setEntries([
      { id: "disabled", text: "写作复盘偏好旧版", enabled: false, status: "disabled", revision: 2, history: [{ revision: 1, text: "history secret" }] } as MemoryEntry,
      { id: "expired", text: "写作复盘偏好临时版", enabled: true, expiresAt: "2020-01-01T00:00:00Z", revision: 1 },
      { id: "foreign", text: "写作复盘偏好私有版", enabled: true, scope: { kind: "thread", threadId: "other" } },
      { id: "unrelated", text: "database indexes", enabled: true },
    ]);
    const material = await prepare(f);
    assert.deepEqual(material.memories.map((entry) => entry.id).sort(), ["disabled", "expired", "unrelated"]);
    assert.equal(JSON.stringify(material.memories).includes("history secret"), false);
    assert.equal((await f.service.stage({ batchId: material.batchId, proposals: [{ action: "update", memoryId: "disabled", expectedRevision: 2, text: "写作复盘偏好新版本", sourceMessageId: "u1", sourceQuote: "写作复盘偏好", reason: "更新偏好" }] })).ok, false);
  });
  it("stages locally and atomically commits candidates with cursor only after completed", async () => {
    const f = fixture();
    const prepared = await prepare(f);
    assert.deepEqual(prepared.memories, []);
    assert.equal(await f.service.stage({ batchId: prepared.batchId, proposals: [proposal()], outcomes: [{ messageId: "u1", status: "extracted" }] }).then((x) => x.ok), true);
    assert.equal(f.committed.length, 0);
    const final = await f.service.finalize({ status: "completed" });
    assert.equal(final.ok, true);
    assert.equal(f.committed.length, 1);
    assert.equal(f.committed[0]?.candidates[0]?.source.threadId, "thread");
    assert.equal(f.getCursor()?.throughMessageId, "u1");
    const replay = await f.service.finalize({ status: "completed" });
    assert.deepEqual(replay, { ok: true, value: { candidateIds: ["c0"], replayed: true, processedCount: 1,
      outcomes: [{ messageId: "u1", status: "extracted" }] } });
    assert.equal(f.committed.length, 1);
  });
  it("requires an explicit empty stage, and never advances on failed or cancelled Runs", async () => {
    for (const status of ["failed", "cancelled", "timed_out"]) {
      const f = fixture(); const prepared = await prepare(f);
      await f.service.stage({ batchId: prepared.batchId, proposals: [] });
      await f.service.finalize({ status });
      assert.equal(f.committed.length, 0);
    }
    const f = fixture(); await prepare(f);
    const missing = await f.service.finalize({ status: "completed" });
    assert.equal(missing.ok, false);
    assert.equal(f.committed.length, 0);
    const empty = await prepare(f);
    await f.service.stage({ batchId: empty.batchId, proposals: [], outcomes: noMemoryOutcomes(empty) });
    assert.equal((await f.service.finalize({ status: "completed" })).ok, true);
    assert.equal(f.getCursor()?.throughMessageId, "u1");
  });
  it("rejects duplicate prepare/stage calls even after the first one succeeded", async () => {
    for (const duplicate of ["prepare", "stage"]) {
      const f = fixture(); const prepared = await prepare(f);
      await f.service.stage({ batchId: prepared.batchId, proposals: [] });
      const result = duplicate === "prepare" ? await f.service.prepare({ mode: "incremental" }) : await f.service.stage({ batchId: prepared.batchId, proposals: [] });
      assert.equal(result.ok, false);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
      assert.equal(f.committed.length, 0);
    }
  });
  it("rejects schema-failed extra tool attempts invisible to execute and permits cancelled ordinary chat", async () => {
    const f = fixture(); const prepared = await prepare(f);
    await f.service.stage({ batchId: prepared.batchId, proposals: [] });
    assert.equal((await f.service.finalize({ status: "completed", consolidationAttempts: { prepare: 1, stage: 2 } })).ok, false);
    assert.equal(f.committed.length, 0);
    f.service.begin("primary");
    const cancelled = new AbortController(); cancelled.abort();
    assert.deepEqual(await f.service.finalize({ status: "cancelled" }, cancelled.signal), { ok: true, value: { candidateIds: [], replayed: false } });
    f.service.begin("primary");
    assert.deepEqual(await f.service.finalize({ status: "completed", consolidationAttempts: { prepare: 0, stage: 0 } }, cancelled.signal), { ok: true, value: { candidateIds: [], replayed: false } });
    assert.equal((await f.service.finalize({ status: "completed", consolidationAttempts: { prepare: 1, stage: 0 } })).ok, false);
  });
  it("validates every exact user source and rejects a whole mixed batch", async () => {
    for (const invalid of [proposal({ sourceQuote: "复盘 先结论" }), proposal({ sourceMessageId: "assistant" }), proposal({ pinned: true }), proposal({ scope: { kind: "thread", threadId: "other" } })]) {
      const f = fixture([user("u1", "复盘先结论，再给步骤"), { id: "assistant", role: "assistant", parts: [{ type: "text", text: "复盘先结论，再给步骤" }] }]);
      const prepared = await prepare(f);
      assert.equal((await f.service.stage({ batchId: prepared.batchId, proposals: [proposal(), invalid] })).ok, false);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
      assert.equal(f.committed.length, 0);
    }
  });
  it("manual completion preserves the automatic cursor; ordinary chat has no batch error", async () => {
    const f = fixture(); const previous: ConsolidationCursor = { threadId: "thread", throughMessageId: "missing", prefixHash: "old", lastBatchId: "old", updatedAt: "2026-09-30T00:00:00Z" };
    f.setCursor(previous);
    const prepared = await prepare(f, "primary");
    await f.service.stage({ batchId: prepared.batchId, proposals: [] });
    assert.equal((await f.service.finalize({ status: "completed" })).ok, true);
    assert.equal(f.committed[0]?.nextCursor, null);
    assert.deepEqual(f.getCursor(), previous);
    f.service.begin("primary");
    assert.deepEqual(await f.service.finalize({ status: "completed" }), { ok: true, value: { candidateIds: [], replayed: false } });
    f.service.begin("primary");
    assert.equal((await f.service.prepare({ mode: "incremental" })).ok, false);
  });
  it("bootstraps latest eight then consumes earliest eight without skipping backlog", async () => {
    const initial = Array.from({ length: 10 }, (_, index) => user(`u${index}`));
    const f = fixture(initial); const boot = await prepare(f);
    assert.ok("bootstrap" in boot && boot.bootstrap);
    if (!("bootstrap" in boot)) return;
    assert.deepEqual(boot.turns.map((turn) => turn.user.messageId), initial.slice(2).map((message) => message.id));
    await f.service.stage({ batchId: boot.batchId, proposals: [], outcomes: noMemoryOutcomes(boot) }); await f.service.finalize({ status: "completed" });
    const appended = Array.from({ length: 12 }, (_, index) => user(`new${index}`));
    f.setMessages([...initial, ...appended]);
    const next = await prepare(f);
    if (!("bootstrap" in next)) return assert.fail("expected incremental material");
    assert.equal(next.bootstrap, false);
    assert.deepEqual(next.turns.map((turn) => turn.user.messageId), appended.slice(0, 8).map((message) => message.id));
    await f.service.stage({ batchId: next.batchId, proposals: [], outcomes: noMemoryOutcomes(next) }); await f.service.finalize({ status: "completed" });
    const last = await prepare(f);
    if (!("bootstrap" in last)) return assert.fail("expected incremental material");
    assert.deepEqual(last.turns.map((turn) => turn.user.messageId), appended.slice(8).map((message) => message.id));
  });
  it("cursor ignores automatic transcript markers but rejects changed ordinary prefixes", async () => {
    const initial = [user("u1", "复盘先结论，再给步骤")];
    const f = fixture(initial); const boot = await prepare(f);
    await f.service.stage({ batchId: boot.batchId, proposals: [], outcomes: noMemoryOutcomes(boot) }); await f.service.finalize({ status: "completed" });
    f.setMessages([...initial, { ...user("auto"), metadata: { source: AUTO_CONSOLIDATION_SOURCE } }, user("u2")]);
    const next = await prepare(f);
    if (!("bootstrap" in next)) return assert.fail("expected incremental");
    assert.deepEqual(next.turns.map((turn) => turn.user.messageId), ["u2"]);
    f.setMessages([user("u1", "被替换的对话"), user("u2")]);
    f.service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const mismatch = await f.service.prepare({ mode: "incremental" });
    assert.ok(!mismatch.ok && mismatch.error.code === "MEMORY_CURSOR_MISMATCH");
    assert.notEqual(consolidationPrefixHash(initial, "u1"), consolidationPrefixHash([user("u1", "其他")], "u1"));
  });
  it("rereads evidence and target revision before final commit", async () => {
    const f = fixture();
    const entry: MemoryEntry = { id: "m1", text: "复盘先结论，再给步骤", enabled: true, revision: 1, scope: { kind: "workspace" } };
    f.setEntries([entry]); const prepared = await prepare(f);
    await f.service.stage({ batchId: prepared.batchId, proposals: [proposal({ action: "update", memoryId: "m1", expectedRevision: 1 })] });
    f.setEntries([{ ...entry, revision: 2 }]);
    assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
    assert.equal(f.committed.length, 0);
    const other = fixture(); const batch = await prepare(other);
    await other.service.stage({ batchId: batch.batchId, proposals: [proposal()] });
    other.setMessages([user("u1", "复盘先结论，再给步骤，内容已经改变")]);
    assert.equal((await other.service.finalize({ status: "completed" })).ok, false);
    assert.equal(other.committed.length, 0);
  });
  it("rejects oversize source without clipping, and caps current-only conflict material", async () => {
    const huge = fixture([user("huge", "界".repeat(CONSOLIDATION_MATERIAL_MAX_BYTES))]);
    huge.service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    assert.equal((await huge.service.prepare({ mode: "incremental" })).ok, false);
    assert.equal(huge.committed.length, 0);
    const f = fixture(); f.setEntries(Array.from({ length: 25 }, (_, index) => ({ id: `m${index}`, text: "复盘先结论，再给步骤", enabled: false, revision: 1, history: [], scope: { kind: "workspace" } })));
    const prepared = await prepare(f);
    assert.equal(prepared.memories.length, 20);
    assert.equal(prepared.truncated, true);
    assert.ok(prepared.memories.every((entry) => !("history" in entry)));
    assert.ok(Buffer.byteLength(JSON.stringify(prepared)) <= CONSOLIDATION_MATERIAL_MAX_BYTES);
  });
  it("checks queue capacity before reading/model material and cancels before commit", async () => {
    const f = fixture(); f.setPending(64);
    assert.deepEqual(await f.service.canStart(), { ok: true, value: { canStart: false, pendingCount: 64 } });
    f.service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    assert.equal((await f.service.prepare({ mode: "incremental" })).ok, false);
    f.setPending(0); const prepared = await prepare(f);
    await f.service.stage({ batchId: prepared.batchId, proposals: [] });
    const aborted = new AbortController(); aborted.abort(new Error("cancelled"));
    await assert.rejects(f.service.finalize({ status: "completed" }, aborted.signal), /cancelled/);
    assert.equal(f.committed.length, 0);
  });
  it("combines up to four exact user quotes without treating the abstraction as verified truth", async () => {
    const f = fixture([user("u1", "复盘先结论"), user("u2", "然后给两条执行步骤")]);
    const batch = await prepare(f);
    const combined = { action: "add", text: "复盘先结论，再给两条执行步骤", reason: "两轮一致偏好", kind: "preference", recallTerms: ["总结格式", "回顾"],
      sources: [{ sourceMessageId: "u1", sourceQuote: "复盘先结论" }, { sourceMessageId: "u2", sourceQuote: "给两条执行步骤" }] };
    assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [combined] })).ok, true);
    assert.equal(f.committed.length, 0);
    assert.equal((await f.service.finalize({ status: "completed" })).ok, true);
    const draft = f.committed[0]!.candidates[0]!;
    assert.deepEqual(draft.sources?.map((source) => source.messageId), ["u1", "u2"]);
    assert.equal(draft.source.messageId, "u1");
    assert.ok(draft.change.operation === "add");
    assert.deepEqual(draft.change.recallTerms, ["总结格式", "回顾"]);
    assert.equal(draft.change.validTime, undefined, "Store creates unknown time, not an invented observation date");
  });
  it("rejects invalid multi-source provenance as a whole without advancing a cursor", async () => {
    const valid = { sourceMessageId: "u1", sourceQuote: "复盘先结论，再给步骤" };
    const bad = [
      { sources: [] }, { sources: Array(5).fill(valid) }, { sources: [valid, valid] },
      { sources: [valid, { sourceMessageId: "u2", sourceQuote: "没有这句话" }] },
      { sources: [valid], sourceQuote: "与第一来源不一致" },
      { sources: [{ ...valid, threadId: "foreign" }] },
    ];
    for (const extra of bad) {
      const f = fixture([user("u1", "复盘先结论，再给步骤"), user("u2", "另一个真实消息")]);
      const batch = await prepare(f);
      assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [proposal(), proposal(extra)] })).ok, false);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
      assert.equal(f.committed.length, 0);
      assert.equal(f.getCursor(), null);
    }
  });
  it("validates temporal/recall fields and never lets a model write recognition timestamps", async () => {
    const target: MemoryEntry = { id: "m1", text: "复盘先结论，再给步骤", revision: 1, enabled: true, status: "active" };
    const invalid = [
      { systemTime: { from: "2026-10-01T00:00:00Z", to: null } },
      { action: "change", memoryId: "m1", expectedRevision: 1, effectiveAt: "not-a-date" },
      { action: "correct", memoryId: "m1", expectedRevision: 1, effectiveAt: "2026-10-02T00:00:00Z" },
      { action: "change", memoryId: "m1", expectedRevision: 1, effectiveAt: "2026-10-02T00:00:00Z", validTime: { from: null, to: null, basis: "unknown" } },
    ];
    for (const extra of invalid) {
      const f = fixture(); f.setEntries([target]); const batch = await prepare(f);
      assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [proposal(extra)] })).ok, false);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
      assert.equal(f.getCursor(), null);
    }
    for (const extra of [
      { recallTerms: ["a", "b", "c", "d"] }, { recallTerms: ["界".repeat(33)] },
      { validTime: { from: "2026-02-30T00:00:00Z", to: null, basis: "explicit" } },
      { validTime: { from: "2026-10-01T00:00:00Z", to: null, basis: "unknown" } },
    ]) {
      const f = fixture(); const batch = await prepare(f);
      assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [proposal(extra)] })).ok, true);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, true);
      assert.deepEqual(f.committed[0]!.candidates[0]!.change, { operation: "add", text: "复盘先结论，再给步骤",
        kind: "note", scope: { kind: "workspace" }, expiresAt: null });
    }
    const f = fixture(); f.setEntries([target]); const batch = await prepare(f);
    assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [proposal({ action: "change", memoryId: "m1", expectedRevision: 1,
      kind: "preference", effectiveAt: "2026-10-02T08:00:00+08:00" })] })).ok, true);
    await f.service.finalize({ status: "completed" });
    const change = f.committed[0]!.candidates[0]!.change;
    assert.ok(change.operation === "change");
    assert.equal(change.effectiveAt, "2026-10-02T00:00:00.000Z");
  });
  it("withdraws disabled or expired provided targets without changing their contents", async () => {
    for (const action of ["retract", "disable"] as const) {
      const f = fixture(); f.setEntries([{ id: "m1", text: "复盘先结论，再给步骤", revision: 3, enabled: false, status: "disabled", expiresAt: "2020-01-01T00:00:00Z" }]);
      const batch = await prepare(f);
      const withdrawal = { action, memoryId: "m1", expectedRevision: 3, sourceMessageId: "u1", sourceQuote: "复盘先结论，再给步骤", reason: "用户明确撤回" };
      assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [withdrawal] })).ok, true);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, true);
      assert.deepEqual(f.committed[0]?.candidates[0]?.change, { operation: action, memoryId: "m1", expectedRevision: 3, text: "复盘先结论，再给步骤", expiresAt: "2020-01-01T00:00:00Z" });
      for (const extra of [{ text: "不允许替换正文" }, { recallTerms: ["别名"] }, { expiresAt: null }]) {
        const other = fixture(); other.setEntries([{ id: "m1", text: "复盘先结论，再给步骤", revision: 3, enabled: false }]);
        const prepared = await prepare(other);
        assert.equal((await other.service.stage({ batchId: prepared.batchId, proposals: [{ ...withdrawal, ...extra }] })).ok, false);
      }
    }
  });
  it("rechecks CAS for every target action and permits an administratively active future assertion", async () => {
    const target: MemoryEntry = { id: "m1", text: "复盘先结论，再给步骤", revision: 1, enabled: true, status: "active" };
    for (const action of ["update", "change", "correct", "retract", "disable"] as const) {
      const f = fixture(); f.setEntries([target]); const batch = await prepare(f);
      assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [proposal({ action, memoryId: "m1", expectedRevision: 1,
        ...(action === "change" ? { effectiveAt: "2026-10-02T00:00:00Z" } : {}) })] })).ok, true);
      f.setEntries([{ ...target, revision: 2 }]);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
      assert.equal(f.committed.length, 0);
    }
    const future = fixture(); future.setEntries([{ ...target, enabled: false }]); const batch = await prepare(future);
    assert.equal((await future.service.stage({ batchId: batch.batchId, proposals: [proposal({ action: "correct", memoryId: "m1", expectedRevision: 1 })] })).ok, true);
  });
  it("keeps fixed bounded conflict material and its temporal status without query ranking", async () => {
    const old = { ...createAssertion({ text: "复盘先结论，再给步骤", kind: "preference", sources: [{ kind: "manual" }] }, "a1", "2026-09-01T00:00:00Z"),
      systemTime: { from: "2026-09-01T00:00:00Z", to: "2026-09-20T00:00:00Z" } };
    const unrelated = createAssertion({ text: "数据库备份在周二", sources: [{ kind: "manual" }] }, "a2", "2026-09-20T00:00:00Z");
    const f = fixture(); f.setMaterial([{ id: "m1", text: "格式已经改变", enabled: true, status: "active", revision: 2,
      relatedAssertions: [old, unrelated], historyCoverage: "legacy_partial" }]);
    const batch = await prepare(f);
    assert.equal(batch.memories[0]?.text, "格式已经改变");
    assert.deepEqual(batch.memories[0]?.relatedAssertions?.map((assertion) => assertion.assertionId), ["a1", "a2"]);
    assert.equal(batch.memories[0]?.relatedAssertions?.[0]?.systemTime.to, "2026-09-20T00:00:00Z");
    assert.equal(batch.memories[0]?.historyCoverage, "legacy_partial");
    assert.equal(JSON.stringify(batch.memories).includes("数据库备份"), true);
  });
  it("finds later-turn conflict targets even after an earlier message exhausts one query budget", async () => {
    const old = createAssertion({ text: "复盘先给结论", kind: "preference", sources: [{ kind: "manual" }] }, "old-format", "2026-09-01T00:00:00Z");
    const f = fixture([user("long", "database ".repeat(600)), user("change", "复盘现在先讲背景，不再先给结论")]);
    f.setMaterial([
      { id: "old-format", text: "旧版格式", enabled: true, status: "active", revision: 2, relatedAssertions: [old], historyCoverage: "complete" },
      { id: "other-thread", text: "复盘先给结论", enabled: true, scope: { kind: "thread", threadId: "private" }, relatedAssertions: [], historyCoverage: "complete" },
      { id: "earlier", text: "database backup", enabled: true, relatedAssertions: [], historyCoverage: "complete" },
    ]);
    const batch = await prepare(f);
    assert.deepEqual(batch.memories.map(entry => entry.id), ["old-format", "earlier"]);
    assert.deepEqual(batch.memories[0]!.relatedAssertions!.map(assertion => assertion.assertionId), ["old-format"]);
    assert.equal(batch.memories[0]!.text, "旧版格式");
    assert.ok(Buffer.byteLength(JSON.stringify(batch.memories)) <= CONSOLIDATION_MEMORIES_MAX_BYTES);
    assert.equal(f.committed.length, 0);
    assert.equal(f.getCursor(), null);
  });
  it("bounds even large relevant history as whole assertions, retaining a target and truncation marker", async () => {
    const assertions = Array.from({ length: 40 }, (_, index) => createAssertion({ text: `复盘 ${"字".repeat(600)}`, sources: [{ kind: "manual" }] }, `a${index}`, "2026-09-01T00:00:00Z"));
    const f = fixture(); f.setMaterial([{ id: "m1", text: "已更改的偏好", enabled: true, revision: 2, relatedAssertions: assertions, historyCoverage: "complete" }]);
    const batch = await prepare(f);
    assert.equal(batch.memories.length, 1);
    assert.equal(batch.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(batch.memories)) <= CONSOLIDATION_MEMORIES_MAX_BYTES);
    assert.ok(batch.memories[0]!.relatedAssertions!.length > 0);
    assert.ok(batch.memories[0]!.relatedAssertions!.length < 40);
    assert.ok(batch.memories[0]!.relatedAssertions!.every((assertion) => assertion.text === `复盘 ${"字".repeat(600)}`));
  });
  it("hard-excludes program-marked messages from automatic and explicit material and evidence, not prefix hashing", async () => {
    const initial = [user("u1", "复盘先结论，再给步骤"), { ...user("secret", "复盘隐私不要整理"), metadata: { memoryConsolidation: "exclude" } }, user("u2", "复盘新说法")];
    const plain = initial.map((message) => ({ ...message, metadata: undefined }));
    assert.equal(consolidationPrefixHash(initial, "u2"), consolidationPrefixHash(plain, "u2"));
    for (const agent of [AUTO_CONSOLIDATION_AGENT_ID, "primary"]) {
      const f = fixture(initial); const batch = await prepare(f, agent);
      assert.equal(JSON.stringify(batch).includes("隐私"), false);
      assert.equal((await f.service.stage({ batchId: batch.batchId, proposals: [proposal({ sourceMessageId: "secret", sourceQuote: "复盘隐私不要整理" })] })).ok, false);
      assert.equal((await f.service.finalize({ status: "completed" })).ok, false);
      assert.equal(f.getCursor(), null);
    }
    const f = fixture(initial); const batch = await prepare(f);
    await f.service.stage({ batchId: batch.batchId, proposals: [], outcomes: noMemoryOutcomes(batch) }); await f.service.finalize({ status: "completed" });
    const more = Array.from({ length: 10 }, (_, index) => user(`new${index}`, "复盘待处理"));
    f.setMessages([...initial, ...more]);
    const next = await prepare(f);
    if (!("bootstrap" in next)) return assert.fail("expected incremental");
    assert.deepEqual(next.turns.map((turn) => turn.user.messageId), more.slice(0, 8).map((message) => message.id));
  });
});
