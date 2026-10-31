import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskStore } from "./task-store.js";
import { createWorkTaskStore } from "./work-task-store.js";
import { upgradeTaskCopy, rollbackTaskCopy } from "./task-store-upgrade.js";

const arrangement = {
  id: "reminder",
  prompt: "复核",
  runAt: "2026-11-01T01:00:00.000Z",
  status: "scheduled",
  createdAt: "2026-10-31T01:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  threadId: null,
  runId: null,
  resultText: null,
  error: null,
};
const failed = {
  ...arrangement,
  id: "failed-job",
  status: "failed",
  startedAt: "2026-10-31T01:01:00.000Z",
  finishedAt: "2026-10-31T01:02:00.000Z",
  threadId: "thread-failed",
  runId: "run-failed",
  error: { code: "MODEL_FAILED", message: "unavailable" },
};

function work(status: string) {
  const acceptance = { id: "human", description: "范围可接受", method: "human", verification: { kind: "human" }, required: true, status: "not_run", evidenceRefs: [] as string[], note: null };
  const task = {
    id: `work-${status}`,
    revision: 2,
    threadId: "thread-1",
    goal: "修复 slug",
    constraints: [] as string[],
    acceptance: [acceptance],
    status,
    runIds: status === "ready" ? [] : ["run-1"],
    delivery: status === "awaiting_acceptance" || status === "completed" ? { summary: "已提交", artifactRefs: [] as string[], evidence: [] as unknown[], unresolved: [] as string[] } : null,
    reconciliations: [] as unknown[],
    createdAt: "2026-10-31T01:00:00.000Z",
    updatedAt: "2026-10-31T01:05:00.000Z",
  };
  if (status === "completed" && task.delivery) {
    acceptance.status = "passed";
    acceptance.evidenceRefs = ["human-1"];
    task.delivery.evidence = [{ id: "human-1", kind: "human", criterionId: "human", acceptedAt: "2026-10-31T02:00:00.000Z" }];
  }
  return task;
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "serika-task-upgrade-"));
  await writeFile(join(root, "tasks.json"), `${JSON.stringify({ version: 1, tasks: [arrangement, failed] })}\n`);
  await writeFile(join(root, "work-tasks.json"), `${JSON.stringify({ version: 1, tasks: ["ready", "needs_review", "awaiting_acceptance", "paused", "completed", "cancelled"].map(work) })}\n`);
  return root;
}

test("dry-run counts the 7-to-4 and timer mappings, and rollback restores an unmodified copy", async () => {
  const root = await fixture();
  try {
    const beforeTasks = await readFile(join(root, "tasks.json"));
    const beforeWork = await readFile(join(root, "work-tasks.json"));
    const preview = await upgradeTaskCopy({ dataDirectory: root, dryRun: true });
    assert.equal(preview.blocked, false, preview.reasons.join("; "));
    assert.equal(preview.counts.arrangements, 2);
    assert.equal(preview.counts.workTasks, 6);
    assert.equal(preview.counts.from["arrangement:scheduled"], 1);
    assert.equal(preview.counts.from["arrangement:failed"], 1);
    assert.equal(preview.counts.from["work:needs_review"], 1);
    assert.equal(preview.counts.from["work:awaiting_acceptance"], 1);
    assert.equal(preview.counts.from["work:ready"], 1);
    assert.deepEqual(await readFile(join(root, "tasks.json")), beforeTasks);
    const review = preview.rows.find((row) => row.id === "work-needs_review");
    assert.equal(review?.to, "pending");
    assert.equal(review?.effectReviewRequired, true);
    assert.equal((await upgradeTaskCopy({ dataDirectory: root })).blocked, false);
    await rollbackTaskCopy({ dataDirectory: root });
    assert.deepEqual(await readFile(join(root, "tasks.json")), beforeTasks);
    assert.deepEqual(await readFile(join(root, "work-tasks.json")), beforeWork);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("upgraded copy keeps review locked and does not let the worker claim or interrupt foreground work", async () => {
  const root = await fixture();
  try {
    assert.equal((await upgradeTaskCopy({ dataDirectory: root })).blocked, false);
    const now = Date.parse("2026-11-02T00:00:00.000Z");
    const store = createTaskStore(join(root, "tasks.json"), { now: () => now });
    const claimed = await store.claimNextDue();
    assert.equal(claimed.ok && claimed.value?.id, "reminder");
    const failedJob = await store.get("failed-job");
    assert.equal(failedJob.ok && failedJob.value.status, "pending");
    assert.equal(failedJob.ok && failedJob.value.error?.code, "MODEL_FAILED");
    const workStore = createWorkTaskStore(store, { workspace: root });
    const locked = await workStore.get("work-needs_review");
    assert.equal(locked.ok && locked.value.effectReviewRequired, true);
    assert.equal((await workStore.beginRun("work-needs_review", { expectedRevision: 2, runId: "next" })).ok, false);
    assert.equal((await workStore.cancel("work-needs_review", 2)).ok, false);
    const ready = await workStore.get("work-ready");
    assert.equal(ready.ok, true);
    if (!ready.ok) return;
    assert.equal((await workStore.beginRun(ready.value.id, { expectedRevision: ready.value.revision, runId: "foreground-run" })).ok, true);
    const interrupted = await store.interruptRunning();
    assert.equal(interrupted.ok && interrupted.value, 1);
    const still = await workStore.get(ready.value.id);
    assert.equal(still.ok && still.value.status, "running");
    const reminder = await store.get("reminder");
    assert.equal(reminder.ok && reminder.value.status, "pending");
    assert.equal(reminder.ok && reminder.value.error?.code, "WORKER_INTERRUPTED");
  } finally { await rm(root, { recursive: true, force: true }); }
});
