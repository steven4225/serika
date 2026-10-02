import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CandidatePreview, MemoryCandidate } from "@aisdk-agent/example-cli/dist/memory-candidates.js";
import {
  canAccept,
  canReject,
  capabilityText,
  initialMemoryPanel,
  loadedLabel,
  memoryPanelReducer,
  proposedText,
  resolvePayload,
  scopeLabel,
  sourceQuote,
  unavailableLabel,
} from "./memory-review.js";

function candidate(id: string, text: string, revision = 1): MemoryCandidate {
  return {
    id,
    revision,
    batchId: "batch",
    originThreadId: "thread-a",
    fingerprint: id,
    createdAt: "2026-10-01T00:00:00.000Z",
    resolvedAt: null,
    status: "pending",
    staleReason: null,
    appliedResult: null,
    change: { operation: "add", text, scope: { kind: "workspace" }, expiresAt: null },
    source: { kind: "conversation", threadId: "thread-a", messageId: "message-1", quote: "先给结论" },
    reason: "长期偏好",
  };
}

function preview(id = "c1", text = "先给结论"): CandidatePreview {
  const item = candidate(id, text);
  return {
    candidate: item,
    current: null,
    proposed: { text, scope: { kind: "workspace" }, expiresAt: null, pinned: false, status: "active" },
    applicable: true,
    unavailableReason: null,
  };
}

function ready(item: CandidatePreview = preview()) {
  return memoryPanelReducer(
    { ...initialMemoryPanel(), controllerIdle: true },
    { type: "detail-result", request: 0, id: "c1", result: { ok: true, value: item } },
  );
}

describe("memory candidate review state", () => {
  it("sends the candidate revision from the open preview", () => {
    const open = preview();
    open.candidate.revision = 4;
    assert.deepEqual(resolvePayload(open, "accept"), {
      candidateId: "c1",
      expectedCandidateRevision: 4,
      decision: "accept",
    });
  });

  it("ignores a second accept while the first request is in flight", () => {
    const open = memoryPanelReducer(
      { ...initialMemoryPanel(), preview: preview(), selectedId: "c1" },
      { type: "resolve-start", decision: "accept" },
    );
    assert.equal(open.resolving, true);
    const again = memoryPanelReducer(open, { type: "resolve-start", decision: "accept" });
    assert.equal(again, open);
  });

  it("does not retry when revision conflicts or the candidate is stale", () => {
    const open = memoryPanelReducer(
      { ...initialMemoryPanel(), preview: preview(), selectedId: "c1", resolving: true },
      { type: "resolve-start", decision: "accept" },
    );
    const conflict = memoryPanelReducer(open, {
      type: "resolve-result",
      result: { ok: false, error: { code: "MEMORY_CANDIDATE_CONFLICT", message: "Candidate revision changed" } },
    });
    assert.equal(conflict.resolving, false);
    assert.match(conflict.reviewError ?? "", /重新核对/);
    assert.equal(conflict.preview?.candidate.revision, 1);
    assert.equal(conflict.receipt, null);

    const stale = memoryPanelReducer(open, {
      type: "resolve-result",
      result: { ok: false, error: { code: "MEMORY_CANDIDATE_STALE", message: "Candidate is stale: target_changed" } },
    });
    assert.match(stale.reviewError ?? "", /MEMORY_CANDIDATE_STALE/);
    assert.equal(stale.resolving, false);
  });

  it("describes a busy conflict separately from a revision conflict", () => {
    const busy = memoryPanelReducer(
      { ...initialMemoryPanel(), controllerIdle: false, preview: preview(), selectedId: "c1", resolving: true },
      {
        type: "resolve-result",
        result: { ok: false, error: { code: "MEMORY_CANDIDATE_CONFLICT", message: "Memory review requires an idle controller" } },
      },
    );
    assert.equal(busy.reviewError, "当前忙，空闲后再试");
  });

  it("keeps an older detail response from replacing the current selection", () => {
    let state = memoryPanelReducer(initialMemoryPanel(), { type: "select", id: "c2", request: 2 });
    state = memoryPanelReducer(state, {
      type: "detail-result",
      request: 1,
      id: "c1",
      result: { ok: true, value: preview("c1", "旧稿") },
    });
    assert.equal(state.preview, null);
    assert.equal(state.selectedId, "c2");
    state = memoryPanelReducer(state, {
      type: "detail-result",
      request: 2,
      id: "c2",
      result: { ok: true, value: preview("c2", "新稿") },
    });
    assert.equal(state.preview?.candidate.id, "c2");
    assert.equal(proposedText(state.preview!), "新稿");
  });

  it("pages with nextOffset and resets the list when memory changes", () => {
    let state = memoryPanelReducer(initialMemoryPanel(), { type: "list-start", request: 1, append: false });
    state = memoryPanelReducer(state, {
      type: "list-result",
      request: 1,
      result: { ok: true, value: { candidates: [candidate("a", "one")], nextOffset: 1, truncated: true } },
    });
    state = memoryPanelReducer(state, { type: "list-start", request: 2, append: true });
    state = memoryPanelReducer(state, {
      type: "list-result",
      request: 1,
      result: { ok: true, value: { candidates: [candidate("stale", "gone")], nextOffset: null, truncated: false } },
    });
    assert.deepEqual(state.candidates.map((item) => item.id), ["a"]);
    state = memoryPanelReducer(state, {
      type: "list-result",
      request: 2,
      result: { ok: true, value: { candidates: [candidate("a", "one"), candidate("b", "two")], nextOffset: null, truncated: false } },
    });
    assert.deepEqual(state.candidates.map((item) => item.id), ["a", "b"]);
    assert.equal(loadedLabel(state.candidates.length), "已加载 2 条");
    state = memoryPanelReducer(state, {
      type: "resolve-result",
      result: { ok: true, value: { candidateId: "a", status: "accepted", memoryId: "mem", memoryRevision: 1, replayed: false } },
    });
    const receipt = "已接受候选。写入记忆 mem，本次写入版本为 revision 1。";
    assert.equal(state.receipt, null);
    state = { ...state, resolving: true };
    state = memoryPanelReducer(state, {
      type: "resolve-result",
      result: { ok: true, value: { candidateId: "a", status: "accepted", memoryId: "mem", memoryRevision: 1, replayed: false } },
    });
    assert.equal(state.receipt, receipt);
    state = memoryPanelReducer(state, { type: "invalidate", listRequest: 3, detailRequest: 3 });
    assert.deepEqual(state.candidates, []);
    assert.equal(state.nextOffset, null);
    assert.equal(state.receipt, receipt);
  });

  it("disables accept when the preview must be reread, and still allows reject of a pending candidate", () => {
    const open = { ...initialMemoryPanel(), preview: preview(), selectedId: "c1" };
    assert.equal(canAccept(open), true);
    assert.equal(canReject(open), true);
    const stalePreview = {
      ...open,
      previewNeedsReview: true,
      preview: {
        ...preview(),
        applicable: false,
        unavailableReason: "target_changed",
        proposed: null,
      },
    };
    assert.equal(canAccept(stalePreview), false);
    assert.equal(canReject(stalePreview), true);
    const reloaded = memoryPanelReducer(stalePreview, {
      type: "detail-result",
      request: 0,
      id: "c1",
      result: {
        ok: true,
        value: {
          ...preview(),
          candidate: { ...preview().candidate, revision: 2, change: { ...preview().candidate.change, text: "新稿" } },
          proposed: { text: "新稿", scope: { kind: "workspace" }, expiresAt: null, pinned: false, status: "active" },
        },
      },
    });
    assert.equal(reloaded.previewChanged, true);
    assert.equal(reloaded.previewNeedsReview, false);
    assert.equal(resolvePayload(reloaded.preview!, "accept").expectedCandidateRevision, 2);
  });

  it("shows module, corrupt file, and empty list as different states", () => {
    assert.equal(capabilityText({ enabled: false, autoConsolidate: false }), "记忆模块未启用");
    assert.match(capabilityText({ enabled: true, autoConsolidate: false }), /自动候选整理未开启/);
    assert.match(capabilityText({ enabled: true, autoConsolidate: true }), /需你接受才保存/);
    const failed = memoryPanelReducer(initialMemoryPanel(), {
      type: "list-result",
      request: 0,
      result: { ok: false, error: { code: "MEMORY_FILE_INVALID", message: "Memory file must contain valid JSON" } },
    });
    assert.equal(failed.listError?.code, "MEMORY_FILE_INVALID");
    assert.equal(failed.candidates.length, 0);
    const empty = memoryPanelReducer(
      { ...initialMemoryPanel(), listRequest: 1 },
      { type: "list-result", request: 1, result: { ok: true, value: { candidates: [], nextOffset: null, truncated: false } } },
    );
    assert.equal(empty.listError, null);
    assert.equal(empty.candidates.length, 0);
    const disabled = memoryPanelReducer(initialMemoryPanel(), {
      type: "list-result",
      request: 0,
      result: { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory requires an enabled module and configured workspace" } },
    });
    assert.equal(disabled.listError?.code, "MEMORY_DISABLED");
  });

  it("reads the saved quote and does not invent a scope when the update target is missing", () => {
    const missing: CandidatePreview = {
      candidate: {
        ...candidate("c1", "新正文"),
        change: { operation: "update", memoryId: "gone", expectedRevision: 1, text: "新正文", expiresAt: null },
      },
      current: null,
      proposed: null,
      applicable: false,
      unavailableReason: "target_missing",
    };
    assert.equal(sourceQuote(missing), "先给结论");
    assert.equal(proposedText(missing), "新正文");
    assert.equal(scopeLabel(missing), null);
    assert.equal(unavailableLabel(missing), "target_missing");
    const shown = ready(missing);
    assert.equal(canAccept({ ...shown, preview: missing, selectedId: "c1" }), false);
  });

  it("locks both decisions after an unconfirmed review until a reread restores the stored status", () => {
    const pending = memoryPanelReducer(
      { ...initialMemoryPanel(), preview: preview(), selectedId: "c1", detailRequest: 4 },
      { type: "resolve-start", decision: "accept" },
    );
    const lost = memoryPanelReducer(pending, { type: "resolve-unconfirmed" });
    assert.equal(lost.resolving, false);
    assert.equal(lost.outcomeUnknown, true);
    assert.match(lost.reviewError ?? "", /未确认/);
    assert.equal(canAccept(lost), false);
    assert.equal(canReject(lost), false);
    assert.equal(memoryPanelReducer(lost, { type: "resolve-start", decision: "accept" }), lost);
    assert.equal(memoryPanelReducer(lost, { type: "resolve-start", decision: "reject" }), lost);
    assert.equal(memoryPanelReducer(lost, { type: "resolve-unconfirmed" }), lost);

    const failedRead = memoryPanelReducer(lost, {
      type: "detail-result",
      request: 4,
      id: "c1",
      result: { ok: false, error: { code: "IPC_FAILED", message: "详情结果未确认，请刷新核对" } },
    });
    assert.equal(failedRead.outcomeUnknown, true);
    assert.equal(canAccept(failedRead), false);
    assert.equal(canReject(failedRead), false);

    const stillPending = memoryPanelReducer(lost, {
      type: "detail-result",
      request: 4,
      id: "c1",
      result: { ok: true, value: preview() },
    });
    assert.equal(stillPending.outcomeUnknown, false);
    assert.equal(canAccept(stillPending), true);
    assert.equal(canReject(stillPending), true);

    const accepted = preview();
    accepted.candidate = { ...accepted.candidate, status: "accepted" };
    accepted.applicable = false;
    accepted.unavailableReason = "accepted";
    accepted.proposed = null;
    const afterAccept = memoryPanelReducer(lost, {
      type: "detail-result",
      request: 4,
      id: "c1",
      result: { ok: true, value: accepted },
    });
    assert.equal(canAccept(afterAccept), false);
    assert.equal(canReject(afterAccept), false);

    const rejected = preview();
    rejected.candidate = { ...rejected.candidate, status: "rejected" };
    rejected.applicable = false;
    rejected.unavailableReason = "rejected";
    rejected.proposed = null;
    const afterReject = memoryPanelReducer(lost, {
      type: "detail-result",
      request: 4,
      id: "c1",
      result: { ok: true, value: rejected },
    });
    assert.equal(canAccept(afterReject), false);
    assert.equal(canReject(afterReject), false);
  });

  it("clears the previous receipt when another candidate is opened or a new review starts", () => {
    const accepted = {
      ...initialMemoryPanel(),
      preview: preview("a", "甲"),
      selectedId: "a",
      receipt: "已接受候选。写入记忆 mem，本次写入版本为 revision 1。",
    };
    const opened = memoryPanelReducer(accepted, { type: "select", id: "b", request: 2 });
    assert.equal(opened.receipt, null);
    const next = {
      ...initialMemoryPanel(),
      preview: preview("b", "乙"),
      selectedId: "b",
      receipt: accepted.receipt,
    };
    const started = memoryPanelReducer(next, { type: "resolve-start", decision: "reject" });
    assert.equal(started.receipt, null);
    assert.equal(started.resolving, true);
  });
});
