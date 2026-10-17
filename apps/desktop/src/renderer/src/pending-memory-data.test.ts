import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CandidatePreview, MemoryCandidate } from "@serika/assistant";
import { canAccept, canReject, resolvePayload, scopeLabel, sourceQuote } from "../../shared/memory-review.js";
import { initialPendingMemory, pendingMemoryReducer, pendingMemoryStatus } from "./pending-memory-data.js";

function candidate(id: string, revision = 1): MemoryCandidate {
  return {
    id,
    revision,
    batchId: "batch-a",
    originThreadId: "thread-a",
    fingerprint: id,
    createdAt: "2026-10-03T00:00:00.000Z",
    resolvedAt: null,
    status: "pending",
    staleReason: null,
    appliedResult: null,
    change: { operation: "add", text: "列表摘要", scope: { kind: "workspace" }, expiresAt: null },
    source: { kind: "conversation", threadId: "thread-a", messageId: "message-a", quote: "我的原话不是助手生成的建议。" },
    reason: "用户明确陈述的长期偏好",
  };
}

function preview(id: string, revision = 3): CandidatePreview {
  const item = candidate(id, revision);
  return {
    candidate: { ...item, change: { ...item.change, text: "完整拟保存正文" } },
    current: null,
    proposed: { text: "完整拟保存正文", scope: { kind: "workspace" }, expiresAt: null, pinned: false, status: "active" },
    applicable: true,
    unavailableReason: null,
  };
}

function loaded() {
  let state = pendingMemoryReducer(initialPendingMemory(), { type: "list-start", request: 1, append: false });
  state = pendingMemoryReducer(state, {
    type: "list-result", request: 1,
    result: { ok: true, value: { candidates: [candidate("a"), candidate("b")], nextOffset: 2, truncated: true } },
  });
  state = pendingMemoryReducer(state, { type: "select", id: "a", request: 1 });
  return pendingMemoryReducer(state, { type: "detail-result", request: 1, id: "a", result: { ok: true, value: preview("a") } });
}

describe("conversation pending memory", () => {
  it("does not accept the list item and submits only the full displayed preview revision", () => {
    const listOnly = { ...initialPendingMemory(), candidates: [candidate("a")] };
    assert.equal(canAccept(listOnly), false);
    assert.equal(canReject(listOnly), false);
    const opened = loaded();
    assert.equal(canAccept(opened), true);
    assert.equal(opened.preview?.proposed?.text, "完整拟保存正文");
    assert.equal(sourceQuote(opened.preview!), "我的原话不是助手生成的建议。");
    assert.deepEqual(resolvePayload(opened.preview!, "accept"), {
      candidateId: "a", expectedCandidateRevision: 3, decision: "accept",
    });
  });

  it("reports loaded pending count and pagination, without inventing a total", () => {
    const state = loaded();
    assert.deepEqual(pendingMemoryStatus(state, true, true, true), {
      count: 2, hasMore: true, loading: false, error: null, reviewing: true,
    });
    assert.equal(pendingMemoryStatus(state, true, false, true).reviewing, false);
    assert.equal(pendingMemoryStatus(state, true, true, false).loading, true);
    assert.equal(pendingMemoryStatus(state, true, true, false).reviewing, false);
    assert.deepEqual(pendingMemoryStatus(state, false, true, true), {
      count: 0, hasMore: false, loading: false, error: null, reviewing: false,
    });
  });

  it("invalidates decisions immediately and discards stale list and detail responses", () => {
    const before = loaded();
    const invalidated = pendingMemoryReducer(before, { type: "invalidate", listRequest: 2, detailRequest: 2 });
    assert.equal(canAccept(invalidated), false);
    assert.equal(canReject(invalidated), false);
    const lateDetail = pendingMemoryReducer(invalidated, {
      type: "detail-result", request: 1, id: "a", result: { ok: true, value: preview("a", 9) },
    });
    assert.equal(lateDetail, invalidated);
    const lateList = pendingMemoryReducer(invalidated, {
      type: "list-result", request: 1,
      result: { ok: true, value: { candidates: [candidate("late")], nextOffset: null, truncated: false } },
    });
    assert.equal(lateList, invalidated);
    const updated = pendingMemoryReducer(invalidated, {
      type: "detail-result", request: 2, id: "a", result: { ok: true, value: preview("a", 4) },
    });
    assert.equal(updated.previewChanged, true);
    assert.equal(canAccept(updated), true);
    assert.equal(resolvePayload(updated.preview!, "accept").expectedCandidateRevision, 4);
  });

  it("removes the reviewed card only after a confirmed terminal result, then allows the next candidate", () => {
    const waiting = pendingMemoryReducer(loaded(), { type: "resolve-start", decision: "accept" });
    assert.equal(canAccept(waiting), false);
    assert.equal(waiting.candidates.length, 2);
    const done = pendingMemoryReducer(waiting, {
      type: "resolve-result",
      result: { ok: true, value: { candidateId: "a", status: "accepted", memoryId: "memory-a", memoryRevision: 1, replayed: false } },
    });
    assert.equal(done.preview, null);
    assert.equal(done.selectedId, null);
    assert.deepEqual(done.candidates.map((item) => item.id), ["b"]);
    assert.match(done.receipt ?? "", /完整拟保存正文/);
    assert.doesNotMatch(done.receipt ?? "", /memory-a/);
    assert.match(done.receiptDetail ?? "", /memory-a/);
    const next = pendingMemoryReducer(done, { type: "select", id: "b", request: 2 });
    assert.equal(canAccept(next), false);
    const opened = pendingMemoryReducer(next, { type: "detail-result", request: 2, id: "b", result: { ok: true, value: preview("b") } });
    assert.equal(canAccept(opened), true);
    assert.equal(opened.preview?.candidate.id, "b");
  });

  it("does not resend an unknown outcome and rereads the same candidate before advancing", () => {
    const waiting = pendingMemoryReducer(loaded(), { type: "resolve-start", decision: "reject" });
    const unknown = pendingMemoryReducer(waiting, { type: "resolve-unconfirmed" });
    assert.equal(unknown.selectedId, "a");
    assert.equal(canAccept(unknown), false);
    assert.equal(canReject(unknown), false);
    assert.equal(pendingMemoryReducer(unknown, { type: "resolve-start", decision: "reject" }), unknown);
    const reread = pendingMemoryReducer(unknown, { type: "invalidate", listRequest: 2, detailRequest: 2 });
    const failedRead = pendingMemoryReducer(reread, {
      type: "detail-result", request: 2, id: "a",
      result: { ok: false, error: { code: "IPC_FAILED", message: "结果未确认" } },
    });
    assert.equal(canAccept(failedRead), false);
    assert.equal(canReject(failedRead), false);
    const stillPending = pendingMemoryReducer(reread, { type: "detail-result", request: 2, id: "a", result: { ok: true, value: preview("a") } });
    assert.equal(stillPending.reviewError, null);
    assert.equal(stillPending.outcomeUnknown, false);
    assert.match(stillPending.receipt ?? "", /没有自动重发/);
    const rejected = { ...preview("a"), candidate: { ...preview("a").candidate, status: "rejected" as const }, applicable: false };
    const confirmed = pendingMemoryReducer(reread, { type: "detail-result", request: 2, id: "a", result: { ok: true, value: rejected } });
    assert.equal(confirmed.preview, null);
    assert.equal(confirmed.selectedId, null);
    assert.equal(confirmed.outcomeUnknown, false);
  });

  it("does not repeatedly select a candidate removed between list and detail reads", () => {
    const gone = pendingMemoryReducer(loaded(), {
      type: "detail-result", request: 1, id: "a",
      result: { ok: false, error: { code: "MEMORY_CANDIDATE_NOT_FOUND", message: "Record not found" } },
    });
    assert.equal(gone.selectedId, null);
    assert.deepEqual(gone.candidates.map((item) => item.id), ["b"]);
    assert.equal(gone.detailError?.code, "MEMORY_CANDIDATE_NOT_FOUND");
  });

  it("keeps unavailable targets and busy controllers non-writable", () => {
    const opened = loaded();
    const busy = pendingMemoryReducer(opened, { type: "controller", idle: false });
    assert.equal(canAccept(busy), false);
    assert.equal(canReject(busy), false);
    const missing: CandidatePreview = {
      ...preview("a"),
      candidate: { ...preview("a").candidate, change: { operation: "update", memoryId: "missing", expectedRevision: 1, text: "更新正文", expiresAt: null } },
      current: null, proposed: null, applicable: false, unavailableReason: "target_missing",
    };
    const unavailable = pendingMemoryReducer(opened, { type: "detail-result", request: 1, id: "a", result: { ok: true, value: missing } });
    assert.equal(scopeLabel(unavailable.preview!), null);
    assert.equal(canAccept(unavailable), false);
    assert.equal(canReject(unavailable), true);
  });

  it("does not turn a corrupt file into an empty list or preserve an old selection when disabled", () => {
    const invalid = pendingMemoryReducer(initialPendingMemory(), {
      type: "list-result", request: 0,
      result: { ok: false, error: { code: "MEMORY_FILE_INVALID", message: "损坏的候选文件" } },
    });
    assert.match(pendingMemoryStatus(invalid, true, true, true).error ?? "", /MEMORY_FILE_INVALID/);
    const empty = pendingMemoryReducer(initialPendingMemory(), {
      type: "list-result", request: 0,
      result: { ok: true, value: { candidates: [], nextOffset: null, truncated: false } },
    });
    assert.equal(pendingMemoryStatus(empty, true, true, true).error, null);
    const disabled = pendingMemoryReducer(loaded(), { type: "disabled" });
    assert.equal(disabled.preview, null);
    assert.equal(disabled.candidates.length, 0);
    assert.equal(canAccept(disabled), false);
  });
});
