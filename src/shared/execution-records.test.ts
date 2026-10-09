import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXECUTION_RECORDS_UNAVAILABLE,
  completedOutcome,
  runPhaseLabel,
  runStatusLabel,
  runSummary,
  toListRunsResponse,
  toolNote,
  toolStatusLabel,
  toolTone,
  wrapExecutionQuery,
} from "./execution-records.js";
import type { ExecutionRunRecord, ExecutionToolRecord } from "./ui-contract.js";

function tool(overrides: Partial<ExecutionToolRecord> & Pick<ExecutionToolRecord, "status" | "toolName">): ExecutionToolRecord {
  return {
    toolCallId: overrides.toolCallId ?? "call-1",
    toolName: overrides.toolName,
    status: overrides.status,
    requestedAt: "2026-09-29T12:00:00.000Z",
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
    inputPreview: overrides.inputPreview ?? "{\"path\":\"notes.md\"}",
    inputTruncated: overrides.inputTruncated ?? false,
    resultPreview: overrides.resultPreview ?? null,
    resultTruncated: overrides.resultTruncated ?? false,
    errorPreview: overrides.errorPreview ?? null,
    shell: overrides.shell ?? null,
  };
}

function run(overrides: Partial<ExecutionRunRecord> = {}): ExecutionRunRecord {
  return {
    runId: "run-1",
    threadId: "thread-1",
    phase: "primary",
    status: "failed",
    startedAt: "2026-09-29T12:00:00.000Z",
    finishedAt: "2026-09-29T12:01:00.000Z",
    resultTextPreview: null,
    resultTextTruncated: false,
    errorPreview: "model failed",
    tools: [],
    ...overrides,
  };
}

describe("execution record presentation", () => {
  it("explains an exact complete missing-file result without claiming success or hiding unknown effects", () => {
    const missing = tool({ toolName: "read_file", status: "completed", resultPreview: JSON.stringify({ ok: false, error: { code: "FILE_NOT_FOUND" } }) });
    assert.equal(toolNote(missing), "文件不存在，未读取到内容");
    assert.equal(toolTone(missing), "fail");
    assert.doesNotMatch(toolNote({ ...missing, resultTruncated: true }), /文件不存在/);
    assert.doesNotMatch(toolNote({ ...missing, status: "unknown" }), /文件不存在/);
    assert.equal(toolTone({ ...missing, status: "unknown" }), "unknown");
  });
  it("does not treat a query throw as an empty history", async () => {
    const wrapped = await wrapExecutionQuery(async () => {
      throw new Error("CONFLICT: Thread is already owned");
    });
    const listed = toListRunsResponse(wrapped);
    assert.equal(listed.ok, false);
    if (!listed.ok) {
      assert.equal(listed.reason, "unavailable");
      assert.match(listed.message, /CONFLICT/);
    }
    assert.equal(EXECUTION_RECORDS_UNAVAILABLE.includes("空"), false);
  });

  it("keeps completed write_file beside a later unknown tool on a failed Run", () => {
    const record = run({
      status: "failed",
      tools: [
        tool({
          toolCallId: "write-1",
          toolName: "write_file",
          status: "completed",
          startedAt: "2026-09-29T12:00:01.000Z",
          finishedAt: "2026-09-29T12:00:02.000Z",
          resultPreview: "{\"ok\":true,\"path\":\"notes.md\"}",
        }),
        tool({
          toolCallId: "shell-1",
          toolName: "shell_exec",
          status: "unknown",
          startedAt: "2026-09-29T12:00:03.000Z",
          inputPreview: "{\"command\":\"npm test\"}",
        }),
      ],
    });
    assert.equal(runStatusLabel(record.status), "失败");
    assert.equal(runPhaseLabel(record.phase), "主任务");
    assert.match(runSummary(record), /1 需核对/);
    assert.match(runSummary(record), /1 已返回/);
    const [write, shell] = record.tools;
    assert.equal(write && toolStatusLabel(write.status), "已返回");
    assert.equal(write && completedOutcome(write), "ok:true");
    assert.equal(write && toolTone(write), "ok");
    assert.equal(shell && toolStatusLabel(shell.status), "需人工核对");
    assert.match(shell ? toolNote(shell) : "", /不会自动重试/);
    assert.equal(runPhaseLabel("consolidation"), "整理");
    assert.equal(runPhaseLabel("skill"), "Skill");
  });

  it("does not treat not_started as an unknown side effect", () => {
    const pending = tool({ toolName: "write_file", status: "not_started" });
    assert.equal(toolStatusLabel(pending.status), "未执行");
    assert.match(toolNote(pending), /不能当成已经改过文件/);
    assert.equal(toolTone(pending), "muted");
  });

  it("reads Shell receipts from the record instead of assuming completed means success", () => {
    const timedOut = tool({
      toolName: "shell_exec",
      status: "completed",
      shell: { exitCode: null, timedOut: true, cancelled: false },
      resultPreview: "{\"ok\":true,\"timedOut\":true}",
    });
    assert.equal(completedOutcome(timedOut), "exit null · Shell 超时");
    assert.equal(toolTone(timedOut), "warn");
    const denied = tool({
      toolName: "write_file",
      status: "failed",
      errorPreview: "TOOL_DENIED",
    });
    assert.equal(toolStatusLabel(denied.status), "失败");
    assert.equal(toolTone(denied), "fail");
  });

  it("labels a running audit row as in progress, not interrupted", () => {
    assert.equal(runStatusLabel("running"), "进行中");
    assert.equal(runStatusLabel("interrupted"), "已中断");
  });
});
