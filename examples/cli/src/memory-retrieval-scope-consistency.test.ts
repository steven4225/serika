import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectEligibleMemoryEntries, retrieveMemories, memorySemanticTextHash } from "./memory-retrieval.js";
import { LocalMemorySemanticIndex, type MemoryEmbeddingPort } from "./memory-semantic-index.js";
import { prepareMemoryRelevanceCandidates } from "./memory-relevance.js";
import { buildMemoryContextView } from "./memory-context-view.js";
import { statedThreadScope } from "./memory-observation-policy.js";
import type { MemoryEntry } from "./memory-store.js";

const now = new Date("2026-10-15T00:00:00Z");
const entry = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, text, enabled: true, status: "active", revision: 1, scope: { kind: "workspace" }, ...extra,
});
const recorded = "在【Serika-Eval-1013-2208】当前验收对话范围内，用户喝咖啡不加糖（验收专用偏好，不是日常偏好，不改变工作区或旧记忆）。";
const invalid = [entry("recorded", recorded), entry("pin", "仅在当前对话里，我喝咖啡不加糖。", { pinned: true }),
  entry("legacy", "Only in this conversation, coffee is unsweetened.")];
delete invalid[2]!.scope;
const shared = entry("shared", "我喝咖啡不加糖。");
const thread = entry("thread", "仅在当前对话里，我喝咖啡加糖。", { scope: { kind: "thread", threadId: "origin" } });

test("explicit acceptance-conversation labels are recognized without authorizing negations or questions", () => {
  for (const text of [recorded, "仅在本次验收对话范围内，我喝咖啡不加糖。"])
    assert.equal(statedThreadScope(text), "explicit", text);
  for (const text of ["是否仅在当前验收对话范围内喝咖啡不加糖？", "我不限定在当前验收对话范围内喝咖啡不加糖。",
    "这不是仅在本次验收对话范围内有效。", "不只在当前验收对话范围内，我喝咖啡不加糖。"])
    assert.equal(statedThreadScope(text), "ambiguous", text);
});

test("workspace metadata cannot broaden a body-limited fact, while valid shared and bound Thread facts retain eligibility", () => {
  for (const threadId of ["origin", "other", undefined]) {
    const input = { now, ...(threadId === undefined ? {} : { threadId }) };
    const selected = selectEligibleMemoryEntries([...invalid, shared, thread], input);
    assert.deepEqual(selected.map(item => item.id), threadId === "origin" ? ["shared", "thread"] : ["shared"]);
  }
  assert.deepEqual(invalid.map(item => item.text), [recorded, "仅在当前对话里，我喝咖啡不加糖。", "Only in this conversation, coffee is unsweetened."], "filtering never mutates stored facts");
});

test("neither pins nor lexical/vector/relevance hints bypass the scope-consistency gate, including the worker no-Thread path", () => {
  for (const threadId of ["origin", "other", undefined]) {
    const entries = [...invalid, shared, thread];
    const hits = entries.map(item => ({ id: item.id, revision: 1, textHash: memorySemanticTextHash(item.text), score: 1 }));
    const input = { now, query: "咖啡", ...(threadId === undefined ? {} : { threadId }) };
    for (const hints of [{}, { semanticHits: hits }, { relevanceSelection: hits }]) {
      const selected = retrieveMemories(entries, { ...input, ...hints });
      assert.deepEqual(selected.entries.map(item => item.id).sort(), threadId === "origin" ? ["shared", "thread"] : ["shared"]);
      assert.equal(selected.eligibleCount, threadId === "origin" ? 2 : 1);
    }
    const pool = prepareMemoryRelevanceCandidates(entries, "咖啡", { ...input, signal: new AbortController().signal, semanticCandidates: hits });
    assert.deepEqual(pool.candidates.map(item => item.id).sort(), threadId === "origin" ? ["shared", "thread"] : ["shared"]);
  }
});

test("scope-inconsistent bodies never reach embedding input or relevance material", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memory-retrieval-scope-")));
  try {
    const calls: string[][] = [];
    const embedding: MemoryEmbeddingPort = { modelId: "fixture/no-network", async embed(texts) {
      calls.push([...texts]); return texts.map(() => [1, 0]);
    } };
    const index = new LocalMemorySemanticIndex({ file: join(root, "index.json"), embedding });
    const hits = await index.search([...invalid, shared, thread], { now, threadId: "origin", query: "咖啡" });
    assert.deepEqual(hits.map(item => item.id).sort(), ["shared", "thread"]);
    assert.deepEqual(calls.flat().sort(), [shared.text, thread.text, "咖啡"].sort());
    const pool = prepareMemoryRelevanceCandidates([...invalid, shared, thread], "咖啡", {
      now, threadId: "origin", signal: new AbortController().signal, semanticCandidates: hits,
    });
    assert.ok(pool.candidates.every(item => item.text === shared.text || item.text === thread.text));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a general identity cannot promote a workspace/body scope mismatch into the stable profile", () => {
  const assertion: NonNullable<MemoryEntry["assertion"]> = { assertionId: "a", kind: "preference", state: "asserted",
    factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" }, recallTerms: [],
    validTime: { from: null, to: null, basis: "unknown" }, systemTime: { from: null, to: null }, sourceIds: [{ kind: "manual" }] };
  const inconsistent = entry("wrong-profile", "当前对话范围内，用户喝咖啡不加糖。", { assertion });
  const allowed = entry("shared-profile", "用户喝咖啡不加糖。", { assertion });
  const profile = buildMemoryContextView([inconsistent, allowed], [], { now, threadId: "origin" });
  assert.deepEqual(profile.profile.map(item => item.id), ["shared-profile"]);
});
