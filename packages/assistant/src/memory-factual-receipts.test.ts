import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "./memory-v7-store.js";
import { readMemoryFactReceipts } from "./memory-factual-receipts.js";

test("v7 receipts bind original source and replacement/withdrawal state across reopen; receipts use validated records before transcript commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-receipts-"));
  const source = (i: number) => ({ kind: "conversation" as const, threadId: "t", messageId: String(i), quote: ["旧值", "新值", "撤回"][i]!, sentAt: null });
  let store = createMemoryStore(join(root, ".runloom/memory.json"), null);
  try {
    const saved = await store.writeV7!([{ operation: "add", scope: { kind: "user" }, text: "旧值", category: "note", source: source(0) }]); assert.ok(saved.ok);
    const immediate = await readMemoryFactReceipts(store, "t");
    assert.ok(immediate.ok, "a committed v7 write must have a receipt before the Run commits its transcript");
    assert.equal(immediate.value[0]?.text, "已保存");
    assert.deepEqual(immediate.value[0]?.undo, { operation: "retract", id: saved.value[0]!.id, expectedRevision: 1 });
    const replaced = await store.writeV7!([{ operation: "replace", scope: { kind: "user" }, id: saved.value[0]!.id, expectedRevision: 1, text: "新值", category: "note", source: source(1) }]); assert.ok(replaced.ok);
    const replacementReceipt = await readMemoryFactReceipts(store, "t"); assert.ok(replacementReceipt.ok);
    assert.equal(replacementReceipt.value.find(row => row.sourceMessageId === "1")?.undo?.operation, "undo");
    assert.ok((await store.writeV7!([{ operation: "retract", id: replaced.value[0]!.id, expectedRevision: 1, source: source(2) }])).ok);
    const before = await readMemoryFactReceipts(store, "t"); assert.ok(before.ok); assert.equal(before.value.length, 3);
    assert.match(before.value.find(row => row.sourceMessageId === "0")!.text, /被取代/);
    assert.match(before.value.find(row => row.sourceMessageId === "2")!.text, /撤回/);
    store = createMemoryStore(join(root, ".runloom/memory.json"), null); assert.deepEqual(await readMemoryFactReceipts(store, "t"), before);
    assert.deepEqual(await readMemoryFactReceipts(store, "other"), { ok: true, value: [] });
  } finally { await rm(root, { recursive: true, force: true }); }
});
