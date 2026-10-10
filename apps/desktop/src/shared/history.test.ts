import assert from "node:assert/strict";
import { it } from "node:test";
import { historyPage } from "./history.js";

it("bounded pages keep complete messages, stable cursors and do not lose messages after append", () => {
  const messages = Array.from({ length: 120 }, (_, i) => ({ id: `m-${i}`, role: "assistant" as const, parts: [{ type: "text" as const, text: "x".repeat(32_000) }] }));
  const first = historyPage(messages, "t");
  assert(first.beforeId); assert(Buffer.byteLength(JSON.stringify(first)) < 2 * 1024 * 1024);
  const all = [...first.messages]; let before: string | null = first.beforeId;
  messages.push({ id: "new", role: "assistant", parts: [{ type: "text", text: "new" }] });
  while (before) { const page = historyPage(messages, "t", { beforeId: before }); all.unshift(...page.messages); before = page.beforeId; }
  assert.equal(all.length, 120); assert.equal(new Set(all.map(x => x.id)).size, 120);
  assert.throws(() => historyPage(messages, "t", { beforeId: "missing" }), /历史位置/);
});
