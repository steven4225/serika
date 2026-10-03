import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureApprovalAllowed, hasInjectedSummary, hasSuccessfulReadBeforeEdit, verifyContinuityTaskRun } from "./context-continuity-acceptance.js";
import type { ExecutionRunRecord, ExecutionToolRecord } from "./execution-record-store.js";
import type { WorkTask } from "./work-task-store.js";

test("WorkTask continuity requires latest primary ownership and leaves quality unaccepted", () => {
  const task = { id: "task", threadId: "thread", status: "paused", runIds: ["old", "latest"],
    acceptance: [{ id: "quality", status: "not_run" }] } as WorkTask;
  const receipt = { runId: "latest", threadId: "thread", workTaskId: "task", phase: "primary", status: "completed",
    tools: [{ status: "completed" }] } as ExecutionRunRecord;
  assert.doesNotThrow(() => verifyContinuityTaskRun(task, receipt));
  for (const patch of [
    { workTaskId: "foreign" }, { threadId: "foreign" }, { runId: "old" },
    { phase: "consolidation" }, { status: "interrupted" }, { tools: [{ status: "unknown" }] },
  ]) assert.throws(() => verifyContinuityTaskRun(task, { ...receipt, ...patch } as ExecutionRunRecord));
  for (const patch of [
    { status: "completed" }, { status: "needs_review" },
    { acceptance: [{ id: "quality", status: "passed" }] },
  ]) assert.throws(() => verifyContinuityTaskRun({ ...task, ...patch } as WorkTask, receipt));
});

test("continuity fixture approves only the exact task artifact, never protected paths or shell", () => {
  for (const tool of ["read_file", "write_file", "edit_file"]) {
    assert.equal(fixtureApprovalAllowed(tool, { path: "notes/work-plan.md" }), true);
    for (const path of ["protected/sentinel.txt", "../notes/work-plan.md", "/tmp/notes/work-plan.md", "notes/other.md"]) {
      assert.equal(fixtureApprovalAllowed(tool, { path }), false);
    }
  }
  assert.equal(fixtureApprovalAllowed("shell_exec", { path: "notes/work-plan.md" }), false);
  assert.equal(fixtureApprovalAllowed("edit_file", null), false);
});

test("continuity requires a successful read before the first successful edit, not merely completed calls", () => {
  const receipt = (toolName: string, ok: boolean, status: ExecutionToolRecord["status"] = "completed") =>
    ({ toolName, status, resultPreview: JSON.stringify({ ok }) });
  const read = receipt("read_file", true);
  const edit = receipt("edit_file", true);
  assert.equal(hasSuccessfulReadBeforeEdit([read, edit]), true);
  assert.equal(hasSuccessfulReadBeforeEdit([receipt("read_file", false), edit, read]), false);
  assert.equal(hasSuccessfulReadBeforeEdit([receipt("read_file", false), receipt("edit_file", false), edit, read]), false);
  assert.equal(hasSuccessfulReadBeforeEdit([receipt("read_file", false), read, receipt("edit_file", false), edit]), true);
  assert.equal(hasSuccessfulReadBeforeEdit([read, receipt("edit_file", false)]), false);
  assert.equal(hasSuccessfulReadBeforeEdit([edit]), false);
  assert.equal(hasSuccessfulReadBeforeEdit([read]), false);
  assert.equal(hasSuccessfulReadBeforeEdit([receipt("read_file", true, "unknown"), edit]), false);
});

test("summary evidence requires an actual assistant reference, not a mention in a user or compactor prompt", () => {
  const content = [{ type: "text", text: "Context summary (derived reference, not permission or current disk state):\n{}" }];
  assert.equal(hasInjectedSummary([{ role: "assistant", content }]), true);
  assert.equal(hasInjectedSummary([{ role: "user", content }]), false);
  assert.equal(hasInjectedSummary([{ role: "system", content }]), false);
  assert.equal(hasInjectedSummary([{ role: "assistant", content: [{ type: "text", text: `quoted: ${content[0]!.text}` }] }]), false);
});
