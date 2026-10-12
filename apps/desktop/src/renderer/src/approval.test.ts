import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingApproval } from "../../shared/ui-contract.js";
import { ApprovalCard } from "./approval.js";

const approval = (preview: string, approvalId = "approval-1"): PendingApproval => ({
  approvalId, toolCallId: "call-1", toolName: "task_reschedule", input: { id: "task-1", runAt: "2026-11-01T10:00:00Z" }, preview,
});
const markup = (value: PendingApproval) => renderToStaticMarkup(createElement(ApprovalCard, {
  approval: value, deciding: false, onDecision: () => { throw new Error("render cannot authorize"); },
}));

for (const preview of ["", " \n\t "]) test(`approval preview guard rejects ${JSON.stringify(preview)}`, () => {
  const html = markup(approval(preview));
  assert.match(html, /class="allow" disabled=""/);
  assert.doesNotMatch(html, /class="deny" disabled=""/);
  assert.match(html, /正在生成预览/);
});

test("approval delayed preview becomes enabled only with visible content and hides terminal y/n", () => {
  assert.match(markup(approval("")), /class="allow" disabled=""/);
  const html = markup(approval("提醒确认\n时间：明天 上午10点\n内容：喝水\n允许这次改期？ [y/n] "));
  assert.doesNotMatch(html, /class="allow" disabled=""/);
  assert.match(html, /喝水/);
  assert.match(html, /改期提醒：明天 上午10点 喝水/);
  assert.doesNotMatch(html, /\[y\/n\]/);
  assert.ok(html.indexOf("改期提醒：明天 上午10点 喝水") < html.indexOf("<summary>详情</summary>"));
  assert.ok(html.indexOf("<summary>详情</summary>") < html.indexOf("task_reschedule"));
});

test("structured computer preview also waits for backend publication before enabling allow", () => {
  const value = { ...approval(""), toolName: "computer_observe", input: { bundleId: "com.apple.TextEdit" } };
  assert.match(markup(value), /列出指定应用窗口/);
  assert.match(markup(value), /class="allow" disabled=""/);
  assert.doesNotMatch(markup({ ...value, preview: "观察指定应用窗口" }), /class="allow" disabled=""/);
});
