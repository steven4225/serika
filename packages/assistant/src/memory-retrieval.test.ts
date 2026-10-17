import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRetrievedMemoryContextMessage, placeCurrentMemoryReference, retrieveMemories, tokenizeMemoryQuery, rankMemoryEntriesForQuery, memorySemanticTextHash } from "./memory-retrieval.js";
import type { MemoryEntry } from "./memory-store.js";

const now = new Date("2026-10-01T00:00:00.000Z");
const memory = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, text, enabled: true, status: "active", scope: { kind: "workspace" }, revision: 1,
  updatedAt: "2026-09-30T00:00:00.000Z", ...extra,
});
const corpus = [
  memory("writing", "复盘先给一行结论，再列两条可执行步骤。"),
  memory("english", "Prefer concise reports and executable steps."),
  memory("unicode", "Use TypeScript for development."),
  memory("sleep", "睡眠时间是晚上十一点。"),
  memory("disabled", "复盘旧格式是五段。", { enabled: false, status: "disabled" }),
  memory("expired", "复盘临时要求。", { expiresAt: "2026-09-01T00:00:00.000Z" }),
  memory("private", "复盘私密要求。", { scope: { kind: "thread", threadId: "private" } }),
  memory("current-private", "开发使用 Rust。", { scope: { kind: "thread", threadId: "current" } }),
];
describe("minimal kind-aware retrieval ordering", () => {
  function typed(id: string, text: string, kind: "preference" | "fact" | "event" | "note", updatedAt: string): MemoryEntry {
    return memory(id, text, { updatedAt, assertion: { assertionId: `a:${id}`, kind, state: "asserted", recallTerms: [],
      validTime: { from: null, to: null, basis: "unknown" }, systemTime: { from: null, to: null }, sourceIds: [{ kind: "manual" }] } });
  }
  it("does not let equally matching recent events crowd out a current preference", () => {
    const preference = typed("current", "咖啡不加糖", "preference", "2026-09-01T00:00:00.000Z");
    const events = Array.from({ length: 15 }, (_, n) => typed(`event:${n}`, `咖啡记录 ${n}`, "event", "2026-09-30T00:00:00.000Z"));
    const selected = retrieveMemories([...events, preference], { query: "咖啡", now, maxEntries: 3 });
    assert.equal(selected.entries[0]?.id, "current");
    assert.equal(selected.entries.length, 3);
  });
  it("still puts a more relevant event ahead of a weaker preference", () => {
    const event = typed("event", "杭州咖啡节", "event", "2026-09-01T00:00:00.000Z");
    const preference = typed("preference", "咖啡不加糖", "preference", "2026-09-30T00:00:00.000Z");
    assert.equal(retrieveMemories([preference, event], { query: "杭州咖啡节", now }).entries[0]?.id, "event");
  });
  it("uses the same relevance tie-break for hybrid ranks without adding irrelevant facts", () => {
    const fact = typed("fact", "住在杭州", "fact", "2026-09-01T00:00:00.000Z");
    const event = typed("event", "杭州旅游", "event", "2026-09-30T00:00:00.000Z");
    const other = typed("other", "喜欢咖啡", "preference", "2026-09-30T00:00:00.000Z");
    const hits = [event, fact].map(entry => ({ id: entry.id, revision: 1, textHash: memorySemanticTextHash(entry.text), score: 0.8 }));
    const selected = retrieveMemories([event, fact, other], { query: "杭州", now, semanticHits: hits, maxEntries: 1 });
    assert.equal(selected.entries[0]?.id, "fact");
    assert.ok(!selected.entries.some(entry => entry.id === "other"));
  });
});
describe("hybrid Memory selection", () => {
  const hit = (entry: MemoryEntry, score = 1) => ({ id: entry.id, revision: entry.revision ?? 1, textHash: memorySemanticTextHash(entry.text), score });
  it("fuses lexical and semantic ranks while preserving exact named facts", () => {
    const exact = memory("named", "Serika 使用 TypeScript"), related = memory("related", "复盘先给结论"), irrelevant = memory("other", "晚饭七点");
    const selection = retrieveMemories([exact, related, irrelevant], { query: "Serika", now, semanticHits: [hit(related), hit(exact, 0.9)] });
    assert.deepEqual(selection.entries.map(entry => entry.id), ["named", "related"]);
    assert.deepEqual(selection.selected.map(reference => reference.reason), ["hybrid", "semantic"]);
  });
  it("does not turn invalid, below-threshold or duplicate semantic hints into filler", () => {
    const entry = memory("writing", "复盘先给结论");
    for (const semanticHits of [[hit(entry, 0.49)], [hit(entry, NaN)], [hit(entry, Infinity)], [{ ...hit(entry), revision: 0 }], [{ ...hit(entry), textHash: "fake" }]]) {
      assert.deepEqual(retrieveMemories([entry], { query: "回顾", now, semanticHits }).entries, []);
    }
    assert.deepEqual(retrieveMemories([entry], { query: "回顾", now, semanticHits: [hit(entry), hit(entry)] }).entries.map(item => item.id), ["writing"]);
  });
  it("shares a lower serialized budget without changing pinned priority or clipping text", () => {
    const entries = Array.from({ length: 12 }, (_, n) => memory(String(n), "复盘 " + "汉字".repeat(200)));
    const pin = memory("pin", "pinned unrelated", { pinned: true });
    const selected = retrieveMemories([pin, ...entries], { query: "回顾", now, maxBytes: 6144, semanticHits: entries.map(entry => hit(entry)) });
    assert.equal(selected.entries[0]?.id, "pin");
    assert.ok(selected.bytes <= 6144);
    assert.ok(selected.entries.length < 12);
    assert.equal(selected.bytes, Buffer.byteLength(JSON.stringify(createRetrievedMemoryContextMessage(selected)), "utf8"));
    assert.ok(selected.entries.slice(1).every(entry => entry.text === entries[0]?.text));
  });
});
const evalCases: Array<{ name: string; query: string; expected: string[]; forbidden?: string[]; threadId?: string; semanticBoundary?: boolean; entries?: MemoryEntry[] }> = [
  { name: "direct Chinese", query: "复盘", expected: ["writing"] },
  { name: "Chinese question", query: "我复盘偏好的格式是什么？", expected: ["writing"] },
  { name: "Chinese phrase", query: "一行结论", expected: ["writing"] },
  { name: "Chinese second step", query: "可执行步骤", expected: ["writing"] },
  { name: "English direct", query: "reports", expected: ["english"] },
  { name: "English case", query: "REPORTS", expected: ["english"] },
  { name: "English question", query: "What reports do I prefer?", expected: ["english"] },
  { name: "English punctuation", query: "reports!!!", expected: ["english"] },
  { name: "English complete words", query: "port", expected: [] },
  { name: "Unicode compatibility", query: "ＴｙｐｅＳｃｒｉｐｔ", expected: ["unicode"] },
  { name: "unrelated Chinese", query: "天气预报", expected: [] },
  { name: "unrelated English", query: "weather forecast", expected: [] },
  { name: "empty", query: "", expected: [] },
  { name: "whitespace", query: " \n ", expected: [] },
  { name: "English stop terms", query: "please tell me what I should do", expected: [] },
  { name: "Chinese stop terms", query: "请问什么", expected: [] },
  { name: "expiry exclusion", query: "临时要求", expected: [], forbidden: ["expired"] },
  { name: "disabled exclusion", query: "旧格式", expected: [], forbidden: ["disabled"] },
  { name: "private exclusion", query: "私密要求", expected: [], forbidden: ["private"] },
  { name: "same Thread", query: "Rust", threadId: "current", expected: ["current-private"] },
  { name: "worker no Thread", query: "Rust", expected: [], forbidden: ["current-private"] },
  { name: "different Thread", query: "Rust", threadId: "other", expected: [], forbidden: ["current-private"] },
  { name: "strong Chinese synonym boundary", query: "回顾要怎么组织内容？", expected: [], semanticBoundary: true },
  { name: "strong English synonym boundary", query: "brief retrospective layout", expected: [], semanticBoundary: true },
  { name: "pin selected without lexical match", query: "weather", entries: [memory("pin", "writing style", { pinned: true })], expected: ["pin"] },
  { name: "disabled pin excluded", query: "", entries: [memory("pin", "writing style", { pinned: true, enabled: false })], expected: [], forbidden: ["pin"] },
  { name: "current revision never searches old history", query: "Python", entries: [memory("new", "Use TypeScript", { revision: 2, history: [{ revision: 1, text: "Use Python", status: "active", scope: { kind: "workspace" }, expiresAt: null, source: { kind: "manual" }, changedAt: now.toISOString() }] })], expected: [], forbidden: ["new"] },
  { name: "oversize selected match skipped without clipping", query: "reports", entries: [memory("large", "reports" + "\"".repeat(5000)), memory("small", "reports brief")], expected: ["small"], forbidden: ["large"] },
];

describe("fixed lexical Memory Eval (28 cases; semantic paraphrase misses are explicit)", () => {
  for (const test of evalCases) it(test.name, () => {
    const selection = retrieveMemories(test.entries ?? corpus, { query: test.query, now, ...(test.threadId ? { threadId: test.threadId } : {}) });
    const ids = selection.entries.map((entry) => entry.id);
    assert.deepEqual(ids, test.expected);
    for (const id of test.forbidden ?? ["disabled", "expired", "private"]) assert.ok(!ids.includes(id));
    assert.ok(selection.bytes <= 8192);
  });
});

describe("Memory retrieval invariants", () => {
  it("uses current versions only and injects neither history nor source quotes", () => {
    const entry = memory("x", "new preference", { revision: 2, source: { kind: "conversation", threadId: "current", messageId: "source", quote: "secret-source-quote" }, history: [{ revision: 1, text: "old preference", status: "active", scope: { kind: "workspace" }, expiresAt: null, source: { kind: "manual" }, changedAt: now.toISOString() }] });
    const selection = retrieveMemories([entry], { query: "preference", now });
    assert.equal(selection.entries[0]?.history, undefined);
    const serialized = JSON.stringify(createRetrievedMemoryContextMessage(selection));
    assert.ok(!serialized.includes("old preference"));
    assert.ok(!serialized.includes("secret-source-quote"));
    assert.equal(selection.selected[0]?.revision, 2);
  });

  it("returns an explicit bounded empty reference, not an empty-store claim", () => {
    const selection = retrieveMemories(corpus, { query: "unrelated", now });
    const message = createRetrievedMemoryContextMessage(selection);
    assert.equal(message.id, "runloom-workspace-memory");
    assert.equal(selection.eligibleCount, 4);
    assert.match(JSON.stringify(message), /No matching Memory entries/);
    assert.match(JSON.stringify(message), /does not mean the store is empty/);
  });

  it("identifies a fresh nonempty snapshot independently of earlier empty-selection replies", () => {
    const selection = retrieveMemories([memory("restored", "reports in three steps", { revision: 4 })], { query: "reports", now });
    const message = createRetrievedMemoryContextMessage(selection);
    const text = message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    assert.match(text, /selectedCount=1/);
    assert.ok(text.includes(`validAt=${now.toISOString()}`));
    assert.match(text, /earlier 'selected entries: \[\]' claim cannot override/);
    assert.match(text, /"id":"restored","revision":4/);
    assert.equal(selection.bytes, Buffer.byteLength(JSON.stringify(message), "utf8"));
    assert.ok(selection.bytes <= 8192);
  });

  it("places the same bounded snapshot after old answers and before this question, without changing tool pairs", () => {
    const reference = createRetrievedMemoryContextMessage(retrieveMemories([memory("restored", "reports")], { query: "reports", now }));
    const old = { id: "old", role: "assistant" as const, parts: [{ type: "text" as const, text: "Earlier selected entries: []" }] };
    const question = { id: "current", role: "user" as const, parts: [{ type: "text" as const, text: "reports?" }] };
    const input = [reference, old, question];
    const output = placeCurrentMemoryReference(input, question.id);
    assert.deepEqual(output.map(message => message.id), [old.id, reference.id, question.id]);
    assert.equal(output[1], reference);
    assert.equal(Buffer.byteLength(JSON.stringify(output)), Buffer.byteLength(JSON.stringify(input)));
    assert.deepEqual(input.map(message => message.id), [reference.id, old.id, question.id]);
    const call = { ...old, id: "tool-call" }, response = { ...old, id: "tool-result" };
    assert.deepEqual(placeCurrentMemoryReference([reference, old, call, response], "compacted-current").map(message => message.id), [old.id, call.id, response.id, reference.id]);
  });

  it("pins at most two by deterministic recency and ID, empty query does not fill", () => {
    const entries = [memory("b", "pinned B", { pinned: true }), memory("a", "pinned A", { pinned: true }), memory("new", "pinned new", { pinned: true, updatedAt: now.toISOString() }), memory("z", "other")];
    const selected = retrieveMemories(entries, { query: "", now });
    assert.deepEqual(selected.entries.map((entry) => entry.id), ["new", "a"]);
    assert.equal(selected.truncated, true);
    assert.ok(selected.selected.every((item) => item.reason === "pinned"));
  });

  it("overflow pins may compete as regular matches", () => {
    const entries = Array.from({ length: 3 }, (_, i) => memory(String(i), "reports", { pinned: true }));
    const result = retrieveMemories(entries, { query: "reports", now });
    assert.deepEqual(result.selected.map((item) => item.reason), ["pinned", "pinned", "matched"]);
    assert.equal(result.truncated, true);
  });

  it("pin byte budget uses serialized reference, not raw body lengths", () => {
    const entries = [memory("a", "\"".repeat(2000), { pinned: true }), memory("b", "small", { pinned: true })];
    const result = retrieveMemories(entries, { query: "", now });
    assert.deepEqual(result.entries.map((entry) => entry.id), ["b"]);
    assert.equal(result.truncated, true);
  });

  it("orders exact phrase before coverage, then recency and stable ID", () => {
    const entries = [memory("recent", "alpha separate beta gamma", { updatedAt: now.toISOString() }), memory("exact", "alpha beta gamma", { updatedAt: "2020-01-01T00:00:00.000Z" }), memory("b", "alpha"), memory("a", "alpha")];
    assert.deepEqual(retrieveMemories(entries, { query: "alpha beta", now }).entries.map((entry) => entry.id), ["exact", "recent", "a", "b"]);
  });

  it("caps 12 matches and marks omitted matches", () => {
    const result = retrieveMemories(Array.from({ length: 20 }, (_, i) => memory(String(i).padStart(2, "0"), "reports")), { query: "reports", now });
    assert.equal(result.entries.length, 12);
    assert.equal(result.truncated, true);
  });

  it("continues after oversized matches to admit smaller subsequent items", () => {
    // One escaped entry plus current-reference bookkeeping fits; two still do not.
    const result = retrieveMemories([memory("a", "reports " + "\"".repeat(1600)), memory("b", "reports " + "\"".repeat(1600)), memory("c", "reports small")], { query: "reports", now });
    assert.deepEqual(result.entries.map((entry) => entry.id), ["a", "c"]);
    assert.equal(result.truncated, true);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(createRetrievedMemoryContextMessage(result)), "utf8"));
    assert.ok(result.bytes <= 8192);
  });

  it("counts multibyte and JSON escaping in actual final reference", () => {
    const result = retrieveMemories(Array.from({ length: 20 }, (_, i) => memory(String(i), "复盘 " + "汉字\n\"".repeat(150))), { query: "复盘", now });
    assert.ok(result.bytes <= 8192);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(createRetrievedMemoryContextMessage(result)), "utf8"));
    assert.ok(result.entries.length < 12);
  });

  it("clips queries at complete Unicode boundaries without changing stored text", () => {
    const query = "复盘" + "😀".repeat(1100);
    const tokenized = tokenizeMemoryQuery(query);
    assert.equal(tokenized.queryTruncated, true);
    assert.ok(Buffer.byteLength(tokenized.normalizedQuery, "utf8") <= 4096);
    assert.ok(!tokenized.normalizedQuery.includes("�"));
    assert.equal(retrieveMemories(corpus, { query, now }).queryTruncated, true);
  });

  it("never mutates caller entries or array", () => {
    const entries = [Object.freeze(memory("a", "reports")), Object.freeze(memory("b", "reports"))];
    Object.freeze(entries);
    assert.equal(retrieveMemories(entries, { query: "reports", now }).entries.length, 2);
  });

  it("shared conflict ordering does not apply active-only eligibility", () => {
    assert.deepEqual(rankMemoryEntriesForQuery(corpus, "旧格式").map((entry) => entry.id), ["disabled"]);
  });
});
