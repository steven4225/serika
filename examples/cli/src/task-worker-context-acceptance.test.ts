import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { createCheckpointStore } from "./checkpoint-store.js";
import { createMemoryStore } from "./memory-store.js";
import { createTaskStore } from "./task-store.js";

// Live opt-in only. The ordinary suite never contacts a model provider.
const model = process.env.RUNLOOM_ACCEPTANCE_MODEL;

it("live scheduled workspace brief: Memory + checkpoint → worker → inbox → ack", {
  skip: model !== "deepseek" && model !== "minimax-m3",
  timeout: 150_000,
}, async () => {
  const retainedRoot = process.env.RUNLOOM_ACCEPTANCE_WORKSPACE;
  const root = retainedRoot ?? await mkdtemp(join(tmpdir(), "runloom-brief-live-"));
  if (retainedRoot !== undefined) await mkdir(root);
  const store = createTaskStore(root);
  const workerEntry = fileURLToPath(new URL("./task-worker-entry.js", import.meta.url));
  let worker: ChildProcess | undefined;
  let workerError = "";

  async function stopWorker(): Promise<void> {
    if (worker === undefined || worker.exitCode !== null || worker.signalCode !== null) return;
    const closed = once(worker, "close", { signal: AbortSignal.timeout(5_000) });
    worker.kill("SIGTERM");
    try {
      await closed;
    } catch {
      worker.kill("SIGKILL");
      await once(worker, "close", { signal: AbortSignal.timeout(5_000) });
    }
  }

  try {
    const memory = await createMemoryStore(root).add({
      text: "本项目当前优先事项是完成 Runloom 的任务级验收。",
      scope: { kind: "workspace" },
    });
    assert.ok(memory.ok, JSON.stringify(memory));
    const checkpoint = await createCheckpointStore(root).saveNextVersion({
      expectedVersion: null,
      sourceThreadId: "acceptance-setup",
      draft: {
        status: "active",
        goal: "完成 Runloom 阶段一任务级验收",
        currentPhase: "worker 实际交付核对",
        summary: "这是保存时的工作意图，尚未核对当前磁盘状态。",
        completed: [],
        inProgress: [],
        nextActions: ["核对简报中的 Memory ID 和 checkpoint 版本"],
        blockers: [],
        artifacts: [],
      },
    });
    assert.ok(checkpoint.ok, JSON.stringify(checkpoint));

    // Give the production worker at least 20 seconds to start before the next UTC minute.
    const due = new Date(Math.ceil((Date.now() + 20_000) / 60_000) * 60_000);
    const series = await store.createRecurring({
      prompt: "请依据这次工作区快照写一份简短工作简报：依据、今天最重要的一件事、15 分钟下一步。引用实际 Memory ID 与 checkpoint 保存版本；不能声称已检查当前磁盘。",
      recurrence: { kind: "daily", time: due.toISOString().slice(11, 16), utcOffset: "+00:00" },
    });
    assert.ok(series.ok, JSON.stringify(series));
    assert.equal(series.value.nextRunAt, due.toISOString());

    worker = spawn(process.execPath, [workerEntry, "--workspace", root, "--workspace-context"], {
      env: { ...process.env, RUNLOOM_MODEL: model },
      stdio: ["ignore", "ignore", "pipe"],
    });
    worker.on("error", (error) => { workerError += error.message; });
    worker.stderr?.setEncoding("utf8");
    worker.stderr?.on("data", (chunk) => { workerError += chunk; });

    const deadline = due.getTime() + 45_000;
    let occurrenceId: string | null = null;
    while (Date.now() < deadline) {
      assert.equal(worker.exitCode, null, workerError);
      assert.equal(worker.signalCode, null, workerError);
      const detail = await store.getRecurring(series.value.id);
      assert.ok(detail.ok, JSON.stringify(detail));
      const task = detail.value.latestTask;
      if (task !== null && (task.status === "completed" || task.status === "failed" || task.status === "interrupted")) {
        assert.equal(task.status, "completed", JSON.stringify(task));
        const resultText = task.resultText;
        assert.ok(resultText, "No result text");
        assert.ok(resultText.includes(memory.entry.id), resultText);
        assert.match(resultText, /(?:v1|version 1|版本\s*1)/i);
        assert.match(resultText, /15\s*分钟/);
        assert.ok(task.threadId && task.runId);
        occurrenceId = task.id;
        const transcript = await new JsonlAgentStore({ directory: join(root, ".runloom/task-transcripts") })
          .getMessages(task.threadId);
        assert.ok(transcript.some((message) => message.role === "assistant"));
        break;
      }
      await setTimeout(250);
    }
    assert.ok(occurrenceId, `No terminal brief by ${new Date(deadline).toISOString()}: ${workerError}`);
    const inbox = await store.list({ inbox: true });
    assert.ok(inbox.ok && inbox.value.tasks.some((task) => task.id === occurrenceId));
    const acknowledged = await store.acknowledge(occurrenceId);
    assert.ok(acknowledged.ok && acknowledged.value.acknowledgedAt);
    await stopWorker();
    const reopened = createTaskStore(root);
    const afterRestart = await reopened.get(occurrenceId);
    assert.ok(afterRestart.ok && afterRestart.value.acknowledgedAt);
    const inboxAfterRestart = await reopened.list({ inbox: true });
    assert.ok(inboxAfterRestart.ok && !inboxAfterRestart.value.tasks.some((task) => task.id === occurrenceId));
    process.stdout.write(`Brief series ${series.value.id}; occurrence ${occurrenceId}; workspace ${root}\n`);
  } finally {
    await stopWorker();
    if (retainedRoot === undefined) await rm(root, { recursive: true, force: true });
  }
});
