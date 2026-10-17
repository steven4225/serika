import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { AgentEvent, RunResult } from "@serika/core";
import {
  EXECUTION_RECORD_FILE,
  EXECUTION_RECORD_MAX_TOOLS,
  ExecutionRecordError,
  createExecutionRecordStore,
  readFileWriteReceipt,
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
  it("keeps receipts beyond the old 64-call limit and rejects dispatch at the new bounded capacity", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    for (let index = 0; index < 129; index++) {
      await store.recordToolEvent("run-1", toolEvent("tool.call.requested", { toolCallId: `call-${index}`, toolName: "read_file", input: { path: "file.txt" } }));
    }
    const file = join(path, EXECUTION_RECORD_FILE);
    const document = JSON.parse(await readFile(file, "utf8"));
    assert.equal(document.runs[0].tools.length, 129);
    const template = { ...document.runs[0].tools[0], inputPreview: "x".repeat(2048), inputTruncated: true };
    document.runs[0].tools = Array.from({ length: EXECUTION_RECORD_MAX_TOOLS }, (_, index) => ({ ...template, toolCallId: `call-${index}` }));
    await writeFile(file, JSON.stringify(document));
    assert.ok((await stat(file)).size > 256 * 1024, "long Runs also exceed the former document size limit");
    const reopened = createExecutionRecordStore(path, { now });
    assert.equal((await reopened.getRun("thread-1", "run-1"))?.tools.length, EXECUTION_RECORD_MAX_TOOLS);
    assert.equal(await errorCode(() => reopened.recordToolEvent("run-1", toolEvent("tool.call.requested", { toolCallId: "overflow", toolName: "shell_exec", input: { command: "never" } }))), "LIMIT_EXCEEDED");
    assert.equal((await reopened.getRun("thread-1", "run-1"))?.tools.some(tool => tool.toolCallId === "overflow"), false);
  });
  for (const boundary of ["file", "directory"] as const) {
    it(`stops receipt writes at ${boundary} sync failure, preserves the correct unknown boundary on reopen`, async (t) => {
      const path = await directory();
      const store = createExecutionRecordStore(path, { now });
      await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
      await store.recordToolEvent("run-1", toolEvent("tool.call.requested", { toolCallId: "write", toolName: "write_file", input: { path: "report.txt" } }));
      const file = join(path, EXECUTION_RECORD_FILE), before = await readFile(file);
      const probe = await open(file, "r"), prototype = Object.getPrototypeOf(probe), original = prototype.sync;
      await probe.close();
      const order: string[] = [];
      const injected = t.mock.method(prototype, "sync", async function (this: typeof probe) {
        const kind = (await this.stat()).isDirectory() ? "directory" : "file";
        order.push(kind);
        if (kind === boundary) throw new Error("sync fault");
        return original.call(this);
      });
      const expected = boundary === "file" ? "WRITE_FAILED" : "COMMIT_UNCERTAIN";
      assert.equal(await errorCode(() => store.recordToolEvent("run-1", toolEvent("tool.call.started", { toolCallId: "write", toolName: "write_file" }))), expected);
      injected.mock.restore();
      assert.deepEqual(order, boundary === "file" ? ["file"] : ["file", "directory"]);
      if (boundary === "file") assert.deepEqual(await readFile(file), before);
      assert.equal(await errorCode(() => store.startRun({ runId: "no-dispatch", threadId: "thread-2", phase: "primary" })), expected);
      const reopened = createExecutionRecordStore(path, { now });
      await reopened.recoverInterrupted("thread-1");
      const recovered = await reopened.getRun("thread-1", "run-1");
      assert.equal(recovered?.tools[0]?.status, boundary === "file" ? "not_started" : "unknown");
      assert.equal(await reopened.getRun("thread-2", "no-dispatch"), null);
    });
  }

  it("persists bounded full readback evidence across reopen, never hashes a truncated display preview", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    const content = "回读🧩".repeat(800);
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    for (const [id, output] of [["read", { ok: true, path: "report.md", content, bytes: Buffer.byteLength(content) }],
      ["bad-read", { ok: true, path: "report.md", content, bytes: 1 }]] as const) {
      await store.recordToolEvent("run-1", toolEvent("tool.call.requested", { toolCallId: id, toolName: "read_file", input: { path: "report.md" } }));
      await store.recordToolEvent("run-1", toolEvent("tool.call.started", { toolCallId: id, toolName: "read_file" }));
      await store.recordToolEvent("run-1", toolEvent("tool.call.completed", { toolCallId: id, toolName: "read_file", output }));
    }
    await store.finishRun("run-1", result());
    const tools = (await createExecutionRecordStore(path).getRun("thread-1", "run-1"))!.tools;
    assert.equal(tools[0]!.resultTruncated, true);
    assert.deepEqual(tools[0]!.fileRead, { path: "report.md", bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });
    assert.equal(tools[0]!.fileWrite, undefined);
    assert.equal(tools[1]!.fileRead, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(tools[0]!.fileRead)) < 256);
  });
  it("persists compact file evidence independently of truncated display input across reopen", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    const content = "资料🧩".repeat(800);
    const sha256 = createHash("sha256").update(content).digest("hex");
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
      toolCallId: "write", toolName: "write_file", input: { path: "report.md", content },
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.started", { toolCallId: "write", toolName: "write_file" }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.completed", {
      toolCallId: "write", toolName: "write_file", output: { ok: true, path: "report.md", bytes: Buffer.byteLength(content), sha256 },
    }));
    await store.finishRun("run-1", result());
    const receipt = (await createExecutionRecordStore(path).getRun("thread-1", "run-1"))!.tools[0]!;
    assert.equal(receipt.inputTruncated, true);
    assert.deepEqual(receipt.fileInput, { path: "report.md", sha256 });
    assert.deepEqual(readFileWriteReceipt(receipt, "report.md"), { sha256, bytes: Buffer.byteLength(content) });
    assert.equal(readFileWriteReceipt(receipt, "other.md"), undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt.fileWrite)) < 256);
  });

  it("does not create file success evidence for denial, unknown, wrong digest/path or completion without start", async () => {
    for (const scenario of ["denied", "unknown", "wrong-hash", "wrong-path", "no-start"] as const) {
      const path = await directory();
      const store = createExecutionRecordStore(path, { now });
      await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
      const content = "x".repeat(4096);
      await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
        toolCallId: "write", toolName: "write_file", input: { path: "report.md", content },
      }));
      if (!["denied", "no-start"].includes(scenario)) await store.recordToolEvent("run-1", toolEvent("tool.call.started", { toolCallId: "write", toolName: "write_file" }));
      if (scenario === "denied") await store.recordToolEvent("run-1", toolEvent("tool.call.failed", {
        toolCallId: "write", toolName: "write_file", error: { code: "TOOL_DENIED", message: "No", phase: "tool", retryable: false },
      }));
      else if (scenario !== "unknown") await store.recordToolEvent("run-1", toolEvent("tool.call.completed", {
        toolCallId: "write", toolName: "write_file", output: { ok: true, path: scenario === "wrong-path" ? "other.md" : "report.md",
          bytes: 4096, sha256: createHash("sha256").update(scenario === "wrong-hash" ? "different" : content).digest("hex") },
      }));
      await store.finishRun("run-1", result());
      const receipt = (await createExecutionRecordStore(path).getRun("thread-1", "run-1"))!.tools[0]!;
      assert.equal(receipt.fileWrite, undefined, scenario);
      assert.equal(readFileWriteReceipt(receipt, "report.md"), undefined, scenario);
    }
  });

  it("keeps old truncated records unverifiable and rejects corrupt compact metadata", async () => {
    const path = await directory();
    const store = createExecutionRecordStore(path, { now });
    await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
    await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
      toolCallId: "write", toolName: "write_file", input: { path: "report.md", content: "x".repeat(4096) },
    }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.started", { toolCallId: "write", toolName: "write_file" }));
    await store.recordToolEvent("run-1", toolEvent("tool.call.completed", {
      toolCallId: "write", toolName: "write_file", output: { ok: true, path: "report.md", bytes: 4096 },
    }));
    await store.finishRun("run-1", result());
    const file = join(path, EXECUTION_RECORD_FILE);
    const document = JSON.parse(await readFile(file, "utf8"));
    delete document.runs[0].tools[0].fileInput;
    await writeFile(file, JSON.stringify(document));
    const receipt = (await createExecutionRecordStore(path).getRun("thread-1", "run-1"))!.tools[0]!;
    assert.equal(readFileWriteReceipt(receipt, "report.md"), undefined);
    document.runs[0].tools[0].fileInput = { path: "report.md", sha256: "not-a-digest" };
    await writeFile(file, JSON.stringify(document));
    assert.equal(await errorCode(() => createExecutionRecordStore(path).getRun("thread-1", "run-1")), "FILE_INVALID");
  });

  it("preserves explicit unknown outcomes across finalization and reopen, unlike ordinary failures", async () => {
    for (const code of ["TOOL_OUTCOME_UNKNOWN", "TOOL_EXECUTION_FAILED", "TOOL_DENIED"]) {
      const path = await directory();
      const store = createExecutionRecordStore(path, { now });
      await store.startRun({ runId: "run-1", threadId: "thread-1", phase: "primary" });
      await store.recordToolEvent("run-1", toolEvent("tool.call.requested", {
        toolCallId: "computer-1", toolName: "computer_action", input: { action: "type_text" },
      }));
      if (code !== "TOOL_DENIED") await store.recordToolEvent("run-1", toolEvent("tool.call.started", {
        toolCallId: "computer-1", toolName: "computer_action",
      }));
      await store.recordToolEvent("run-1", toolEvent("tool.call.failed", {
        toolCallId: "computer-1", toolName: "computer_action",
        error: { code, message: "controlled failure", retryable: false, phase: "tool" },
      }));
      await store.finishRun("run-1", result("failed"));
      const run = await createExecutionRecordStore(path).getRun("thread-1", "run-1");
      assert.equal(run?.tools[0]?.status, code === "TOOL_OUTCOME_UNKNOWN" ? "unknown" : "failed");
      assert.equal(run?.tools[0]?.resultPreview, null);
    }
  });
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
