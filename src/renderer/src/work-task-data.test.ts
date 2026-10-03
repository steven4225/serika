import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkTask, WorkTaskStatus } from "../../shared/work-tasks.js";
import type { ExecutionRunRecord } from "../../shared/ui-contract.js";
import { isTaskRun, selectCurrentTask, taskActions, unreconciledRuns } from "./work-task-data.js";

const task = (status: WorkTaskStatus): WorkTask => ({ id: "task", revision: 1, threadId: "thread", goal: "写计划", constraints: [], acceptance: [], status, runIds: ["run"], delivery: null, reconciliations: [], createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" });

describe("work task presentation invariants", () => {
  it("never starts a needs_review task or exposes the ordinary cancel bypass", () => {
    assert.deepEqual(taskActions(task("needs_review")), { run: false, delivery: false, accept: false, rework: false, reconcile: true, cancel: false });
    assert.equal(taskActions(task("paused")).run, true);
    assert.equal(taskActions(task("completed")).run, false);
    assert.equal(taskActions(task("awaiting_acceptance")).accept, false);
    assert.equal(taskActions({ ...task("awaiting_acceptance"), delivery: { summary: "交付", artifactRefs: [], evidence: [], unresolved: [] } }).accept, true);
    assert.equal(selectCurrentTask([task("completed"), task("needs_review")])?.status, "needs_review");
  });

  it("a human reconciliation removes only the action banner, never the unknown receipt", () => {
    const run = { runId: "run", workTaskId: "task", threadId: "thread", phase: "primary", tools: [{ status: "unknown" }] } as ExecutionRunRecord;
    const reviewed = { ...task("paused"), reconciliations: [{ id: "report", runId: "run", actor: "human" as const, observedOutcome: "not_applied" as const, decision: "continue" as const, note: "用户报告", confirmedAt: "2026-10-03T00:00:00.000Z" }] };
    assert.equal(unreconciledRuns([run], [task("needs_review")]).length, 1);
    assert.equal(unreconciledRuns([run], [reviewed]).length, 0);
    assert.equal(run.tools[0]?.status, "unknown");
    assert.equal(unreconciledRuns([{ ...run, workTaskId: "other" }], [reviewed]).length, 1);
    assert.equal(isTaskRun(reviewed, run), true);
    assert.equal(isTaskRun(reviewed, { ...run, phase: "consolidation" }), false);
  });
});
