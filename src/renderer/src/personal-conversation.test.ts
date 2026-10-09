import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationRow, ToolRow } from "./conversation.js";
import { PersonalConversation, PersonalTool } from "./personal/conversation.js";
import { PersonalPromptEditor, PersonalPromptOptions } from "./personal/composer.js";

const user: ConversationRow = { kind: "text", role: "user", key: "user", text: "帮我改一下计划", committed: true };
const interim: ConversationRow = { kind: "text", role: "assistant", key: "interim", text: "先核对当前文件。", committed: true };
const tool: ToolRow = { kind: "tool", key: "tool", toolCallId: "call-1", runId: "run-1", toolName: "edit_file", status: "ok", receipt: { kind: "file", path: "notes/plan.md", bytes: 18 } };
const reply: ConversationRow = { kind: "text", role: "assistant", key: "reply", text: "已修改。\n\n这是完整正文。", committed: true };
const render = (rows: readonly ConversationRow[], running = false, streaming = "", waitingForApproval = false) => renderToStaticMarkup(createElement(PersonalConversation, { rows, running, streaming, waitingForApproval }));

it("personal conversation keeps a right user bubble and a safe full assistant reply, without invented timestamps", () => {
  const markup = render([user, reply]);
  assert.match(markup, /personal-message role-user/);
  assert.match(markup, /personal-message role-assistant/);
  assert.match(markup, /这是完整正文/);
  assert.match(markup, /aria-label="复制回复"/);
  assert.doesNotMatch(markup, /今天 \d|<time|麦克风|avatar/);
  const unsafe = render([{ ...reply, text: "<script>alert(1)</script>\n\n[危险](javascript:alert(1))" }]);
  assert.doesNotMatch(unsafe, /<script>|href="javascript:/);
});

it("personal conversation keeps tool logs inside a collapsed execution disclosure after completion", () => {
  const markup = render([user, interim, { ...tool, stdout: "private tool stdout" }, reply]);
  assert.match(markup, /<details class="personal-work">/);
  assert.match(markup, /执行过程 · 1 次工具调用/);
  assert.match(markup, /private tool stdout/);
  assert.match(markup, /personal-tool-output stdout/);
  assert.ok(markup.indexOf("personal-work") < markup.indexOf("private tool stdout"));
  assert.ok(markup.indexOf("private tool stdout") < markup.indexOf("这是完整正文"));
  assert.doesNotMatch(markup, /程序检查通过|自动重试|重新执行/);
});

it("personal conversation exposes unknown effects, truncation and approval waits without a success claim", () => {
  const { receipt, ...withoutReceipt } = tool;
  const markup = render([user, { ...withoutReceipt, status: "unknown", detail: "副作用尚未核对", progressTruncated: true }, reply]);
  assert.match(markup, /personal-work needs-attention" open=""/);
  assert.match(markup, /效果未知/);
  assert.match(markup, /副作用尚未核对/);
  assert.match(markup, /输出已截断；不能据此判断执行成功/);
  assert.doesNotMatch(markup, /自动重试|重新执行/);
  assert.match(render([user], true, "", true), /等待确认后继续/);
});

it("personal conversation retains streaming, steering and explicit incomplete task outcomes", () => {
  const steer: ConversationRow = { ...user, key: "steer", text: "只追加，不覆盖。", steer: true };
  const markup = render([user, steer, { kind: "result", key: "result", status: "completed", completion: { reason: "budget_exhausted", corrections: 0 } }], true, "正在继续回复");
  assert.match(markup, /补充本轮要求/);
  assert.match(markup, /只追加，不覆盖。/);
  assert.match(markup, /personal-message role-assistant streaming/);
  assert.match(markup, /正在继续回复/);
  assert.match(markup, /本轮额度已用完 · 任务尚未完成/);
  assert.doesNotMatch(markup, /aria-label="复制回复"/);
});

it("personal trace links require the row's exact known Run, not only a toolCallId", () => {
  const onTrace = () => {};
  assert.match(renderToStaticMarkup(createElement(PersonalTool, { row: tool, onTrace })), /查看本次执行追踪/);
  const { runId, ...historicalTool } = tool;
  assert.doesNotMatch(renderToStaticMarkup(createElement(PersonalTool, { row: historicalTool, onTrace })), /查看本次执行追踪/);
});

it("personal capsule composer forwards draft and input controls without unsupported attachment or microphone actions", () => {
  const markup = renderToStaticMarkup(createElement(PersonalPromptEditor, {
    inputRef: { current: null }, value: "<script>draft</script>", "aria-label": "消息输入", placeholder: "和 Serika 聊天", disabled: true,
    onChange: () => {}, onKeyDown: () => {}, onCompositionStart: () => {}, onCompositionEnd: () => {},
    topContent: createElement("p", {}, "本条不整理为记忆"), notice: "先核对这次工具操作。",
    leadingActions: createElement(PersonalPromptOptions, {}, createElement("button", { type: "button" }, "创建工作任务")),
    submitControl: createElement("button", { type: "button", "aria-label": "停止本轮" }, "停止"),
  }));
  assert.match(markup, /personal-composer-pill/);
  assert.match(markup, /&lt;script&gt;draft&lt;\/script&gt;/);
  assert.match(markup, /placeholder="和 Serika 聊天"/);
  assert.match(markup, /disabled=""/);
  assert.match(markup, /rows="1"/);
  assert.match(markup, /aria-label="输入选项"/);
  assert.match(markup, /创建工作任务/);
  assert.match(markup, /aria-label="停止本轮"/);
  assert.match(markup, /personal-composer-notice" role="status"/);
  assert.ok(markup.indexOf("先核对这次工具操作。") < markup.indexOf("personal-composer-pill"));
  assert.doesNotMatch(markup, /添加附件|上传文件|麦克风|<script>/);
});

it("personal composer hides only the presentation while keeping a supplied draft and controls intact", () => {
  const markup = renderToStaticMarkup(createElement(PersonalPromptEditor, {
    inputRef: { current: null }, value: "保留的草稿", hidden: true, readOnly: true, leadingActions: null,
    submitControl: createElement("button", {}, "发送"),
  }));
  assert.match(markup, /class="personal-composer" hidden=""/);
  assert.match(markup, /保留的草稿/);
  assert.match(markup, /发送/);
  assert.doesNotMatch(markup, /personal-composer-feedback|personal-composer-notice/);
});
