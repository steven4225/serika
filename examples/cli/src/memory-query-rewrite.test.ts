import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createMemoryQueryRewriter, parseMemoryQueries } from "./memory-query-rewrite.js";
import { retrieveMemories } from "./memory-retrieval.js";
import type { MemoryEntry } from "./memory-store.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
describe("bounded opt-in Memory query rewrite", () => {
  it("accepts only phrases, never extra facts or unbounded output", () => {
    assert.deepEqual(parseMemoryQueries('{"queries":["复盘格式","复盘格式"]}'), ["复盘格式"]);
    for (const value of ['{}', '{"queries":[],"facts":[]}', '{"queries":[null]}', '{"queries":[""]}', JSON.stringify({ queries: ["a".repeat(97)] }), JSON.stringify({ queries: ["a", "b", "c", "d"] }), '```json\n{"queries":[]}\n```', "a".repeat(1025)]) assert.throws(() => parseMemoryQueries(value));
  });
  it("sends only a clipped question, caches once per message, exposes degradation, and has no tools or retries", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async options => {
      calls++;
      assert.equal(options.tools, undefined);
      assert.equal(options.maxOutputTokens, 256);
      assert.ok(Buffer.byteLength(JSON.stringify(options.prompt)) < 8000);
      return { content: [{ type: "text", text: calls === 1 ? '{"queries":["复盘格式"]}' : 'invalid' }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    } });
    const rewrite = createMemoryQueryRewriter(model);
    const signal = new AbortController().signal;
    assert.deepEqual(await rewrite("one", "回顾怎么写", signal), { state: "succeeded", queries: ["复盘格式"] });
    await rewrite("one", "回顾怎么写", signal);
    assert.equal(calls, 1);
    assert.deepEqual(await rewrite("two", "x".repeat(8000), signal), { state: "degraded", queries: [] });
    await rewrite("two", "x".repeat(8000), signal);
    assert.equal(calls, 2);
  });
  it("timeout degrades but caller cancellation aborts even with a non-cooperative provider", async () => {
    const model = new MockLanguageModelV3({ doGenerate: () => new Promise(() => {}) });
    const keepAlive = setTimeout(() => {}, 500);
    try {
      assert.deepEqual(await createMemoryQueryRewriter(model, 15)("one", "reports", new AbortController().signal), { state: "degraded", queries: [] });
      const controller = new AbortController();
      const promise = createMemoryQueryRewriter(model)("two", "reports", controller.signal);
      controller.abort(new Error("user stopped"));
      await assert.rejects(promise, /user stopped/);
    } finally { clearTimeout(keepAlive); }
  });
});

const now = new Date("2026-10-04T00:00:00Z");
const entry = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({ id, text, enabled: true, status: "active", scope: { kind: "workspace" }, revision: 1, ...extra });
const entries = [entry("writing", "复盘先给一行结论，再列两条可执行步骤。"), entry("sleep", "睡眠时间为晚上十一点"), entry("private", "复盘私密", { scope: { kind: "thread", threadId: "private" } }), entry("disabled", "复盘旧格式", { enabled: false, status: "disabled" }), entry("expired", "复盘临时", { expiresAt: "2026-10-01T00:00:00Z" })];
describe("fixed before/after recall cases (rewrite output is a fixture, not real model quality)", () => {
  for (const test of [
    { query: "复盘", rewrite: [], before: ["writing"], after: ["writing"] },
    { query: "回顾要怎样组织内容？", rewrite: ["复盘格式"], before: [], after: ["writing"] },
    { query: "brief retrospective layout", rewrite: ["复盘结构"], before: [], after: ["writing"] },
    { query: "天气预报", rewrite: ["明天天气"], before: [], after: [] },
    { query: "部署日志", rewrite: ["服务部署日志"], before: [], after: [] },
  ]) it(test.query, () => {
    assert.deepEqual(retrieveMemories(entries, { query: test.query, now }).selected.map(item => item.id), test.before);
    const selection = retrieveMemories(entries, { query: test.query, now, rewrittenQueries: test.rewrite });
    assert.deepEqual(selection.selected.map(item => item.id), test.after);
    if (!test.before.length && test.after.length) assert.equal(selection.selected[0]?.reason, "rewritten");
    assert.ok(selection.bytes <= 8192);
  });
  it("does not hide a false positive produced by a bad paraphrase", () => {
    const selection = retrieveMemories(entries, { query: "天气预报", now, rewrittenQueries: ["复盘"] });
    assert.deepEqual(selection.selected.map(item => item.id), ["writing"]); // lexical filtering is not a semantic correctness guarantee
    assert.equal(selection.selected[0]?.reason, "rewritten");
  });
  it("keeps original matches ahead of expansion, filters scope/expiry, and reads only current versions", () => {
    const changed = [entry("new", "Use TypeScript", { revision: 2 }), entry("old", "复盘", { status: "disabled", enabled: false })];
    assert.equal(retrieveMemories(changed, { query: "Python", now, rewrittenQueries: ["Python"] }).entries.length, 0);
    assert.deepEqual(retrieveMemories(entries, { query: "睡眠", now, rewrittenQueries: ["复盘"] }).selected.map(item => item.id), ["sleep", "writing"]);
  });
});
