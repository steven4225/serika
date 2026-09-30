import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InMemoryAgentStore, type AgentEvent, type RunRecord } from "@aisdk-agent/core";
import { createExecutionRecordAdapter } from "./execution-record-adapter.js";
import { createExecutionRecordStore, EXECUTION_RECORD_FILE } from "./execution-record-store.js";
import { createWorkTaskStore } from "./work-task-store.js";

const at = "2026-09-29T01:00:00.000Z";
const run: RunRecord = {
  id: "run-1", threadId: "thread-1", agentId: "calculator", agentVersion: "1",
  status: "created", version: 0, createdAt: at, updatedAt: at,
};

function event(type: "tool.call.requested" | "tool.call.started" | "tool.call.completed", data: Record<string, unknown>, sequence: number): AgentEvent {
  return { id: type, type, runId: "run-1", threadId: "thread-1", occurredAt: at,
    sequence, data } as AgentEvent;
}

describe("execution record adapter", () => {
  it("binds a WorkTask at the Run create barrier and consumes it once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-audit-task-bind-"));
    try {
      const records = createExecutionRecordStore(directory);
      const workTasks = createWorkTaskStore(directory, { generateId: () => "task-1" });
      const task = await workTasks.create({
        threadId: "thread-1", goal: "Do the work", acceptance: [{
          id: "human", description: "User accepts", method: "human",
          verification: { kind: "human" }, required: true,
        }],
      });
      assert.equal(task.ok, true);
      const adapter = createExecutionRecordAdapter(new InMemoryAgentStore(), records, workTasks);
      adapter.enable();
      adapter.bindNextWorkTask({ id: "task-1", expectedRevision: 1 });
      await adapter.store.create(run);
      assert.equal((await records.getRun("thread-1", "run-1"))?.workTaskId, "task-1");
      const runningTask = await workTasks.get("task-1");
      assert.equal(runningTask.ok && runningTask.value.runIds[0], "run-1");
      const failed = {
        runId: "run-1", threadId: "thread-1", status: "failed" as const,
        text: "", steps: 0, usage: {},
      };
      await adapter.store.transition("run-1", 0, "failed", failed);
      await records.finishRun("run-1", failed);
      await adapter.store.create({ ...run, id: "run-2" });
      assert.equal((await records.getRun("thread-1", "run-2"))?.workTaskId, undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not create a Run or receipt when WorkTask begin fails at the create barrier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-audit-task-bind-failure-"));
    try {
      const records = createExecutionRecordStore(directory);
      const base = new InMemoryAgentStore();
      const workTasks = createWorkTaskStore(directory, { generateId: () => "task-failure" });
      const task = await workTasks.create({
        threadId: "thread-1", goal: "Do the work", acceptance: [{
          id: "human", description: "User accepts", method: "human",
          verification: { kind: "human" }, required: true,
        }],
      });
      assert.equal(task.ok, true);
      const adapter = createExecutionRecordAdapter(base, records, workTasks);
      adapter.enable();
      adapter.bindNextWorkTask({ id: "task-failure", expectedRevision: 99 });
      await assert.rejects(adapter.store.create(run), /WORK_TASK_REVISION_CONFLICT/);
      assert.equal(await base.getRun("run-1"), undefined);
      assert.equal(await records.getRun("thread-1", "run-1"), null);
      const unchanged = await workTasks.get("task-failure");
      assert.equal(unchanged.ok && unchanged.value.status, "ready");
      assert.deepEqual(unchanged.ok && unchanged.value.runIds, []);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists a completed file-tool receipt even when no conversation is committed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-audit-adapter-"));
    try {
      const records = createExecutionRecordStore(directory);
      const adapter = createExecutionRecordAdapter(new InMemoryAgentStore(), records);
      adapter.enable();
      await adapter.store.create(run);
      await adapter.store.append(event("tool.call.requested", {
        toolCallId: "write-1", toolName: "write_file", input: { path: "report.txt" },
      }, 1));
      await adapter.store.append(event("tool.call.started", { toolCallId: "write-1", toolName: "write_file" }, 2));
      const file = join(directory, "report.txt");
      await writeFile(file, "changed");
      await adapter.store.append(event("tool.call.completed", {
        toolCallId: "write-1", toolName: "write_file", output: { ok: true },
      }, 3));
      await records.finishRun("run-1", {
        runId: "run-1", threadId: "thread-1", status: "failed", text: "", steps: 1, usage: {},
      });
      assert.equal(await readFile(file, "utf8"), "changed");
      assert.deepEqual(await adapter.store.getMessages("thread-1"), []);
      assert.equal((await records.getRun("thread-1", "run-1"))?.tools[0]?.status, "completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not enter tool execution when its started receipt cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-audit-barrier-"));
    try {
      const records = createExecutionRecordStore(directory);
      const adapter = createExecutionRecordAdapter(new InMemoryAgentStore(), records);
      adapter.enable();
      await adapter.store.create(run);
      await adapter.store.append(event("tool.call.requested", {
        toolCallId: "write-1", toolName: "write_file", input: { path: "report.txt" },
      }, 1));
      await writeFile(join(directory, EXECUTION_RECORD_FILE), "{broken");
      let toolEntered = false;
      await assert.rejects(async () => {
        await adapter.store.append(event("tool.call.started", { toolCallId: "write-1", toolName: "write_file" }, 2));
        toolEntered = true;
      });
      assert.equal(toolEntered, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
