import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { V7MemoryStore } from "./memory-v7-store.js";
import { createMemoryStore } from "./memory-v7-store.js";
import type { MemoryImportEntry, MemoryImportConfirm } from "./memory-import.js";

const entries: MemoryImportEntry[] = [{ text: "Use Chinese for replies", kind: "preference", scope: { kind: "user" } }, { text: "Release notes", kind: "note", scope: { kind: "user" } }];
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "runloom-import-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function preview(store: V7MemoryStore, values = entries): Promise<MemoryImportConfirm> {
  const result = await store.previewImport(values); assert.ok(result.ok);
  return { entries: values, snapshot: result.value.snapshot, operationId: "import-1" };
}
it("preview and cancellation do not create storage; rejects unbounded and forged source fields before writing", () => fixture(async root => {
  const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null), file = join(root, ".runloom/memory.json");
  assert.ok((await store.previewImport(entries)).ok);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  for (const values of [[], Array.from({ length: 33 }, () => entries[0]!), [{ text: "x".repeat(2049), kind: "note", scope: { kind: "user" } }], [{ ...entries[0], source: { kind: "conversation", threadId: "forged" } }]]) {
    const result = await store.previewImport(values as MemoryImportEntry[]); assert.equal(result.ok, false);
  }
  assert.equal((await store.confirmImport({ ...(await preview(store)), pinned: true } as MemoryImportConfirm, "thread")).ok, false);
  await assert.rejects(readFile(file), { code: "ENOENT" });
}));
it("imports atomically with manual scoped sources, skips exact active duplicates, and preserves receipts across writes/restart", () => fixture(async root => {
  const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null), file = join(root, ".runloom/memory.json");
  const input = await preview(store, [...entries, entries[0]!]);
  const result = await store.confirmImport(input, "thread"); assert.ok(result.ok);
  assert.deepEqual(result.value.items.map(item => item.status), ["saved", "saved", "existing"]);
  assert.equal(result.value.items[0]!.id, result.value.items[2]!.id);
  const list = await store.list(); assert.ok(list.ok); assert.equal(list.entries.length, 2);
  for (const entry of list.entries) { assert.deepEqual(entry.source, { kind: "manual" }); assert.deepEqual(entry.scope, { kind: "user" }); assert.equal(entry.pinned, false); }
  const content = await readFile(file, "utf8");
  assert.deepEqual(await new V7MemoryStore(join(root, ".runloom/memory.json"), null).confirmImport(input, "thread"), result);
  assert.equal(await readFile(file, "utf8"), content, "replay is write-free");
  assert.equal((await store.confirmImport({ ...input, entries: [{ text: "changed", kind: "note", scope: { kind: "user" } }] }, "thread")).ok, false);
  assert.equal((await store.confirmImport(input, "another-thread")).ok, false);
  await store.update(list.entries[0]!.id, { expectedRevision: 1, status: "disabled" });
  assert.deepEqual(await new V7MemoryStore(join(root, ".runloom/memory.json"), null).importReceipt(input.operationId, "thread"), result);
  assert.deepEqual(await store.importReceipt(input.operationId, "other"), { ok: true, value: null });
}));
it("changed preview or capacity rejects the entire batch; disabled entries are never revived", () => fixture(async root => {
  const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null), file = join(root, ".runloom/memory.json");
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
  const atCapacity = await preview(store, [{ text: "one", kind: "note", scope: { kind: "user" } }, { text: "two", kind: "note", scope: { kind: "user" } }]); atCapacity.operationId = "capacity";
  const before = await readFile(file, "utf8");
  const result = await store.confirmImport(atCapacity, "thread"); assert.equal(result.ok, false);
  assert.equal(await readFile(file, "utf8"), before, "no first-entry partial commit");
}));
it("post-rename uncertainty is resolved by reading the persisted receipt, without another write", () => fixture(async root => {
  const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null, phase => { if (phase === "after-rename") throw new Error("lost acknowledgement"); });
  const input = await preview(store), result = await store.confirmImport(input, "thread");
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "MEMORY_COMMIT_UNCERTAIN");
  const reopened = new V7MemoryStore(join(root, ".runloom/memory.json"), null), receipt = await reopened.importReceipt(input.operationId, "thread"); assert.ok(receipt.ok && receipt.value);
  const file = join(root, ".runloom/memory.json"), before = await readFile(file, "utf8");
  assert.deepEqual(await reopened.confirmImport(input, "thread"), receipt);
  assert.equal(await readFile(file, "utf8"), before);
}));
it("concurrent confirmations sharing a preview serialize; a rejected or cancelled batch writes nothing", () => fixture(async root => {
  const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null), input = await preview(store);
  const results = await Promise.all([store.confirmImport(input, "thread"), new V7MemoryStore(join(root, ".runloom/memory.json"), null).confirmImport({ ...input, operationId: "second" }, "thread")]);
  assert.equal(results.filter(result => result.ok).length, 1);
  const list = await store.list(); assert.ok(list.ok); assert.equal(list.entries.length, 2);
  const cancelled = new AbortController(); cancelled.abort(new Error("cancel"));
  await assert.rejects(store.confirmImport({ ...input, operationId: "cancelled" }, "thread", cancelled.signal), /cancel/);
}));
it("imports equal text separately by scope and binds replay receipts to the selected project", () => fixture(async root => {
  const file = join(root, "memory.json"), a = new V7MemoryStore(file, "a"), b = new V7MemoryStore(file, "b");
  const text = "先列出结论";
  const input = await preview(a, [{ text, kind: "preference", scope: { kind: "user" } }, { text, kind: "preference", scope: { kind: "project", projectId: "a" } }]);
  const saved = await a.confirmImport(input, "thread"); assert.ok(saved.ok); assert.deepEqual(saved.value.items.map(item => item.status), ["saved", "saved"]);
  assert.notEqual(saved.value.items[0]!.id, saved.value.items[1]!.id);
  assert.deepEqual(await b.importReceipt(input.operationId, "thread"), { ok: true, value: null });
  assert.equal((await b.confirmImport(input, "thread")).ok, false);
  assert.equal((await b.previewImport([{ text, kind: "note", scope: { kind: "project", projectId: "a" } }])).ok, false);
  const visible = await b.list(); assert.ok(visible.ok); assert.deepEqual(visible.entries.map(entry => entry.id), [saved.value.items[0]!.id]);
}));
