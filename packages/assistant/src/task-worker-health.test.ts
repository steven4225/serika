import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createTaskStore, TASK_WORKER_LOCK_FILE_NAME } from "./task-store.js";
import { acquireFlock } from "./flock.js";
import { createTaskWorkerHealthWriter, readTaskWorkerHealth, TASK_WORKER_HEALTH_FILE } from "./task-worker-health.js";

it("health writes serialize and heartbeat cannot revive a stopped worker", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-health-")));
  try {
    const writer = createTaskWorkerHealthWriter(root, { pid: 123 });
    await Promise.all([writer.heartbeat("task-a"), writer.handled("task-a"), writer.failure("TEST", "failed"), writer.stopped(), writer.heartbeat("task-b")]);
    const file = JSON.parse(await readFile(join(root, TASK_WORKER_HEALTH_FILE), "utf8"));
    assert.equal(file.currentTaskId, null);
    assert.notEqual(file.stoppedAt, null);
    assert.equal(file.lastHandled.taskId, "task-a");
    const health = await readTaskWorkerHealth(root, createTaskStore(join(root, ".runloom/tasks.json")));
    assert.equal(health.ownership, "unchecked");
    assert.equal(health.heartbeat?.pid, 123);
    assert.equal(health.heartbeatIsLivenessProof, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("missing health is empty and corrupt health never appears healthy", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-health-")));
  try {
    const store = createTaskStore(join(root, ".runloom/tasks.json"));
    const missing = await readTaskWorkerHealth(root, store);
    assert.equal(missing.heartbeat, null);
    assert.equal(missing.error, null);
    const writer = createTaskWorkerHealthWriter(root);
    await writer.heartbeat();
    await writeFile(join(root, TASK_WORKER_HEALTH_FILE), "not json");
    const bad = await readTaskWorkerHealth(root, store);
    assert.equal(bad.heartbeat, null);
    assert.notEqual(bad.error, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("health ownership uses the worker lock, not a recent heartbeat", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runloom-health-")));
  const lock = await acquireFlock(join(root, TASK_WORKER_LOCK_FILE_NAME));
  try {
    const store = createTaskStore(join(root, ".runloom/tasks.json"));
    assert.equal((await readTaskWorkerHealth(root, store)).ownership, "held");
    await lock.release();
    assert.equal((await readTaskWorkerHealth(root, store)).ownership, "free");
  } finally { await lock.release(); await rm(root, { recursive: true, force: true }); }
});
