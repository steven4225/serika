import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { V6MemoryStore } from "./memory-v6-store.js";
import { createMemoryStore } from "./memory-v6-store.js";
import type { MemoryImportEntry, MemoryImportConfirm } from "./memory-import.js";

const entries: MemoryImportEntry[] = [{ text: "Use Chinese for replies", kind: "preference" }, { text: "Release notes", kind: "note" }];
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "runloom-import-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function preview(store: V6MemoryStore, values = entries): Promise<MemoryImportConfirm> {
  const result = await store.previewImport(values); assert.ok(result.ok);
  return { entries: values, snapshot: result.value.snapshot, operationId: "import-1" };
}
it("preview and cancellation do not create storage; rejects unbounded and forged source fields before writing", () => fixture(async root => {
  const store = new V6MemoryStore(root), file = join(root, ".runloom/memory.json");
  assert.ok((await store.previewImport(entries)).ok);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  for (const values of [[], Array.from({ length: 33 }, () => entries[0]!), [{ text: "x".repeat(2049), kind: "note" }], [{ ...entries[0], source: { kind: "conversation", threadId: "forged" } }]]) {
    const result = await store.previewImport(values as MemoryImportEntry[]); assert.equal(result.ok, false);
  }
  assert.equal((await store.confirmImport({ ...(await preview(store)), pinned: true } as MemoryImportConfirm, "thread")).ok, false);
  await assert.rejects(readFile(file), { code: "ENOENT" });
}));
it("imports atomically with manual workspace sources, skips exact active duplicates, and preserves receipts across writes/restart", () => fixture(async root => {
  const store = new V6MemoryStore(root), file = join(root, ".runloom/memory.json");
  const input = await preview(store, [...entries, entries[0]!]);
  const result = await store.confirmImport(input, "thread"); assert.ok(result.ok);
  assert.deepEqual(result.value.items.map(item => item.status), ["saved", "saved", "existing"]);
  assert.equal(result.value.items[0]!.id, result.value.items[2]!.id);
  const list = await store.list(); assert.ok(list.ok); assert.equal(list.entries.length, 2);
  for (const entry of list.entries) { assert.deepEqual(entry.source, { kind: "manual" }); assert.deepEqual(entry.scope, { kind: "workspace" }); assert.equal(entry.pinned, false); }
  const content = await readFile(file, "utf8");
  assert.deepEqual(await new V6MemoryStore(root).confirmImport(input, "thread"), result);
  assert.equal(await readFile(file, "utf8"), content, "replay is write-free");
  assert.equal((await store.confirmImport({ ...input, entries: [{ text: "changed", kind: "note" }] }, "thread")).ok, false);
  assert.equal((await store.confirmImport(input, "another-thread")).ok, false);
  await store.update(list.entries[0]!.id, { expectedRevision: 1, status: "disabled" });
  assert.deepEqual(await new V6MemoryStore(root).importReceipt(input.operationId, "thread"), result);
  assert.deepEqual(await store.importReceipt(input.operationId, "other"), { ok: true, value: null });
}));
it("changed preview or capacity rejects the entire batch; disabled entries are never revived", () => fixture(async root => {
  const store = new V6MemoryStore(root), file = join(root, ".runloom/memory.json");
  const input = await preview(store);
  const old = await store.add({ ...entries[0]!, status: "disabled" }); assert.ok(old.ok);
  assert.equal((await store.confirmImport(input, "thread")).ok, false);
  const fresh = await preview(store); const imported = await store.confirmImport(fresh, "thread"); assert.ok(imported.ok);
  assert.notEqual(imported.value.items[0]!.id, old.entry.id);
  const disabled = await store.get(old.entry.id); assert.ok(disabled.ok); assert.equal(disabled.entry.status, "disabled");
  const doc = JSON.parse(await readFile(file, "utf8"));
  const template = doc.entries[0];
  doc.entries = Array.from({ length: 511 }, (_, i) => ({ ...template, id: `entry-${i}` }));
  await writeFile(file, JSON.stringify(doc));
  const atCapacity = await preview(store, [{ text: "one", kind: "note" }, { text: "two", kind: "note" }]); atCapacity.operationId = "capacity";
  const before = await readFile(file, "utf8");
  const result = await store.confirmImport(atCapacity, "thread"); assert.equal(result.ok, false);
  assert.equal(await readFile(file, "utf8"), before, "no first-entry partial commit");
}));
it("post-rename uncertainty is resolved by reading the persisted receipt, without another write", () => fixture(async root => {
  const store = new V6MemoryStore(root, phase => { if (phase === "after-rename") throw new Error("lost acknowledgement"); });
  const input = await preview(store), result = await store.confirmImport(input, "thread");
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "MEMORY_COMMIT_UNCERTAIN");
  const reopened = new V6MemoryStore(root), receipt = await reopened.importReceipt(input.operationId, "thread"); assert.ok(receipt.ok && receipt.value);
  const file = join(root, ".runloom/memory.json"), before = await readFile(file, "utf8");
  assert.deepEqual(await reopened.confirmImport(input, "thread"), receipt);
  assert.equal(await readFile(file, "utf8"), before);
}));
it("concurrent confirmations sharing a preview serialize; a rejected or cancelled batch writes nothing", () => fixture(async root => {
  const store = new V6MemoryStore(root), input = await preview(store);
  const results = await Promise.all([store.confirmImport(input, "thread"), new V6MemoryStore(root).confirmImport({ ...input, operationId: "second" }, "thread")]);
  assert.equal(results.filter(result => result.ok).length, 1);
  const list = await store.list(); assert.ok(list.ok); assert.equal(list.entries.length, 2);
  const cancelled = new AbortController(); cancelled.abort(new Error("cancel"));
  await assert.rejects(store.confirmImport({ ...input, operationId: "cancelled" }, "thread", cancelled.signal), /cancel/);
}));
