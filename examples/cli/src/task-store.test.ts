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
    await writeFile(join(runloom, "tasks.json"), JSON.stringify({ version: 2, tasks: [] }));
    assert.equal(code(await store.list()), "TASK_VERSION_UNSUPPORTED");
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
