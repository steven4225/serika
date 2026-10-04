import assert from "node:assert/strict";
import fsPromises, { mkdtemp, mkdir, readFile, rm, writeFile, open } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { createMemoryStore, MEMORY_FILE_MAX_BYTES } from "./memory-store.js";
import type { CandidateDraft, ConsolidationCursor } from "./memory-candidates.js";
import { candidateFingerprint } from "./memory-candidates.js";
import { acquireFlock } from "./flock.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runloom-candidates-")); directories.push(root);
  return { root, store: createMemoryStore(root), file: join(root, ".runloom/memory.json") };
}
const opts = { boundThreadId: "thread-a", now: new Date("2026-10-01T00:00:00Z") };
function draft(text = "用户偏好先给结论"): CandidateDraft {
  return { change: { operation: "add", text, scope: { kind: "workspace" }, expiresAt: null }, source: { kind: "conversation", threadId: "thread-a", messageId: "message-1", quote: "先给结论" }, reason: "明确的长期偏好" };
}
function cursor(batch = "batch-1", message = "message-1"): ConsolidationCursor {
  return { threadId: "thread-a", throughMessageId: message, prefixHash: `v1:${message}`, lastBatchId: batch, updatedAt: opts.now.toISOString() };
}

it("persists pending and cursor together; accepting is atomic and exact replay does not duplicate", async () => {
  const { root, store, file } = await fixture();
  const input = { batchId: "batch-1", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: cursor() };
  const committed = await store.commitCandidateBatch(input, undefined, opts); assert.equal(committed.ok, true); if (!committed.ok) return;
  const id = committed.value.candidateIds[0]!;
  assert.deepEqual(await store.list(), { ok: true, entries: [] });
  const disk = JSON.parse(await readFile(file, "utf8")); assert.equal(disk.version, 4); assert.equal(disk.consolidationCursors[0].throughMessageId, "message-1");
  const reopened = createMemoryStore(root);
  const preview = await reopened.getCandidate(id, undefined, opts); assert.equal(preview.ok, true); if (preview.ok) assert.equal(preview.value.applicable, true);
  const accepted = await reopened.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "accept" }, undefined, opts); assert.equal(accepted.ok, true); if (!accepted.ok) return;
  const replay = await store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "accept" }, undefined, opts);
  assert.deepEqual(replay, { ok: true, value: { ...accepted.value, replayed: true } });
  const wrong = await store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 2, decision: "accept" }, undefined, opts); assert.equal(wrong.ok, false);
  const opposite = await store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "reject" }, undefined, opts); assert.equal(opposite.ok, false);
  const entries = await store.list(); if (entries.ok) assert.equal(entries.entries.length, 1);
  const batchReplay = await store.commitCandidateBatch(input, undefined, opts); if (batchReplay.ok) assert.equal(batchReplay.value.replayed, true); else assert.fail(batchReplay.error.message);
});

it("isolates candidates by origin Thread, rejects missing binding, and rejects without entries", async () => {
  const { store } = await fixture();
  const committed = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts); if (!committed.ok) assert.fail(committed.error.message);
  const id = committed.value.candidateIds[0]!;
  assert.equal((await store.listCandidates()).ok, false);
  const other = await store.getCandidate(id, undefined, { boundThreadId: "thread-b" }); assert.equal(other.ok, false); if (!other.ok) assert.equal(other.error.code, "MEMORY_CANDIDATE_NOT_FOUND");
  const rejected = await store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "reject" }, undefined, opts); assert.equal(rejected.ok, true);
  assert.deepEqual(await store.list(), { ok: true, entries: [] });
  const second = await store.commitCandidateBatch({ batchId: "b2", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts); if (second.ok) assert.deepEqual(second.value.candidateIds, [id]);
});

it("one identical pending transition from separate messages needs only one review", async () => {
  const { store } = await fixture();
  const first = await store.commitCandidateBatch({ batchId: "first", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts);
  assert.ok(first.ok);
  const repeated = { ...draft(), source: { kind: "conversation" as const, threadId: "thread-a", messageId: "message-2", quote: "也先给结论" } };
  const input = { batchId: "second", originThreadId: "thread-a", candidates: [repeated], expectedCursor: null, nextCursor: cursor("second", "message-2") };
  const second = await store.commitCandidateBatch(input, undefined, opts);
  assert.ok(second.ok); assert.deepEqual(second.value.candidateIds, first.value.candidateIds);
  const listed = await store.listCandidates({}, undefined, opts); assert.ok(listed.ok); assert.equal(listed.value.candidates.length, 1);
  assert.ok((await store.commitCandidateBatch(input, undefined, opts)).ok);
  const accepted = await store.resolveCandidate({ candidateId: first.value.candidateIds[0]!, expectedCandidateRevision: 1, decision: "accept" }, undefined, opts);
  assert.ok(accepted.ok);
  const entries = await store.list(); assert.ok(entries.ok); assert.equal(entries.entries.length, 1);
});

it("updates preserve pinned/scope and stale sibling proposals and direct writes", async () => {
  const { store } = await fixture();
  const added = await store.add({ text: "old", pinned: true, scope: { kind: "thread", threadId: "thread-a" } }, undefined, opts); if (!added.ok) assert.fail(added.error.message);
  const update = (text: string): CandidateDraft => ({ ...draft(), change: { operation: "update", memoryId: added.entry.id, expectedRevision: 1, text, expiresAt: null } });
  const batch = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [update("new"), update("alternative")], expectedCursor: null, nextCursor: null }, undefined, opts); if (!batch.ok) assert.fail(batch.error.message);
  const [first, sibling] = batch.value.candidateIds;
  assert.equal((await store.resolveCandidate({ candidateId: first!, expectedCandidateRevision: 1, decision: "accept" }, undefined, opts)).ok, true);
  const entry = await store.get(added.entry.id, undefined, opts); if (entry.ok) { assert.equal(entry.entry.pinned, true); assert.equal(entry.entry.scope?.kind, "thread"); assert.equal(entry.entry.history?.[0]?.pinned, true); }
  const stale = await store.getCandidate(sibling!, undefined, opts); if (stale.ok) { assert.equal(stale.value.candidate.status, "stale"); assert.equal(stale.value.current?.text, "new"); assert.equal("history" in stale.value.current!, false); }
  const b2 = await store.commitCandidateBatch({ batchId: "b2", originThreadId: "thread-a", candidates: [{ ...update("later"), change: { operation: "update", memoryId: added.entry.id, expectedRevision: 2, text: "later", expiresAt: null } }], expectedCursor: null, nextCursor: null }, undefined, opts); if (!b2.ok) assert.fail(b2.error.message);
  await store.delete(added.entry.id, undefined, opts);
  const deleted = await store.getCandidate(b2.value.candidateIds[0]!, undefined, opts); assert.equal(deleted.ok, false); if (!deleted.ok) assert.equal(deleted.error.code, "MEMORY_CANDIDATE_NOT_FOUND");
});

it("CAS protects cursor, manual batches ignore it, and empty batches advance it", async () => {
  const { store, file } = await fixture();
  assert.equal((await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [], expectedCursor: null, nextCursor: cursor("b") }, undefined, opts)).ok, true);
  const before = await readFile(file, "utf8");
  const mismatch = await store.commitCandidateBatch({ batchId: "b2", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: cursor("b2", "message-2") }, undefined, opts); if (!mismatch.ok) assert.equal(mismatch.error.code, "MEMORY_CURSOR_MISMATCH"); else assert.fail("expected conflict");
  assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await store.commitCandidateBatch({ batchId: "manual", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts)).ok, true);
  const next = await store.commitCandidateBatch({ batchId: "b2", originThreadId: "thread-a", candidates: [], expectedCursor: cursor("b"), nextCursor: cursor("b2", "message-2") }, undefined, opts); assert.equal(next.ok, true);
});

it("does not create or migrate a file for an empty manual batch", async () => {
  const { root, store, file } = await fixture();
  const empty = { batchId: "manual-empty", originThreadId: "thread-a", candidates: [], expectedCursor: null, nextCursor: null };
  assert.equal((await store.commitCandidateBatch(empty, undefined, opts)).ok, true);
  await assert.rejects(readFile(file), { code: "ENOENT" });
  await mkdir(join(root, ".runloom"), { recursive: true });
  const legacy = JSON.stringify({ version: 1, entries: [{ id: "legacy", text: "existing", enabled: true }] });
  await writeFile(file, legacy);
  assert.equal((await store.commitCandidateBatch(empty, undefined, opts)).ok, true);
  assert.equal(await readFile(file, "utf8"), legacy);
});

it("serializes competing acceptance and rejects entire invalid batch without moving cursor", async () => {
  const { root, store, file } = await fixture();
  const committed = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts); if (!committed.ok) assert.fail(committed.error.message);
  const request = { candidateId: committed.value.candidateIds[0]!, expectedCandidateRevision: 1, decision: "accept" as const };
  const results = await Promise.all([store.resolveCandidate(request, undefined, opts), createMemoryStore(root).resolveCandidate(request, undefined, opts)]);
  assert.equal(results.filter((r) => r.ok && !r.value.replayed).length, 1); assert.equal(results.filter((r) => r.ok && r.value.replayed).length, 1);
  const before = await readFile(file, "utf8");
  const invalid = { ...draft("another"), source: { ...draft().source, threadId: "foreign" } };
  assert.equal((await store.commitCandidateBatch({ batchId: "invalid", originThreadId: "thread-a", candidates: [draft("valid"), invalid], expectedCursor: null, nextCursor: cursor("invalid") }, undefined, opts)).ok, false);
  assert.equal(await readFile(file, "utf8"), before);
});

it("checks expiry at execution; keeps pending unchanged when cancelled while waiting for lock", async () => {
  const { store, root, file } = await fixture();
  const expiring = draft(); expiring.change.expiresAt = "2026-10-02T00:00:00Z";
  const result = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [expiring], expectedCursor: null, nextCursor: null }, undefined, opts); if (!result.ok) assert.fail(result.error.message);
  const id = result.value.candidateIds[0]!;
  const lock = await acquireFlock(join(root, ".runloom/memory.json.lock"), new AbortController().signal);
  const abort = new AbortController(); const before = await readFile(file, "utf8");
  const resolve = store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "accept" }, abort.signal, opts); abort.abort(new Error("cancelled")); await assert.rejects(resolve, /cancelled/); await lock.release();
  assert.equal(await readFile(file, "utf8"), before);
  const expired = await store.resolveCandidate({ candidateId: id, expectedCandidateRevision: 1, decision: "accept" }, undefined, { ...opts, now: new Date("2026-10-03T00:00:00Z") }); if (!expired.ok) assert.equal(expired.error.code, "MEMORY_CANDIDATE_STALE"); else assert.fail("expected stale");
  const preview = await store.getCandidate(id, undefined, opts); if (preview.ok) assert.equal(preview.value.candidate.status, "stale");
  assert.deepEqual(await store.list(), { ok: true, entries: [] });
});

it("fails closed on oversized file before parsing and preserves v2 until successful mutation", async () => {
  const { root, store, file } = await fixture(); await mkdir(join(root, ".runloom"));
  const entry = { id: "old", text: "old", enabled: false, status: "disabled", scope: { kind: "workspace" }, source: { kind: "legacy" }, revision: 1, history: [], createdAt: null, updatedAt: null, expiresAt: null };
  await writeFile(file, JSON.stringify({ version: 2, entries: [entry] }));
  const list = await store.list(); if (list.ok) assert.equal(list.entries[0]?.pinned, false);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 2);
  await store.add({ text: "new" }, undefined, opts); assert.equal(JSON.parse(await readFile(file, "utf8")).version, 4);
  const handle = await open(file, "r+"); await handle.truncate(MEMORY_FILE_MAX_BYTES + 1); await handle.close();
  const result = await store.list(); if (!result.ok) assert.equal(result.error.code, "MEMORY_LIMIT_EXCEEDED"); else assert.fail("oversized file accepted");
});

it("enforces global pending capacity, paginates bounded results, and prunes only old terminal records", async () => {
  const { store, file } = await fixture();
  const initial = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts); if (!initial.ok) assert.fail(initial.error.message);
  const document = JSON.parse(await readFile(file, "utf8"));
  const template = document.candidates[0];
  document.candidates = Array.from({ length: 64 }, (_, index) => {
    const value = draft(`candidate-${index}`); return { ...template, ...value, id: `id-${index}`, fingerprint: candidateFingerprint("thread-a", value) };
  });
  await writeFile(file, JSON.stringify(document));
  assert.deepEqual(await store.checkCandidateCapacity(), { ok: true, value: { pendingCount: 64, canStart: false } });
  const before = await readFile(file, "utf8");
  const full = await store.commitCandidateBatch({ batchId: "new", originThreadId: "thread-a", candidates: [draft("new")], expectedCursor: null, nextCursor: cursor("new") }, undefined, opts); if (!full.ok) assert.equal(full.error.code, "MEMORY_LIMIT_EXCEEDED"); else assert.fail("expected full queue");
  assert.equal(await readFile(file, "utf8"), before);
  const page = await store.listCandidates({ limit: 50 }, undefined, opts); if (!page.ok) assert.fail(page.error.message);
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 16384); assert.equal(page.value.truncated, true); assert.ok(page.value.nextOffset! > 0);
  document.candidates = Array.from({ length: 256 }, (_, index) => {
    const value = draft(`terminal-${index}`); return { ...template, ...value, id: `terminal-${index}`, fingerprint: candidateFingerprint("thread-a", value), revision: 2, status: "rejected", resolvedAt: "2026-09-30T00:00:00Z" };
  });
  document.candidates.push({ ...template, id: "pending-new", fingerprint: candidateFingerprint("thread-a", draft()) });
  await writeFile(file, JSON.stringify(document));
  const resolved = await store.resolveCandidate({ candidateId: "pending-new", expectedCandidateRevision: 1, decision: "reject" }, undefined, opts); assert.equal(resolved.ok, true);
  const after = JSON.parse(await readFile(file, "utf8")); assert.equal(after.candidates.length, 256); assert.ok(after.candidates.some((c: { id: string }) => c.id === "pending-new"));
  const removed = document.candidates.find((candidate: { id: string }) => !after.candidates.some((c: { id: string }) => c.id === candidate.id));
  const gone = await store.getCandidate(removed.id, undefined, opts); if (!gone.ok) assert.equal(gone.error.code, "MEMORY_CANDIDATE_NOT_FOUND");
});

it("rename failure leaves both entries and candidate receipt unchanged", async (context) => {
  const { store, file } = await fixture();
  const initial = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts); if (!initial.ok) assert.fail(initial.error.message);
  const before = await readFile(file, "utf8");
  const renameMock = context.mock.method(fsPromises, "rename", async () => { throw new Error("injected rename failure"); }); syncBuiltinESMExports();
  try {
    const result = await store.resolveCandidate({ candidateId: initial.value.candidateIds[0]!, expectedCandidateRevision: 1, decision: "accept" }, undefined, opts);
    if (!result.ok) assert.equal(result.error.code, "WRITE_FAILED"); else assert.fail("expected write failure");
    assert.equal(await readFile(file, "utf8"), before);
  } finally { renameMock.mock.restore(); syncBuiltinESMExports(); }
});

it("rejects forged accepted lifecycle receipts and never revives disabled deterministic duplicates", async () => {
  const { store, file } = await fixture();
  const disabled = await store.add({ text: draft().change.text, enabled: false }, undefined, opts); assert.equal(disabled.ok, true);
  const duplicate = await store.commitCandidateBatch({ batchId: "duplicate", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: cursor("duplicate") }, undefined, opts);
  if (duplicate.ok) assert.deepEqual(duplicate.value.candidateIds, []); else assert.fail(duplicate.error.message);
  const entries = await store.list(); if (entries.ok) assert.equal(entries.entries[0]?.enabled, false);
  const initial = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [draft("different")], expectedCursor: null, nextCursor: null }, undefined, opts); if (!initial.ok) assert.fail(initial.error.message);
  const document = JSON.parse(await readFile(file, "utf8")); document.candidates[0].status = "accepted"; document.candidates[0].revision = 2; document.candidates[0].resolvedAt = opts.now.toISOString();
  await writeFile(file, JSON.stringify(document));
  const corrupted = await store.list(); if (!corrupted.ok) assert.equal(corrupted.error.code, "MEMORY_FILE_INVALID"); else assert.fail("forged receipt accepted");
});

it("allows rejecting a pending expired candidate and rejects replayed batch reason changes", async () => {
  const { store } = await fixture();
  const expiring = draft(); expiring.change.expiresAt = "2026-10-02T00:00:00Z";
  const input = { batchId: "b", originThreadId: "thread-a", candidates: [expiring], expectedCursor: null, nextCursor: null };
  const first = await store.commitCandidateBatch(input, undefined, opts); if (!first.ok) assert.fail(first.error.message);
  const altered = await store.commitCandidateBatch({ ...input, candidates: [{ ...expiring, reason: "changed after review" }] }, undefined, opts); if (!altered.ok) assert.equal(altered.error.code, "MEMORY_BATCH_INVALID"); else assert.fail("changed reason replay accepted");
  const result = await store.resolveCandidate({ candidateId: first.value.candidateIds[0]!, expectedCandidateRevision: 1, decision: "reject" }, undefined, { ...opts, now: new Date("2026-10-03T00:00:00Z") });
  assert.equal(result.ok, true); if (result.ok) assert.equal(result.value.status, "rejected");
  assert.deepEqual(await store.list(), { ok: true, entries: [] });
});

it("reports committed acceptance even when cancellation arrives immediately after rename", async (context) => {
  const { store } = await fixture();
  const initial = await store.commitCandidateBatch({ batchId: "b", originThreadId: "thread-a", candidates: [draft()], expectedCursor: null, nextCursor: null }, undefined, opts); if (!initial.ok) assert.fail(initial.error.message);
  const abort = new AbortController();
  const original = fsPromises.rename;
  const renameMock = context.mock.method(fsPromises, "rename", async (...args: Parameters<typeof original>) => { await original(...args); abort.abort(new Error("cancelled after commit")); }); syncBuiltinESMExports();
  try {
    const accepted = await store.resolveCandidate({ candidateId: initial.value.candidateIds[0]!, expectedCandidateRevision: 1, decision: "accept" }, abort.signal, opts);
    assert.equal(accepted.ok, true);
    const entries = await store.list(); if (entries.ok) assert.equal(entries.entries.length, 1);
  } finally { renameMock.mock.restore(); syncBuiltinESMExports(); }
});

it("rejects a write that exceeds total document bytes without overwriting the prior file", async () => {
  const { store, file } = await fixture(); await store.add({ text: "old" }); const before = await readFile(file, "utf8");
  const large = await store.add({ text: "new", source: { kind: "conversation", threadId: "thread-a", messageId: "m", quote: "q".repeat(MEMORY_FILE_MAX_BYTES) } });
  if (!large.ok) assert.equal(large.error.code, "MEMORY_LIMIT_EXCEEDED"); else assert.fail("oversized document written");
  assert.equal(await readFile(file, "utf8"), before);
});
