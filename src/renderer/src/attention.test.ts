import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionKind, headerStatus, loadedCountLabel, deliveredReplyKeys, isMockModel } from "./attention.js";
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
