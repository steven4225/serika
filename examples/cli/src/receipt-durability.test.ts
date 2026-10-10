import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { InMemoryAgentStore, type AgentEvent } from "@aisdk-agent/core";
import { AiSdkAgentLoop, InMemoryModelRegistry, ToolRegistry } from "@aisdk-agent/ai-sdk-adapter";
import { createExecutionRecordAdapter } from "./execution-record-adapter.js";
import { createExecutionRecordStore, EXECUTION_RECORD_FILE } from "./execution-record-store.js";
import { toolCommitResult } from "./commit-outcome.js";
import { createTaskStore, TASK_FILE_NAME } from "./task-store.js";
import { createWorkTaskStore } from "./work-task-store.js";
import { createCheckpointStore, CHECKPOINT_FILE_NAME } from "./checkpoint-store.js";

for (const kind of ["task", "work-task", "checkpoint"] as const) {
  for (const boundary of ["file", "directory"] as const) {
    it(`${kind} ${boundary} sync failure preserves the replacement boundary and freezes uncertain writes`, async t => {
      if (process.platform === "win32") return t.skip("These stores require POSIX flock");
      const directory = await mkdtemp(join(tmpdir(), "runloom-store-sync-"));
      try {
        const task = createTaskStore(directory);
        const workTask = createWorkTaskStore(directory);
        const checkpoint = createCheckpointStore(directory);
        const save = (version: number) => {
          if (kind === "task") return task.create({ prompt: `version ${version}`, runAt: "2099-01-01T00:00:00Z" });
          if (kind === "work-task") return workTask.create({ threadId: "thread", goal: `version ${version}`, constraints: [], acceptance: [
            { id: "human", description: "Accepted", method: "human", required: true, verification: { kind: "human" } },
          ] });
          return checkpoint.saveNextVersion({ expectedVersion: version === 1 ? null : version - 1, sourceThreadId: "thread", draft: {
            status: "active", goal: "save", currentPhase: "test", summary: `version ${version}`, completed: [], inProgress: [], nextActions: [], blockers: [], artifacts: [],
          } });
        };
        const path = join(directory, kind === "task" ? TASK_FILE_NAME : kind === "work-task" ? ".runloom/work-tasks.json" : CHECKPOINT_FILE_NAME);
        assert((await save(1)).ok);
        const original = await readFile(path);
        const probe = await open(join(directory, "probe"), "w");
        const prototype = Object.getPrototypeOf(probe); const originalSync = prototype.sync; await probe.close();
        const fault = t.mock.method(prototype, "sync", async function(this: FileHandle) {
          const stat = await this.stat();
          if (boundary === "file" ? stat.isFile() : stat.isDirectory()) throw new Error("injected sync failure");
          return originalSync.call(this);
        });
        const failed = await save(2);
        fault.mock.restore();
        assert(!failed.ok);
        const prefix = kind === "work-task" ? "WORK_TASK_" : kind === "checkpoint" ? "CHECKPOINT_" : "";
        assert.equal(failed.error.code, `${prefix}${boundary === "directory" ? "COMMIT_UNCERTAIN" : "WRITE_FAILED"}`);
        const saved = await readFile(path);
        if (boundary === "file") assert.deepEqual(saved, original);
        else {
          assert.notDeepEqual(saved, original);
          const blocked = await save(3);
          assert(!blocked.ok);
          assert.equal(blocked.error.code, `${prefix}COMMIT_UNCERTAIN`);
          assert.deepEqual(await readFile(path), saved);
        }
        const read = kind === "task" ? await createTaskStore(directory).list({}) : kind === "work-task" ? await createWorkTaskStore(directory).list({}) : await createCheckpointStore(directory).getCurrent();
        assert(read.ok, "a new instance can reread the actual committed state without replay");
        assert.deepEqual(await readFile(path), saved);
      } finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
    });
  }
}

for (const boundary of ["file", "directory"] as const) {
  it(`${boundary} sync failure at the start barrier never dispatches a tool; uncertain replacement remains unknown after reopen`, async t => {
    if (boundary === "directory" && process.platform === "win32") return t.skip("Windows has no POSIX directory sync guarantee");
    const directory = await mkdtemp(join(tmpdir(), "runloom-receipt-sync-"));
    try {
      const records = createExecutionRecordStore(directory);
      const adapter = createExecutionRecordAdapter(new InMemoryAgentStore(), records); adapter.enable();
      await adapter.store.create({ id: "run", threadId: "thread", agentId: "primary", agentVersion: "1", status: "created", version: 0,
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
      const probe = await open(join(directory, "probe"), "w");
      const prototype = Object.getPrototypeOf(probe); const originalSync = prototype.sync; await probe.close();
      let armed = false, calls = 0, executions = 0;
      const fault = t.mock.method(prototype, "sync", async function(this: FileHandle) {
        const stat = await this.stat();
        if (armed && (boundary === "file" ? stat.isFile() : stat.isDirectory())) throw new Error("injected sync failure");
        return originalSync.call(this);
      });
      const model = new MockLanguageModelV3({ doStream: async () => {
        calls++;
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: "call", toolName: "write", input: "{}" },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
        ] }) };
      } });
      const loop = new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }), tools: new ToolRegistry([{ metadata: {
        name: "write", version: "1", risk: "write", timeoutMs: 500, idempotent: false,
      }, tool: tool({ inputSchema: z.object({}), execute: () => { executions++; return { ok: true }; } }) }]) });
      let sequence = 0;
      await assert.rejects(loop.execute({ definition: { id: "primary", version: "1", instructions: "write", model: "test", tools: ["write"],
        // Real lock helpers and fsync are exercised here. A loaded test runner
        // must reach the injected boundary, not win an unrelated timeout race.
        limits: { maxSteps: 2, totalTimeoutMs: 30_000, stepTimeoutMs: 10_000 } },
        messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "write" }] }], signal: new AbortController().signal,
        generateId: () => `id-${++sequence}`, beforeToolExecute: async () => ({ allow: true }),
        emit: async (type, data) => {
          if (type === "tool.call.started") armed = true;
          await adapter.store.append({ id: `${++sequence}`, type, data, runId: "run", threadId: "thread", sequence, occurredAt: new Date(0).toISOString() } as AgentEvent);
        },
      }));
      fault.mock.restore();
      assert.equal(executions, 0); assert.equal(calls, 1);
      const snapshot = await readFile(join(directory, EXECUTION_RECORD_FILE));
      if (boundary === "directory") {
        await assert.rejects(records.failStart("run", new Error("must not overwrite uncertainty")), /uncertain/);
        assert.deepEqual(await readFile(join(directory, EXECUTION_RECORD_FILE)), snapshot);
      }
      const reopened = createExecutionRecordStore(directory); await reopened.recoverInterrupted("thread");
      const receipt = await reopened.getRun("thread", "run");
      assert.equal(receipt?.status, "interrupted");
      assert.equal(receipt?.tools[0]?.status, boundary === "directory" ? "unknown" : "not_started");
    } finally { t.mock.restoreAll(); await rm(directory, { recursive: true, force: true }); }
  });
}

it("uncertain task/checkpoint store replies are unknown effects at the tool boundary, ordinary failures remain ordinary", async () => {
  for (const code of ["COMMIT_UNCERTAIN", "CHECKPOINT_COMMIT_UNCERTAIN"]) {
    await assert.rejects(toolCommitResult(Promise.resolve({ ok: false, error: { code } })), e => e instanceof Error && "data" in e && (e.data as { code: string }).code === "TOOL_OUTCOME_UNKNOWN");
  }
  assert.deepEqual(await toolCommitResult(Promise.resolve({ ok: false, error: { code: "WRITE_FAILED" } })), { ok: false, error: { code: "WRITE_FAILED" } });
});
