import assert from "node:assert/strict";
import { test } from "node:test";
import { memorySemanticTextHash, retrieveMemories } from "./memory-retrieval.js";
import type { MemoryEntry } from "./memory-store.js";

const now = new Date("2026-10-14T04:00:00.000Z");
const fact = (id: string, text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, text, revision: 1, enabled: true, status: "active", scope: { kind: "workspace" }, ...extra,
});
const approval = (entry: MemoryEntry) => ({ id: entry.id, revision: entry.revision ?? 1, textHash: memorySemanticTextHash(entry.text) });

test("captured MR02: source-backed relevance can select a paraphrase missed by the fixed vector threshold", () => {
  const style = fact("style", "复盘先给一行结论，再列两条可执行步骤。");
  const input = { query: "回顾过去一周应该怎样组织内容？", now, semanticHits: [], relevanceSelection: [approval(style)] };
  assert.deepEqual(retrieveMemories([style, fact("noise", "晚饭时间是七点。")], input).entries.map(entry => entry.id), ["style"]);
});

test("captured topical events: approved relevance filters both lexical and vector candidates, not just the first rank", () => {
  const coffee = fact("coffee", "我喝咖啡不加糖。");
  const event = fact("event", "咖啡记录：第7次到店。");
  const input = { query: "我的咖啡偏好", now, relevanceSelection: [approval(coffee)],
    semanticHits: [coffee, event].map(entry => ({ ...approval(entry), score: entry.id === "coffee" ? .594 : .529 })) };
  const selection = retrieveMemories([coffee, event], input);
  assert.deepEqual(selection.entries.map(entry => entry.id), ["coffee"]);
  assert.equal(selection.selected[0]?.reason, "relevance");
});

test("captured MH04: a successful empty relevance selection does not fall back to topical keyword matches", () => {
  const input = { query: "咖啡为什么会影响睡眠？", now, semanticHits: [], relevanceSelection: [] };
  assert.deepEqual(retrieveMemories([fact("coffee", "我喜欢美式咖啡。")], input).entries, []);
});

test("relevance cannot revive changed revisions or foreign facts; explicit pins retain their bounded priority", () => {
  const original = fact("coffee", "咖啡不加糖。");
  const edited = { ...original, text: "咖啡改成加糖。", revision: 2 };
  const privateFact = fact("foreign", "咖啡秘密。", { scope: { kind: "thread", threadId: "foreign" } });
  const pin = fact("pin", "固定的参考。", { pinned: true });
  const input = { query: "咖啡", now, threadId: "current", relevanceSelection: [approval(original), approval(privateFact)] };
  assert.deepEqual(retrieveMemories([edited, privateFact, pin], input).entries.map(entry => entry.id), ["pin"]);
});
