import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { createMemoryStore } from "./memory-store.js";
import { readMemoryFactReceipts } from "./memory-factual-receipts.js";

test("v6 receipts bind original source and replacement/withdrawal state across reopen; missing evidence never becomes saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-receipts-"));
  const messages: UIMessage[] = ["旧值", "新值", "撤回"].map((text, i) => ({ id: String(i), role: "user", parts: [{ type: "text", text }] }));
  const source = (i: number) => ({ kind: "conversation" as const, threadId: "t", messageId: String(i), quote: ["旧值", "新值", "撤回"][i]!, sentAt: null });
  let store = createMemoryStore(root);
  try {
    const saved = await store.writeV6!([{ operation: "add", text: "旧值", category: "note", scope: { kind: "workspace" }, source: source(0) }]); assert.ok(saved.ok);
    const replaced = await store.writeV6!([{ operation: "replace", id: saved.value[0]!.id, expectedRevision: 1, text: "新值", category: "note", scope: { kind: "workspace" }, source: source(1) }]); assert.ok(replaced.ok);
    assert.ok((await store.writeV6!([{ operation: "retract", id: replaced.value[0]!.id, expectedRevision: 1, source: source(2) }])).ok);
    const before = await readMemoryFactReceipts(store, "t", messages); assert.ok(before.ok); assert.equal(before.value.length, 3);
    assert.match(before.value.find(row => row.sourceMessageId === "0")!.text, /被取代/);
    assert.match(before.value.find(row => row.sourceMessageId === "2")!.text, /撤回/);
    store = createMemoryStore(root); assert.deepEqual(await readMemoryFactReceipts(store, "t", messages), before);
    assert.equal((await readMemoryFactReceipts(store, "t", [])).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
