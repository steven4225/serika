import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { annotateMemoryReceipts, rowsFromHistory, type ConversationRow, type ToolRow } from "./conversation.js";
import { conversationTurns, workSummary } from "./ui-kit/conversation-data.js";
import { PersonalConversation } from "./personal/conversation.js";

const user: ConversationRow = { kind: "text", role: "user", key: "u1", text: "改一下计划", committed: true };
const tool: ToolRow = { kind: "tool", key: "t1", toolCallId: "t1", toolName: "edit_file", status: "ok", receipt: { kind: "file", path: "notes/plan.md", bytes: 18 } };
const interim: ConversationRow = { kind: "text", role: "assistant", key: "a1", text: "先核对当前文件。", committed: true };
const answer: ConversationRow = { kind: "text", role: "assistant", key: "a2", text: "已修改。\n\n## 下一步\n这是要保留的完整正文。", committed: true };

const receiptTexts = (rows: readonly ConversationRow[]) => rows.flatMap(row => row.kind === "text" ? (row.memoryReceipts ?? []).map(receipt => receipt.text) : []);

it("keeps source-bound host memory receipts out of the reply copy text", () => {
  const source = { ...user, memoryReceipts: [{ id: "batch:u1", threadId: "thread", sourceMessageId: "u1", text: "当时已保存：咖啡不加糖。" }] };
  assert.equal(conversationTurns([source, answer], false)[0]!.copyText, answer.text);
});

it("attaches only the current Thread's host receipt to the matching committed user and deduplicates replay", () => {
  const rows = rowsFromHistory([{ id: "u1", role: "user", parts: [{ type: "text", text: "记住我喝咖啡不加糖" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "明白" }] }]);
  const receipt = { id: "batch:u1", threadId: "thread", sourceMessageId: "u1", text: "当时已保存：咖啡不加糖" };
  const attached = annotateMemoryReceipts(rows, [receipt, receipt, { ...receipt, id: "foreign", threadId: "other" },
    { ...receipt, id: "unrelated", sourceMessageId: "a1" }], "thread");
  assert.deepEqual(receiptTexts(attached), ["当时已保存：咖啡不加糖"]);
  assert.deepEqual(annotateMemoryReceipts(attached, [receipt], "thread"), attached, "restart refresh replaces the same projection");
  const removed = annotateMemoryReceipts(attached, [receipt], "other");
  assert.deepEqual(receiptTexts(removed), []);
  assert.equal(rows.some(row => row.kind === "text" && row.memoryReceipts), false, "display projection never mutates source rows");
});

it("keeps applied steering in the same conversation turn", () => {
  const steer: ConversationRow = { kind: "text", role: "user", key: "steer-1", text: "只追加", committed: true, steer: true };
  const rows: ConversationRow[] = [user, tool, steer, answer];
  assert.equal(conversationTurns(rows, false).length, 1);
});

it("groups completed work before the final reply without rewriting text or losing row order", () => {
  const rows: ConversationRow[] = [user, interim, tool, answer, { kind: "result", key: "r1", status: "completed" }];
  const turns = conversationTurns(rows, false);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0]?.items.map(item => item.kind), ["text", "work", "text"]);
  assert.deepEqual(turns[0]?.items[1], { kind: "work", rows: [interim, tool] });
  assert.equal(turns[0]?.copyText, `${interim.text}\n\n${answer.text}`);
});

it("does not promote text before a later tool into a final answer or collapse a live answer", () => {
  assert.deepEqual(conversationTurns([user, interim, tool], false)[0]?.items.map(item => item.kind), ["text", "work"]);
  const running = conversationTurns([user, interim, tool, answer], true)[0]!;
  assert.equal(running.running, true);
  assert.deepEqual(running.items.map(item => item.kind), ["text", "work"]);
  const markup = renderToStaticMarkup(createElement(PersonalConversation, { rows: [user, interim, tool], running: true, streaming: "正在逐字回复" }));
  assert.match(markup, /正在逐字回复/);
  assert.doesNotMatch(markup, /aria-label="复制回复"/);
});

it("keeps unresolved effects expanded, while retaining known failures in the summary without a success claim", () => {
  for (const status of ["unknown", "incomplete", "timed_out", "dispatched"] as const) {
    const { receipt, ...withoutReceipt } = tool;
    const row: ToolRow = { ...withoutReceipt, status };
    assert.equal(workSummary([row]).needsAttention, true);
  }
  const failed = { ...tool, status: "failed" as const };
  assert.equal(workSummary([failed]).needsAttention, false);
  assert.match(workSummary([failed]).label, /有调用未成功/);
  assert.match(workSummary([{ ...tool, status: "denied" }]).label, /有调用被拒绝/);
  assert.equal(workSummary([{ ...tool, status: "requested" }]).pending, true);
});

it("preserves completion reasons, system messages and multiple user turns", () => {
  const rows: ConversationRow[] = [{ ...interim, role: "system" }, user, tool, answer,
    { kind: "result", key: "r1", status: "completed", completion: { reason: "budget_exhausted", corrections: 0 } },
    { ...user, key: "u2", text: "第二轮" }, { ...answer, key: "a3" }];
  assert.equal(conversationTurns(rows, false).length, 3);
  const markup = renderToStaticMarkup(createElement(PersonalConversation, { rows, running: false, streaming: "" }));
  assert.match(markup, /本轮额度已用完 · 任务尚未完成/);
  assert.match(markup, /role-system/);
  assert.match(markup, /第二轮/);
});


