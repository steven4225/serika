import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { createMemoryStore, type TemporalWorkspaceMemoryStore } from "./memory-store.js";
import { candidateFingerprint, type CandidateDraft } from "./memory-candidates.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const now = new Date("2026-10-04T00:00:00.000Z");
const options = { boundThreadId: "thread-a", now };
const source = { kind: "conversation" as const, threadId: "thread-a", messageId: "user-1", quote: "先结论" };
const extra = { ...source, messageId: "user-2", quote: "给两步" };
const add = (): CandidateDraft => ({ source, sources: [source, extra], reason: "两轮一致的显式偏好", change: { operation: "add", text: "复盘先结论，再给两步", kind: "preference", recallTerms: ["总结格式"], validTime: { from: null, to: null, basis: "unknown" }, scope: { kind: "workspace" }, expiresAt: null } });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "runloom-memory-b-")); roots.push(root); return { root, store: createMemoryStore(root), file: join(root, ".runloom/memory.json") }; }
async function stage(store: TemporalWorkspaceMemoryStore, draft: CandidateDraft, batchId: string) {
  const result = await store.commitCandidateBatch({ batchId, originThreadId: "thread-a", candidates: [draft], expectedCursor: null, nextCursor: null }, undefined, options);
  if (!result.ok) assert.fail(result.error.message);
  return result.value.candidateIds[0]!;
}
async function accept(store: TemporalWorkspaceMemoryStore, id: string) {
  const result = await store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "accept" }, undefined, options);
  if (!result.ok) assert.fail(result.error.message); return result.value;
}

it("persists all approved sources/terms/time and exact accepted replay stays write-free after reopen", async () => {
  const { root, store, file } = await fixture();
  const id = await stage(store, add(), "two-sources");
  const preview = await store.getCandidate(id, undefined, options);
  assert.equal(preview.ok, true); if (preview.ok) assert.deepEqual(preview.value.proposed?.recallTerms, ["总结格式"]);
  const receipt = await accept(store, id);
  const inspected = await store.inspectMemory(receipt.memoryId!, undefined, options);
  assert.equal(inspected.ok, true); if (inspected.ok) { assert.deepEqual(inspected.value.assertions[0]!.sources, [source, extra]); assert.deepEqual(inspected.value.assertions[0]!.recallTerms, ["总结格式"]); }
  const before = await readFile(file, "utf8");
  const replay = await createMemoryStore(root).resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "accept" }, undefined, options);
  assert.deepEqual(replay, { ok: true, value: { ...receipt, replayed: true } }); assert.equal(await readFile(file, "utf8"), before);
});

it("accepts real changes, preserves old applicability, and invalidates every sibling target operation", async () => {
  const { store } = await fixture();
  const receipt = await accept(store, await stage(store, add(), "add"));
  const target = { memoryId: receipt.memoryId!, expectedRevision: 1, expiresAt: null };
  const change: CandidateDraft = { ...add(), change: { operation: "change", ...target, text: "复盘用表格", effectiveAt: "2026-10-03T00:00:00Z", recallTerms: ["总结格式"] } };
  const sibling = await stage(store, { source, reason: "停止使用", change: { operation: "disable", ...target, text: "复盘先结论，再给两步" } }, "disable-sibling");
  const id = await stage(store, change, "change"); await accept(store, id);
  const old = await store.queryMemory(target.memoryId, { validAt: "2026-10-02T00:00:00Z" }, undefined, options);
  const current = await store.get(target.memoryId, undefined, options);
  assert.equal(old.ok, true); if (old.ok) assert.equal(old.value.assertions[0]?.text, "复盘先结论，再给两步");
  assert.equal(current.ok, true); if (current.ok) assert.equal(current.entry.text, "复盘用表格");
  const stale = await store.getCandidate(sibling, undefined, options); assert.equal(stale.ok, true); if (stale.ok) assert.equal(stale.value.candidate.status, "stale");
});

it("correct replaces erroneous recognition while retract leaves no current fact and historical knowledge remains queryable", async () => {
  const { root, store } = await fixture();
  const original = await store.add({ text: "错误偏好", kind: "preference" }, undefined, { ...options, now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(original.ok, true); if (!original.ok) return;
  const correction = await stage(store, { ...add(), change: { operation: "correct", memoryId: original.entry.id, expectedRevision: 1, text: "正确偏好", expiresAt: null, recallTerms: ["总结格式"] } }, "correct");
  await accept(store, correction);
  const oldKnowledge = await store.queryMemory(original.entry.id, { knownAt: "2026-10-02T00:00:00Z" }, undefined, options);
  assert.equal(oldKnowledge.ok, true); if (oldKnowledge.ok) assert.equal(oldKnowledge.value.assertions[0]?.text, "错误偏好");
  const withdrawal = await stage(store, { source, reason: "用户撤回", change: { operation: "retract", memoryId: original.entry.id, expectedRevision: 2, text: "正确偏好", expiresAt: null } }, "retract");
  const preview = await store.getCandidate(withdrawal, undefined, options); if (preview.ok) assert.equal(preview.value.proposed?.text, "");
  await accept(store, withdrawal);
  const reopened = await createMemoryStore(root).get(original.entry.id, undefined, options);
  assert.equal(reopened.ok, true); if (reopened.ok) { assert.equal(reopened.entry.text, ""); assert.equal(reopened.entry.enabled, false); assert.equal(reopened.entry.assertion, undefined); }
});

it("source-backed disable can stop an expired entry without clearing expiry, pin or scope", async () => {
  const { store } = await fixture();
  const saved = await store.add({ text: "过期偏好", kind: "preference", pinned: true, scope: { kind: "thread", threadId: "thread-a" }, expiresAt: "2026-10-02T00:00:00Z" }, undefined, { ...options, now: new Date("2026-10-01T00:00:00Z") });
  assert.equal(saved.ok, true); if (!saved.ok) return;
  const id = await stage(store, { source, reason: "用户明确停用", change: { operation: "disable", memoryId: saved.entry.id, expectedRevision: 1, text: "过期偏好", expiresAt: "2026-10-02T00:00:00.000Z" } }, "disable");
  await accept(store, id);
  const current = await store.get(saved.entry.id, undefined, options); assert.equal(current.ok, true);
  if (current.ok) { assert.equal(current.entry.status, "disabled"); assert.equal(current.entry.pinned, true); assert.deepEqual(current.entry.scope, saved.entry.scope); assert.equal(current.entry.expiresAt, saved.entry.expiresAt); }
});

it("checks target CAS after preview, purges new-operation candidates on deletion, and keeps legacy fingerprints stable", async () => {
  const { store } = await fixture();
  const receipt = await accept(store, await stage(store, add(), "initial"));
  const id = await stage(store, { source, reason: "更正", change: { operation: "correct", memoryId: receipt.memoryId!, expectedRevision: 1, text: "新的偏好", expiresAt: null } }, "correction");
  assert.equal((await store.getCandidate(id, undefined, options)).ok, true);
  await store.update(receipt.memoryId!, { expectedRevision: 1, pinned: true }, undefined, options);
  const stale = await store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "accept" }, undefined, options); assert.equal(stale.ok, false);
  await store.deleteMemory({ id: receipt.memoryId!, expectedRevision: 2 }, undefined, options);
  assert.equal((await store.getCandidate(id, undefined, options)).ok, false);
  const legacy: CandidateDraft = { source, reason: "旧候选", change: { operation: "add", text: "先结论", scope: { kind: "workspace" }, expiresAt: null } };
  const originalHash = candidateFingerprint("thread-a", legacy);
  const legacyId = await stage(store, legacy, "legacy");
  const loaded = await store.getCandidate(legacyId, undefined, options); if (loaded.ok) { assert.equal(loaded.value.candidate.fingerprint, originalHash); assert.equal(loaded.value.candidate.sources, undefined); }
});

it("rejects invalid new fields/sources as a whole batch without touching disk or cursor", async () => {
  const { store, file } = await fixture();
  await stage(store, add(), "seed");
  const before = await readFile(file, "utf8");
  for (const invalid of [
    { ...add(), sources: [extra, source] },
    { ...add(), sources: Array.from({ length: 5 }, () => source) },
    { ...add(), change: { ...add().change, recallTerms: ["x".repeat(97)] } },
    { ...add(), change: { ...add().change, systemTime: { from: "2020-01-01T00:00:00Z", to: null } } },
  ]) {
    const result = await store.commitCandidateBatch({ batchId: "bad", originThreadId: "thread-a", candidates: [add(), invalid as CandidateDraft], expectedCursor: null, nextCursor: null }, undefined, options);
    assert.equal(result.ok, false); assert.equal(await readFile(file, "utf8"), before);
  }
});

it("historical consolidation material includes relevant old/disabled assertions but excludes private timelines", async () => {
  const { store } = await fixture();
  const publicMemory = await store.add({ text: "旧公开偏好", kind: "preference" }, undefined, options);
  assert.equal(publicMemory.ok, true); if (!publicMemory.ok) return;
  await store.reviseMemory({ id: publicMemory.entry.id, expectedRevision: 1, operation: "correct", text: "新公开偏好" }, undefined, options);
  await store.update(publicMemory.entry.id, { expectedRevision: 2, enabled: false }, undefined, options);
  await store.add({ text: "私密事实", scope: { kind: "thread", threadId: "other" } }, undefined, { ...options, boundThreadId: "other" });
  const material = await store.listConsolidationMaterial!(undefined, options);
  assert.equal(material.ok, true); if (material.ok) { assert.equal(material.value.length, 1); assert.equal(material.value[0]?.enabled, false); assert.ok(material.value[0]?.relatedAssertions.some(assertion => assertion.text === "旧公开偏好")); assert.equal(JSON.stringify(material).includes("私密事实"), false); }
});

it("preview shows inherited terms/time and marks an impossible temporal edit unavailable without a write", async () => {
  const { store, file } = await fixture();
  const receipt = await accept(store, await stage(store, add(), "initial"));
  const corrected = await stage(store, { source, reason: "更正正文", change: { operation: "correct", memoryId: receipt.memoryId!, expectedRevision: 1, text: "复盘用三个步骤", expiresAt: null } }, "correct-preview");
  const before = await readFile(file, "utf8");
  const preview = await store.getCandidate(corrected, undefined, options); assert.ok(preview.ok);
  assert.deepEqual(preview.value.proposed?.recallTerms, ["总结格式"]);
  assert.deepEqual(preview.value.proposed?.validTime, { from: null, to: null, basis: "unknown" });
  assert.equal(await readFile(file, "utf8"), before);
  const note = await store.add({ text: "保存的笔记", kind: "note" }, undefined, options); assert.ok(note.ok);
  const invalid = await stage(store, { source, reason: "不合法的状态变更", change: { operation: "change", memoryId: note.entry.id, expectedRevision: 1, text: "新笔记", effectiveAt: now.toISOString(), expiresAt: null } }, "invalid-preview");
  const disk = await readFile(file, "utf8");
  const unavailable = await store.getCandidate(invalid, undefined, options); assert.ok(unavailable.ok);
  assert.equal(unavailable.value.applicable, false); assert.equal(unavailable.value.proposed, null);
  assert.equal(unavailable.value.unavailableReason, "MEMORY_TEMPORAL_CONFLICT");
  assert.equal(await readFile(file, "utf8"), disk);
});

it("filtered private history is marked partial instead of a complete shared timeline", async () => {
  const { store } = await fixture();
  const added = await store.add({ text: "private old fact", scope: { kind: "thread", threadId: "other" } }, undefined, { ...options, boundThreadId: "other" }); assert.ok(added.ok);
  await store.update(added.entry.id, { expectedRevision: 1, scope: { kind: "workspace" }, text: "public new fact" }, undefined, { ...options, boundThreadId: "other" });
  const material = await store.listConsolidationMaterial!(undefined, options); assert.ok(material.ok);
  assert.equal(material.value[0]?.historyCoverage, "legacy_partial"); assert.doesNotMatch(JSON.stringify(material), /private old fact/);
});
