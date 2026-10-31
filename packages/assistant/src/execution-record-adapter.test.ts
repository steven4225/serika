import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { describe, it } from "node:test";
import { InMemoryAgentStore, type AgentEvent, type RunRecord } from "@serika/core";
import { createExecutionRecordAdapter } from "./execution-record-adapter.js";
import { createExecutionRecordStore, EXECUTION_RECORD_FILE } from "./execution-record-store.js";
import { createWorkTaskStore, workTaskPhase } from "./work-task-store.js"
import { createTaskStore } from "./task-store.js";

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
  it("does not swallow corrupt authoritative receipts at an optional trace barrier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-receipt-corrupt-stop-"));
    try {
      const records = createExecutionRecordStore(directory);
      const adapter = createExecutionRecordAdapter(new InMemoryAgentStore(), records);
      adapter.enable();
      await adapter.store.create(run);
      await writeFile(join(directory, EXECUTION_RECORD_FILE), "{broken");
      const trace: AgentEvent = { id: "step", type: "step.started", runId: run.id, threadId: run.threadId, sequence: 1, occurredAt: at, data: { stepNumber: 1 } };
      await assert.rejects(adapter.store.append(trace), /invalid JSON/);
      await assert.rejects(records.recordApprovalRequested(run.threadId, "call", "read_file"), /invalid JSON/);
      assert.deepEqual(await adapter.store.list(run.id), [], "failed persistence does not publish the next execution step");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("a failed optional trace file sync blocks later tool dispatch even after the filesystem recovers", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-receipt-sync-stop-"));
    try {
      const records = createExecutionRecordStore(directory);
      const adapter = createExecutionRecordAdapter(new InMemoryAgentStore(), records);
      adapter.enable();
      await adapter.store.create(run);
      await adapter.store.append(event("tool.call.requested", { toolCallId: "write-1", toolName: "write_file", input: { path: "report.txt" } }, 1));
      const probe = await open(join(directory, EXECUTION_RECORD_FILE), "r");
      const prototype = Object.getPrototypeOf(probe);
      await probe.close();
      const injected = t.mock.method(prototype, "sync", async () => { throw new Error("disk sync failed"); });
      const trace: AgentEvent = { id: "step", type: "step.started", runId: run.id, threadId: run.threadId, sequence: 2, occurredAt: at, data: { stepNumber: 1 } };
      await assert.rejects(adapter.store.append(trace), /WRITE_FAILED|save failed/);
      injected.mock.restore();
      let dispatched = false;
      await assert.rejects(async () => {
        await adapter.store.append(event("tool.call.started", { toolCallId: "write-1", toolName: "write_file" }, 3));
        dispatched = true;
      }, /restart|reconcile/);
      assert.equal(dispatched, false);
      assert.equal((await records.getRun(run.threadId, run.id))?.tools[0]?.status, "requested");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("persists host source association before Core creation and fails closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-source-barrier-"));
    try {
      const base = new InMemoryAgentStore();
      const records = createExecutionRecordStore(directory);
      const seen: string[] = [];
      const adapter = createExecutionRecordAdapter(base, records, undefined, id => id === "consolidator" ? "consolidation" : "primary", async record => {
        assert.equal(await base.getRun(record.id), undefined);
        assert.equal((await records.getRun(record.threadId, record.id))?.status, "running");
        seen.push(record.id);
        if (record.id === "blocked") throw new Error("source association unavailable");
      });
      adapter.enable();
      await adapter.store.create(run);
      await adapter.store.create({ ...run, id: "maintenance", threadId: "thread-2", agentId: "consolidator" });
      await assert.rejects(adapter.store.create({ ...run, id: "blocked" }), /source association unavailable/);
      assert.deepEqual(seen, ["run-1", "blocked"]);
      assert.equal(await base.getRun("blocked"), undefined);
      assert.equal((await records.getRun(run.threadId, "blocked"))?.status, "failed");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("binds a WorkTask at the Run create barrier and consumes it once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-audit-task-bind-"));
    try {
      const records = createExecutionRecordStore(directory);
      const workTasks = createWorkTaskStore(createTaskStore(join(dirname(join(directory, ".runloom/work-tasks.json")), "tasks.json")), { workspace: directory,  generateId: () => "task-1"  });
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
      const workTasks = createWorkTaskStore(createTaskStore(join(dirname(join(directory, ".runloom/work-tasks.json")), "tasks.json")), { workspace: directory,  generateId: () => "task-failure"  });
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
      assert.equal(unchanged.ok && workTaskPhase(unchanged.value), "ready");
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
