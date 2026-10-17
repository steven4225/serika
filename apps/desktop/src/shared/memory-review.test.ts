import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CandidatePreview, MemoryCandidate } from "@serika/example-cli/dist/memory-candidates.js";
import {
  canAccept,
  canReject,
  capabilityText,
  candidateKindLabel,
  candidateAcceptLabel,
  candidateOperationExplanation,
  candidateSources,
  initialMemoryPanel,
  loadedLabel,
  memoryPanelReducer,
  proposedText,
  resolvePayload,
  scopeLabel,
  sourceQuote,
  unavailableLabel,
  validTimeLabel,
  systemTimeLabel,
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
  it("undated change presents an explicit from-now choice, never an implicit correction", () => {
    const open = preview();
    open.candidate.change = { operation: "change", memoryId: "memory-1", expectedRevision: 1, text: "咖啡加糖", expiresAt: null, effectiveAt: null };
    assert.equal(candidateKindLabel(open.candidate), "事实变更");
    assert.equal(candidateAcceptLabel(open.candidate), "从现在开始用新偏好");
    assert.match(candidateOperationExplanation(open.candidate), /旧记忆仍有效.*从现在开始.*历史/);
    assert.deepEqual(resolvePayload(open, "accept"), { candidateId: "c1", expectedCandidateRevision: 1, decision: "accept", effectiveAt: "now" });
    assert.deepEqual(resolvePayload(open, "reject"), { candidateId: "c1", expectedCandidateRevision: 1, decision: "reject" });
    open.candidate.change.effectiveAt = "2026-10-01T00:00:00Z";
    assert.equal(candidateAcceptLabel(open.candidate), "确认更新");
    assert.equal("effectiveAt" in resolvePayload(open, "accept"), false, "known date is not replaced by now");
  });

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
    assert.match(stale.reviewError ?? "", /记忆已经变化.*刷新/);
    assert.doesNotMatch(stale.reviewError ?? "", /MEMORY_CANDIDATE_STALE|target_changed/);
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
    assert.equal(state.receipt, null);
    state = { ...state, resolving: true };
    state = memoryPanelReducer(state, {
      type: "resolve-result",
      result: { ok: true, value: { candidateId: "a", status: "accepted", memoryId: "mem", memoryRevision: 1, replayed: false } },
    });
    assert.equal(state.receipt, "已记住这项内容。");
    assert.equal(state.receiptDetail, "记忆 mem · 版本 1");
    assert.doesNotMatch(state.receipt ?? "", /mem/);
    state = memoryPanelReducer(state, { type: "invalidate", listRequest: 3, detailRequest: 3 });
    assert.deepEqual(state.candidates, []);
    assert.equal(state.nextOffset, null);
    assert.equal(state.receipt, "已记住这项内容。");
    assert.equal(state.receiptDetail, "记忆 mem · 版本 1");
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
      receipt: "已记住：先给结论",
      receiptDetail: "记忆 mem · 版本 1",
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

  it("distinguishes real change, correction, withdrawal and disable and preserves all checked quotes", () => {
    const item = preview();
    const labels: string[] = [];
    for (const operation of ["update", "change", "correct", "retract", "disable"] as const) {
      item.candidate.change = operation === "change"
        ? { operation, memoryId: "memory-a", expectedRevision: 2, text: "三步", expiresAt: null, effectiveAt: "2026-10-03T00:00:00Z" }
        : { operation, memoryId: "memory-a", expectedRevision: 2, text: "三步", expiresAt: null };
      labels.push(candidateKindLabel(item.candidate));
      assert.notEqual(candidateOperationExplanation(item.candidate), "");
      item.current = null;
      item.proposed = null;
      assert.equal(scopeLabel(item), null, `${operation} must not invent workspace scope`);
    }
    assert.deepEqual(labels, ["更新", "事实变更", "纠错", "撤回事实", "停用"]);
    assert.deepEqual(candidateSources(item), [item.candidate.source]);
    const additional = { kind: "conversation" as const, threadId: "thread-a", messageId: "message-2", quote: "从昨天开始改成三步。" };
    item.candidate.sources = [item.candidate.source, additional];
    assert.deepEqual(candidateSources(item), [item.candidate.source, additional]);
  });

  it("marks a reloaded preview changed for temporal, inherited, retrieval and source-only differences", () => {
    const original = preview();
    original.candidate.change = { operation: "correct", memoryId: "memory-a", expectedRevision: 2, text: "结论后两步", expiresAt: null };
    original.current = { id: "memory-a", text: "结论后两步", revision: 2, enabled: true, scope: { kind: "workspace" } };
    const changes: Array<(item: CandidatePreview) => void> = [
      item => { item.candidate.sources = [{ ...item.candidate.source, quote: "新的精确引文" }]; },
      item => { item.candidate.reason = "修正后的理由"; },
      item => { item.proposed!.expiresAt = "2026-11-01T00:00:00Z"; },
      item => { item.proposed!.pinned = true; },
      item => { item.proposed!.status = "disabled"; },
      item => { item.proposed!.kind = "preference"; },
      item => { item.proposed!.recallTerms = ["复盘格式"]; },
      item => { item.proposed!.validTime = { from: "2026-10-02T00:00:00Z", to: null, basis: "explicit" }; },
      item => { item.candidate.change = { operation: "change", memoryId: "memory-a", expectedRevision: 2, text: "结论后两步", expiresAt: null, effectiveAt: "2026-10-03T00:00:00Z" }; },
      item => { item.current!.scope = { kind: "thread", threadId: "thread-a" }; },
    ];
    for (const change of changes) {
      const next = structuredClone(original);
      change(next);
      const invalid = memoryPanelReducer({ ...initialMemoryPanel(), preview: original, selectedId: "c1" }, { type: "invalidate", listRequest: 1, detailRequest: 1 });
      assert.equal(canAccept(invalid), false);
      const reloaded = memoryPanelReducer(invalid, { type: "detail-result", request: 1, id: "c1", result: { ok: true, value: next } });
      assert.equal(reloaded.previewChanged, true, JSON.stringify(next));
      assert.equal(reloaded.previewNeedsReview, false);
    }
  });

  it("labels unknown validity separately from system knowledge time", () => {
    assert.match(validTimeLabel({ from: null, to: null, basis: "unknown" }), /起点未确定.*边界未知/);
    assert.equal(validTimeLabel(undefined), "未提供");
    assert.match(systemTimeLabel({ from: "2026-10-04T00:00:00Z", to: null }), /2026-10-04.*当前认知/);
  });
});
