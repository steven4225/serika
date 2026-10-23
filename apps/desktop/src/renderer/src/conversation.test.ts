import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@serika/core";
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
  withSteerRecords,
} from "./conversation.js";
import type { ExecutionToolRecord } from "../../shared/ui-contract.js";

it("shows an accepted correction as a normal user message in order, then updates it without duplication", () => {
  const event = { id: "e", runId: "r1", threadId: "t1", occurredAt: "2026-10-16T00:00:00Z", sequence: 1 };
  const accepted = applyEvent({ rows: [], streaming: "原来的分析" }, {
    ...event, type: "run.steer.accepted", data: { id: "s1", text: "先别改文件，只分析原因" },
  });
  assert.deepEqual(accepted.rows.filter(row => row.kind === "text").map(row => [row.role, row.text]),
    [["assistant", "原来的分析"], ["user", "先别改文件，只分析原因"]]);
  assert.equal(accepted.streaming, "");
  const applied = applyEvent(accepted, { ...event, sequence: 2, type: "run.steer.applied", data: { id: "s1", messageId: "msg1" } });
  const correction = applied.rows.filter(row => row.kind === "text" && row.role === "user");
  assert.equal(correction.length, 1);
  assert.equal(correction[0]?.key, "h:msg1:text:0");
});

it("retains failed corrections after reconnect, without duplicating a committed correction or claiming success", () => {
  const base = { id: "s1", runId: "r1", text: "只分析原因", receivedAt: "2026-10-16T00:00:00Z" };
  const committed = rowsFromHistory([{ id: "msg1", role: "user", metadata: { source: "steer" }, parts: [{ type: "text", text: base.text }] }]);
  const rows = withSteerRecords(committed, [{ ...base, status: "applied", messageId: "msg1" }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind === "text" && rows[0].committed, true);
  for (const reason of ["cancelled", "budget_exhausted", "run_failed"]) {
    const restored = withSteerRecords([], [{ ...base, status: "not_applied", reason }]);
    assert.equal(restored.length, 1);
    assert.ok(restored[0]?.kind === "text" && restored[0].role === "user" && restored[0].text === base.text);
    assert.equal(restored[0].steerRecord?.status, "not_applied");
  }
});

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

it("keeps a reminder readback in Chinese when the tool result also says scheduled", () => {
  const requested = applyEvent(emptyLiveRun, {
    id: "e1", type: "tool.call.requested", occurredAt: "2026-10-08T00:00:00Z", runId: "r1", threadId: "t1", sequence: 1,
    data: { toolCallId: "task-1", toolName: "task_create", input: {} },
  });
  const completed = applyEvent(requested, {
    id: "e2", type: "tool.call.completed", occurredAt: "2026-10-08T00:00:01Z", runId: "r1", threadId: "t1", sequence: 2,
    data: { toolCallId: "task-1", toolName: "task_create", output: { ok: true, status: "scheduled", backgroundReady: true, readback: "已定：明天 9:00 提醒喝水" } },
  });
  const row = completed.rows[0];
  assert.equal(row?.kind, "tool");
  if (row?.kind !== "tool") return;
  assert.equal(row.status, "ok");
  assert.equal(row.detail, "已定：明天 9:00 提醒喝水");
  assert.deepEqual(row.reminder, { readback: "已定：明天 9:00 提醒喝水", backgroundReady: true });
  assert.doesNotMatch(row.detail, /scheduled/);
  const [snapshot] = rowsFromToolActivity([{ toolCallId: "task-1", toolName: "task_create", status: "completed", summary: JSON.stringify({ ok: true, backgroundReady: true, readback: row.detail }), truncated: false }]);
  assert.deepEqual(snapshot?.kind === "tool" && snapshot.reminder, row.reminder);
  const [truncated] = rowsFromToolActivity([{ toolCallId: "task-1", toolName: "task_create", status: "completed", summary: JSON.stringify({ ok: true, readback: row.detail }), truncated: true }]);
  assert.equal(truncated?.kind === "tool" && truncated.reminder, undefined);
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

it("failure activity Demo presents the actual failure message on snapshot reload rather than an incomplete JSON receipt", () => {
  const [row] = rowsFromToolActivity([{ toolCallId: "fail", toolName: "write_file", status: "failed",
    summary: "WRITE_FAILED: Unable to save this file", truncated: false }], "completed-run");
  assert.ok(row?.kind === "tool");
  assert.equal(row.status, "failed");
  assert.equal(row.detail, "WRITE_FAILED: Unable to save this file");
  assert.equal(row.runId, "completed-run");
  assert.equal(row.receipt, undefined);
  for (const [errorCode, status] of [["WRITE_FAILED", "failed"], ["TOOL_DENIED", "denied"], ["TOOL_OUTCOME_UNKNOWN", "unknown"]] as const) {
    const [bounded] = rowsFromToolActivity([{ toolCallId: "fail", toolName: "write_file", status: "failed", errorCode,
      summary: `${errorCode}: ${"x".repeat(990)}`.slice(0, 1_000), truncated: true }]);
    assert.ok(bounded?.kind === "tool");
    assert.equal(bounded.status, status);
    assert.equal(bounded.errorCode, errorCode);
    assert.equal(bounded.receipt, undefined);
    assert.doesNotMatch(bounded.detail ?? "", /推断成功|返回成功/);
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

for (const toolName of ["shell_exec", "terminal_exec"]) it(`${toolName} projects exact Shell input from live events and history, and only complete receipt previews after reconnect`, () => {
  const input = { command: "node check.mjs\nprintf done", cwd: "project" };
  const requested = applyEvent(emptyLiveRun, { id: "command", type: "tool.call.requested", occurredAt: "2026-10-16T00:00:00Z", runId: "run", threadId: "thread", sequence: 1,
    data: { toolCallId: "shell", toolName, input } });
  const history = rowsFromHistory([{ id: "command", role: "assistant", parts: [{ type: "dynamic-tool", toolName, toolCallId: "shell", state: "input-available", input }] }]);
  const receipt: ExecutionToolRecord = { toolCallId: "shell", toolName, status: "completed", requestedAt: "2026-10-16T00:00:00Z", startedAt: null, finishedAt: null,
    inputPreview: JSON.stringify(input), inputTruncated: false, resultPreview: null, resultTruncated: true, errorPreview: null,
    shell: { exitCode: 0, cancelled: false, timedOut: false } };
  for (const rows of [requested.rows, history, overlayExecutionReceipts([], [receipt]), overlayExecutionReceipts(requested.rows, [receipt])]) {
    const row = rows[0];
    assert.ok(row?.kind === "tool");
    assert.equal(row.inputCommand, input.command);
    assert.equal(row.inputCwd, "project");
  }
  const merged = overlayExecutionReceipts(requested.rows, [receipt])[0];
  assert.equal(merged?.kind === "tool" && merged.exitCode, 0);
  for (const invalid of [{ ...receipt, inputTruncated: true }, { ...receipt, inputPreview: '{"command":' }]) {
    const row = overlayExecutionReceipts([], [invalid])[0];
    assert.ok(row?.kind === "tool");
    assert.equal(row.inputCommand, undefined);
    assert.equal(row.inputCwd, undefined);
  }
  const output = { ok: true, exitCode: 0, timedOut: false, cancelled: false, output: "sum check passed" };
  const completed = applyEvent(requested, { id: "done", type: "tool.call.completed", occurredAt: "2026-10-16T00:00:01Z", runId: "run", threadId: "thread", sequence: 2,
    data: { toolCallId: "shell", toolName, output } });
  const saved = rowsFromHistory([{ id: "done", role: "assistant", parts: [{ type: "dynamic-tool", toolName, toolCallId: "shell", state: "output-available", input, output }] }]);
  const reloaded = overlayExecutionReceipts([], [{ ...receipt, resultPreview: JSON.stringify(output), resultTruncated: false }]);
  for (const row of [completed.rows[0], saved[0], reloaded[0]]) {
    assert.ok(row?.kind === "tool");
    assert.equal(row.output, "sum check passed");
  }
});

it("keeps bounded file-change intent separate from the write outcome", () => {
  const [row] = rowsFromHistory([{ id: "edit", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "edit_file", toolCallId: "edit", state: "output-denied", approval: { id: "approval", approved: false },
    input: { path: "sum.js", oldText: "a - b", newText: `a + b${"x".repeat(4_001)}` } }] }]);
  assert.ok(row?.kind === "tool");
  assert.equal(row.status, "denied");
  assert.deepEqual(row.fileChange, { before: "a - b", after: `a + b${"x".repeat(3_995)}`, truncated: true });
  assert.equal(row.receipt, undefined);
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

  for (const toolName of ["shell_exec", "terminal_exec"]) it(`${toolName} keeps truncated progress when overlaying a snapshot after reload`, () => {
    const buffer = new ShellProgressBuffer();
    buffer.apply({ toolCallId: "sh-1", sequence: 1, stream: "stdout", text: "log", truncated: false });
    buffer.apply({ toolCallId: "sh-1", sequence: 2, stream: "stdout", text: "", truncated: true });
    const rows = overlayShellProgress(
      [{ kind: "tool", key: "t:sh-1", toolCallId: "sh-1", toolName, status: "requested" }],
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

it("shows persisted attachments once without displaying host document wrappers or accepting remote image URLs", () => {
  const data = "data:image/png;base64,aGVsbG8=";
  const rows = rowsFromHistory([{ id: "attached", role: "user", metadata: { attachments: [{ name: "note.md", mediaType: "text/markdown" }, { name: "pixel.png", mediaType: "image/png" }] }, parts: [
    { type: "text", text: "帮我读一下" },
    { type: "text", text: '\n<attached-document name="note.md">\nprivate text\n</attached-document>' },
    { type: "file", filename: "pixel.png", mediaType: "image/png", url: data },
  ] }]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0]?.kind === "text");
  assert.equal(rows[0].text, "帮我读一下");
  assert.deepEqual(rows[0].attachments, [{ name: "note.md" }, { name: "pixel.png", url: data }]);
});

it("projects bounded file contents only from successful full outcomes, never saved previews", () => {
  const row = (output: unknown) => rowsFromHistory([{ id: "a", role: "assistant", parts: [{ type: "dynamic-tool", toolCallId: "read", toolName: "read_file", state: "output-available", input: { path: "sum.js" }, output }] }])[0];
  const full = row({ ok: true, path: "sum.js", content: "export const sum = (a, b) => a + b;", bytes: 34 });
  assert.ok(full?.kind === "tool"); assert.equal(full.fileContent?.text, "export const sum = (a, b) => a + b;");
  const saved: ExecutionToolRecord = { toolCallId: "read", toolName: "read_file", status: "unknown", requestedAt: "2026-10-16T10:00:00Z", startedAt: null, finishedAt: null, inputPreview: "{}", inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: null, shell: null };
  const unknown = overlayExecutionReceipts([full], [saved])[0];
  assert.ok(unknown?.kind === "tool"); assert.equal(unknown.fileContent, undefined);
  const long = row({ ok: true, path: "sum.js", content: "x".repeat(11999) + "😀tail", bytes: 12007 });
  assert.ok(long?.kind === "tool"); assert.equal(long.fileContent?.text.length, 11999); assert.equal(long.fileContent?.truncated, true);
  const failed = row({ ok: false, content: "must not show", error: { code: "READ_FAILED", message: "failed" } });
  assert.ok(failed?.kind === "tool"); assert.equal(failed.fileContent, undefined);
  const preview = rowsFromToolActivity([{ toolCallId: "read", toolName: "read_file", status: "completed", summary: '{"ok":true,"content":"preview"}', truncated: false }])[0];
  assert.ok(preview?.kind === "tool"); assert.equal(preview.fileContent, undefined);
});

describe("host tool failures: detail `CODE: message` with the code", () => {
  const historyTool = (errorText: string) => {
    const rows = rowsFromHistory([{ id: "a1", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "write_file", toolCallId: "c1", state: "output-error", input: {}, errorText }] }] as never);
    return rows[0]?.kind === "tool" ? rows[0] : undefined;
  };
  it("history reads the code from the front of the stored error text, and only from there", () => {
    assert.deepEqual([historyTool("TOOL_OUTCOME_UNKNOWN: Connection lost")?.status, historyTool("TOOL_OUTCOME_UNKNOWN: Connection lost")?.errorCode], ["unknown", "TOOL_OUTCOME_UNKNOWN"]);
    assert.equal(historyTool("TOOL_EXECUTION_FAILED: disk full")?.errorCode, "TOOL_EXECUTION_FAILED");
    assert.equal(historyTool("disk full: TOOL_EXECUTION_FAILED")?.errorCode, undefined);
    assert.equal(historyTool("boom")?.errorCode, undefined);
    assert.equal(historyTool("boom")?.detail, "boom");
    const superseded = historyTool("STEER_SUPERSEDED: no dispatch");
    assert.deepEqual([superseded?.status, superseded?.detail, superseded?.errorCode], ["not_started", "因补充要求停止，调用未派发", undefined]);
  });
});
