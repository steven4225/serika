import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormalMemory } from "@serika/example-cli";
import type { MemoryActionPreview, MemoryHistoryPage, MemoryMaintenance } from "@serika/example-cli";
import type { MemoryAssertion } from "@serika/example-cli";
import { createMemoryActionDraft, explicitTimestamp, memoryActionFromDraft, memoryAvailabilityLabel } from "./memory-temporal-data.js";
import { CurrentMemoryDetails, MemoryAssertionDetails, MemoryActionPreviewDetails, MemoryHistory, MemoryMaintenanceSummary } from "./memory-temporal.js";

const assertion: MemoryAssertion = {
  assertionId: "assertion-old", text: "复盘先给结论，再列两步。", kind: "preference", recallTerms: ["回顾结构"],
  validTime: { from: "2026-09-01T00:00:00.000Z", to: null, basis: "explicit" },
  systemTime: { from: "2026-10-01T00:00:00.000Z", to: null }, state: "asserted",
  sources: [{ kind: "conversation", threadId: "A", messageId: "m1", quote: "复盘先给结论，再列两步。" }, { kind: "conversation", threadId: "A", messageId: "m2", quote: "是的，以后都按这个格式。" }],
};
const current: FormalMemory = {
  id: "memory", revision: 3, text: assertion.text, enabled: false, status: "disabled", pinned: false,
  scope: { kind: "workspace" }, expiresAt: "2026-10-01T12:00:00.000Z", source: assertion.sources[0],
  assertion: { assertionId: assertion.assertionId, kind: assertion.kind, recallTerms: assertion.recallTerms,
    validTime: assertion.validTime, systemTime: assertion.systemTime, state: assertion.state,
    sourceIds: assertion.sources.map(source => source.kind === "conversation" ? { kind: source.kind, threadId: source.threadId, messageId: source.messageId } : source),
  },
};

it("memory content leads with a human status and moves assertion identities into closed diagnostics", () => {
  const html = renderToStaticMarkup(createElement(MemoryAssertionDetails, { assertion }));
  assert.match(html, /<div class="hint">偏好 · 已记录<\/div>/);
  assert.match(html, /<details class="memory-engineering"><summary>高级：记录标识<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

it("temporal editor requires explicit ISO instants, rejects nonexistent dates and local-time guesses", () => {
  for (const value of ["2026-10-04", "2026-10-04T09:00", "2026-10-04T09:00:00", "2026-02-29T09:00:00+08:00", "2026-10-04T25:00:00Z", "2026-10-04T09:00:00+24:00"]) assert.equal(explicitTimestamp(value), false, value);
  for (const value of ["2026-10-04T09:00:00+08:00", "2024-02-29T09:00:00Z", "2026-10-04T09:00:00.123Z"]) assert.equal(explicitTimestamp(value), true, value);
});

it("correction and real change stay separate, preserve CAS, and never forge saved sources or system time", () => {
  const draft = createMemoryActionDraft(current);
  const corrected = memoryActionFromDraft(current, { ...draft, text: "复盘先给结论，再列三步。" });
  assert.ok(corrected.ok);
  assert.deepEqual(corrected.input, { id: "memory", expectedRevision: 3, operation: "correct", text: "复盘先给结论，再列三步。", kind: "preference", recallTerms: ["回顾结构"] });
  const changed = memoryActionFromDraft(current, { ...draft, mode: "change", text: "新格式", effectiveAt: "2026-10-04T09:00:00+08:00" });
  assert.ok(changed.ok);
  assert.equal(changed.input.operation, "change");
  for (const key of ["source", "sources", "scope", "systemTime", "assertionId"]) assert.equal(Object.hasOwn(changed.input, key), false);
});

it("blank change time means now and recall terms obey the three-term byte budget", () => {
  const draft = createMemoryActionDraft(current);
  const now = memoryActionFromDraft(current, { ...draft, mode: "change", text: "新格式" }, { now: new Date("2026-10-04T01:00:00.000Z") });
  assert.ok(now.ok && now.input.operation === "change");
  assert.equal(now.input.effectiveAt, "2026-10-04T01:00:00.000Z");
  assert.equal(memoryActionFromDraft(current, { ...draft, mode: "change", text: "新格式", effectiveAt: "明天" }).ok, false);
  const corrected = memoryActionFromDraft(current, draft);
  assert.ok(corrected.ok && corrected.input.operation === "correct");
  assert.equal(Object.hasOwn(corrected.input, "validTime"), false);
  assert.equal(memoryActionFromDraft(current, { ...draft, recallTerms: "一\n二\n三\n四" }).ok, false);
  assert.equal(memoryActionFromDraft(current, { ...draft, recallTerms: "中".repeat(33) }).ok, false);
});

it("restore requires explicit enablement and expiry choices rather than silently reviving an expired disabled record", () => {
  const draft = { ...createMemoryActionDraft(current), mode: "restore" as const, targetAssertionId: assertion.assertionId };
  assert.equal(memoryActionFromDraft(current, draft).ok, false);
  assert.equal(memoryActionFromDraft(current, { ...draft, restoreStatus: "active" }).ok, false);
  const restored = memoryActionFromDraft(current, { ...draft, restoreStatus: "active", expiryChoice: "none" });
  assert.ok(restored.ok);
  assert.deepEqual(restored.input, { id: "memory", expectedRevision: 3, operation: "restore", targetAssertionId: "assertion-old", status: "active", expiresAt: null });
  const keep = memoryActionFromDraft(current, { ...draft, restoreStatus: "disabled", expiryChoice: "keep" });
  assert.ok(keep.ok && keep.input.operation === "restore");
  assert.equal(keep.input.status, "disabled");
  assert.equal(keep.input.expiresAt, current.expiresAt);
});

it("pin, disable, expiry, retraction and permanent delete are explicit revision-bound operations", () => {
  const draft = createMemoryActionDraft(current);
  const pin = memoryActionFromDraft(current, { ...draft, mode: "pin" });
  assert.ok(pin.ok);
  assert.deepEqual(pin.input, { id: "memory", expectedRevision: 3, operation: "metadata", pinned: true });
  const expiry = memoryActionFromDraft(current, { ...draft, mode: "expiry", expiryChoice: "none" });
  assert.ok(expiry.ok);
  assert.deepEqual(expiry.input, { id: "memory", expectedRevision: 3, operation: "metadata", expiresAt: null });
  for (const mode of ["retract", "delete"] as const) {
    const result = memoryActionFromDraft(current, { ...draft, mode }); assert.ok(result.ok);
    assert.deepEqual(result.input, { id: "memory", expectedRevision: 3, operation: mode });
  }
});

it("current details show every verified saved quote while history distinguishes applicability from knowledge", () => {
  const html = renderToStaticMarkup(createElement(CurrentMemoryDetails, { current, assertion }));
  for (const expected of ["事实适用时间", "系统记录时间", "2026-09-01", "2026-10-01", "是的，以后都按这个格式。", "回顾结构", "多条来源：对话、对话"]) assert.ok(html.includes(expected), expected);
  const beforeSources = html.slice(0, html.indexOf("来源记录"));
  assert.equal(beforeSources.includes("m1"), false);
  assert.equal(beforeSources.includes("m2"), false);
  assert.match(html.slice(html.indexOf("来源记录")), /m1/);
  const page: MemoryHistoryPage = { id: "memory", revision: 3, historyCoverage: "legacy_partial", assertions: [assertion, { ...assertion, assertionId: "retracted", state: "retracted" }], versions: [{ revision: 3, assertionId: "assertion-old", scope: { kind: "workspace" }, status: "disabled", pinned: false, expiresAt: null, changedAt: "2026-10-01T00:00:00Z" }], nextOffset: null };
  const history = renderToStaticMarkup(createElement(MemoryHistory, { page, ready: false, onRestore: () => undefined }));
  assert.match(history, /历史不完整/);
  assert.match(history, /管理变更（固定、停用与有效期）/);
  assert.match(history, /不是多条新的事实/);
  assert.equal((history.match(/恢复这份内容/g) ?? []).length, 1);
  assert.match(history, /disabled=""/);
});

it("retraction and absent current applicability are not rendered as disabled or legacy data", () => {
  const retracted: FormalMemory = { ...current, text: "", assertion: undefined, status: "active", expiresAt: null, temporalState: "retracted" };
  assert.equal(memoryAvailabilityLabel(retracted), "已撤回");
  const html = renderToStaticMarkup(createElement(CurrentMemoryDetails, { current: retracted, assertion: undefined }));
  assert.match(html, /已撤回，不再注入/);
  assert.doesNotMatch(html, /旧格式记录|用户手动记录或纠正/);
  const future: FormalMemory = { ...retracted, temporalState: "not_applicable" };
  assert.equal(memoryAvailabilityLabel(future), "当前不适用");
  assert.doesNotMatch(renderToStaticMarkup(createElement(CurrentMemoryDetails, { current: future, assertion: undefined })), /旧格式记录/);
  assert.equal(memoryAvailabilityLabel({ ...future, status: "disabled" }), "已停用");
});

it("failed consolidation and deletion consequences never look like an empty successful state", () => {
  const maintenance: MemoryMaintenance = { stored: 1, pending: 0, expired: 1, disabled: 1, duplicateSuggestions: 0, capacity: { entries: 512, bytes: 16777216, assertionsPerEntry: 64 }, consolidation: { enabled: true, state: "failed", error: "写入失败", backlogCount: 2 } };
  const status = renderToStaticMarkup(createElement(MemoryMaintenanceSummary, { value: maintenance }));
  assert.match(status, /整理失败/); assert.match(status, /写入失败/); assert.match(status, /不会自动裁剪/);
  assert.doesNotMatch(status, /暂无待处理材料/);
  const preview: MemoryActionPreview = { current, input: { id: "memory", expectedRevision: 3, operation: "delete" }, proposedAssertion: null, warnings: [] };
  const deletion = renderToStaticMarkup(createElement(MemoryActionPreviewDetails, { preview }));
  assert.match(deletion, /不能从这里恢复/); assert.match(deletion, /旧对话、旧摘要与已发出的回复不会因此删除/);
});
