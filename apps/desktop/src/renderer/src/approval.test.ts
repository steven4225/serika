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

test("approval offers the conversation grant only when the backend offers one", () => {
  const plain = { ...approval("读取文件 a.txt"), toolName: "read_file" };
  const html = markup(plain);
  assert.match(html, /仅本次 · 不记住选择/);
  assert.doesNotMatch(html, /允许并在本次对话内记住/);
  const offered = markup({ ...plain, remember: { label: "本次对话内不再询问 read_file" } });
  assert.match(offered, /允许并在本次对话内记住/);
  assert.match(offered, /本次对话内不再询问 read_file/);
  assert.match(offered, /拒绝不会被记住/);
  assert.match(markup({ ...plain, preview: "", remember: { label: "x" } }), /class="allow ghost" disabled=""/);
});
