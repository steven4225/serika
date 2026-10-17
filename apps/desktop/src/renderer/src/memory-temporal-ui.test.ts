import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CandidatePreview } from "@serika/assistant";
import type { MemoryReferenceSnapshot } from "@serika/assistant";
import { CandidateDetail, MemoryPanel, MemoryTabs, memoryTabOnOpen } from "./memory.js";
import { MemoryReferenceDetails } from "./memory-references.js";
import { MemoryActionPreviewDetails } from "./memory-temporal.js";

function candidatePreview(): CandidatePreview {
  const source = { kind: "conversation" as const, threadId: "thread-a", messageId: "source-a", quote: "从昨天开始改成三步。" };
  return {
    candidate: {
      id: "candidate-a", revision: 3, batchId: "batch-a", originThreadId: "thread-a", fingerprint: "fingerprint",
      createdAt: "2026-10-04T00:00:00Z", resolvedAt: null, status: "pending", staleReason: null, appliedResult: null,
      change: { operation: "change", memoryId: "memory-a", expectedRevision: 2, text: "复盘先结论，再列三步。", expiresAt: null, effectiveAt: "2026-10-03T00:00:00Z" },
      source, sources: [source, { ...source, messageId: "source-b", quote: "旧的两步不再适用。" }], reason: "用户明确报告真实偏好变化",
    },
    current: {
      id: "memory-a", revision: 2, text: "复盘先结论，再列两步。", enabled: true, status: "active", scope: { kind: "workspace" },
      assertion: { assertionId: "assertion-a", kind: "preference", state: "asserted", recallTerms: ["复盘格式"], validTime: { from: null, to: null, basis: "unknown" }, systemTime: { from: "2026-10-02T00:00:00Z", to: null }, sourceIds: [{ kind: "conversation", threadId: "thread-a", messageId: "source-old" }] },
    },
    proposed: { text: "复盘先结论，再列三步。", scope: { kind: "workspace" }, expiresAt: null, pinned: false, status: "active", kind: "preference", recallTerms: ["复盘格式"], validTime: { from: "2026-10-03T00:00:00Z", to: null, basis: "explicit" }, effectiveAt: "2026-10-03T00:00:00Z" },
    applicable: true, unavailableReason: null,
  };
}

function detail(preview: CandidatePreview) {
  return renderToStaticMarkup(createElement(CandidateDetail, {
    preview, previewChanged: false, canAcceptDecision: preview.applicable, canRejectDecision: true, resolving: false,
    onAccept: () => {}, onReject: () => {}, onRefresh: () => {},
  }));
}

describe("memory temporal review UI", () => {
  it("starts with the memory library and keeps management records in settings", () => {
    const html = renderToStaticMarkup(createElement(MemoryPanel, { libraryAvailable: true, memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" }, temporaryThread: false, controllerIdle: true, refreshToken: 0, focusRequest: { id: null, sequence: 1 } }));
    assert.match(html, /memory-library/);
    assert.match(html, /新建文件夹/);
    assert.match(html, /导入文件/);
    assert.equal(html.includes("健康"), false);
    assert.doesNotMatch(html, /未保存内容与处理记录|停用与历史记忆|查看处理记录/);
    const management = renderToStaticMarkup(createElement(MemoryPanel, { managementOnly: true, memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" }, temporaryThread: false, controllerIdle: true, refreshToken: 0 }));
    assert.match(management, /未保存内容与处理记录|查看处理记录/);
    assert.match(management, /停用与历史记忆/);
    assert.doesNotMatch(management, /我对你的了解|memory-category-card/);
    for (const label of ["只审核当前对话的候选", "选择待审核候选", "核对并接受", "待审核（0", "待确认（0"]) assert.equal(html.includes(label), false, label);
    const history = renderToStaticMarkup(createElement(MemoryTabs, { tab: "history", onSelect: () => {} }));
    assert.match(history, /aria-selected="true">审核记录/);
  });

  it("keeps automatic-mode candidates quiet and opens review only on an explicit candidate link", () => {
    const props = { libraryAvailable: true, memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" as const }, temporaryThread: false, controllerIdle: true, refreshToken: 0 };
    const pending = renderToStaticMarkup(createElement(MemoryPanel, { ...props, pendingCount: 2, pendingHasMore: true }));
    assert.doesNotMatch(pending, /待确认|待审核（2/);
    assert.match(pending, /memory-library/);
    assert.equal(pending.includes("只审核当前对话的候选"), false);
    assert.equal(pending.includes("aria-selected=\"true\">待审核"), false);
    const focused = renderToStaticMarkup(createElement(MemoryPanel, { ...props, focusRequest: { id: "candidate-a", sequence: 1 } }));
    assert.match(focused, /返回记忆/);
    assert.match(focused, /aria-selected="true">待审核/);
    assert.equal(memoryTabOnOpen(0, null), "formal", "ordinary open is not a review request");
    assert.equal(memoryTabOnOpen(1, null), "formal", "a pending count does not replace the saved cards");
    assert.equal(memoryTabOnOpen(0, "candidate-a"), "pending");
  });

  it("keeps checked quote/current/proposed/scope visible while internal metadata is collapsed", () => {
    const html = detail(candidatePreview());
    assert.ok(html.indexOf("原话来源") < html.indexOf("当前记忆"));
    assert.ok(html.indexOf("当前记忆") < html.indexOf("接受后的记忆"));
    assert.match(html, /当前工作区，可供其他对话使用/);
    assert.match(html, /确认更新/);
    const technical = html.slice(html.indexOf('<details class="memory-technical"'), html.indexOf('</details>', html.indexOf('<details class="memory-technical"')));
    for (const text of ["candidate-a", "expectedRevision 2", "系统认知时间", "用户明确报告真实偏好变化"]) assert.ok(technical.includes(text), text);
    assert.equal(technical.includes(" open="), false);
    const terminal = candidatePreview(); terminal.candidate.status = "accepted";
    assert.equal(detail(terminal).includes("确认更新"), false, "review history does not offer a repeat decision");
  });
  it("shows both checked source quotes and real-change current/proposed timing", () => {
    const html = detail(candidatePreview());
    for (const text of ["事实变更", "从昨天开始改成三步。", "旧的两步不再适用。", "source-a", "source-b", "再列两步", "再列三步", "事实适用时间", "系统认知时间", "2026-10-03T00:00:00Z", "复盘格式", "接受时记录；尚未写入"]) assert.ok(html.includes(text), text);
    assert.match(html, /此前适用的事实仍保留/);
  });

  it("does not present withdrawn text as a new saved fact or invent a missing target scope", () => {
    const withdrawal = candidatePreview();
    withdrawal.candidate.change = { operation: "retract", memoryId: "memory-a", expectedRevision: 2, text: "旧两步", expiresAt: null };
    withdrawal.proposed = { ...withdrawal.proposed!, text: "" };
    const withdrawalHtml = detail(withdrawal);
    assert.match(withdrawalHtml, /这条事实将被撤回，不再作为当前事实引用/);
    assert.match(withdrawalHtml, /旧对话、旧摘要和已经发出的回复不会被删除/);
    const missing = candidatePreview();
    missing.current = null; missing.proposed = null; missing.applicable = false; missing.unavailableReason = "target_missing";
    const html = detail(missing);
    assert.match(html, /当前目标不可用/);
    assert.equal(html.includes("workspace"), false);
    assert.match(html, /完整变更预览不可用/);
  });

  it("renders actual selected revision/assertion, recall-term reason and both temporal viewpoints", () => {
    const preview = candidatePreview();
    const assertion = preview.current!.assertion!;
    const { recallTerms: _terms, ...referenceAssertion } = assertion;
    const reference: MemoryReferenceSnapshot & { runId: string } = {
      runId: "run-a", messageId: "message-current", preparedAt: "2026-10-04T00:00:00Z", temporalView: { validAt: "2026-10-03T00:00:00Z", knownAt: "2026-10-04T00:00:00Z" },
      selected: [{ id: "memory-a", revision: 2, text: "已选择的正文", reason: "recall_term", assertion: referenceAssertion }],
      truncated: false, queryTruncated: false, rewrite: "off",
    };
    const html = renderToStaticMarkup(createElement(MemoryReferenceDetails, { reference }));
    for (const text of ["memory-a", "revision 2", "assertion-a", "已审核检索词匹配", "source-old", "validAt", "knownAt", "不是模型自报", "旧摘要里的引用不算本轮选中"]) assert.ok(html.includes(text), text);
    assert.equal(html.includes("复盘格式"), false, "lookup phrases are not factual source evidence");
    assert.equal(html.includes("从昨天开始改成三步"), false, "reference snapshots do not contain source quotes");
  });

  it("does not promise erasure of old conversations or summaries when forgetting formal memory", () => {
    const current = candidatePreview().current!;
    for (const operation of ["retract", "delete"] as const) {
      const html = renderToStaticMarkup(createElement(MemoryActionPreviewDetails, {
        preview: { input: { id: current.id, expectedRevision: current.revision!, operation }, current, proposedAssertion: null, warnings: [] },
      }));
      for (const text of ["旧对话", "旧摘要", "回复", "不会"]) assert.ok(html.includes(text), `${operation}: ${text}`);
    }
  });
});
