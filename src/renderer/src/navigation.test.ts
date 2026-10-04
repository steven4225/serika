import assert from "node:assert/strict";
import { it } from "node:test";
import { draftKey, completionLabel } from "./navigation.js";
import { resultRow } from "./conversation.js";

it("unsent drafts have separate workspace, transcript and Thread identities", () => {
  const info = { workspaceRoot: "/workspace-a", directory: "/transcripts", threadId: "thread-a" };
  const key = draftKey(info);
  assert.equal(draftKey({ ...info }), key);
  for (const other of [{ ...info, threadId: "thread-b" }, { ...info, directory: "/other" }, { ...info, workspaceRoot: "/workspace-b" }]) assert.notEqual(draftKey(other), key);
});

it("completion presentation keeps quality separate and cancellation takes precedence", () => {
  const base = { runId: "run", threadId: "thread", agentId: "test", status: "completed" as const, text: "done", steps: 3, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
  const delivered = resultRow({ ...base, completion: { reason: "delivered", corrections: 1 } });
  assert.equal(delivered.completion?.corrections, 1);
  assert.match(completionLabel(delivered), /程序检查通过.*任务验收/);
  assert.doesNotMatch(completionLabel(delivered), /任务已完成|质量通过/);
  assert.match(completionLabel({ status: "cancelled", completion: { reason: "delivered", corrections: 0 } }), /已停止/);
  assert.match(completionLabel({ status: "completed", completion: { reason: "needs_review", corrections: 0 } }), /待核对/);
  assert.match(completionLabel({ status: "completed", completion: { reason: "needs_confirmation", corrections: 0 } }), /没有自动重试/);
  assert.match(completionLabel({ status: "completed", completion: { reason: "budget_exhausted", corrections: 2 } }), /尚未完成/);
  assert.equal(completionLabel({ status: "completed" }), "本轮回复结束");
});
