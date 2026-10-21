import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { V6MemoryStore, v6Conflicts, type V6Change, type V6Document } from "./memory-v6-store.js";
import { assertExperimentalDataPaths } from "./experimental-data.js";
const change = (value = "北京", attribute = "住址"): Extract<V6Change, { text: string }> => ({ operation: "add", text: `我住在${value}`, category: "note", scope: { kind: "workspace" },
  identity: { subject: "user", attribute, value }, source: { kind: "conversation", threadId: "t", messageId: value, quote: `我住在${value}`, sentAt: "2026-10-21T01:00:00Z" } });

test("v5 remains readable; every write refuses migration without creating locks, siblings or backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-v5-"));
  try {
    await mkdir(join(root, ".runloom"));
    const file = join(root, ".runloom/memory.json"), original = JSON.stringify({ version: 5, lastWrittenAt: null, entries: [], candidates: [], consolidationCursors: [], library: { revision: 0, folders: [], documents: [] } });
    await writeFile(file, original);
    const store = new V6MemoryStore(root); assert.ok((await store.list()).ok);
    for (const result of [await store.add({ text: "test" }), await store.update("missing", { text: "test", expectedRevision: 1 }), await store.delete("missing"), await store.writeV6([change()]), await store.commitCandidateBatch({}), await store.resolveCandidate({})]) {
      assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "MEMORY_MIGRATION_REQUIRED");
    }
    assert.equal(await readFile(file, "utf8"), original);
    assert.deepEqual(await readdir(join(root, ".runloom")), ["memory.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v6 replacement/undo, withdrawal/undo, conflict diagnostics and source-specific deletion survive reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-chain-"));
  try {
    let store = new V6MemoryStore(root);
    const added = await store.writeV6([{ ...change(), uncertain: true }]); assert.ok(added.ok); assert.equal(added.value[0]!.uncertain, true); const old = added.value[0]!;
    const replacement = change("上海"); assert.ok("text" in replacement);
    const replaced = await store.writeV6([{ ...replacement, operation: "replace", id: old.id, expectedRevision: old.revision! }]); assert.ok(replaced.ok);
    store = new V6MemoryStore(root);
    const next = replaced.value[0]!; assert.ok((await store.writeV6([{ operation: "undo", id: next.id, expectedRevision: next.revision!, source: { kind: "manual" } }])).ok);
    const current = await store.get(old.id); assert.ok(current.ok); assert.equal(current.entry.enabled, true); assert.equal(current.entry.uncertain, true);
    const withdrawn = await store.writeV6([{ operation: "retract", id: old.id, expectedRevision: current.entry.revision!, source: { kind: "manual" } }]); assert.ok(withdrawn.ok);
    assert.ok((await store.writeV6([{ operation: "undo", id: old.id, expectedRevision: withdrawn.value[0]!.revision!, source: { kind: "manual" } }])).ok);
    assert.ok((await store.writeV6([change("杭州"), change("深圳", "公司地址")])).ok);
    const document = await store.readV6(); assert.ok(document.ok);
    assert.equal(v6Conflicts(document.value.entries).length, 1);
    assert.equal(v6Conflicts(document.value.entries.filter(entry => entry.identity?.attribute !== "住址")).length, 0);
    const victim = document.value.entries.find(entry => entry.id === old.id)!;
    assert.ok((await store.deleteMemory({ id: old.id, expectedRevision: victim.revision })).ok);
    assert.ok((await store.writeV6([change()])).ok);
    const after = await store.readV6(); assert.ok(after.ok);
    assert.equal(after.value.entries.some(entry => entry.id === old.id || entry.text === "我住在北京"), false);
    assert.equal(after.value.suppressed.length, 1);
    const independent = change("北京", "办公习惯"); independent.text = "我工作时先列结论"; independent.source = { kind: "conversation", threadId: "t", messageId: "北京", quote: independent.text, sentAt: null };
    assert.ok((await store.writeV6([independent])).ok);
    const sameSource = await store.readV6(); assert.ok(sameSource.ok); assert.ok(sameSource.value.entries.some(entry => entry.text === independent.text));
    const privateEntry = await store.writeV6([{ ...change("其他对话"), scope: { kind: "thread", threadId: "private" }, source: { kind: "manual" } }]); assert.ok(privateEntry.ok);
    const crossScope = await store.writeV6([{ ...change("越界"), operation: "replace", id: privateEntry.value[0]!.id, expectedRevision: 1 }]); assert.equal(crossScope.ok, false);
    if (!crossScope.ok) assert.equal(crossScope.error.code, "MEMORY_SOURCE_INVALID");
    const persisted = JSON.parse(await readFile(join(root, ".runloom/memory.json"), "utf8"));
    assert.equal(persisted.version, 6); assert.equal("candidates" in persisted, false);
    assert.doesNotMatch(JSON.stringify(persisted), /systemTime|validTime|assertions|versions|operationLog/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory and progress share the commit barrier; pre-rename and post-rename failures stay distinct", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-barrier-"));
  try {
    const progress: V6Document["progress"][number] = { threadId: "t", throughMessageId: "北京", prefixHash: "test-hash", pending: [], retry: null };
    for (const phase of ["before-rename", "after-rename"] as const) {
      const workspace = join(root, phase); await mkdir(workspace);
      const writer = new V6MemoryStore(workspace, observed => { if (observed === phase) throw new Error(phase); });
      const result = await writer.writeV6([change()], undefined, { progress, expectedProgress: null }); assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, phase === "after-rename" ? "MEMORY_COMMIT_UNCERTAIN" : "WRITE_FAILED");
      const read = await new V6MemoryStore(workspace).readV6(); assert.ok(read.ok);
      assert.equal(read.value.entries.length, phase === "after-rename" ? 1 : 0);
      assert.equal(read.value.progress.length, read.value.entries.length);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("automatic extraction reserves space; explicit remember still tries the actual hard limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-capacity-"));
  try {
    const store = new V6MemoryStore(root), first = await store.writeV6([change()]); assert.ok(first.ok);
    const loaded = await store.readV6(); assert.ok(loaded.ok);
    const document = loaded.value, entry = document.entries[0]!;
    document.entries = Array.from({ length: 511 }, (_, index) => ({ ...entry, id: String(index) }));
    await writeFile(join(root, ".runloom/memory.json"), JSON.stringify(document));
    const automatic = await store.writeV6([change("上海")], undefined, { automatic: true }); assert.equal(automatic.ok, false);
    assert.ok((await store.writeV6([change("上海")])).ok);
    const full = await store.writeV6([change("杭州")]); assert.equal(full.ok, false);
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
    const result = await new V6MemoryStore(join(root, "alias")).writeV6([change()]); assert.equal(result.ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("privacy redaction survives an uncertain acknowledgement, blocks replacement-chain undo and is read-before-write idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-private-barrier-"));
  try {
    const store = new V6MemoryStore(root), seed = await store.writeV6([change()]); assert.ok(seed.ok);
    const newer = await store.writeV6([{ ...change("上海"), operation: "replace", id: seed.value[0]!.id, expectedRevision: seed.value[0]!.revision! }]); assert.ok(newer.ok);
    const faulty = new V6MemoryStore(root, phase => { if (phase === "after-rename") throw new Error("ack lost"); });
    const result = await faulty.excludeSources("t", ["北京"]); assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "MEMORY_COMMIT_UNCERTAIN");
    const read = await store.readV6(); assert.ok(read.ok); assert.equal(read.value.entries.find(entry => entry.id === seed.value[0]!.id)?.privacyExcluded, true);
    assert.doesNotMatch(JSON.stringify(read.value), /我住在北京/);
    const undo = await store.writeV6([{ operation: "undo", id: newer.value[0]!.id, expectedRevision: newer.value[0]!.revision!, source: { kind: "manual" } }]); assert.equal(undo.ok, false);
    const before = await readFile(join(root, ".runloom/memory.json"));
    assert.ok((await new V6MemoryStore(root).excludeSources("t", ["北京"])).ok);
    assert.deepEqual(await readFile(join(root, ".runloom/memory.json")), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
