import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExecutionRunRecord } from "./execution-record-store.js";
import type { WorkTask } from "./work-task-store.js";
import { workTaskContinuation } from "./work-task-continuation.js";
import { createWorkTaskContextMessage } from "./work-task-context.js";

const task: WorkTask = { id: "task", revision: 4, threadId: "thread", goal: "Maintain plan", constraints: [],
  acceptance: [], status: "paused", runIds: ["old", "latest"], reconciliations: [],
  delivery: { summary: "First draft", artifactRefs: ["plan.md"], unresolved: ["check source"], evidence: [] },
  createdAt: "2026-10-04T00:00:00.000Z", updatedAt: "2026-10-04T00:00:00.000Z" };
const run: ExecutionRunRecord = { runId: "latest", threadId: "thread", workTaskId: "task", phase: "primary", status: "interrupted",
  startedAt: task.createdAt, finishedAt: task.updatedAt, tools: [], resultTextPreview: "Not verified", resultTextTruncated: false, errorPreview: null };

it("continuation binds only the latest owned primary receipt and preserves unknown effects", () => {
  for (const patch of [{ runId: "old" }, { workTaskId: "other" }, { threadId: "other" }, { phase: "consolidation" as const }]) {
    const data = workTaskContinuation(task, { ...run, ...patch });
    assert.equal(data.latestRun, null);
    assert.equal(data.receiptUnavailable, true);
  }
  const data = workTaskContinuation({ ...task, status: "needs_review" }, { ...run, tools: [{
    toolCallId: "edit", toolName: "edit_file", status: "unknown", requestedAt: task.createdAt, startedAt: task.createdAt, finishedAt: null,
    inputPreview: "{}", inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: null, shell: null, fileInput: { path: "plan.md" },
  }] });
  assert.equal(data.requiresReview, true);
  assert.equal(data.latestRun?.tools[0]?.status, "unknown");
  assert.equal(data.previousDelivery?.unresolved[0], "check source");
  assert.equal(workTaskContinuation({ ...task, runIds: [], delivery: null }, null).receiptUnavailable, false);
});

it("bounded prior delivery enters task context as a reference, never evidence or permission", () => {
  const long = { ...task, delivery: { ...task.delivery!, summary: "偏好🙂".repeat(1000), unresolved: Array(10).fill("check") } };
  const data = workTaskContinuation(long, run);
  assert.equal(data.previousDelivery?.truncated, true);
  assert.ok(Buffer.byteLength(data.previousDelivery!.summary, "utf8") <= 2048);
  assert.doesNotMatch(data.previousDelivery!.summary, /\uFFFD/);
  assert.equal(data.previousDelivery!.unresolved.length, 4);
  const message = createWorkTaskContextMessage(task, workTaskContinuation(task, run));
  const text = message?.parts[0]?.type === "text" ? message.parts[0].text : "";
  assert.match(text, /First draft/);
  assert.match(text, /check source/);
  assert.match(text, /read its current disk contents in this Run/);
  assert.match(text, /Never replay an old tool/);
  assert.match(text, /interrupted/);
  assert.deepEqual(task.acceptance, []);
});
