import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "./memory-store.js";

test("v1-v5 are readable without upgrading; every old-format write requires Step 7 migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-read-versions-"));
  try {
    await mkdir(join(root, ".runloom"));
    const file = join(root, ".runloom/memory.json"), store = createMemoryStore(root);
    for (let version = 1; version <= 5; version++) {
      const original = JSON.stringify({ version, lastWrittenAt: null, entries: [], candidates: [], consolidationCursors: [], ...(version === 5 ? { library: { revision: 0, folders: [], documents: [] } } : {}) });
      await writeFile(file, original);
      assert.ok((await store.list()).ok, `read v${version}`);
      const write = await store.add({ text: "must not migrate" }); assert.equal(write.ok, false);
      if (!write.ok) assert.equal(write.error.code, "MEMORY_MIGRATION_REQUIRED");
      assert.equal(await readFile(file, "utf8"), original);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed, unsupported, duplicate and symlinked files fail closed; stale concurrent CAS has one winner", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-invalid-"));
  try {
    await mkdir(join(root, ".runloom"));
    const file = join(root, ".runloom/memory.json"), store = createMemoryStore(root);
    for (const raw of ["not-json", JSON.stringify({ version: 7, entries: [] }), JSON.stringify({ version: 1, entries: [{ id: "same", text: "one", enabled: true }, { id: "same", text: "two", enabled: true }] })]) {
      await writeFile(file, raw); assert.equal((await store.list()).ok, false); assert.equal((await store.add({ text: "no" })).ok, false); assert.equal(await readFile(file, "utf8"), raw);
    }
    await rm(file); const added = await store.add({ text: "initial" }); assert.ok(added.ok);
    const results = await Promise.all([store.update(added.entry.id, { expectedRevision: 1, pinned: true }), createMemoryStore(root).update(added.entry.id, { expectedRevision: 1, pinned: false })]);
    assert.equal(results.filter(result => result.ok).length, 1);
    await writeFile(join(root, "target"), await readFile(file)); await rm(file); await symlink(join(root, "target"), file);
    const denied = await store.add({ text: "no" }); assert.equal(denied.ok, false); if (!denied.ok) assert.equal(denied.error.code, "SYMLINK_NOT_ALLOWED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
