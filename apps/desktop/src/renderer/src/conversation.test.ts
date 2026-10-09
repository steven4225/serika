import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@aisdk-agent/core";
import { ShellProgressBuffer } from "../../shared/shell-progress.js";
import {
  applyEvent,
  applyShellProgress,
  emptyLiveRun,
  overlayShellProgress,
  rowsFromHistory,
  annotateHistoryTools,
  rowsFromToolActivity,
  overlayExecutionReceipts,
  canReuseReceiptHistory,
} from "./conversation.js";
import type { ExecutionToolRecord } from "../../shared/ui-contract.js";

it("marks superseded proposals unstarted and keeps applied steer within the original task/receipt boundary", () => {
  const history = rowsFromHistory([
    { id: "u1", role: "user", parts: [{ type: "text", text: "original" }] },
    { id: "a1", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "write_file", toolCallId: "old", state: "output-error", input: {}, errorText: "STEER_SUPERSEDED: no dispatch" }] },
    { id: "s1", role: "user", metadata: { source: "steer", memoryConsolidation: "exclude" }, parts: [{ type: "text", text: "append only" }] },
    { id: "a2", role: "assistant", parts: [{ type: "text", text: "done" }] },
  ]);
  assert.equal(history[1]?.kind === "tool" && history[1].status, "not_started");
  assert.equal(history[2]?.kind === "text" && history[2].steer, true);
  const receipt: ExecutionToolRecord = { toolCallId: "old", toolName: "write_file", status: "not_started", requestedAt: "2026-10-08T00:00:00Z", startedAt: null, finishedAt: null, inputPreview: "{}", inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: null, shell: null };
  assert.equal(overlayExecutionReceipts(history, [receipt]).filter(row => row.kind === "tool").length, 1);
  const requested = applyEvent(emptyLiveRun, { id: "e1", type: "tool.call.requested", occurredAt: "2026-10-08T00:00:00Z", runId: "r1", threadId: "t1", sequence: 1, data: { toolCallId: "old", toolName: "write_file", input: {} } });
  const superseded = applyEvent(requested, { id: "e2", type: "tool.call.superseded", occurredAt: "2026-10-08T00:00:01Z", runId: "r1", threadId: "t1", sequence: 2, data: { toolCallId: "old", toolName: "write_file", reason: "steer" } });
  assert.equal(superseded.rows[0]?.kind === "tool" && superseded.rows[0].status, "not_started");
});

it("keeps background consolidation out of chat without hiding the next user turn", () => {
  const text = (id: string, role: "user" | "assistant", value: string) => ({ id, role, parts: [{ type: "text" as const, text: value }] });
  const messages = [text("u1", "user", "first"), text("a1", "assistant", "reply"),
    { ...text("bg", "user", "internal prompt"), metadata: { source: "auto-consolidation" } },
    text("bg-a", "assistant", "internal analysis"), text("u2", "user", "internal prompt"), text("a2", "assistant", "next reply")];
  assert.deepEqual(rowsFromHistory(messages).map(row => row.kind === "text" ? row.text : row.kind), ["first", "reply", "internal prompt", "next reply"]);
  assert.equal(messages.length, 6); // Display only: original history remains untouched.
});

it("reuses receipt history only for the same completed Run", () => {
  assert.equal(canReuseReceiptHistory({ runId: "current", status: "completed" }, "current"), true);
  assert.equal(canReuseReceiptHistory({ runId: "current", status: "completed" }, "previous"), false);
  assert.equal(canReuseReceiptHistory({ runId: "current", status: "completed" }, null), false);
  for (const status of ["failed", "cancelled", "interrupted", "timed_out", "running"] as const) {
    assert.equal(canReuseReceiptHistory({ runId: "current", status }, "current"), false);
  }
});

it("retains missing-file input and exact error code in history and live output, not assistant claims", () => {
  const failure = { ok: false, error: { code: "FILE_NOT_FOUND", message: "File not found: notes/work-plan.md" } };
  const rows = rowsFromHistory([{ id: "missing", role: "assistant", parts: [
    { type: "dynamic-tool", toolName: "read_file", toolCallId: "read-1", state: "output-available", input: { path: "notes/work-plan.md" }, output: failure },
    { type: "text", text: "文件存在，读取成功。" },
  ] }]);
  const row = rows[0];
  assert.ok(row?.kind === "tool");
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "FILE_NOT_FOUND");
  assert.equal(row.inputPath, "notes/work-plan.md");
  assert.equal(row.historical, true);
  assert.equal(row.recordedAt, undefined);
  const { historical, ...liveRow } = row;
  const live = applyEvent({ rows: [liveRow], streaming: "" }, {
    ...completed(failure), type: "tool.call.completed", data: { toolCallId: "read-1", toolName: "read_file", output: failure },
  });
  assert.equal(live.rows[0]?.kind === "tool" && live.rows[0].errorCode, "FILE_NOT_FOUND");
});

it("attaches history timestamps only for a unique current-Thread primary receipt, without altering its outcome", () => {
  const rows = rowsFromHistory([{ id: "read", role: "assistant", parts: [
    { type: "dynamic-tool", toolName: "read_file", toolCallId: "read-1", state: "output-available", input: { path: "notes/plan.md" }, output: { ok: false, error: { code: "FILE_NOT_FOUND" } } },
  ] }]);
  const tool: ExecutionToolRecord = { toolCallId: "read-1", toolName: "read_file", status: "completed", requestedAt: "2026-10-08T12:17:00Z", startedAt: null, finishedAt: null,
    inputPreview: "{}", inputTruncated: false, resultPreview: '{"ok":true}', resultTruncated: false, errorPreview: null, shell: null, fileInput: { path: "notes/plan.md" } };
  const run = { runId: "r1", threadId: "t1", phase: "primary" as const, status: "completed" as const, startedAt: tool.requestedAt, finishedAt: null,
    resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [tool] };
  const result = annotateHistoryTools(rows, [run], "t1")[0];
  assert.ok(result?.kind === "tool");
  assert.equal(result.runId, "r1");
  assert.equal(result.recordedAt, tool.requestedAt);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "FILE_NOT_FOUND");
  for (const receipts of [
    [run, { ...run, runId: "r2" }],
    [{ ...run, threadId: "foreign" }],
    [{ ...run, phase: "consolidation" as const }],
    [{ ...run, status: "interrupted" as const }],
    [{ ...run, status: "failed" as const }],
    [{ ...run, status: "cancelled" as const }],
    [{ ...run, tools: [{ ...tool, fileInput: { path: "different.md" } }] }],
    [],
  ]) assert.deepEqual(annotateHistoryTools(rows, receipts, "t1"), rows);
  const duplicate = [...rows, ...rows];
  assert.deepEqual(annotateHistoryTools(duplicate, [run], "t1"), duplicate);
});

describe("conversation file receipts", () => {
  const output = { ok: true, path: "notes/next-actions.md", bytes: 3838 };

  it("takes compact facts from real history and live outputs, not summaries or assistant prose", () => {
    const history = rowsFromHistory([{ id: "m1", role: "assistant", parts: [
      { type: "dynamic-tool", toolName: "edit_file", toolCallId: "file-1", state: "output-available", input: { path: output.path }, output },
      { type: "text", text: "已编辑 99999 字节。" },
    ] }]);
    assert.deepEqual(history[0]?.kind === "tool" && history[0].receipt, { kind: "file", path: output.path, bytes: 3838 });
    const live = applyEvent({ ...emptyLiveRun, rows: [{ kind: "tool", key: "file-1", toolCallId: "file-1", toolName: "edit_file", status: "requested" }] }, {
      ...completed(output), type: "tool.call.completed", data: { toolCallId: "file-1", toolName: "edit_file", output },
    });
    assert.deepEqual(live.rows[0]?.kind === "tool" && live.rows[0].receipt, { kind: "file", path: output.path, bytes: 3838 });
    for (const truncated of [true, false]) {
      const summary = rowsFromToolActivity([{ toolCallId: "file-1", toolName: "edit_file", status: "completed", summary: JSON.stringify(output), truncated }]);
      assert.equal(summary[0]?.kind === "tool" && summary[0].receipt, undefined);
    }
  });

  it("keeps refused and failed file calls distinct even when the assistant claims success", () => {
    const rows = rowsFromHistory([{ id: "m1", role: "assistant", parts: [
      { type: "dynamic-tool", toolName: "edit_file", toolCallId: "file-1", state: "output-available", input: {}, output: { ok: false, error: { code: "WRITE_FAILED", message: "Unable to write" }, path: output.path, bytes: 3838 } },
      { type: "dynamic-tool", toolName: "write_file", toolCallId: "file-2", state: "output-denied", input: {}, approval: { id: "approval", approved: false } },
      { type: "text", text: "两个工具都成功了。" },
    ] }]);
    assert.equal(rows[0]?.kind === "tool" && rows[0].status, "failed");
    assert.equal(rows[1]?.kind === "tool" && rows[1].status, "denied");
    assert.equal(rows[0]?.kind === "tool" && rows[0].receipt, undefined);
    assert.equal(rows[1]?.kind === "tool" && rows[1].receipt, undefined);
  });

  it("never derives facts from final preview and clears an earlier receipt on unknown/failure", () => {
    const saved: ExecutionToolRecord = { toolCallId: "file-1", toolName: "edit_file", status: "completed",
      requestedAt: "2026-10-03T00:00:00.000Z", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
      inputPreview: "{}", inputTruncated: false, resultPreview: JSON.stringify(output), resultTruncated: false, errorPreview: null, shell: null };
    const fromPreview = overlayExecutionReceipts([], [saved]);
    assert.equal(fromPreview[0]?.kind === "tool" && fromPreview[0].receipt, undefined);
    const full = rowsFromHistory([{ id: "m1", role: "assistant", parts: [
      { type: "dynamic-tool", toolName: "edit_file", toolCallId: "file-1", state: "output-available", input: {}, output },
    ] }]);
    const partialPreview = overlayExecutionReceipts(full, [{ ...saved, resultTruncated: true }]);
    assert.deepEqual(partialPreview[0]?.kind === "tool" && partialPreview[0].receipt, { kind: "file", path: output.path, bytes: 3838 });
    for (const status of ["unknown", "failed", "not_started"] as const) {
      const changed = overlayExecutionReceipts(full, [{ ...saved, status }]);
      assert.equal(changed[0]?.kind === "tool" && changed[0].receipt, undefined);
      assert.equal(changed[0]?.kind === "tool" && changed[0].status, status);
    }
    const failed = applyEvent({ rows: full, streaming: "" }, { ...completed(output), type: "tool.call.failed",
      data: { toolCallId: "file-1", toolName: "edit_file", error: { code: "TOOL_OUTCOME_UNKNOWN", message: "Connection lost", retryable: false, phase: "tool" } } });
    assert.equal(failed.rows[0]?.kind === "tool" && failed.rows[0].receipt, undefined);
    assert.equal(failed.rows[0]?.kind === "tool" && failed.rows[0].status, "unknown");
  });

  it("keeps returned failure/denial/unknown and Shell failure across activity and receipt reload", () => {
    for (const [code, status] of [["WRITE_FAILED", "failed"], ["TOOL_DENIED", "denied"], ["TOOL_OUTCOME_UNKNOWN", "unknown"]] as const) {
      const summary = JSON.stringify({ ok: false, error: { code, message: "not successful" } });
      const activity = rowsFromToolActivity([{ toolCallId: "file-1", toolName: "write_file", status: "completed", summary, truncated: false }]);
      assert.equal(activity[0]?.kind === "tool" && activity[0].status, status);
      const saved: ExecutionToolRecord = { toolCallId: "file-1", toolName: "write_file", status: "completed",
        requestedAt: "2026-10-03T00:00:00.000Z", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
        inputPreview: "{}", inputTruncated: false, resultPreview: summary, resultTruncated: false, errorPreview: null, shell: null };
      const final = overlayExecutionReceipts([], [saved]);
      assert.equal(final[0]?.kind === "tool" && final[0].status, status);
      assert.equal(final[0]?.kind === "tool" && final[0].receipt, undefined);
    }
    const shell = rowsFromToolActivity([{ toolCallId: "shell-1", toolName: "shell_exec", status: "completed",
      summary: JSON.stringify({ ok: true, exitCode: 7, timedOut: false, cancelled: false }), truncated: false }]);
    assert.equal(shell[0]?.kind === "tool" && shell[0].status, "failed");
  });

  it("never lets incomplete final previews turn a full failed history output into success", () => {
    const failure = { ok: false, error: { code: "WRITE_FAILED", message: "Unable to write the file" } };
    const full = rowsFromHistory([{ id: "m1", role: "assistant", parts: [
      { type: "dynamic-tool", toolName: "edit_file", toolCallId: "file-1", state: "output-available", input: {}, output: failure },
    ] }]);
    const saved: ExecutionToolRecord = { toolCallId: "file-1", toolName: "edit_file", status: "completed",
      requestedAt: "2026-10-03T00:00:00.000Z", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
      inputPreview: "{}", inputTruncated: false, resultPreview: '{"ok":false', resultTruncated: true, errorPreview: null, shell: null };
    for (const preview of [
      { resultPreview: '{"ok":false', resultTruncated: true },
      { resultPreview: '{"ok":false', resultTruncated: false },
      { resultPreview: null, resultTruncated: false },
      { resultPreview: "", resultTruncated: false },
    ]) {
      const overlaid = overlayExecutionReceipts(full, [{ ...saved, ...preview }]);
      assert.equal(overlaid[0]?.kind === "tool" && overlaid[0].status, "failed");
      assert.match(overlaid[0]?.kind === "tool" && overlaid[0].detail || "", /WRITE_FAILED: Unable to write/);
      assert.equal(overlaid[0]?.kind === "tool" && overlaid[0].receipt, undefined);
      const noFull = overlayExecutionReceipts([], [{ ...saved, ...preview }]);
      assert.equal(noFull[0]?.kind === "tool" && noFull[0].status, "incomplete");
      const activity = rowsFromToolActivity([{ toolCallId: "file-1", toolName: "edit_file", status: "completed",
        summary: preview.resultPreview ?? "", truncated: preview.resultTruncated }]);
      assert.equal(activity[0]?.kind === "tool" && activity[0].status, "incomplete");
    }
    const shell = overlayExecutionReceipts([], [{ ...saved, toolName: "shell_exec", shell: { exitCode: 7, timedOut: false, cancelled: false } }]);
    assert.equal(shell[0]?.kind === "tool" && shell[0].status, "failed");
    const noShellExit = overlayExecutionReceipts([], [{ ...saved, toolName: "shell_exec", shell: { exitCode: null, timedOut: false, cancelled: false } }]);
    assert.equal(noShellExit[0]?.kind === "tool" && noShellExit[0].status, "incomplete");
    const unknown = rowsFromToolActivity([{ toolCallId: "file-1", toolName: "edit_file", status: "failed",
      summary: "", truncated: true, outcomeUnknown: true }]);
    assert.equal(unknown[0]?.kind === "tool" && unknown[0].status, "unknown");
  });

  it("matches tool identity only in the last user turn and supports refusing all history reuse", () => {
    const full = rowsFromHistory([
      { id: "old-user", role: "user", parts: [{ type: "text", text: "old task" }] },
      { id: "old-result", role: "assistant", parts: [
        { type: "dynamic-tool", toolName: "edit_file", toolCallId: "same-id", state: "output-available", input: {}, output },
      ] },
      { id: "new-user", role: "user", parts: [{ type: "text", text: "new task" }] },
      { id: "new-result", role: "assistant", parts: [
        { type: "dynamic-tool", toolName: "edit_file", toolCallId: "same-id", state: "output-available", input: {},
          output: { ok: false, error: { code: "WRITE_FAILED", message: "new task failed" } } },
      ] },
    ]);
    const saved: ExecutionToolRecord = { toolCallId: "same-id", toolName: "edit_file", status: "completed",
      requestedAt: "2026-10-03T00:00:00.000Z", startedAt: "2026-10-03T00:00:00.000Z", finishedAt: "2026-10-03T00:00:01.000Z",
      inputPreview: "{}", inputTruncated: false, resultPreview: '{"ok":', resultTruncated: true, errorPreview: null, shell: null };
    const reused = overlayExecutionReceipts(full, [saved]);
    assert.equal(reused.length, full.length);
    assert.equal(reused[1]?.kind === "tool" && reused[1].status, "ok");
    assert.deepEqual(reused[1], full[1]);
    assert.equal(reused[3]?.kind === "tool" && reused[3].status, "failed");

    const lastTurnWithoutCall = full.slice(0, 3);
    const appended = overlayExecutionReceipts(lastTurnWithoutCall, [saved]);
    assert.equal(appended.length, 4);
    assert.deepEqual(appended[1], full[1]);
    assert.equal(appended[3]?.kind === "tool" && appended[3].status, "incomplete");

    const otherName = overlayExecutionReceipts(full, [{ ...saved, toolName: "write_file", status: "not_started" }]);
    assert.equal(otherName.length, full.length + 1);
    assert.deepEqual(otherName[3], full[3]);
    assert.equal(otherName[4]?.kind === "tool" && otherName[4].toolName, "write_file");

    const noReuse = overlayExecutionReceipts(full, [saved, { ...saved, toolName: "write_file", status: "not_started" }], { reuseHistory: false });
    assert.equal(noReuse.length, full.length + 2);
    assert.deepEqual(noReuse.slice(0, full.length), full);
    assert.equal(noReuse[4]?.kind === "tool" && noReuse[4].status, "incomplete");
    assert.equal(noReuse[5]?.kind === "tool" && noReuse[5].status, "not_started");
    assert.equal(new Set(noReuse.map(row => row.key)).size, noReuse.length);
  });
});

function completed(output: unknown): AgentEvent {
  return {
    id: "e1",
    type: "tool.call.completed",
    runId: "run",
    threadId: "thread",
    sequence: 2,
    occurredAt: "2026-09-29T00:00:00.000Z",
    data: { toolCallId: "sh-1", toolName: "shell_exec", output },
  };
}

describe("conversation shell display", () => {
  it("shows live progress before the tool result and does not mark truncation as failure", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({
      toolCallId: "sh-1", sequence: 1, stream: "stdout", text: "working", truncated: false,
    });
    let live = applyEvent(emptyLiveRun, {
      id: "e0",
      type: "tool.call.requested",
      runId: "run",
      threadId: "thread",
      sequence: 1,
      occurredAt: "2026-09-29T00:00:00.000Z",
      data: { toolCallId: "sh-1", toolName: "shell_exec", input: { command: "sleep 1" } },
    });
    live = applyShellProgress(live, "sh-1", buffer);
    const tool = live.rows.find((row) => row.kind === "tool");
    assert.equal(tool?.kind, "tool");
    if (tool?.kind === "tool") {
      assert.equal(tool.status, "requested");
      assert.equal(tool.stdout, "working");
    }
    buffer.apply({
      toolCallId: "sh-1", sequence: 2, stream: "stdout", text: "", truncated: true,
    });
    live = applyShellProgress(live, "sh-1", buffer);
    live = applyEvent(live, completed({
      ok: true, exitCode: 0, cancelled: false, timedOut: false, output: "working", truncated: true,
    }));
    const done = live.rows.find((row) => row.kind === "tool");
    assert.equal(done?.kind, "tool");
    if (done?.kind === "tool") {
      assert.equal(done.status, "ok");
      assert.equal(done.stdout, "working");
      assert.equal(done.progressTruncated, true);
    }
  });

  it("keeps truncated progress when overlaying a snapshot after reload", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({ toolCallId: "sh-1", sequence: 1, stream: "stdout", text: "log", truncated: false });
    buffer.apply({ toolCallId: "sh-1", sequence: 2, stream: "stdout", text: "", truncated: true });
    const rows = overlayShellProgress(
      [{ kind: "tool", key: "t:sh-1", toolCallId: "sh-1", toolName: "shell_exec", status: "requested" }],
      buffer,
    );
    const tool = rows[0];
    assert.equal(tool?.kind, "tool");
    if (tool?.kind === "tool") {
      assert.equal(tool.stdout, "log");
      assert.equal(tool.progressTruncated, true);
      assert.equal(tool.status, "requested");
    }
  });

  it("does not overlay the current Shell buffer onto repeated IDs in older turns or other tools", () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({ toolCallId: "same-id", sequence: 1, stream: "stdout", text: "current logs", truncated: false });
    const history = rowsFromHistory([
      { id: "old-user", role: "user", parts: [{ type: "text", text: "old command" }] },
      { id: "old-result", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "shell_exec", toolCallId: "same-id",
        state: "output-available", input: {}, output: { ok: true, exitCode: 0, timedOut: false, cancelled: false, output: "old logs" } }] },
      { id: "new-user", role: "user", parts: [{ type: "text", text: "new command" }] },
      { id: "new-call", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "shell_exec", toolCallId: "same-id", state: "input-available", input: {} }] },
      { id: "file-call", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "read_file", toolCallId: "same-id", state: "input-available", input: {} }] },
    ]);
    const overlaid = overlayShellProgress(history, buffer);
    assert.deepEqual(overlaid[1], history[1]);
    assert.equal(overlaid[1]?.kind === "tool" && overlaid[1].stdout, undefined);
    assert.equal(overlaid[3]?.kind === "tool" && overlaid[3].stdout, "current logs");
    assert.deepEqual(overlaid[4], history[4]);
    assert.equal(overlaid[4]?.kind === "tool" && overlaid[4].stdout, undefined);
    // A live/activity list has no user rows and still receives current progress.
    const live = overlayShellProgress([history[3]!], buffer);
    assert.equal(live[0]?.kind === "tool" && live[0].stdout, "current logs");
  });
});
