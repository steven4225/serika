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
import { taskWorkerLockPath } from "./task-store.js";

describe("task-worker CLI arguments", () => {
  it("requires the explicit workspace and accepts pnpm's separator", () => {
    assert.deepEqual(parseTaskWorkerArgs(["--", "--workspace", "./sample"]), {
      workspace: "./sample",
    });
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
