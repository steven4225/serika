import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionKind, headerStatus, loadedCountLabel, deliveredReplyKeys, isMockModel } from "./attention.js";
import { canSubmitComposer } from "../../shared/composer.js";
import type { ConversationRow } from "./conversation.js";

test("mock warning recognizes the production model alias without mistaking real providers", () => {
  assert.equal(isMockModel("mock/default"), true);
  assert.equal(isMockModel("mock"), true);
  assert.equal(isMockModel("command-code/default"), false);
  assert.equal(isMockModel(undefined), false);
});

test("only the highest-priority decision expands; memory writes wait for idle", () => {
  assert.equal(attentionKind({ approval: true, unknownRuns: 2, pendingMemory: 4, idle: false }), "approval");
  assert.equal(attentionKind({ approval: false, unknownRuns: 2, pendingMemory: 4, idle: true }), "unknown");
  assert.equal(attentionKind({ approval: false, unknownRuns: 0, pendingMemory: 4, idle: false }), "none");
  assert.equal(attentionKind({ approval: false, unknownRuns: 0, pendingMemory: 4, idle: true }), "memory");
});

test("header represents actual processing, not a background candidate as a second Run", () => {
  assert.deepEqual(headerStatus({ kind: "running", runId: "run", phase: "consolidation" }, "unknown"), { label: "正在整理记忆", tone: "active" });
  assert.deepEqual(headerStatus({ kind: "running", runId: null, phase: "primary" }, "approval"), { label: "等待确认", tone: "awaiting" });
  assert.equal(headerStatus({ kind: "idle" }, "unknown").label, "有效果待核对");
  assert.equal(headerStatus({ kind: "idle" }, "none").label, "空闲");
});

test("only ordinary chat can preempt an automatic memory followup", () => {
  const background = { kind: "running", runId: "memory", phase: "consolidation", background: true } as const;
  assert.equal(canSubmitComposer(background), true);
  assert.equal(canSubmitComposer(background, "command"), false);
  assert.equal(canSubmitComposer(background, "task"), false);
  assert.equal(canSubmitComposer({ ...background, phase: "primary" }), false);
  assert.equal(canSubmitComposer({ kind: "running", runId: "manual", phase: "consolidation" }), false);
  assert.equal(canSubmitComposer({ kind: "compacting" }), false);
  assert.equal(canSubmitComposer({ kind: "idle" }), true);
  assert.equal(headerStatus(background, "none").label, "后台整理记忆，可继续聊天");
  assert.equal(headerStatus({ ...background, phase: "skill" }, "none").label, "后台 Skill，可继续聊天");
  assert.equal(headerStatus({ kind: "running", runId: "manual", phase: "skill" }, "none").label, "正在运行 Skill");
});

test("deferring memory only hides its attention card, never higher priority decisions", () => {
  const input = { approval: false, unknownRuns: 0, pendingMemory: 4, idle: true, memoryDeferred: true };
  assert.equal(attentionKind(input), "none");
  assert.equal(loadedCountLabel(input.pendingMemory, false), "4");
  assert.equal(attentionKind({ ...input, approval: true }), "approval");
  assert.equal(attentionKind({ ...input, unknownRuns: 1 }), "unknown");
  assert.equal(attentionKind({ ...input, memoryDeferred: false }), "memory");
});

test("paged candidate counts are lower bounds, not invented totals", () => {
  assert.equal(loadedCountLabel(20, true), "20+");
  assert.equal(loadedCountLabel(3, false), "3");
  assert.equal(loadedCountLabel(0, false), null);
});

test("delivery folding does not cross user turns or fold pre-tool and streaming replies", () => {
  const text = (key: string, role: "user" | "assistant", committed = true): ConversationRow => ({ kind: "text", key, role, text: key, committed });
  const rows: ConversationRow[] = [text("request", "user"), text("before", "assistant"),
    { kind: "tool", key: "tool", toolName: "read_file", toolCallId: "one", status: "ok" }, text("final", "assistant"),
    text("another", "user"), text("ordinary", "assistant"), text("new", "user"),
    { kind: "tool", key: "tool2", toolName: "read_file", toolCallId: "two", status: "requested" }, text("live", "assistant", false)];
  assert.deepEqual([...deliveredReplyKeys(rows)], ["final"]);
});


test("trusted Telegram work is identified in both starting and active states", () => {
  for (const runId of [null, "phone-run"]) assert.equal(headerStatus({ kind: "running", phase: "primary", source: "telegram", runId }, "none").label, "正在处理 Telegram 消息");
  assert.equal(headerStatus({ kind: "running", phase: "primary", source: "telegram", runId: "r" }, "approval").label, "等待确认");
  assert.equal(headerStatus({ kind: "idle" }, "none").label, "空闲");
});
