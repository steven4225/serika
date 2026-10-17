import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createRetrievedMemoryContextMessage, retrieveMemories } from "./memory-retrieval.js";
import { createMemoryQueryRewriter, type MemoryReferenceSnapshot } from "./memory-query-rewrite.js";
import type { MemoryEntry } from "./memory-store.js";

const now = new Date("2026-10-04T00:00:00.000Z");
type Assertion = NonNullable<MemoryEntry["assertion"]>;
function memory(id: string, text: string, assertion: Partial<Assertion> = {}, fields: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id, text, revision: 2, enabled: true, status: "active", scope: { kind: "workspace" },
    updatedAt: "2026-10-03T00:00:00.000Z",
    assertion: {
      assertionId: `assertion-${id}`, kind: "preference", recallTerms: [], state: "asserted",
      validTime: { from: "2026-09-01T00:00:00.000Z", to: null, basis: "explicit" },
      systemTime: { from: "2026-09-02T00:00:00.000Z", to: null },
      sourceIds: [{ kind: "conversation", threadId: "origin", messageId: "source-message" }],
      ...assertion,
    },
    ...fields,
  };
}

describe("approved recall terms and current temporal Memory references", () => {
  it("recalls approved paraphrases without inventing matches for unrelated questions", () => {
    const entry = memory("writing", "复盘先给一行结论，再列两条可执行步骤。", { recallTerms: ["回顾内容组织", "brief retrospective layout"] });
    for (const query of ["回顾怎样组织内容？", "brief retrospective layout"]) {
      const result = retrieveMemories([entry], { query, now });
      assert.deepEqual(result.selected.map(({ id, reason }) => ({ id, reason })), [{ id: "writing", reason: "recall_term" }]);
    }
    assert.deepEqual(retrieveMemories([entry], { query: "天气预报", now }).selected, []);
  });

  it("ranks original bodies before approved terms, then rewritten bodies and terms", () => {
    const entries = [
      memory("terms", "one-line conclusion then two steps", { recallTerms: ["retrospective layout"] }),
      memory("body", "retrospective layout is concise", {}, { updatedAt: "2020-01-01T00:00:00.000Z" }),
      memory("rewrite-body", "复盘格式先结论"),
      memory("rewrite-terms", "write two actions", { recallTerms: ["复盘结构"] }),
    ];
    const result = retrieveMemories(entries, { query: "retrospective layout", now, rewrittenQueries: ["复盘"] });
    assert.deepEqual(result.selected.map(({ id, reason }) => [id, reason]), [
      ["body", "matched"], ["terms", "recall_term"], ["rewrite-body", "rewritten"], ["rewrite-terms", "rewritten"],
    ]);
  });

  it("retains pin priority without allowing pins to bypass temporal filtering", () => {
    const entries = [
      memory("pin", "unrelated pinned preference", {}, { pinned: true }),
      memory("closed-pin", "reports", { systemTime: { from: "2026-09-01T00:00:00.000Z", to: now.toISOString() } }, { pinned: true }),
      memory("matched", "reports"),
    ];
    assert.deepEqual(retrieveMemories(entries, { query: "reports", now }).selected.map(({ id, reason }) => [id, reason]), [
      ["pin", "pinned"], ["matched", "matched"],
    ]);
  });

  it("filters state facts on half-open valid/system intervals and keeps event/note dates separate from expiry", () => {
    const ended = { from: "2026-09-01T00:00:00.000Z", to: now.toISOString(), basis: "explicit" as const };
    const future = { from: "2026-10-05T00:00:00.000Z", to: null, basis: "explicit" as const };
    const entries = [
      memory("current", "reports current", { validTime: { ...ended, from: now.toISOString(), to: null } }),
      memory("old-fact", "reports obsolete", { kind: "fact", validTime: ended }),
      memory("future-preference", "reports future", { validTime: future }),
      memory("old-system", "reports previous knowledge", { systemTime: { from: "2026-09-01T00:00:00.000Z", to: now.toISOString() } }),
      memory("future-system", "reports not known yet", { systemTime: { from: future.from, to: null } }),
      memory("retracted", "reports withdrawn", { state: "retracted" }),
      memory("event", "reports event happened", { kind: "event", validTime: ended }),
      memory("future-event", "reports planned appointment", { kind: "event", validTime: future }),
      memory("note", "reports dated note", { kind: "note", validTime: ended }),
      memory("expired-event", "reports event expired", { kind: "event", validTime: ended }, { expiresAt: now.toISOString() }),
      memory("disabled", "reports disabled", {}, { enabled: false, status: "disabled" }),
      memory("private", "reports private", {}, { scope: { kind: "thread", threadId: "other" } }),
    ];
    assert.deepEqual(retrieveMemories(entries, { query: "reports", now }).selected.map(({ id }) => id), ["current", "event", "future-event", "note"]);
    assert.equal(retrieveMemories(entries, { query: "reports", now }).eligibleCount, 4);
  });

  it("rejects malformed assertion dates, states and unbounded lookup phrases rather than injecting stale facts", () => {
    const entries = [
      memory("calendar", "reports", { validTime: { from: "2026-02-30T00:00:00Z", to: null, basis: "explicit" } }),
      memory("local", "reports", { systemTime: { from: "2026-09-01T00:00:00", to: null } }),
      memory("inverted", "reports", { systemTime: { from: "2026-10-03T00:00:00Z", to: "2026-10-02T00:00:00Z" } }),
      memory("large-term", "reports", { recallTerms: ["x".repeat(97)] }),
      memory("many-terms", "reports", { recallTerms: ["a", "b", "c", "d"] }),
      memory("no-source", "reports", { sourceIds: [] }),
      memory("unknown-time", "reports accepted legacy uncertainty", { validTime: { from: null, to: null, basis: "unknown" }, systemTime: { from: null, to: null } }),
    ];
    assert.deepEqual(retrieveMemories(entries, { query: "reports", now }).selected.map(({ id }) => id), ["unknown-time"]);
  });

  it("injects actual assertion/time/source identities but not lookup terms, quotes, histories or old text", () => {
    const entry = memory("writing", "Write a conclusion then two steps.", { recallTerms: ["retrospective layout"] }, {
      source: { kind: "conversation", threadId: "origin", messageId: "source-message", quote: "SECRET EXACT QUOTE" },
      history: [{ revision: 1, text: "OBSOLETE FIVE PARAGRAPHS", status: "active", scope: { kind: "workspace" }, expiresAt: null, source: { kind: "manual" }, changedAt: "2026-09-01T00:00:00Z" }],
    });
    const result = retrieveMemories([entry], { query: "retrospective layout", now });
    const message = createRetrievedMemoryContextMessage(result);
    const reference: MemoryReferenceSnapshot = {
      messageId: "question", preparedAt: now.toISOString(), temporalView: result.temporalView,
      selected: result.selected.map((item) => ({ ...item, text: result.entries.find((value) => value.id === item.id)!.text })),
      truncated: result.truncated, queryTruncated: result.queryTruncated, rewrite: "off",
    };
    for (const serialized of [JSON.stringify(message), JSON.stringify(reference)]) {
      assert.ok(serialized.includes("assertion-writing"));
      assert.ok(serialized.includes("source-message"));
      assert.ok(!serialized.includes("SECRET EXACT QUOTE"));
      assert.ok(!serialized.includes("OBSOLETE FIVE PARAGRAPHS"));
      assert.ok(!serialized.includes("retrospective layout"));
      assert.ok(!serialized.includes("recallTerms"));
    }
    assert.deepEqual(reference.temporalView, { validAt: now.toISOString(), knownAt: now.toISOString() });
    assert.equal(reference.selected[0]?.reason, "recall_term");
    assert.equal(reference.selected[0]?.assertion?.assertionId, "assertion-writing");
    assert.equal(reference.selected[0]?.revision, 2);
  });

  it("uses actual serialized provenance cost for final and pinned budgets without clipping a fact", () => {
    const entries = Array.from({ length: 20 }, (_, index) => memory(String(index).padStart(2, "0"), "reports " + "汉字\n\"".repeat(90), {}, { pinned: index < 3 }));
    const result = retrieveMemories(entries, { query: "reports", now });
    assert.ok(result.entries.length <= 12);
    assert.ok(result.entries.length < entries.length);
    assert.equal(result.truncated, true);
    assert.ok(result.selected.filter((item) => item.reason === "pinned").length <= 2);
    assert.ok(result.bytes <= 8192);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(createRetrievedMemoryContextMessage(result)), "utf8"));
    for (const selected of result.entries) assert.equal(selected.text, entries.find((entry) => entry.id === selected.id)!.text);
  });

  it("does not resurrect old facts or terms after a reference is serialized and the current store changes", () => {
    const old = memory("writing", "Use five paragraphs", { recallTerms: ["retrospective layout"] });
    const oldReference = JSON.stringify(createRetrievedMemoryContextMessage(retrieveMemories([old], { query: "retrospective layout", now })));
    assert.ok(oldReference.includes("Use five paragraphs"));
    const current = memory("writing", "Use a conclusion and two steps", { assertionId: "new-assertion", recallTerms: ["brief review"] }, { revision: 3 });
    const restarted = JSON.parse(JSON.stringify([current])) as MemoryEntry[];
    assert.deepEqual(retrieveMemories(restarted, { query: "five paragraphs", now }).selected, []);
    assert.deepEqual(retrieveMemories(restarted, { query: "retrospective layout", now }).selected, []);
    assert.deepEqual(retrieveMemories(restarted, { query: "brief review", now }).selected.map(({ revision }) => revision), [3]);
    assert.deepEqual(retrieveMemories([memory("writing", "Use a conclusion and two steps", { state: "retracted" })], { query: "conclusion", now }).selected, []);
  });

  it("rewrite failure degrades to the original body and approved-term search with no model retry", async () => {
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      calls += 1;
      return {
        content: [{ type: "text", text: "invalid rewrite" }], finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [],
      };
    } });
    const rewrite = createMemoryQueryRewriter(model);
    const query = "retrospective layout";
    const expanded = await rewrite("question", query, new AbortController().signal);
    assert.deepEqual(expanded, { state: "degraded", queries: [] });
    const result = retrieveMemories([memory("writing", "conclusion plus two steps", { recallTerms: [query] })], { query, now, rewrittenQueries: expanded.queries });
    assert.equal(result.selected[0]?.reason, "recall_term");
    await rewrite("question", query, new AbortController().signal);
    assert.equal(calls, 1);
  });
});
