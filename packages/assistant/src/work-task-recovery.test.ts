import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { ExecutionRunRecord, ExecutionToolRecord } from "./execution-record-store.js";
import {
  classifyRecoveredWorkTask,
  recoverRunningWorkTasks,
} from "./work-task-recovery.js";
import { createWorkTaskStore, workTaskPhase, type WorkTask, type WorkTaskStore } from "./work-task-store.js"
import { createTaskStore } from "./task-store.js";

const directories: string[] = [];
const at = "2026-09-30T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: "task-1",
    revision: 2,
    threadId: "thread-1",
    goal: "Finish the task",
    constraints: [],
    acceptance: [{
      id: "human",
      description: "User accepts",
      method: "human",
      verification: { kind: "human" },
      required: true,
      status: "not_run",
      evidenceRefs: [],
      note: null,
    }],
    status: "running",
    runIds: ["run-1"],
    delivery: null,
    reconciliations: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
    kind: "work",
    effectReviewRequired: overrides.effectReviewRequired ?? false,
    acceptanceOpen: overrides.acceptanceOpen ?? false,
  };
}

function tool(status: ExecutionToolRecord["status"]): ExecutionToolRecord {
  return {
    toolCallId: "tool-1",
    toolName: "write_file",
    status,
    requestedAt: at,
    startedAt: status === "requested" || status === "not_started" ? null : at,
    finishedAt: status === "completed" || status === "failed" ? at : null,
    inputPreview: "{}",
    inputTruncated: false,
    resultPreview: status === "completed" ? "{\"ok\":true}" : null,
    resultTruncated: false,
    errorPreview: status === "failed" ? "failed" : null,
    shell: null,
  };
}

function run(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    runId: "run-1",
    threadId: "thread-1",
    workTaskId: "task-1",
    phase: "primary",
    status: "interrupted",
    startedAt: at,
    finishedAt: at,
    resultTextPreview: null,
    resultTextTruncated: false,
    errorPreview: null,
    tools: [],
    ...overrides,
  };
}

describe("WorkTask restart recovery", () => {
  it("allows only one controller to own a workspace Thread until its lease is released", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-work-task-owner-"));
    directories.push(workspace);
    const first = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), { workspace: workspace, });
    const second = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), { workspace: workspace, });
    const lease = await first.claimThread("thread-1");
    try {
      await assert.rejects(second.claimThread("thread-1"), /already controlled/);
      const otherThread = await second.claimThread("thread-2");
      await otherThread.release();
    } finally {
      await lease.release();
    }
    const reopened = await second.claimThread("thread-1");
    await reopened.release();
  });

  it("classifies missing, foreign, consolidation, and unknown receipts as needs_review", () => {
    const current = task();
    assert.equal(classifyRecoveredWorkTask(current, [null]), "needs_review");
    assert.equal(classifyRecoveredWorkTask(current, [run({ workTaskId: "other-task" })]), "needs_review");
    assert.equal(classifyRecoveredWorkTask(current, [run({ phase: "consolidation" })]), "needs_review");
    assert.equal(classifyRecoveredWorkTask(current, [run({ tools: [tool("unknown")] })]), "needs_review");
  });

  it("keeps a genuinely live receipt running and pauses every settled receipt without unknown effects", () => {
    const current = task();
    assert.equal(classifyRecoveredWorkTask(current, [run({ status: "running", finishedAt: null })]), "running");
    for (const status of ["completed", "failed", "cancelled", "timed_out", "interrupted"] as const) {
      assert.equal(classifyRecoveredWorkTask(current, [run({ status })]), "paused", status);
    }
    assert.equal(classifyRecoveredWorkTask(current, [run({ tools: [tool("not_started")] })]), "paused");
    assert.equal(classifyRecoveredWorkTask(current, [run({ tools: [tool("completed")] })]), "paused");
  });

  it("uses the latest Run for recovery because older receipts are bounded audit history", () => {
    const recovered = task({
      revision: 6,
      runIds: ["run-1", "run-2"],
      reconciliations: [{
        id: "reconciliation-1",
        runId: "run-1",
        actor: "human",
        observedOutcome: "applied",
        decision: "continue",
        note: "Verified the first write manually",
        confirmedAt: at,
      }],
    });
    const oldUnknown = run({ tools: [tool("unknown")] });
    const latestClean = run({ runId: "run-2", status: "completed", tools: [tool("completed")] });
    assert.equal(classifyRecoveredWorkTask(recovered, [oldUnknown, latestClean]), "paused");
    assert.equal(classifyRecoveredWorkTask({ ...recovered, reconciliations: [] }, [oldUnknown, latestClean]), "paused");
    assert.equal(classifyRecoveredWorkTask(recovered, [oldUnknown, null]), "needs_review");
  });

  it("recovers running tasks beyond the Store's default twenty-item page", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-work-task-recovery-page-"));
    directories.push(workspace);
    let nextId = 0;
    const store = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), { workspace: workspace,  ...({ generateId: () => `task-${++nextId}` }) });
    const oldest = await store.create({
      threadId: "thread-1", goal: "Oldest running task",
      acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
    });
    assert.equal(oldest.ok, true);
    if (!oldest.ok) return;
    assert.equal((await store.beginRun(oldest.value.id, { expectedRevision: 1, runId: "run-oldest" })).ok, true);
    for (let index = 0; index < 20; index += 1) {
      assert.equal((await store.create({
        threadId: "thread-1", goal: `Newer task ${index}`,
        acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
      })).ok, true);
    }
    const defaultPage = await store.list({ threadId: "thread-1" });
    assert.equal(defaultPage.ok && defaultPage.value.some((item) => item.id === oldest.value.id), false);
    const recovered = await recoverRunningWorkTasks({
      threadId: "thread-1", workTasks: store,
      executionRecords: { getRun: async () => run({ runId: "run-oldest" }) },
    });
    assert.equal(recovered[0]?.id, oldest.value.id);
    assert.equal(recovered[0] ? workTaskPhase(recovered[0]) : "", "paused");
  });

  it("settles only this Thread's running tasks and is idempotent after the first recovery", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-work-task-recovery-"));
    directories.push(workspace);
    let nextId = 0;
    const store = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), { workspace: workspace,  ...({ generateId: () => `task-${++nextId}` }) });
    const first = await store.create({
      threadId: "thread-1",
      goal: "First",
      acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
    });
    const other = await store.create({
      threadId: "thread-2",
      goal: "Other",
      acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
    });
    assert.equal(first.ok, true);
    assert.equal(other.ok, true);
    if (!first.ok || !other.ok) return;
    assert.equal((await store.beginRun(first.value.id, { expectedRevision: 1, runId: "run-1" })).ok, true);
    assert.equal((await store.beginRun(other.value.id, { expectedRevision: 1, runId: "run-2" })).ok, true);
    const receipts = new Map<string, ExecutionRunRecord>([
      ["run-1", run()],
      ["run-2", run({ runId: "run-2", threadId: "thread-2", workTaskId: other.value.id })],
    ]);
    const executionRecords = {
      getRun: async (threadId: string, runId: string) => {
        const receipt = receipts.get(runId);
        return receipt?.threadId === threadId ? receipt : null;
      },
    };

    const once = await recoverRunningWorkTasks({ threadId: "thread-1", workTasks: store, executionRecords });
    assert.equal(once.length, 1);
    assert.equal(once[0] ? workTaskPhase(once[0]) : "", "paused");
    assert.equal(once[0]?.revision, 3);
    assert.deepEqual(await recoverRunningWorkTasks({ threadId: "thread-1", workTasks: store, executionRecords }), []);
    const unchanged = await store.get(first.value.id);
    assert.equal(unchanged.ok && unchanged.value.revision, 3);
    const untouched = await store.get(other.value.id);
    assert.equal(untouched.ok && untouched.value.status, "running");
    assert.equal(untouched.ok && untouched.value.revision, 2);
  });

  it("does not settle a different latest Run when recovery used a stale task snapshot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-work-task-recovery-cas-"));
    directories.push(workspace);
    const store = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), { workspace: workspace,  generateId: () => "task-1"  });
    const created = await store.create({
      threadId: "thread-1",
      goal: "Finish",
      acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const running = await store.beginRun(created.value.id, { expectedRevision: 1, runId: "run-2" });
    assert.equal(running.ok, true);
    if (!running.ok) return;
    const stale = await store.settleRecoveredRun(created.value.id, {
      expectedRevision: running.value.revision,
      latestRunId: "run-1",
      disposition: "paused",
    });
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.error.code, "WORK_TASK_REVISION_CONFLICT");
    const unchanged = await store.get(created.value.id);
    assert.equal(unchanged.ok && unchanged.value.status, "running");
    assert.equal(unchanged.ok && unchanged.value.revision, 2);
  });

  it("surfaces a settle write failure and converges when startup recovery is retried", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-work-task-recovery-retry-"));
    directories.push(workspace);
    const store = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), { workspace: workspace,  generateId: () => "task-1"  });
    const created = await store.create({
      threadId: "thread-1",
      goal: "Finish",
      acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal((await store.beginRun(created.value.id, { expectedRevision: 1, runId: "run-1" })).ok, true);
    const failing = {
      ...store,
      list: store.list.bind(store),
      settleRecoveredRun: async () => ({
        ok: false as const,
        error: { code: "WORK_TASK_WRITE_FAILED" as const, message: "injected settle failure" },
      }),
    } as WorkTaskStore;
    const executionRecords = { getRun: async () => run() };

    await assert.rejects(
      recoverRunningWorkTasks({ threadId: "thread-1", workTasks: failing, executionRecords }),
      /WORK_TASK_WRITE_FAILED: injected settle failure/,
    );
    const stillRunning = await store.get(created.value.id);
    assert.equal(stillRunning.ok && stillRunning.value.status, "running");
    assert.equal(stillRunning.ok && stillRunning.value.revision, 2);

    const recovered = await recoverRunningWorkTasks({ threadId: "thread-1", workTasks: store, executionRecords });
    assert.equal(recovered[0] ? workTaskPhase(recovered[0]) : "", "paused");
    assert.equal(recovered[0]?.revision, 3);
  });

  it("requires explicit human reconciliation and never continues a still-unknown outcome", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-work-task-reconcile-"));
    directories.push(workspace);
    let nextId = 0;
    const store = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), {
      workspace,
      generateId: () => nextId++ === 0 ? "task-1" : "reconciliation-1",
      now: () => new Date(at),
    });
    const created = await store.create({
      threadId: "thread-1",
      goal: "Reconcile an uncertain write",
      acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal((await store.beginRun(created.value.id, { expectedRevision: 1, runId: "run-1" })).ok, true);
    const review = await store.markNeedsReview(created.value.id, 2);
    assert.equal(review.ok, true);
    if (!review.ok) return;
    const bypass = await store.cancel(created.value.id, review.value.revision);
    assert.equal(bypass.ok, false);
    assert.equal(!bypass.ok && bypass.error.code, "WORK_TASK_INVALID_STATE");
    const afterBypass = await store.get(created.value.id);
    assert.equal(afterBypass.ok && workTaskPhase(afterBypass.value), "needs_review");
    assert.deepEqual(afterBypass.ok ? afterBypass.value.reconciliations : undefined, []);

    const rejected = await store.reconcile(created.value.id, {
      expectedRevision: review.value.revision,
      observedOutcome: "still_unknown",
      decision: "continue",
      note: "Could not verify the side effect",
    });
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.error.code, "WORK_TASK_INVALID_INPUT");
    const unchanged = await store.get(created.value.id);
    assert.equal(unchanged.ok && unchanged.value.revision, 3);

    const reconciled = await store.reconcile(created.value.id, {
      expectedRevision: review.value.revision,
      observedOutcome: "applied",
      decision: "continue",
      note: "Verified the external write manually",
    });
    assert.equal(reconciled.ok && workTaskPhase(reconciled.value), "paused");
    assert.equal(reconciled.ok && reconciled.value.reconciliations[0]?.runId, "run-1");
    assert.equal(reconciled.ok && reconciled.value.reconciliations[0]?.actor, "human");
  });

  it("allows cancellation while preserving a still-unknown human report", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-work-task-reconcile-cancel-"));
    directories.push(workspace);
    let nextId = 0;
    const store = createWorkTaskStore(createTaskStore(join(dirname(join(workspace, ".runloom/work-tasks.json")), "tasks.json")), {
      workspace,
      generateId: () => nextId++ === 0 ? "task-1" : "reconciliation-1",
      now: () => new Date(at),
    });
    const created = await store.create({
      threadId: "thread-1", goal: "Stop after an uncertain effect",
      acceptance: [{ id: "human", description: "Accept", method: "human", verification: { kind: "human" }, required: true }],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal((await store.beginRun(created.value.id, { expectedRevision: 1, runId: "run-1" })).ok, true);
    assert.equal((await store.markNeedsReview(created.value.id, 2)).ok, true);
    const cancelled = await store.reconcile(created.value.id, {
      expectedRevision: 3, observedOutcome: "still_unknown", decision: "cancel",
      note: "The external system could not be checked.",
    });
    assert.equal(cancelled.ok && cancelled.value.status, "cancelled");
    assert.equal(cancelled.ok && cancelled.value.reconciliations[0]?.observedOutcome, "still_unknown");
  });
});
