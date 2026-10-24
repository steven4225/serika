import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { V7MemoryStore, v7Conflicts, type V7Change, type V7Document } from "./memory-v7-store.js";
import { assertExperimentalDataPaths } from "./experimental-data.js";
const change = (value = "北京", attribute = "住址"): Extract<V7Change, { text: string }> => ({ operation: "add", text: `我住在${value}`, category: "note", scope: { kind: "user" },
  identity: { subject: "user", attribute, value }, source: { kind: "conversation", threadId: "t", messageId: value, quote: `我住在${value}`, sentAt: "2026-10-21T01:00:00Z" } });

test("v5 requires migration for reads and writes without creating locks, siblings or backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-v5-"));
  try {
    await mkdir(join(root, ".runloom"));
    const file = join(root, ".runloom/memory.json"), original = JSON.stringify({ version: 5, lastWrittenAt: null, entries: [], candidates: [], consolidationCursors: [], library: { revision: 0, folders: [], documents: [] } });
    await writeFile(file, original);
    const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null); assert.equal((await store.list()).ok, false);
    for (const result of [await store.add({ text: "test", scope: { kind: "user" } }), await store.update("missing", { text: "test", expectedRevision: 1 }), await store.delete("missing"), await store.writeV7([change()])]) {
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "MEMORY_MIGRATION_REQUIRED");
    }
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(await readdir(join(root, ".runloom")), ["memory.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v7 replacement/undo, withdrawal/undo, conflict diagnostics and source-specific deletion survive reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-chain-"));
  try {
    let store = new V7MemoryStore(join(root, ".runloom/memory.json"), null);
    const added = await store.writeV7([{ ...change(), uncertain: true }]); assert.ok(added.ok); assert.equal(added.value[0]!.uncertain, true); const old = added.value[0]!;
    const replacement = change("上海"); assert.ok("text" in replacement);
    const replaced = await store.writeV7([{ ...replacement, operation: "replace", id: old.id, expectedRevision: old.revision! }]); assert.ok(replaced.ok);
    store = new V7MemoryStore(join(root, ".runloom/memory.json"), null);
    const next = replaced.value[0]!; assert.ok((await store.writeV7([{ operation: "undo", id: next.id, expectedRevision: next.revision!, source: { kind: "manual" } }])).ok);
    const current = await store.get(old.id); assert.ok(current.ok); assert.equal(current.entry.enabled, true); assert.equal(current.entry.uncertain, true);
    const withdrawn = await store.writeV7([{ operation: "retract", id: old.id, expectedRevision: current.entry.revision!, source: { kind: "manual" } }]); assert.ok(withdrawn.ok);
    assert.ok((await store.writeV7([{ operation: "undo", id: old.id, expectedRevision: withdrawn.value[0]!.revision!, source: { kind: "manual" } }])).ok);
    assert.ok((await store.writeV7([change("杭州"), change("深圳", "公司地址")])).ok);
    const document = await store.readV7(); assert.ok(document.ok);
    assert.equal(v7Conflicts(document.value.entries).length, 1);
    assert.equal(v7Conflicts(document.value.entries.filter(entry => entry.identity?.attribute !== "住址")).length, 0);
    const victim = document.value.entries.find(entry => entry.id === old.id)!;
    assert.ok((await store.deleteMemory({ id: old.id, expectedRevision: victim.revision })).ok);
    assert.ok((await store.writeV7([change()])).ok);
    const after = await store.readV7(); assert.ok(after.ok);
    assert.equal(after.value.entries.some(entry => entry.id === old.id || entry.text === "我住在北京"), false);
    assert.equal(after.value.suppressed.length, 1);
    const rephrased = change(); rephrased.text = "北京是我的住址";
    assert.ok((await store.writeV7([rephrased])).ok);
    const reextracted = await new V7MemoryStore(join(root, ".runloom/memory.json"), null).readV7(); assert.ok(reextracted.ok);
    assert.equal(reextracted.value.entries.some(entry => entry.text === rephrased.text), false);
    const independent = change("北京", "办公习惯"); independent.text = "我工作时先列结论"; independent.source = { kind: "conversation", threadId: "t", messageId: "北京", quote: independent.text, sentAt: null };
    assert.ok((await store.writeV7([independent])).ok);
    const sameSource = await store.readV7(); assert.ok(sameSource.ok); assert.ok(sameSource.value.entries.some(entry => entry.text === independent.text));
    const persisted = JSON.parse(await readFile(join(root, ".runloom/memory.json"), "utf8"));
    assert.equal(persisted.version, 7); assert.equal("candidates" in persisted, false);
    assert.doesNotMatch(JSON.stringify(persisted), /systemTime|validTime|assertions|versions|operationLog/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory and progress share the commit barrier; pre-rename and post-rename failures stay distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-barrier-"));
  try {
    const progress: V7Document["progress"][number] = { threadId: "t", projectId: null, throughMessageId: "北京", prefixHash: "test-hash", pending: [], retry: null };
    for (const phase of ["before-rename", "after-rename"] as const) {
      const workspace = join(root, phase); await mkdir(workspace);
      const writer = new V7MemoryStore(join(workspace, ".runloom/memory.json"), null, observed => { if (observed === phase) throw new Error(phase); });
      const result = await writer.writeV7([change()], undefined, { progress, expectedProgress: null }); assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, phase === "after-rename" ? "MEMORY_COMMIT_UNCERTAIN" : "WRITE_FAILED");
      const read = await new V7MemoryStore(join(workspace, ".runloom/memory.json"), null).readV7(); assert.ok(read.ok);
      assert.equal(read.value.entries.length, phase === "after-rename" ? 1 : 0);
      assert.equal(read.value.progress.length, read.value.entries.length);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic extraction reserves space; explicit remember still tries the actual hard limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-capacity-"));
  try {
    const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null), first = await store.writeV7([change()]); assert.ok(first.ok);
    const loaded = await store.readV7(); assert.ok(loaded.ok);
    const document = loaded.value, entry = document.entries[0]!;
    document.entries = Array.from({ length: 511 }, (_, index) => ({ ...entry, id: String(index) }));
    await writeFile(join(root, ".runloom/memory.json"), JSON.stringify(document));
    const automatic = await store.writeV7([change("上海")], undefined, { automatic: true }); assert.equal(automatic.ok, false);
    assert.ok((await store.writeV7([change("上海")])).ok);
    const full = await store.writeV7([change("杭州")]); assert.equal(full.ok, false);
    if (!full.ok) assert.equal(full.error.code, "MEMORY_LIMIT_EXCEEDED");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily data path and a symlink alias fail before any store write", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-protection-"));
  try {
    const daily = join(homedir(), ".config/@aisdk-agent/desktop");
    assert.throws(() => assertExperimentalDataPaths([daily, join(daily, "workspaces/personal")]), /拒绝写入/);
    await symlink(daily, join(root, "alias"));
    assert.throws(() => assertExperimentalDataPaths([join(root, "alias", "child")]), /拒绝写入/);
    const result = await new V7MemoryStore(join(join(root, "alias"), ".runloom/memory.json"), null).writeV7([change()]); assert.equal(result.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("privacy redaction survives an uncertain acknowledgement, blocks replacement-chain undo and is read-before-write idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-private-barrier-"));
  try {
    const store = new V7MemoryStore(join(root, ".runloom/memory.json"), null), seed = await store.writeV7([change()]); assert.ok(seed.ok);
    const newer = await store.writeV7([{ ...change("上海"), operation: "replace", id: seed.value[0]!.id, expectedRevision: seed.value[0]!.revision! }]); assert.ok(newer.ok);
    const faulty = new V7MemoryStore(join(root, ".runloom/memory.json"), null, phase => { if (phase === "after-rename") throw new Error("ack lost"); });
    const result = await faulty.excludeSources("t", ["北京"]); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "MEMORY_COMMIT_UNCERTAIN");
    const read = await store.readV7(); assert.ok(read.ok); assert.equal(read.value.entries.find(entry => entry.id === seed.value[0]!.id)?.privacyExcluded, true);
    assert.doesNotMatch(JSON.stringify(read.value), /我住在北京/);
    const undo = await store.writeV7([{ operation: "undo", id: newer.value[0]!.id, expectedRevision: newer.value[0]!.revision!, source: { kind: "manual" } }]); assert.equal(undo.ok, false);
    const before = await readFile(join(root, ".runloom/memory.json"));
    assert.ok((await new V7MemoryStore(join(root, ".runloom/memory.json"), null).excludeSources("t", ["北京"])).ok);
    assert.deepEqual(await readFile(join(root, ".runloom/memory.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v7 scopes isolate reads, mutation targets, conflicts, merges and extraction progress across projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm45-scope-"));
  try {
    const file = join(root, "memory.json"), a = new V7MemoryStore(file, "a"), b = new V7MemoryStore(file, "b"), none = new V7MemoryStore(file, null);
    const projectScope = { kind: "project", projectId: "a" } as const;
    const progress: V7Document["progress"][number] = { threadId: "t", projectId: "a", throughMessageId: "北京", prefixHash: "a", pending: [], retry: null };
    const written = await a.writeV7([change(), { ...change("上海"), scope: projectScope }], undefined, { progress, expectedProgress: null }); assert.ok(written.ok);
    const user = written.value[0]!, project = written.value[1]!;
    const view = await a.readV7(); assert.ok(view.ok); assert.equal(view.value.entries.length, 2); assert.equal(v7Conflicts(view.value.entries).length, 0);
    for (const other of [b, none]) {
      const read = await other.list(); assert.ok(read.ok); assert.deepEqual(read.entries.map(entry => entry.id), [user.id]);
      assert.equal((await other.get(project.id)).ok, false);
      const reference = await other.readReferenceMaterial(new AbortController().signal, new Date()); assert.ok(reference.ok); assert.deepEqual(reference.value.entries.map(entry => entry.id), [user.id]);
      assert.equal((await other.update(project.id, { expectedRevision: 1, text: "foreign edit" })).ok, false);
      assert.equal((await other.writeV7([{ operation: "retract", id: project.id, expectedRevision: 1, source: { kind: "manual" } }])).ok, false);
    }
    assert.equal((await a.writeV7([{ ...change("广州"), operation: "replace", id: project.id, expectedRevision: 1 }])).ok, false);
    assert.equal((await a.mergeV7({ members: [{ id: user.id, revision: 1 }, { id: project.id, revision: 1 }], text: "北京，上海" })).ok, false);
    assert.ok((await b.writeV7([], undefined, { progress: { ...progress, projectId: "b", prefixHash: "b" }, expectedProgress: null })).ok);
    const reopened = await new V7MemoryStore(file, "a").readV7(); assert.ok(reopened.ok); assert.deepEqual(reopened.value.progress, [progress]);
    assert.equal((await a.writeV7([], undefined, { progress: { ...progress, projectId: "b" }, expectedProgress: progress })).ok, false);
    assert.ok((await a.deleteMemory({ id: project.id, expectedRevision: 1 })).ok);
    assert.ok((await a.writeV7([{ ...change("上海"), scope: projectScope }, change("上海")])).ok);
    const suppressed = await a.readV7(); assert.ok(suppressed.ok);
    assert.equal(suppressed.value.entries.some(entry => entry.scope.kind === "project"), false);
    assert.equal(suppressed.value.entries.some(entry => entry.scope.kind === "user" && entry.text === "我住在上海"), true);
    assert.ok((await a.excludeSources("t", ["北京", "上海"])).ok);
    const persisted = JSON.parse(await readFile(file, "utf8")); assert.deepEqual(persisted.progress, []); assert.equal(persisted.entries.every((entry: { privacyExcluded?: boolean }) => entry.privacyExcluded), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v6 is rejected without writes and diagnostics contain absolute dry-run and upgrade commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm45-v6-"));
  try {
    const file = join(root, "memory.json"), original = '{"version":6}'; await writeFile(file, original);
    const result = await new V7MemoryStore(file, null).readV7(); assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, "MEMORY_MIGRATION_REQUIRED"); assert.ok(result.error.message.includes(file)); assert.match(result.error.message, /memory-upgrade\.mjs.*--dry-run/); assert.match(result.error.message, /--upgrade/); }
    assert.equal(await readFile(file, "utf8"), original); assert.deepEqual(await readdir(root), ["memory.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
