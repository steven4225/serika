import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tryAcquireFlock } from "./flock.js";
import { TASK_WORKER_LOCK_FILE_NAME, type TaskStore } from "./task-store.js";
import { assertWorkerPathSafe, writeWorkerFileAtomic } from "./task-worker-service.js";

export const TASK_WORKER_HEALTH_FILE = ".runloom/task-worker-health.json";
export interface TaskWorkerHeartbeat {
  version: 1;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  stoppedAt: string | null;
  currentTaskId: string | null;
  lastHandled: { taskId: string; at: string } | null;
  recentFailure: { code: string; message: string; at: string } | null;
}

export function createTaskWorkerHealthWriter(workspace: string, options: { pid?: number; now?: () => Date } = {}) {
  const path = join(resolve(workspace), TASK_WORKER_HEALTH_FILE);
  const now = options.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const state: TaskWorkerHeartbeat = { version: 1, pid: options.pid ?? process.pid, startedAt: timestamp, heartbeatAt: timestamp, stoppedAt: null, currentTaskId: null, lastHandled: null, recentFailure: null };
  let queue = Promise.resolve();
  function update(change: () => void): Promise<void> {
    // Recover the queue after a failed write; the caller still receives that failure.
    queue = queue.catch(() => undefined).then(async () => {
      change();
      const text = `${JSON.stringify(state)}\n`;
      if (Buffer.byteLength(text, "utf8") > 4096) throw new Error("Worker health exceeds 4 KiB");
      await writeWorkerFileAtomic(path, text);
    });
    return queue;
  }
  return {
    heartbeat(currentTaskId?: string | null) { return update(() => { if (state.stoppedAt !== null) return; state.heartbeatAt = now().toISOString(); if (currentTaskId !== undefined) state.currentTaskId = currentTaskId === null ? null : currentTaskId.slice(0, 256); }); },
    handled(taskId: string) { return update(() => { state.currentTaskId = null; state.lastHandled = { taskId: taskId.slice(0, 256), at: now().toISOString() }; }); },
    failure(code: string, message: string) { return update(() => { state.recentFailure = { code: code.slice(0, 128), message: message.slice(0, 512), at: now().toISOString() }; }); },
    stopped() { return update(() => { state.stoppedAt = now().toISOString(); state.currentTaskId = null; }); },
    flush() { return queue; },
  };
}

function validateHealth(value: unknown): TaskWorkerHeartbeat {
  if (typeof value !== "object" || value === null) throw new Error("Invalid worker health record");
  const v = value as Record<string, unknown>;
  const date = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s));
  const text = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max;
  if (v.version !== 1 || !Number.isSafeInteger(v.pid) || (v.pid as number) <= 0 || !date(v.startedAt) || !date(v.heartbeatAt) || !(v.stoppedAt === null || date(v.stoppedAt)) || !(v.currentTaskId === null || text(v.currentTaskId, 256))) throw new Error("Invalid worker health record");
  if (v.lastHandled !== null) {
    const h = v.lastHandled as Record<string, unknown> | undefined;
    if (typeof h !== "object" || h === null || !text(h.taskId, 256) || !date(h.at)) throw new Error("Invalid last-handled health record");
  }
  if (v.recentFailure !== null) {
    const f = v.recentFailure as Record<string, unknown> | undefined;
    if (typeof f !== "object" || f === null || !text(f.code, 128) || !text(f.message, 512) || !date(f.at)) throw new Error("Invalid worker failure health record");
  }
  return value as TaskWorkerHeartbeat;
}

export async function readTaskWorkerHealth(workspace: string, store: TaskStore) {
  let heartbeat: TaskWorkerHeartbeat | null = null;
  let error: string | null = null;
  const root = resolve(workspace);
  try {
    const path = join(root, TASK_WORKER_HEALTH_FILE);
    await assertWorkerPathSafe(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await file.stat()).size > 4096) throw new Error("Worker health exceeds 4 KiB");
      heartbeat = validateHealth(JSON.parse(await file.readFile("utf8")));
    } finally { await file.close(); }
  } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") error = String(failure); }
  let ownership: "held" | "free" | "unchecked" = "unchecked";
  try {
    const path = join(root, TASK_WORKER_LOCK_FILE_NAME);
    await assertWorkerPathSafe(path);
    const stats = await lstat(path);
    if (!stats.isFile()) throw new Error("Worker lock is not a regular file");
    const lock = await tryAcquireFlock(path);
    ownership = lock === null ? "held" : "free";
    await lock?.release();
  } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") error ??= String(failure); }
  const counts = await store.getHealthCounts();
  if (!counts.ok) return { ownership, heartbeat, error: counts.error.message, unacknowledgedCount: null, notificationFailureCount: null, heartbeatIsLivenessProof: false as const };
  return { ownership, heartbeat, error, ...counts.value, heartbeatIsLivenessProof: false as const };
}
