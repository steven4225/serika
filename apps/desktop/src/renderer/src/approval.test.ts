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
  assert.match(html, /<h3>调整提醒：明天 上午10点 喝水<\/h3>/);
  assert.match(html, /确认改期/);
  assert.doesNotMatch(html, /\[y\/n\]/);
  assert.doesNotMatch(html.slice(0, html.indexOf("<summary>详情</summary>")), /task_reschedule|<pre class="prompt"/);
  assert.ok(html.indexOf("调整提醒：明天 上午10点 喝水") < html.indexOf("<summary>详情</summary>"));
  assert.ok(html.indexOf("<summary>详情</summary>") < html.indexOf("task_reschedule"));
  const order = markup(approval("提醒确认\n时间：9:00\n内容：检查订单 task_12345678\n允许这次保存？ [y/n]"));
  const primary = order.slice(0, order.indexOf("<summary>详情</summary>"));
  assert.match(primary, /检查订单 task_12345678/);
});

test("structured computer preview also waits for backend publication before enabling allow", () => {
  const value = { ...approval(""), toolName: "computer_observe", input: { bundleId: "com.apple.TextEdit" } };
  assert.match(markup(value), /列出指定应用窗口/);
  assert.match(markup(value), /class="allow" disabled=""/);
  assert.doesNotMatch(markup({ ...value, preview: "观察指定应用窗口" }), /class="allow" disabled=""/);
  const exact = markup({ ...value, preview: "观察指定窗口", input: { bundleId: "com.apple.TextEdit", pid: 42, windowId: 731 } });
  assert.match(exact, /已选定，编号在详情里/);
  assert.match(exact.slice(exact.indexOf("<summary>技术详情</summary>")), /windowId[^\d]+731/);
});

test("computer connection checks can be approved without an application target after the preview is published", () => {
  const value = { ...approval(""), toolName: "computer_check", input: {} };
  assert.match(markup(value), /class="allow" disabled=""/);
  const html = markup({ ...value, preview: "检查 CUA 连接：不读取窗口或应用内容。Allow this call? [y/n] " });
  assert.doesNotMatch(html, /class="allow" disabled=""|目标信息不完整/);
  assert.match(html, /<h3>检查电脑控制连接<\/h3>/);
  assert.match(html, /不读取窗口或应用内容/);
  assert.doesNotMatch(html, /\[y\/n\]/);
});

test("computer observation and action approvals still reject missing targets and unknown computer tools", () => {
  for (const toolName of ["computer_observe", "computer_action", "computer_unknown"]) {
    const html = markup({ ...approval("电脑操作预览"), toolName, input: {} });
    assert.match(html, /class="allow" disabled=""/);
    assert.match(html, /目标信息不完整/);
    assert.doesNotMatch(html, /class="deny" disabled=""/);
  }
});
