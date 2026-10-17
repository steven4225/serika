import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormalMemory, MemoryReferenceSnapshot } from "@serika/assistant";
import { MemoryPanel } from "./memory.js";
import { MemoryReferenceDetails } from "./memory-references.js";
import { CurrentMemoryDetails, MemoryActionPreviewDetails } from "./memory-temporal.js";

const source = { kind: "conversation" as const, threadId: "A", messageId: "m1", quote: "复盘先给结论，再列两步。" };
const current: FormalMemory = {
  id: "memory", revision: 3, text: source.quote, enabled: true, status: "active", pinned: false,
  scope: { kind: "workspace" }, expiresAt: "2026-10-01T12:00:00.000Z", source,
  assertion: { assertionId: "assertion-old", kind: "preference", recallTerms: ["回顾结构"], state: "asserted",
    validTime: { from: "2026-09-01T00:00:00.000Z", to: null, basis: "explicit" }, systemTime: { from: "2026-10-01T00:00:00.000Z", to: null },
    sourceIds: [{ kind: "conversation", threadId: "A", messageId: "m1" }] },
};

it("memory page has no review queue, history tabs or version tools", () => {
  const library = renderToStaticMarkup(createElement(MemoryPanel, { libraryAvailable: true, memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" }, temporaryThread: false, controllerIdle: true, refreshToken: 0 }));
  assert.match(library, /memory-library/);
  const management = renderToStaticMarkup(createElement(MemoryPanel, { managementOnly: true, memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" }, temporaryThread: false, controllerIdle: true, refreshToken: 0 }));
  for (const html of [library, management]) {
    for (const label of ["待审核", "审核记录", "未保存内容与处理记录", "停用与历史记忆", "历史记录", "恢复", "有效期", "置顶"]) assert.equal(html.includes(label), false, label);
  }
});

it("saved memory details show body, scope and source but no bitemporal metadata", () => {
  const html = renderToStaticMarkup(createElement(CurrentMemoryDetails, { current }));
  assert.ok(html.includes("复盘先给结论"));
  assert.ok(html.includes("工作区记忆"));
  for (const hidden of ["事实适用时间", "系统记录时间", "有效期", "2026-09-01", "回顾结构", "assertion-old"]) assert.equal(html.includes(hidden), false, hidden);
  const inactive = renderToStaticMarkup(createElement(CurrentMemoryDetails, { current: { ...current, text: "", temporalState: "retracted" } }));
  assert.match(inactive, /当前不生效，可以删除/);
});

it("reference details keep identity and source but drop temporal viewpoints", () => {
  const { recallTerms: _terms, ...assertion } = current.assertion!;
  const reference: MemoryReferenceSnapshot & { runId: string } = {
    runId: "run-a", messageId: "message-current", preparedAt: "2026-10-04T00:00:00Z", temporalView: { validAt: "2026-10-03T00:00:00Z", knownAt: "2026-10-04T00:00:00Z" },
    selected: [{ id: "memory", revision: 3, text: "已选择的正文", reason: "recall_term", assertion }],
    truncated: false, queryTruncated: false, rewrite: "off",
  };
  const html = renderToStaticMarkup(createElement(MemoryReferenceDetails, { reference }));
  for (const text of ["memory", "revision 3", "已选择的正文"]) assert.ok(html.includes(text), text);
  for (const text of ["validAt", "knownAt", "适用时间", "认知时间"]) assert.equal(html.includes(text), false, text);
});

it("forgetting memory does not promise erasure of old conversations or summaries", () => {
  for (const operation of ["retract", "delete"] as const) {
    const html = renderToStaticMarkup(createElement(MemoryActionPreviewDetails, {
      preview: { input: { id: current.id, expectedRevision: current.revision!, operation }, current, proposedAssertion: null, warnings: [] },
    }));
    for (const text of ["旧对话", "旧摘要", "回复", "不会"]) assert.ok(html.includes(text), `${operation}: ${text}`);
  }
});
