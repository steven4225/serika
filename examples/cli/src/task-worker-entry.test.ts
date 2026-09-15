import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseTaskWorkerArgs } from "./task-worker-entry.js";
import { tryAcquireFlock } from "./flock.js";
import { createTaskStore, taskWorkerLockPath } from "./task-store.js";

describe("task-worker CLI arguments", () => {
  it("requires the explicit workspace and accepts pnpm's separator", () => {
    assert.deepEqual(parseTaskWorkerArgs(["--", "--workspace", "./sample"]), {
      workspace: "./sample",
    });
    assert.deepEqual(
      parseTaskWorkerArgs(["--workspace", "./sample", "--todoist", "--notify"]),
      { workspace: "./sample", todoist: true, notify: true },
    );
  });

  it("rejects an implicit workspace and unknown options", () => {
    assert.throws(
      () => parseTaskWorkerArgs([]),
      /task-worker requires --workspace/,
    );
    assert.throws(
      () => parseTaskWorkerArgs(["--workspace", "./sample", "extra"]),
      /Unknown task-worker option: extra/,
    );
    assert.throws(
      () => parseTaskWorkerArgs(["--workspace", "./sample", "--todoist", "--todoist"]),
      /at most one --todoist option/,
    );
    assert.throws(
      () => parseTaskWorkerArgs(["--workspace", "./sample", "--notify", "--notify"]),
      /at most one --notify option/,
    );
  });
});

describe("task-worker startup validation", () => {
  async function assertInvalidEnvironmentLeavesTaskScheduled(
    environment: NodeJS.ProcessEnv,
    expectedError: RegExp,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "runloom-worker-todoist-startup-"));
    try {
      const store = createTaskStore(root);
      const created = await store.create({
        runAt: new Date(Date.now() + 100).toISOString(),
        prompt: "Create today's plan from Todoist.",
      });
      assert.ok(created.ok);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const entry = fileURLToPath(new URL("./task-worker-entry.js", import.meta.url));
      const child = spawn(process.execPath, [entry, "--workspace", root, "--todoist"], {
        env: { ...process.env, RUNLOOM_MODEL: "mock", ...environment },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => { stderr += chunk; });
      const [exitCode] = await once(child, "close");
      assert.equal(exitCode, 1);
      assert.match(stderr, expectedError);
      const unchanged = await store.get(created.value.id);
      assert.ok(unchanged.ok);
      assert.equal(unchanged.value.status, "scheduled");
      assert.equal(unchanged.value.startedAt, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("fails before claiming due tasks when the DeepSeek key is missing", async () => {
    await assertInvalidEnvironmentLeavesTaskScheduled(
      { RUNLOOM_MODEL: "deepseek", DEEPSEEK_API_KEY: "" },
      /DEEPSEEK_API_KEY is required/,
    );
  });

  it("fails before claiming due tasks when the token is missing", async () => {
    await assertInvalidEnvironmentLeavesTaskScheduled(
      { TODOIST_API_TOKEN: "" },
      /TODOIST_API_TOKEN is required/,
    );
  });

  it("fails before claiming due tasks when the planning time zone is invalid", async () => {
    await assertInvalidEnvironmentLeavesTaskScheduled(
      { TODOIST_API_TOKEN: "test-token", RUNLOOM_TODOIST_TIMEZONE: "Not\/A-Time-Zone" },
      /Invalid RUNLOOM_TODOIST_TIMEZONE/,
    );
  });
});

async function terminate(
  child: ChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await once(child, "close");
}

describe("task-worker process lock", () => {
  it("rejects a second worker and releases after SIGKILL", { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-worker-lock-"));
    const entry = fileURLToPath(new URL("./task-worker-entry.js", import.meta.url));
    const env = { ...process.env, RUNLOOM_MODEL: "mock" };
    const children: ChildProcess[] = [];

    try {
      const first = spawn(process.execPath, [entry, "--workspace", root], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(first);
      first.stderr?.resume();

      const lockPath = taskWorkerLockPath(root);
      let lockCreated = false;
      for (let attempt = 0; attempt < 100 && !lockCreated; attempt += 1) {
        try {
          await stat(lockPath);
          lockCreated = true;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.equal(lockCreated, true, "first worker did not create its lock file");

      let held = false;
      for (let attempt = 0; attempt < 80 && !held; attempt += 1) {
        // The first worker creates the sidecar just before spawning its lock
        // helper. Give that helper time to acquire before probing, so the
        // test does not repeatedly acquire and release the still-free inode.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const candidate = await tryAcquireFlock(lockPath);
        if (candidate === null) {
          held = true;
          break;
        }
        await candidate.release();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(held, true, "first worker did not acquire its lock");

      const second = spawn(process.execPath, [entry, "--workspace", root], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(second);
      let secondError = "";
      second.stderr?.setEncoding("utf8");
      second.stderr?.on("data", (chunk) => {
        secondError += chunk;
      });
      const [secondCode] = await once(second, "close");
      assert.equal(secondCode, 1);
      assert.match(secondError, /WORKER_ALREADY_RUNNING/);

      await terminate(first, "SIGKILL");

      const third = spawn(process.execPath, [entry, "--workspace", root], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      children.push(third);
      third.stderr?.resume();
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(third.exitCode, null, "worker lock remained held after SIGKILL");
      await terminate(third, "SIGTERM");
    } finally {
      for (const child of children) {
        await terminate(child, "SIGTERM").catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
