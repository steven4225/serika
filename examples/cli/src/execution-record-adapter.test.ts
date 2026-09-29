import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { InMemoryAgentStore, type AgentEvent, type RunRecord } from "@aisdk-agent/core";
import { createExecutionRecordAdapter } from "./execution-record-adapter.js";
import { createExecutionRecordStore, EXECUTION_RECORD_FILE } from "./execution-record-store.js";

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
