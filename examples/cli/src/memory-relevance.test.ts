import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createMemoryRelevanceSelector, parseMemoryRelevance, prepareMemoryRelevanceCandidates } from "./memory-relevance.js";
import { memorySemanticTextHash } from "./memory-retrieval.js";
import type { MemoryEntry } from "./memory-store.js";

const now = new Date("2026-10-14T04:00:00Z");
const entry = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, text, enabled: true, status: "active", revision: 1, scope: { kind: "workspace" }, ...extra,
});
const style = entry("style", "复盘先给一行结论，再列两条可执行步骤。");
const hit = (fact: MemoryEntry, score = .4588) => ({ id: fact.id, revision: fact.revision ?? 1, textHash: memorySemanticTextHash(fact.text), score });
const input = () => ({ now, threadId: "current", signal: new AbortController().signal, semanticCandidates: [hit(style)] });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const response = (text = '{"selectedIds":["style"],"queries":["复盘格式"]}') => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] });

test("relevance pool includes validated below-threshold paraphrases, never foreign/disabled/history or arbitrary filler", () => {
  const foreign = entry("foreign", "复盘私密", { scope: { kind: "thread", threadId: "other" } });
  const disabled = entry("disabled", "复盘旧内容", { enabled: false, status: "disabled" });
  const pool = prepareMemoryRelevanceCandidates([style, foreign, disabled, entry("noise", "晚饭七点")], "回顾过去一周应该怎样组织内容？", {
    ...input(), semanticCandidates: [hit(style), hit(foreign, .99), hit(disabled, .99), { ...hit(style), revision: 9, score: .99 }],
  });
  assert.deepEqual(pool.candidates.map(item => item.id), ["style"]);
  assert.equal(pool.candidates[0]?.text, style.text);
  assert.deepEqual(Object.keys(pool.candidates[0]!).sort(), ["id", "revision", "text", "textHash"]);
});

test("pool bounds whole facts and interleaves raw vectors with lexical matches", () => {
  const facts = Array.from({ length: 40 }, (_, index) => entry(`e${index}`, `咖啡 ${"x".repeat(500)}`));
  const pool = prepareMemoryRelevanceCandidates([...facts, style], "咖啡", { ...input(), semanticCandidates: [hit(style)] });
  assert.equal(pool.candidates[1]?.id, "style");
  assert.ok(pool.candidates.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(pool.candidates)) <= 12 * 1024);
  assert.equal(pool.truncated, true);
  const huge = entry("huge", "咖啡" + "x".repeat(13000));
  assert.deepEqual(prepareMemoryRelevanceCandidates([huge], "咖啡", input()).candidates, []);
});

test("strict relevance parser rejects fabricated IDs, duplicate IDs, extra fields and incomplete/unbounded output", () => {
  const candidates = [hit(style)];
  assert.deepEqual(parseMemoryRelevance('{"selectedIds":[],"queries":[]}', candidates), { selected: [], queries: [] });
  for (const text of ['{}', '{"selectedIds":["foreign"],"queries":[]}', '{"selectedIds":["style","style"],"queries":[]}',
    '{"selectedIds":[],"queries":[],"facts":[]}', '{"selectedIds":[],"queries":[""]}', "x".repeat(4097),
    JSON.stringify({ selectedIds: [], queries: ["x".repeat(97)] }), '{"selectedIds":null,"queries":[]}']) {
    assert.throws(() => parseMemoryRelevance(text, candidates));
  }
});

test("one bounded read-only call is shared while in flight and reused after fact changes; changed query cannot recall again", async () => {
  let calls = 0;
  const selector = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: async options => {
    calls++;
    assert.equal(options.tools, undefined);
    assert.equal(options.maxOutputTokens, 768);
    assert.match(JSON.stringify(options.prompt), /mere shared topic is insufficient/i);
    assert.doesNotMatch(JSON.stringify(options.prompt), /private-secret/);
    return response();
  } }));
  const [a, b] = await Promise.all([selector("one", "回顾", [style], input()), selector("one", "回顾", [style], input())]);
  assert.deepEqual(a, b);
  assert.equal(a.state, "succeeded");
  a.selected.length = 0;
  const cached = await selector("one", "回顾", [{ ...style, revision: 2, text: "新内容" }], input());
  assert.equal(cached.selected[0]?.revision, 1);
  assert.equal((await selector("one", "不同问题", [style], input())).state, "degraded");
  assert.equal(calls, 1);
});

test("empty pool has no inference call; malformed result degrades and never retries", async () => {
  let calls = 0;
  const selector = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: async () => { calls++; return response("invalid"); } }));
  assert.equal((await selector("empty", "天气", [entry("noise", "晚饭七点")], { ...input(), semanticCandidates: [] })).state, "not_applicable");
  assert.equal(calls, 0);
  assert.equal((await selector("one", "回顾", [style], input())).state, "degraded");
  await selector("one", "回顾", [style], input());
  assert.equal(calls, 1);
});

test("deadline bounds noncooperative inference; cancelled caller throws and late results cannot publish", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  let calls = 0;
  const selector = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: () => { calls++; return new Promise(resolve => { finish = resolve; }); } }), 15);
  assert.equal((await selector("timeout", "回顾", [style], input())).state, "degraded");
  finish(response());
  assert.equal((await selector("timeout", "回顾", [style], input())).state, "degraded");
  assert.equal(calls, 1);
  const controller = new AbortController();
  const cancel = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: () => new Promise(() => {}) }));
  const pending = cancel("cancel", "回顾", [style], { ...input(), signal: controller.signal });
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/);
  assert.equal((await cancel("cancel", "回顾", [style], input())).state, "degraded");
});

test("a secondary waiter can cancel without repeating or cancelling the owner's bounded call", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  let calls = 0;
  const selector = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } }));
  const owner = selector("one", "回顾", [style], input());
  const controller = new AbortController();
  const follower = selector("one", "回顾", [style], { ...input(), signal: controller.signal });
  controller.abort(new Error("follower stopped"));
  await assert.rejects(follower, /follower stopped/);
  // Provider dispatch starts asynchronously through the SDK.
  await new Promise(resolve => setImmediate(resolve));
  finish(response());
  assert.equal((await owner).state, "succeeded");
  assert.equal(calls, 1);
});

test("provider failure has no automatic retry or raw upstream error in the result", async () => {
  let calls = 0;
  const selector = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: async () => {
    calls++; throw new Error("upstream private credentials");
  } }));
  const result = await selector("one", "回顾", [style], input());
  assert.equal(result.state, "degraded");
  assert.doesNotMatch(JSON.stringify(result), /credentials/);
  assert.equal(calls, 1);
});

test("captured MR10/11/12: prompt distinguishes bare-topic recall from a specific general-knowledge question without host keyword exceptions", async () => {
  const selector = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: async options => {
    const system = JSON.stringify(options.prompt.filter(message => message.role === "system"));
    assert.match(system, /bare topic or category/);
    assert.match(system, /preserve all distinct scenes/);
    assert.match(system, /does not apply to a complete question/);
    return response('{"selectedIds":["style"],"queries":[]}');
  } }));
  assert.equal((await selector("topic", "复盘", [style], input())).state, "succeeded");
});

// These fixtures verify the request contract and output wiring, not model semantic accuracy.
test("content relevance request separates general-knowledge answers from response style while retaining explicit preference and topic recall", async () => {
  const language = entry("language", "请默认用简体中文回复。");
  const tone = entry("tone", "回答尽量简短。");
  const breakfast = entry("breakfast", "工作日早餐吃燕麦。");
  const weekend = entry("weekend", "休息日早餐吃面包。");
  const facts = [language, tone, style, breakfast, weekend];
  const cases = [
    { question: "为什么月亮会有阴晴圆缺？", selectedIds: [] },
    { question: "解释 TCP 三次握手的原理。", selectedIds: [] },
    { question: "光合作用需要哪些条件？", selectedIds: [] },
    { question: "我要求你用什么语言回答？", selectedIds: ["language"] },
    { question: "我希望复盘怎么组织内容？", selectedIds: ["style"] },
    { question: "早餐", selectedIds: ["breakfast", "weekend"] },
  ];
  let calls = 0;
  const selector = createMemoryRelevanceSelector(new MockLanguageModelV3({ doGenerate: async options => {
    const fixture = cases[calls++]!;
    const system = JSON.stringify(options.prompt.filter(message => message.role === "system"));
    assert.match(system, /selectedIds is content relevance, not response personalization/);
    assert.match(system, /language, tone, length or formatting alone/);
    assert.match(system, /explicitly asks about their saved communication preferences/);
    assert.match(system, /bare topic or category/);
    assert.match(system, /preserve all distinct scenes/);
    assert.equal(options.tools, undefined);
    const user = options.prompt.find(message => message.role === "user");
    assert.ok(JSON.stringify(user).includes(fixture.question));
    return response(JSON.stringify({ selectedIds: fixture.selectedIds, queries: [] }));
  } }));
  for (const [index, fixture] of cases.entries()) {
    const result = await selector(`content-boundary-${index}`, fixture.question, facts, {
      ...input(), semanticCandidates: facts.map(fact => hit(fact)),
    });
    assert.equal(result.state, "succeeded");
    assert.deepEqual(result.selected.map(item => item.id), fixture.selectedIds);
  }
  assert.equal(calls, cases.length);
});
