import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActionablePending } from "./pending-memory-query.js";

test("pending read keeps capacity-limited reviews, filters foreign/stale detail, and fails closed on a broken page", async () => {
  const candidate = { id: "limited", originThreadId: "thread", status: "pending" } as import("@serika/assistant").MemoryCandidate;
  const preview = { candidate, current: null, proposed: null, applicable: false, unavailableReason: "MEMORY_LIMIT_EXCEEDED" } as import("@serika/assistant").CandidatePreview;
  const read = await loadActionablePending({ listMemoryCandidates: async () => ({ ok: true, value: { candidates: [candidate, { ...candidate, id: "foreign", originThreadId: "other" }, { ...candidate, id: "stale", status: "stale" }], nextOffset: null, truncated: false } }), getMemoryCandidate: async () => ({ ok: true, value: preview }) }, "thread");
  assert.ok(read.ok); assert.deepEqual(read.value.candidates.map(item => item.id), ["limited"]);
  for (const unavailableReason of ["expired", "target_changed", "target_missing", "MEMORY_REVISION_CONFLICT"]) {
    const pending = await loadActionablePending({ listMemoryCandidates: async () => ({ ok: true, value: { candidates: [candidate], nextOffset: null, truncated: false } }), getMemoryCandidate: async () => ({ ok: true, value: { ...preview, unavailableReason } }) }, "thread");
    assert.ok(pending.ok); assert.equal(pending.value.candidates.length, 1, `${unavailableReason} does not silently settle a pending review`);
  }
  const failed = await loadActionablePending({ listMemoryCandidates: async () => ({ ok: false, error: { code: "READ_FAILED", message: "fixture" } }), getMemoryCandidate: async () => ({ ok: true, value: preview }) }, "thread");
  assert.equal(failed.ok, false, "read failure is not zero pending");
});
