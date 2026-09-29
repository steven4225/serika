import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import {
  EXECUTION_RECORD_FILE,
  ExecutionRecordError,
  createExecutionRecordStore,
} from "./execution-record-store.js";

const directories: string[] = [];
const now = () => new Date("2026-09-29T01:00:00.000Z");
type ToolEvent = Extract<AgentEvent, { type: "tool.call.requested" | "tool.call.started" | "tool.call.completed" | "tool.call.failed" }>;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "runloom-execution-record-"));
  directories.push(path);
  return path;
}

function toolEvent(
  type: "tool.call.requested" | "tool.call.started" | "tool.call.completed" | "tool.call.failed",
  data: Record<string, unknown>,
  runId = "run-1",
): ToolEvent {
  return {
    id: `${type}-event`, type, runId, threadId: "thread-1", sequence: 1,
    occurredAt: "2026-09-29T01:00:00.000Z", data,
  } as ToolEvent;
}

function result(status: RunResult["status"] = "completed"): RunResult {
  return { runId: "run-1", threadId: "thread-1", status, text: "done", steps: 1, usage: {} };
}

async function errorCode(operation: () => Promise<unknown>): Promise<string | undefined> {
  try { await operation(); return undefined; }
  catch (error) {
    assert.ok(error instanceof ExecutionRecordError);
    return error.code;
  }
}

describe("ExecutionRecordStore", () => {
  it("persists bounded Run and shell tool receipts outside transcript JSONL", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    assert.deepEqual(await store.listRuns("thread-1"), []);
    await assert.rejects(readFile(join(path, EXECUTION_RECORD_FILE)), { code: "ENOENT" });
  });

  it("records request/start/completion and actual shell outcome across reopen", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
      toolCallId: "tool-1", toolName: "shell_exec", input: { command: "sleep 1" },
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.started", {
      toolCallId: "tool-1", toolName: "shell_exec",
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.completed", {
      toolCallId: "tool-1", toolName: "shell_exec",
      output: { ok: true, exitCode: 7, timedOut: false, cancelled: false, output: "bad" },
    }));
    await store.finishRun("run-1", result());
    const reopened = createExecutionRecordStore(path);
    const run = await reopened.getRun("thread-1", "run-1");
    assert.equal(run?.status, "completed");
    assert.equal(run?.resultTextPreview, "done");
    assert.deepEqual(run?.tools[0]?.shell, { exitCode: 7, timedOut: false, cancelled: false });
    assert.equal(run?.tools[0]?.status, "completed");
    assert.match(run?.tools[0]?.inputPreview ?? "", /sleep 1/);
    assert.equal((await stat(join(path, EXECUTION_RECORD_FILE))).mode & 0o777, 0o600);
    assert.equal((await reopened.listRuns("thread-1"))[0]?.runId, "run-1");
  });

  it("marks interrupted Run, started tool unknown, requested tool not_started without replay", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
      toolCallId: "started", toolName: "write_file", input: { path: "report.txt" },
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.started", {
      toolCallId: "started", toolName: "write_file",
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
      toolCallId: "waiting", toolName: "shell_exec", input: { command: "echo hi" },
    }));
    const reopened = createExecutionRecordStore(path, { now });
    assert.equal(await reopened.recoverInterrupted("thread-1"), 1);
    assert.equal(await reopened.recoverInterrupted("thread-1"), 0);
    const run = await reopened.getRun("thread-1", "run-1");
    assert.equal(run?.status, "interrupted");
    assert.equal(run?.tools[0]?.status, "unknown");
    assert.equal(run?.tools[1]?.status, "not_started");
    assert.match(run?.tools[0]?.inputPreview ?? "", /report.txt/);
    assert.equal(await errorCode(() => reopened.recordToolEvent("run-1", toolEvent("tool.call.completed", {
      toolCallId: "started", toolName: "write_file", output: { ok: true },
    }))), "CONFLICT");
  });

  it("preserves completed tool receipt when Run ends abnormally", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
      toolCallId: "tool-1", toolName: "write_file", input: { path: "a" },
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.started", {
      toolCallId: "tool-1", toolName: "write_file",
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.completed", {
      toolCallId: "tool-1", toolName: "write_file", output: { ok: true },
    }));
    await store.finishRun("run-1", result("failed"));
    assert.equal((await store.getRun("thread-1", "run-1"))?.tools[0]?.status, "completed");
  });

  it("fails closed on corrupt JSON and symlink without overwriting either", async () => {
    const path = await directory();
    const target = join(path, "target.json");
    const file = join(path, EXECUTION_RECORD_FILE);
    await writeFile(file, "{broken");
    const store = createExecutionRecordStore(path, { now });
    assert.equal(await errorCode(() => store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" })), "FILE_INVALID");
    assert.equal(await readFile(file, "utf8"), "{broken");
    await rm(file);
    await writeFile(target, "private");
    await symlink(target, file);
    assert.equal(await errorCode(() => store.listRuns("thread-1")), "SYMLINK_NOT_ALLOWED");
    assert.equal(await readFile(target, "utf8"), "private");
  });

  it("rejects duplicate Run and mismatched tool event identity", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    assert.equal(await errorCode(() => store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" })), "CONFLICT");
    assert.equal(await errorCode(() => store.recordToolEvent("run-1", toolEvent("tool.call.started", {
      toolCallId: "missing", toolName: "shell_exec",
    }))), "CONFLICT");
    assert.equal(await errorCode(() => store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
      toolCallId: "tool-1", toolName: "shell_exec", input: {},
    }, "run-2"))), "INVALID_INPUT");
  });

  it("recovers and lists only the selected Thread in a shared transcript directory", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    await store.startRun({ runId: "run-2", threadId: "thread-2", phase: "primary" });
    assert.equal(await store.recoverInterrupted("thread-1"), 1);
    assert.equal((await store.getRun("thread-1", "run-1"))?.status, "interrupted");
    assert.equal((await store.getRun("thread-2", "run-2"))?.status, "running");
    assert.equal(await store.getRun("thread-1", "run-2"), null);
    assert.deepEqual((await store.listRuns("thread-1")).map((run) => run.runId), ["run-1"]);
  });

  it("allows only one live controller to recover a Thread", async () => {
    const path = await directory();
    const first = createExecutionRecordStore(path);
    const second = createExecutionRecordStore(path);
    const lease = await first.claimThread("thread-1");
    try {
      assert.equal(await errorCode(() => second.claimThread("thread-1")), "CONFLICT");
      const otherThread = await second.claimThread("thread-2");
      await otherThread.release();
    } finally {
      await lease.release();
    }
    const reopened = await second.claimThread("thread-1");
    await reopened.release();
  });
});
