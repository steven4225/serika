import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createTaskStore } from "./task-store.js";
import { createTaskWorkerService } from "./task-worker-service.js";

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeoutMs = 35_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (accepts(value)) return value;
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
  } while (Date.now() < deadline);
  throw new Error("Native service acceptance deadline exceeded");
}

/** Explicit opt-in: one isolated launchd label, real worker/OS notifier, no daily service. */
test("native launchd: restart killed worker, deliver overdue reminder once, retain unread result", {
  skip: process.env.RUNLOOM_TASK_SERVICE_ACCEPTANCE !== "1" || process.platform !== "darwin", timeout: 100_000,
}, async () => {
  const envFile = await realpath(resolve(process.env.RUNLOOM_WORKER_ENV_FILE ?? process.env.RUNLOOM_ENV_FILE ?? ".env"));
  const environment = parseEnv(await readFile(envFile, "utf8"));
  assert.ok(environment.RUNLOOM_MODEL && !/^mock(?:\/|$)/.test(environment.RUNLOOM_MODEL), "worker env file must explicitly select a real configured provider, not mock");
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-native-delivery-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const workerEntryPath = fileURLToPath(new URL("./task-worker-entry.js", import.meta.url));
  const service = createTaskWorkerService({ applicationHome: workspace, workspace, nodePath: await realpath(process.execPath), workerEntryPath,
    workingDirectory: dirname(workerEntryPath), launchAgentsDirectory: join(root, "LaunchAgents"), uid: process.getuid!(), envFile,
    notify: true, ...(process.env.RUNLOOM_NOTIFICATION_HELPER ? { notificationHelperPath: await realpath(process.env.RUNLOOM_NOTIFICATION_HELPER) } : {}) });
  const store = createTaskStore(join(workspace, "data/tasks.json"));
  try {
    assert.equal((await service.status()).registered, false);
    await service.enable();
    const original = await until(service.status, status => status.running && status.pid !== null);
    assert.ok(original.pid);
    process.kill(original.pid, "SIGKILL"); // Only the exact PID owned by our isolated label.
    const recovered = await until(service.status, status => status.running && status.pid !== null && status.pid !== original.pid);
    assert.ok(recovered.pid);
    // Stop only this test service to make the reminder overdue, then restore it.
    await service.disable();
    const created = await store.create({ prompt: "隔离验收：喝水", runAt: new Date(Date.now() + 500).toISOString(),
      arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } });
    assert.ok(created.ok);
    await new Promise(resolveWait => setTimeout(resolveWait, 800));
    await service.enable();
    const finished = await until(() => store.get(created.value.id), result => result.ok && result.value.status === "completed" && result.value.notification?.status === "submitted");
    assert.ok(finished.ok);
    assert.equal(finished.value.id, created.value.id);
    assert.equal(finished.value.execution, "deterministic");
    assert.equal(finished.value.runId, null);
    assert.equal(finished.value.attempts.length, 1);
    assert.equal(finished.value.acknowledgedAt, null);
    const reopened = await createTaskStore(join(workspace, "data/tasks.json")).get(created.value.id);
    assert.ok(reopened.ok);
    assert.equal(reopened.value.acknowledgedAt, null);
    console.log(JSON.stringify({ launchdRestart: true, overdueReminderCompleted: true, sameTaskId: true,
      attempts: 1, modelRun: false, notification: "submitted", userReceipt: "not_proven", nativeElectron: "not_run", notificationClick: "not_run" }));
  } finally {
    // Keep the fixture recoverable if cleanup cannot confirm the service is gone.
    const stopped = await service.disable();
    assert.equal(stopped.registered, false);
    await rm(root, { recursive: true, force: true });
  }
});
