import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  TASK_FILE_NAME,
  TASK_PROMPT_MAX_BYTES,
  createTaskStore,
} from "./task-store.js";
import { acquireFlock } from "./flock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-task-store-"));
  directories.push(directory);
  return directory;
}

function code(result: { ok: true } | { ok: false; error: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("WorkspaceTaskStore", () => {
  it("persists create/list/get/cancel through a fresh store instance", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-11T01:00:00.000Z");
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => "task-1",
    });

    assert.deepEqual(await store.list(), {
      ok: true,
      value: { tasks: [], truncated: false },
    });
    await assert.rejects(
      readFile(join(root, TASK_FILE_NAME)),
      { code: "ENOENT" },
    );

    const created = await store.create({
      runAt: "2026-09-12T09:00:00+08:00",
      prompt: "prepare a plan",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.deepEqual(created.value, {
      id: "task-1",
      prompt: "prepare a plan",
      runAt: "2026-09-12T01:00:00.000Z",
      status: "scheduled",
      createdAt: "2026-09-11T01:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      threadId: null,
      runId: null,
      resultText: null,
      error: null,
      acknowledgedAt: null,
      recurringTaskId: null,
    });

    const reopened = createTaskStore(root, { now: () => now });
    assert.deepEqual(await reopened.list(), {
      ok: true,
      value: {
        tasks: [{
          id: "task-1",
          promptPreview: "prepare a plan",
          runAt: "2026-09-12T01:00:00.000Z",
          status: "scheduled",
          finishedAt: null,
          resultPreview: null,
          error: null,
          acknowledgedAt: null,
          recurringTaskId: null,
        }],
        truncated: false,
      },
    });
    assert.deepEqual(await reopened.get("task-1"), { ok: true, value: created.value });

    now = Date.parse("2026-09-11T02:00:00.000Z");
    const cancelled = await reopened.cancel("task-1");
    assert.equal(cancelled.ok, true);
    if (cancelled.ok) {
      assert.equal(cancelled.value.status, "cancelled");
      assert.equal(cancelled.value.finishedAt, "2026-09-11T02:00:00.000Z");
    }
    assert.deepEqual(await reopened.cancel("task-1"), cancelled);
  });

  it("creates, pauses, resumes, and cancels a fixed-offset recurring task", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-10T00:30:00.000Z");
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => "repeat-1",
    });

    const created = await store.createRecurring({
      prompt: "prepare a daily plan",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
    });
    assert.deepEqual(created, {
      ok: true,
      value: {
        id: "repeat-1",
        prompt: "prepare a daily plan",
        recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
        status: "active",
        createdAt: "2026-09-10T00:30:00.000Z",
        nextRunAt: "2026-09-10T01:00:00.000Z",
      },
    });

    assert.deepEqual(await store.pauseRecurring("repeat-1"), {
      ok: true,
      value: {
        id: "repeat-1",
        prompt: "prepare a daily plan",
        recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
        status: "paused",
        createdAt: "2026-09-10T00:30:00.000Z",
        nextRunAt: null,
      },
    });
    now = Date.parse("2026-09-12T05:00:00.000Z");
    const resumed = await store.resumeRecurring("repeat-1");
    assert.equal(resumed.ok, true);
    if (resumed.ok) {
      assert.equal(resumed.value.status, "active");
      assert.equal(resumed.value.nextRunAt, "2026-09-13T01:00:00.000Z");
    }
    assert.deepEqual(await store.cancelRecurring("repeat-1"), {
      ok: true,
      value: {
        id: "repeat-1",
        prompt: "prepare a daily plan",
        recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
        status: "cancelled",
        createdAt: "2026-09-10T00:30:00.000Z",
        nextRunAt: null,
      },
    });
    assert.equal(code(await store.resumeRecurring("repeat-1")), "RECURRING_TASK_CANCELLED");
  });

  it("claims one overdue recurring occurrence and skips missed periods", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-10T00:30:00.000Z");
    const ids = ["repeat-1", "task-1", "thread-1"];
    let idIndex = 0;
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => ids[idIndex++] ?? `generated-${idIndex}`,
    });
    await store.createRecurring({
      prompt: "daily plan",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
    });

    now = Date.parse("2026-09-13T02:00:00.000Z");
    const claimed = await store.claimNextDue();
    assert.equal(claimed.ok, true);
    if (!claimed.ok || claimed.value === null) return;
    assert.equal(claimed.value.id, "task-1");
    assert.equal(claimed.value.runAt, "2026-09-10T01:00:00.000Z");
    assert.equal(claimed.value.recurringTaskId, "repeat-1");
    assert.equal(claimed.value.status, "running");

    const detail = await store.getRecurring("repeat-1");
    assert.equal(detail.ok, true);
    if (detail.ok) {
      assert.equal(detail.value.recurringTask.nextRunAt, "2026-09-14T01:00:00.000Z");
      assert.equal(detail.value.latestTask?.id, "task-1");
    }
    assert.deepEqual(await store.claimNextDue(), { ok: true, value: null });
  });

  it("reads v1 files and upgrades them on the first write", async () => {
    const root = await workspace();
    await mkdir(join(root, ".runloom"));
    await writeFile(
      join(root, TASK_FILE_NAME),
      `${JSON.stringify({
        version: 1,
        tasks: [{
          id: "legacy",
          prompt: "legacy task",
          runAt: "2026-09-12T00:00:00.000Z",
          status: "scheduled",
          createdAt: "2026-09-11T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          threadId: null,
          runId: null,
          resultText: null,
          error: null,
        }],
      })}\n`,
      "utf8",
    );
    let id = 0;
    const store = createTaskStore(root, {
      now: () => Date.parse("2026-09-11T00:00:00.000Z"),
      generateId: () => `new-${++id}`,
    });
    const readOnly = await store.list();
    assert.equal(readOnly.ok, true);
    if (readOnly.ok) assert.equal(readOnly.value.tasks[0]?.recurringTaskId, null);
    const created = await store.create({ prompt: "new task", runAt: "2026-09-13T00:00:00Z" });
    assert.equal(created.ok, true);
    const document = JSON.parse(await readFile(join(root, TASK_FILE_NAME), "utf8")) as {
      version: number;
      tasks: Array<{ recurringTaskId: string | null; acknowledgedAt: string | null }>;
      recurringTasks: unknown[];
    };
    assert.equal(document.version, 3);
    assert.deepEqual(document.recurringTasks, []);
    assert.deepEqual(document.tasks.map((task) => task.recurringTaskId), [null, null]);
    assert.deepEqual(document.tasks.map((task) => task.acknowledgedAt), [null, null]);
  });

  it("filters grouped statuses before limiting and projects bounded results and errors", async () => {
    const root = await workspace();
    const store = createTaskStore(root);
    const longPrompt = "任务😀".repeat(80);
    const longResult = "结果🙂".repeat(80);
    const longError = "模型失败🚨".repeat(80);
    const task = (overrides: Record<string, unknown>) => ({
      id: "task-default",
      prompt: "short prompt",
      runAt: "2026-09-12T00:30:00.000Z",
      status: "scheduled",
      createdAt: "2026-09-11T00:01:00.000Z",
      startedAt: null,
      finishedAt: null,
      threadId: null,
      runId: null,
      resultText: null,
      error: null,
      acknowledgedAt: null,
      ...overrides,
    });
    await mkdir(join(root, ".runloom"));
    await writeFile(
      join(root, TASK_FILE_NAME),
      `${JSON.stringify({
        version: 1,
        tasks: [
          task({ id: "scheduled", prompt: longPrompt }),
          task({
            id: "running",
            status: "running",
            createdAt: "2026-09-11T00:02:00.000Z",
            startedAt: "2026-09-11T00:03:00.000Z",
            threadId: "thread-running",
          }),
          task({
            id: "completed",
            status: "completed",
            createdAt: "2026-09-11T00:03:00.000Z",
            startedAt: "2026-09-11T00:04:00.000Z",
            finishedAt: "2026-09-11T00:05:00.000Z",
            threadId: "thread-completed",
            runId: "run-completed",
            resultText: longResult,
          }),
          task({
            id: "failed",
            status: "failed",
            createdAt: "2026-09-11T00:04:00.000Z",
            startedAt: "2026-09-11T00:05:00.000Z",
            finishedAt: "2026-09-11T00:06:00.000Z",
            threadId: "thread-failed",
            runId: "run-failed",
            error: { code: "MODEL_FAILED", message: longError },
          }),
          task({
            id: "interrupted",
            status: "interrupted",
            createdAt: "2026-09-11T00:05:00.000Z",
            startedAt: "2026-09-11T00:06:00.000Z",
            finishedAt: "2026-09-11T00:07:00.000Z",
            threadId: "thread-interrupted",
            error: { code: "WORKER_INTERRUPTED", message: longError },
          }),
          task({
            id: "cancelled",
            status: "cancelled",
            createdAt: "2026-09-11T00:06:00.000Z",
            finishedAt: "2026-09-11T00:07:00.000Z",
          }),
        ],
      })}\n`,
      "utf8",
    );

    const pending = await store.list({ status: "pending" });
    assert.equal(pending.ok, true);
    if (!pending.ok) return;
    assert.deepEqual(pending.value.tasks.map((item) => item.id), ["running", "scheduled"]);
    assert.equal(pending.value.tasks[0]?.resultPreview, null);
    assert.equal(pending.value.tasks[0]?.error, null);

    const attention = await store.list({ status: "attention", limit: 1 });
    assert.equal(attention.ok, true);
    if (!attention.ok) return;
    assert.deepEqual(attention.value.tasks.map((item) => item.id), ["interrupted"]);
    assert.equal(attention.value.truncated, true);
    assert.deepEqual(attention.value.tasks[0]?.error, {
      code: "WORKER_INTERRUPTED",
      messagePreview: Array.from(longError).slice(0, 120).join(""),
    });

    const all = await store.list({ limit: 50 });
    assert.equal(all.ok, true);
    if (!all.ok) return;
    const completed = all.value.tasks.find((item) => item.id === "completed");
    assert.deepEqual(completed, {
      id: "completed",
      promptPreview: "short prompt",
      runAt: "2026-09-12T00:30:00.000Z",
      status: "completed",
      finishedAt: "2026-09-11T00:05:00.000Z",
      resultPreview: Array.from(longResult).slice(0, 120).join(""),
      error: null,
      acknowledgedAt: null,
      recurringTaskId: null,
    });
    const failed = all.value.tasks.find((item) => item.id === "failed");
    assert.deepEqual(failed?.error, {
      code: "MODEL_FAILED",
      messagePreview: Array.from(longError).slice(0, 120).join(""),
    });
    assert.equal(failed?.resultPreview, null);
    const scheduled = all.value.tasks.find((item) => item.id === "scheduled");
    assert.equal(scheduled?.promptPreview, Array.from(longPrompt).slice(0, 120).join(""));
    assert.equal(scheduled?.promptPreview.endsWith("\ud83d"), false);
  });

  it("keeps list queries read-only", async () => {
    const root = await workspace();
    const store = createTaskStore(root, {
      now: () => Date.parse("2026-09-11T00:00:00.000Z"),
      generateId: () => "task-1",
    });
    await store.create({ prompt: "query only", runAt: "2026-09-12T00:00:00Z" });
    const path = join(root, TASK_FILE_NAME);
    const before = await readFile(path, "utf8");
    const result = await store.list({ status: "pending", limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path, "utf8"), before);
  });

  it("reads v1 without writing and upgrades it on the first successful mutation", async () => {
    const root = await workspace();
    const now = Date.parse("2026-09-11T00:00:00.000Z");
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => "task-v2",
    });
    const runloom = join(root, ".runloom");
    await mkdir(runloom);
    const v1 = {
      version: 1,
      tasks: [{
        id: "task-v1",
        prompt: "old task",
        runAt: "2026-09-12T00:00:00.000Z",
        status: "scheduled",
        createdAt: "2026-09-10T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        threadId: null,
        runId: null,
        resultText: null,
        error: null,
      }],
    };
    await writeFile(join(runloom, "tasks.json"), `${JSON.stringify(v1)}\n`, "utf8");
    const path = join(root, TASK_FILE_NAME);
    const before = await readFile(path, "utf8");

    const queried = await store.get("task-v1");
    assert.equal(queried.ok, true);
    if (queried.ok) assert.equal(queried.value.recurringTaskId, null);
    assert.equal(await readFile(path, "utf8"), before);

    const created = await store.create({
      prompt: "new task",
      runAt: "2026-09-13T00:00:00Z",
    });
    assert.equal(created.ok, true);
    const upgraded = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      tasks: Array<{ id: string; recurringTaskId: string | null; acknowledgedAt: string | null }>;
      recurringTasks: unknown[];
    };
    assert.equal(upgraded.version, 3);
    assert.deepEqual(upgraded.recurringTasks, []);
    assert.equal(upgraded.tasks.find((task) => task.id === "task-v1")?.recurringTaskId, null);
    assert.equal(upgraded.tasks.find((task) => task.id === "task-v1")?.acknowledgedAt, null);
  });

  it("reads v2 without writing and upgrades it to v3 on the first successful mutation", async () => {
    const root = await workspace();
    const now = Date.parse("2026-09-11T00:00:00.000Z");
    const store = createTaskStore(root, { now: () => now });
    const runloom = join(root, ".runloom");
    await mkdir(runloom);
    const v2 = {
      version: 2,
      tasks: [{
        id: "task-v2",
        prompt: "old v2 task",
        runAt: "2026-09-12T00:00:00.000Z",
        status: "scheduled",
        createdAt: "2026-09-10T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        threadId: null,
        runId: null,
        resultText: null,
        error: null,
        recurringTaskId: null,
      }],
      recurringTasks: [],
    };
    const path = join(root, TASK_FILE_NAME);
    await writeFile(path, `${JSON.stringify(v2)}\n`, "utf8");
    const before = await readFile(path, "utf8");

    const queried = await store.get("task-v2");
    assert.equal(queried.ok, true);
    if (queried.ok) assert.equal(queried.value.acknowledgedAt, null);
    const listed = await store.list();
    assert.equal(listed.ok, true);
    if (listed.ok) assert.equal(listed.value.tasks[0]?.acknowledgedAt, null);
    assert.equal(await readFile(path, "utf8"), before);

    const cancelled = await store.cancel("task-v2");
    assert.equal(cancelled.ok, true);
    const upgraded = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      tasks: Array<{ acknowledgedAt: string | null }>;
    };
    assert.equal(upgraded.version, 3);
    assert.equal(upgraded.tasks[0]?.acknowledgedAt, null);
  });

  it("filters inbox items after combining status and recurring-task filters", async () => {
    const root = await workspace();
    const store = createTaskStore(root, {
      now: () => Date.parse("2026-09-11T00:10:00.000Z"),
    });
    const terminalTask = (overrides: Record<string, unknown>) => ({
      id: "task-default",
      prompt: "terminal task",
      runAt: "2026-09-12T00:00:00.000Z",
      status: "completed",
      createdAt: "2026-09-11T00:00:00.000Z",
      startedAt: "2026-09-11T00:00:01.000Z",
      finishedAt: "2026-09-11T00:00:02.000Z",
      threadId: "thread-default",
      runId: "run-default",
      resultText: "done",
      error: null,
      acknowledgedAt: null,
      recurringTaskId: null,
      ...overrides,
    });
    const cancelledTask = {
      id: "cancelled",
      prompt: "cancelled task",
      runAt: "2026-09-12T00:00:00.000Z",
      status: "cancelled",
      createdAt: "2026-09-11T00:05:00.000Z",
      startedAt: null,
      finishedAt: "2026-09-11T00:06:00.000Z",
      threadId: null,
      runId: null,
      resultText: null,
      error: null,
      acknowledgedAt: null,
      recurringTaskId: null,
    };
    await mkdir(join(root, ".runloom"));
    await writeFile(
      join(root, TASK_FILE_NAME),
      `${JSON.stringify({
        version: 3,
        tasks: [
          terminalTask({ id: "completed-unacknowledged", createdAt: "2026-09-11T00:01:00.000Z" }),
          terminalTask({
            id: "completed-acknowledged",
            createdAt: "2026-09-11T00:02:00.000Z",
            acknowledgedAt: "2026-09-11T00:09:00.000Z",
          }),
          terminalTask({
            id: "failed-repeat",
            status: "failed",
            createdAt: "2026-09-11T00:03:00.000Z",
            resultText: null,
            error: { code: "MODEL_FAILED", message: "model failed" },
            recurringTaskId: "repeat-1",
          }),
          terminalTask({
            id: "interrupted-repeat",
            status: "interrupted",
            createdAt: "2026-09-11T00:04:00.000Z",
            resultText: null,
            error: { code: "WORKER_INTERRUPTED", message: "worker stopped" },
            recurringTaskId: "repeat-1",
          }),
          cancelledTask,
        ],
        recurringTasks: [{
          id: "repeat-1",
          prompt: "repeat task",
          recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
          status: "paused",
          createdAt: "2026-09-10T00:00:00.000Z",
          nextRunAt: null,
        }],
      })}\n`,
      "utf8",
    );

    const inbox = await store.list({ inbox: true, limit: 2 });
    assert.equal(inbox.ok, true);
    if (inbox.ok) {
      assert.deepEqual(inbox.value.tasks.map((task) => task.id), [
        "interrupted-repeat",
        "failed-repeat",
      ]);
      assert.equal(inbox.value.truncated, true);
      assert.deepEqual(inbox.value.tasks.map((task) => task.acknowledgedAt), [null, null]);
    }
    const scoped = await store.list({
      inbox: true,
      status: "failed",
      recurringTaskId: "repeat-1",
    });
    assert.equal(scoped.ok, true);
    if (scoped.ok) assert.deepEqual(scoped.value.tasks.map((task) => task.id), ["failed-repeat"]);
    const allInbox = await store.list({ inbox: true, limit: 50 });
    assert.equal(allInbox.ok, true);
    if (allInbox.ok) {
      assert.deepEqual(allInbox.value.tasks.map((task) => task.id), [
        "interrupted-repeat",
        "failed-repeat",
        "completed-unacknowledged",
      ]);
    }
  });

  it("acknowledges terminal tasks idempotently and rejects non-inbox states", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-11T00:10:00.000Z");
    const store = createTaskStore(root, { now: () => now });
    const task = {
      id: "completed",
      prompt: "completed task",
      runAt: "2026-09-12T00:00:00.000Z",
      status: "completed",
      createdAt: "2026-09-11T00:00:00.000Z",
      startedAt: "2026-09-11T00:01:00.000Z",
      finishedAt: "2026-09-11T00:02:00.000Z",
      threadId: "thread-1",
      runId: "run-1",
      resultText: "done",
      error: null,
      acknowledgedAt: null,
      recurringTaskId: null,
    };
    const running = {
      ...task,
      id: "running",
      status: "running",
      finishedAt: null,
      runId: null,
      resultText: null,
      error: null,
    };
    await mkdir(join(root, ".runloom"));
    await writeFile(
      join(root, TASK_FILE_NAME),
      `${JSON.stringify({ version: 3, tasks: [task, running], recurringTasks: [] })}\n`,
      "utf8",
    );

    const acknowledged = await store.acknowledge("completed");
    assert.equal(acknowledged.ok, true);
    if (!acknowledged.ok) return;
    assert.equal(acknowledged.value.acknowledgedAt, "2026-09-11T00:10:00.000Z");
    now = Date.parse("2026-09-11T00:11:00.000Z");
    assert.deepEqual(await store.acknowledge("completed"), acknowledged);
    assert.equal(code(await store.acknowledge("running")), "TASK_NOT_ACKNOWLEDGEABLE");
    assert.equal(code(await store.acknowledge("missing")), "TASK_NOT_FOUND");
  });

  it("creates, pauses, resumes, cancels, and lists recurring task plans", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-11T00:00:00.000Z");
    let id = 0;
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => `repeat-${++id}`,
    });
    const created = await store.createRecurring({
      prompt: "prepare a daily plan",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.deepEqual(created.value, {
      id: "repeat-1",
      prompt: "prepare a daily plan",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
      status: "active",
      createdAt: "2026-09-11T00:00:00.000Z",
      nextRunAt: "2026-09-11T01:00:00.000Z",
    });
    assert.deepEqual(await store.listRecurring(), {
      ok: true,
      value: {
        recurringTasks: [{
          id: "repeat-1",
          promptPreview: "prepare a daily plan",
          recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
          status: "active",
          nextRunAt: "2026-09-11T01:00:00.000Z",
        }],
        truncated: false,
      },
    });

    assert.equal((await store.pauseRecurring("repeat-1")).ok, true);
    const paused = await store.getRecurring("repeat-1");
    assert.equal(paused.ok, true);
    if (paused.ok) assert.deepEqual(paused.value.recurringTask, {
      ...created.value,
      status: "paused",
      nextRunAt: null,
    });
    assert.equal((await store.resumeRecurring("repeat-1")).ok, true);
    assert.equal((await store.cancelRecurring("repeat-1")).ok, true);
    assert.equal(code(await store.resumeRecurring("repeat-1")), "RECURRING_TASK_CANCELLED");
    assert.equal(code(await store.pauseRecurring("missing")), "RECURRING_TASK_NOT_FOUND");
  });

  it("claims one overdue recurring occurrence atomically and preserves later plan changes", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-14T02:00:00.000Z");
    const ids = ["repeat-1", "task-1", "thread-1"];
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => ids.shift() ?? "unexpected-id",
    });
    const recurring = await store.createRecurring({
      prompt: "prepare a daily plan",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
    });
    assert.equal(recurring.ok, true);
    const claimed = await store.claimNextDue();
    assert.equal(claimed.ok, true);
    if (!claimed.ok || claimed.value === null) return;
    assert.equal(claimed.value.id, "task-1");
    assert.equal(claimed.value.threadId, "thread-1");
    assert.equal(claimed.value.recurringTaskId, "repeat-1");
    assert.equal(claimed.value.runAt, "2026-09-11T01:00:00.000Z");
    assert.equal(claimed.value.status, "running");

    const planAfterClaim = await store.getRecurring("repeat-1");
    assert.equal(planAfterClaim.ok, true);
    if (planAfterClaim.ok) assert.equal(
      planAfterClaim.value.recurringTask.nextRunAt,
      "2026-09-15T01:00:00.000Z",
    );
    const noSecondClaim = await store.claimNextDue();
    assert.deepEqual(noSecondClaim, { ok: true, value: null });

    now = Date.parse("2026-09-15T02:00:00.000Z");
    assert.equal((await store.pauseRecurring("repeat-1")).ok, true);
    const finished = await store.finish(claimed.value.id, {
      status: "completed",
      runId: "run-1",
      resultText: "daily plan",
    });
    assert.equal(finished.ok, true);
    const detail = await store.getRecurring("repeat-1");
    assert.equal(detail.ok, true);
    if (detail.ok) {
      assert.equal(detail.value.recurringTask.status, "paused");
      assert.equal(detail.value.recurringTask.nextRunAt, null);
      assert.equal(detail.value.latestTask?.status, "completed");
      assert.equal(detail.value.latestTask?.resultText, "daily plan");
    }
    const tasks = await store.list({ recurringTaskId: "repeat-1" });
    assert.equal(tasks.ok, true);
    if (tasks.ok) assert.deepEqual(tasks.value.tasks.map((task) => task.recurringTaskId), ["repeat-1"]);
  });

  it("keeps acknowledgement independent of recurring execution and crash recovery", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-11T00:00:00.000Z");
    const store = createTaskStore(root, { now: () => now });
    const plan = await store.createRecurring({
      prompt: "daily acceptance",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
    });
    assert.ok(plan.ok);
    now = Date.parse("2026-09-11T02:00:00.000Z");
    const first = await store.claimNextDue();
    assert.ok(first.ok && first.value);
    assert.ok((await store.finish(first.value.id, {
      status: "failed", runId: "run-1", error: { code: "MODEL_FAILED", message: "unavailable" },
    })).ok);

    now = Date.parse("2026-09-12T02:00:00.000Z");
    const second = await store.claimNextDue();
    assert.ok(second.ok && second.value);
    assert.notEqual(second.value.id, first.value.id);
    const beforeAck = await store.getRecurring(plan.value.id);
    assert.ok(beforeAck.ok);
    // Two independent store clients update the same file: neither may lose the other's write.
    const otherClient = createTaskStore(root, { now: () => now });
    const [ack, finish] = await Promise.all([
      store.acknowledge(first.value.id),
      otherClient.finish(second.value.id, { status: "completed", runId: "run-2", resultText: "done" }),
    ]);
    assert.ok(ack.ok && finish.ok);
    const afterAck = await otherClient.getRecurring(plan.value.id);
    assert.ok(afterAck.ok);
    assert.deepEqual(afterAck.value.recurringTask, beforeAck.value.recurringTask);
    assert.deepEqual(await otherClient.get(first.value.id), ack);
    assert.deepEqual(await store.get(second.value.id), finish);

    now = Date.parse("2026-09-13T02:00:00.000Z");
    const third = await store.claimNextDue();
    assert.ok(third.ok && third.value);
    const beforeRecovery = await store.getRecurring(plan.value.id);
    assert.ok(beforeRecovery.ok);
    const reopened = createTaskStore(root, { now: () => now });
    assert.deepEqual(await reopened.interruptRunning(), { ok: true, value: 1 });
    const recovered = await reopened.get(third.value.id);
    assert.ok(recovered.ok);
    assert.equal(recovered.value.status, "interrupted");
    assert.equal(recovered.value.acknowledgedAt, null);
    assert.ok((await reopened.acknowledge(third.value.id)).ok);
    const afterRecovery = await reopened.getRecurring(plan.value.id);
    assert.ok(afterRecovery.ok);
    assert.deepEqual(afterRecovery.value.recurringTask, beforeRecovery.value.recurringTask);
    const inbox = await reopened.list({ inbox: true });
    assert.ok(inbox.ok);
    assert.deepEqual(inbox.value.tasks.map((task) => task.id), [second.value.id]);
    const attention = await reopened.list({ status: "attention" });
    assert.ok(attention.ok);
    assert.deepEqual(new Set(attention.value.tasks.map((task) => task.id)), new Set([first.value.id, third.value.id]));
    assert.deepEqual(await reopened.claimNextDue(), { ok: true, value: null });
  });

  it("leaves the recurring plan for the next claim after an interruption", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-14T00:00:00.000Z");
    const ids = ["repeat-1", "task-1", "thread-1", "task-2", "thread-2"];
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => ids.shift() ?? "unexpected-id",
    });
    await store.createRecurring({
      prompt: "prepare a daily plan",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
    });
    now = Date.parse("2026-09-14T02:00:00.000Z");
    const claimed = await store.claimNextDue();
    assert.equal(claimed.ok, true);
    if (!claimed.ok || claimed.value === null) return;
    now = Date.parse("2026-09-15T02:00:00.000Z");
    assert.deepEqual(await store.interruptRunning(), { ok: true, value: 1 });
    const detail = await store.getRecurring("repeat-1");
    assert.equal(detail.ok, true);
    if (detail.ok) {
      assert.equal(detail.value.recurringTask.nextRunAt, "2026-09-15T01:00:00.000Z");
      assert.equal(detail.value.latestTask?.status, "interrupted");
      assert.equal(detail.value.latestTask?.acknowledgedAt, null);
    }

    const nextClaim = await store.claimNextDue();
    assert.equal(nextClaim.ok, true);
    if (nextClaim.ok) {
      assert.equal(nextClaim.value?.id, "task-2");
      assert.equal(nextClaim.value?.runAt, "2026-09-15T01:00:00.000Z");
      assert.equal(nextClaim.value?.recurringTaskId, "repeat-1");
    }
    const afterNextClaim = await store.getRecurring("repeat-1");
    assert.equal(afterNextClaim.ok, true);
    if (afterNextClaim.ok) {
      assert.equal(afterNextClaim.value.recurringTask.nextRunAt, "2026-09-16T01:00:00.000Z");
    }
  });

  it("rejects invalid future times, prompts, files, and versions", async () => {
    const root = await workspace();
    const store = createTaskStore(root, {
      now: () => Date.parse("2026-09-11T00:00:00.000Z"),
      generateId: () => "task-1",
    });
    assert.equal(code(await store.create({ prompt: " ", runAt: "2026-09-12T00:00:00Z" })), "INVALID_INPUT");
    assert.equal(code(await store.create({ prompt: "x".repeat(TASK_PROMPT_MAX_BYTES + 1), runAt: "2026-09-12T00:00:00Z" })), "INVALID_INPUT");
    assert.equal(code(await store.create({ prompt: "x", runAt: "2026-09-12T00:00:00" })), "INVALID_INPUT");
    assert.equal(code(await store.create({ prompt: "x", runAt: "2026-09-10T00:00:00Z" })), "INVALID_INPUT");

    const runloom = join(root, ".runloom");
    await mkdir(runloom);
    await writeFile(join(runloom, "tasks.json"), "not-json");
    assert.equal(code(await store.list()), "TASK_FILE_INVALID");
    await writeFile(
      join(runloom, "tasks.json"),
      JSON.stringify({ version: 2, tasks: [] }),
    );
    assert.equal(code(await store.list()), "TASK_FILE_INVALID");
  });

  it("claims due tasks in deterministic order and enforces terminal transitions", async () => {
    const root = await workspace();
    let now = Date.parse("2026-09-11T00:00:00.000Z");
    let id = 0;
    const store = createTaskStore(root, {
      now: () => now,
      generateId: () => `task-${++id}`,
    });
    await store.create({ prompt: "later", runAt: "2026-09-11T00:00:02Z" });
    await store.create({ prompt: "first", runAt: "2026-09-11T00:00:01Z" });
    await store.create({ prompt: "second", runAt: "2026-09-11T00:00:01Z" });

    now += 1_000;
    const first = await store.claimNextDue();
    assert.equal(first.ok, true);
    if (!first.ok || first.value === null) return;
    assert.equal(first.value.prompt, "first");
    assert.equal(first.value.status, "running");
    assert.equal(first.value.threadId, "task-4");

    const completed = await store.finish(first.value.id, {
      status: "completed",
      runId: "run-1",
      resultText: "done",
    });
    assert.equal(completed.ok, true);
    if (completed.ok) {
      assert.equal(completed.value.status, "completed");
      assert.equal(completed.value.resultText, "done");
      assert.equal(completed.value.acknowledgedAt, null);
    }
    assert.equal(code(await store.finish(first.value.id, {
      status: "completed",
      runId: "run-2",
      resultText: "again",
    })), "INVALID_INPUT");

    const second = await store.claimNextDue();
    assert.equal(second.ok, true);
    if (!second.ok || second.value === null) return;
    assert.equal(second.value.prompt, "second");
    assert.equal(code(await store.cancel(second.value.id)), "TASK_NOT_CANCELLABLE");

    const interrupted = await store.interruptRunning();
    assert.deepEqual(interrupted, { ok: true, value: 1 });
    const recovered = await store.get(second.value.id);
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.equal(recovered.value.status, "interrupted");
      assert.equal(recovered.value.error?.code, "WORKER_INTERRUPTED");
      assert.equal(recovered.value.acknowledgedAt, null);
    }
  });

  it("serializes real concurrent process updates and releases after SIGKILL", async () => {
    const root = await workspace();
    const taskStoreModule = new URL("./task-store.js", import.meta.url).href;
    const lockModule = new URL("./flock.js", import.meta.url).href;
    const runAt = "2026-09-12T00:00:00.000Z";
    const childScript = [
      `import { createTaskStore } from ${JSON.stringify(taskStoreModule)};`,
      "const [root, id] = process.argv.slice(1);",
      "const store = createTaskStore(root, { now: () => Date.parse('2026-09-11T00:00:00.000Z'), generateId: () => id });",
      `const result = await store.create({ prompt: id, runAt: ${JSON.stringify(runAt)} });`,
      "if (!result.ok) { console.error(result.error); process.exit(1); }",
    ].join("\n");
    const children = ["a", "b", "c", "d"].map((id) =>
      spawn(process.execPath, ["--input-type=module", "-e", childScript, root, id], {
        stdio: ["ignore", "ignore", "pipe"],
      }),
    );
    const exits = await Promise.all(children.map(async (child) => {
      const [result] = await once(child, "close");
      return result as number;
    }));
    assert.deepEqual(exits, [0, 0, 0, 0]);
    const tasks = await createTaskStore(root).list({ limit: 50 });
    assert.equal(tasks.ok, true);
    if (tasks.ok) assert.deepEqual(tasks.value.tasks.map((task) => task.promptPreview).sort(), ["a", "b", "c", "d"]);

    const lockPath = join(root, ".runloom", "tasks.json.lock");
    const holderScript = [
      `import { acquireFlock } from ${JSON.stringify(lockModule)};`,
      "const handle = await acquireFlock(process.argv[1]);",
      "process.stdout.write('held\\n');",
      "await new Promise(() => {});",
      "await handle.release();",
    ].join("\n");
    const holder = spawn(process.execPath, ["--input-type=module", "-e", holderScript, lockPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await once(holder.stdout, "data");
    holder.kill("SIGKILL");
    await once(holder, "close");
    const acquired = await acquireFlock(lockPath);
    await acquired.release();
  });

  it("interrupts a blocked advisory-lock wait with AbortSignal", async () => {
    const root = await workspace();
    const lockPath = join(root, ".runloom", "tasks.json.lock");
    const holder = await acquireFlock(lockPath);
    const controller = new AbortController();
    const blocked = acquireFlock(lockPath, controller.signal);
    setTimeout(() => controller.abort("lock_wait_cancelled"), 20);
    await assert.rejects(blocked, (error: unknown) => error === "lock_wait_cancelled");
    await holder.release();
  });
});
