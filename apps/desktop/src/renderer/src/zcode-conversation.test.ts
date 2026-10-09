import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationRow, ToolRow } from "./conversation.js";
import { conversationTurns, workSummary } from "./zcode/conversation-data.js";
import { ZCodeConversation, ZCodeTool } from "./zcode/conversation.js";
import { ZCodePromptEditor, ZCodePromptOptions } from "./zcode/prompt-editor.js";

const user: ConversationRow = { kind: "text", role: "user", key: "u1", text: "改一下计划", committed: true };
const tool: ToolRow = { kind: "tool", key: "t1", toolCallId: "t1", toolName: "edit_file", status: "ok", receipt: { kind: "file", path: "notes/plan.md", bytes: 18 } };
const interim: ConversationRow = { kind: "text", role: "assistant", key: "a1", text: "先核对当前文件。", committed: true };
const answer: ConversationRow = { kind: "text", role: "assistant", key: "a2", text: "已修改。\n\n## 下一步\n这是要保留的完整正文。", committed: true };

it("keeps applied steering in the same conversation turn with an explicit supplement label", () => {
  const steer: ConversationRow = { kind: "text", role: "user", key: "steer-1", text: "只追加", committed: true, steer: true };
  const rows: ConversationRow[] = [user, tool, steer, answer];
  assert.equal(conversationTurns(rows, false).length, 1);
  const rendered = renderToStaticMarkup(createElement(ZCodeConversation, { rows, running: false, streaming: "" }));
  assert.match(rendered, /补充本轮要求/);
  assert.match(rendered, /只追加/);
});

it("groups completed work before the final reply without rewriting text or losing row order", () => {
  const rows: ConversationRow[] = [user, interim, tool, answer, { kind: "result", key: "r1", status: "completed" }];
  const turns = conversationTurns(rows, false);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]?.items.map(item => item.kind), ["text", "work", "text"]);
  assert.deepEqual(turns[0]?.items[1], { kind: "work", rows: [interim, tool] });
  assert.equal(turns[0]?.copyText, `${interim.text}\n\n${answer.text}`);
  const markup = renderToStaticMarkup(createElement(ZCodeConversation, { rows, running: false, streaming: "" }));
  assert.match(markup, /执行过程 · 1 次工具调用/);
  assert.match(markup, /这是要保留的完整正文/);
  assert.match(markup, /aria-label="复制回复"/);
  assert.doesNotMatch(markup, /本轮回复结束|执行结果见回执|核对说明|class="role"/);
  assert.match(markup, /<details class="zcode-work">/);
});

it("does not promote text before a later tool into a final answer or collapse a live answer", () => {
  assert.deepEqual(conversationTurns([user, interim, tool], false)[0]?.items.map(item => item.kind), ["text", "text", "work"]);
  const running = conversationTurns([user, interim, tool, answer], true)[0]!;
  assert.equal(running.running, true);
  assert.deepEqual(running.items.map(item => item.kind), ["text", "text", "work", "text"]);
  const markup = renderToStaticMarkup(createElement(ZCodeConversation, { rows: [user, interim, tool], running: true, streaming: "正在逐字回复" }));
  assert.match(markup, /正在逐字回复/);
  assert.doesNotMatch(markup, /aria-label="复制回复"/);
});

it("keeps unknown/failure/incomplete effects visible without a success claim or replay action", () => {
  for (const status of ["unknown", "failed", "incomplete", "timed_out", "dispatched"] as const) {
    const { receipt, ...withoutReceipt } = tool;
    const row: ToolRow = { ...withoutReceipt, status };
    assert.equal(workSummary([row]).needsAttention, true);
    const markup = renderToStaticMarkup(createElement(ZCodeConversation, { rows: [user, row, answer], running: false, streaming: "" }));
    assert.match(markup, /有结果待查看/);
    assert.match(markup, /class="zcode-work needs-attention" open=""/);
    assert.doesNotMatch(markup, /程序检查通过|自动重试|重新执行/);
  }
  assert.match(workSummary([{ ...tool, status: "denied" }]).label, /有调用被拒绝/);
  assert.equal(workSummary([{ ...tool, status: "requested" }]).pending, true);
});

it("preserves completion reasons, system messages and multiple user turns", () => {
  const rows: ConversationRow[] = [{ ...interim, role: "system" }, user, tool, answer,
    { kind: "result", key: "r1", status: "completed", completion: { reason: "budget_exhausted", corrections: 0 } },
    { ...user, key: "u2", text: "第二轮" }, { ...answer, key: "a3" }];
  assert.equal(conversationTurns(rows, false).length, 3);
  const markup = renderToStaticMarkup(createElement(ZCodeConversation, { rows, running: false, streaming: "" }));
  assert.match(markup, /本轮额度已用完 · 任务尚未完成/);
  assert.match(markup, /role-system/);
  assert.match(markup, /第二轮/);
});

it("keeps Shell output and truncation separate from successful return or task delivery", () => {
  const { receipt, ...withoutReceipt } = tool;
  const markup = renderToStaticMarkup(createElement(ZCodeTool, { row: { ...withoutReceipt, toolName: "shell_exec", status: "requested", stdout: "already displayed", progressTruncated: true } }));
  assert.match(markup, /already displayed/);
  assert.match(markup, /输出已截断；不能据此判断执行成功/);
  assert.match(markup, /调用中/);
  assert.match(markup, /class="zcode-tool status-requested" open=""/);
});

it("ported composer retains real controls and escaped drafts without inert attachments", () => {
  const markup = renderToStaticMarkup(createElement(ZCodePromptEditor, {
    inputRef: { current: null }, value: "<script>draft</script>", "aria-label": "消息输入", onChange: () => {},
    leadingActions: createElement(ZCodePromptOptions, {}, createElement("button", { type: "button" }, "创建工作任务")),
    submitControl: createElement("button", { type: "button", "aria-label": "停止本轮" }, "停止"),
  }));
  assert.match(markup, /&lt;script&gt;draft&lt;\/script&gt;/);
  assert.match(markup, /aria-label="输入选项"/);
  assert.match(markup, /创建工作任务/);
  assert.match(markup, /aria-label="停止本轮"/);
  assert.doesNotMatch(markup, /添加附件|上传文件|<script>/);
  assert.doesNotMatch(markup, /composer-notice|composer-hint|操作前确认|Enter 发送/);
});

it("shows actionable task feedback inside the composer instead of an always-present instruction footer", () => {
  const markup = renderToStaticMarkup(createElement(ZCodePromptEditor, {
    inputRef: { current: null }, value: "保留的草稿", "aria-label": "本轮任务指令", disabled: true,
    notice: "任务已切换，原草稿仍保留。重新选择任务，或切回普通对话。",
    leadingActions: null, submitControl: createElement("button", { disabled: true }, "继续此任务"),
  }));
  assert.match(markup, /class="zcode-composer-notice" role="status"/);
  assert.match(markup, /重新选择任务/);
  assert.match(markup, /保留的草稿/);
  assert.match(markup, /disabled=""/);
  assert.doesNotMatch(markup, /composer-hint|操作前确认|Enter 发送/);
});

it("does not repeat a raw tool name already shown in the disclosure title", () => {
  const { receipt, ...withoutReceipt } = tool;
  const markup = renderToStaticMarkup(createElement(ZCodeTool, { row: {
    ...withoutReceipt, toolName: "add", status: "denied", detail: "TOOL_DENIED: User denied this tool call",
  } }));
  assert.match(markup, /zcode-tool-name">add</);
  assert.doesNotMatch(markup, /<code>add<\/code>/);
  assert.match(markup, /已拒绝/);
  assert.match(markup, /TOOL_DENIED/);
});
