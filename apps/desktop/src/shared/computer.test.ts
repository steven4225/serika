import assert from "node:assert/strict";
import { it } from "node:test";
import { describeComputerApproval, presentComputerResult } from "./computer.js";
import { overlayExecutionReceipts, rowsFromHistory, rowsFromToolActivity, applyEvent, emptyLiveRun } from "../renderer/src/conversation.js";
import { completedOutcome, toolTone } from "./execution-records.js";
import type { ExecutionToolRecord, PendingApproval } from "./ui-contract.js";

function receipt(overrides: Partial<ExecutionToolRecord> = {}): ExecutionToolRecord {
  return { toolCallId: "action-1", toolName: "computer_action", status: "completed", requestedAt: "2026-10-02T00:00:00.000Z",
    startedAt: "2026-10-02T00:00:00.000Z", finishedAt: "2026-10-02T00:00:01.000Z",
    inputPreview: "{}", inputTruncated: false, resultPreview: null, resultTruncated: false,
    errorPreview: null, shell: null, ...overrides };
}

it("shows dispatched Computer receipts as unverified, not business success, across live/history/reload", () => {
  const output = { ok: true, dispatched: true, verified: false, effect: "confirmed" };
  assert.equal(presentComputerResult("computer_action", output)?.status, "dispatched");
  const history = rowsFromHistory([{ id: "message", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "computer_action",
    toolCallId: "action-1", state: "output-available", input: {}, output }] }]);
  assert.equal(history[0]?.kind === "tool" && history[0].status, "dispatched");
  const live = applyEvent({ ...emptyLiveRun, rows: [{ kind: "tool", key: "action", toolCallId: "action-1", toolName: "computer_action", status: "requested" }] }, {
    id: "event", type: "tool.call.completed", runId: "run", threadId: "thread", sequence: 1, occurredAt: "2026-10-02T00:00:00.000Z",
    data: { toolCallId: "action-1", toolName: "computer_action", output },
  });
  assert.equal(live.rows[0]?.kind === "tool" && live.rows[0].status, "dispatched");
  const reloaded = rowsFromToolActivity([{ toolCallId: "action-1", toolName: "computer_action", status: "completed", summary: JSON.stringify(output), truncated: false }]);
  assert.equal(reloaded[0]?.kind === "tool" && reloaded[0].status, "dispatched");
  const saved = receipt({ resultPreview: JSON.stringify(output) });
  assert.equal(toolTone(saved), "warn");
  assert.match(completedOutcome(saved), /业务完成/);
  assert.equal(presentComputerResult("computer_action", { ...output, effect: "suspected_noop" })?.status, "dispatched");
  assert.match(presentComputerResult("computer_action", { ...output, effect: "suspected_noop" })?.detail ?? "", /疑似未生效/);
});

it("retains unknown outcomes and distinguishes cancellation-before-start from cancellation-after-start", () => {
  const reloaded = rowsFromToolActivity([{ toolCallId: "action-1", toolName: "computer_action", status: "failed",
    outcomeUnknown: true, summary: "Connection lost", truncated: false }]);
  assert.equal(reloaded[0]?.kind === "tool" && reloaded[0].status, "unknown");
  for (const status of ["unknown", "not_started"] as const) {
    const overlaid = overlayExecutionReceipts([{ kind: "tool", key: "original", toolName: "computer_action", toolCallId: "action-1", status: "requested" }], [receipt({ status })]);
    assert.equal(overlaid.length, 1);
    assert.equal(overlaid[0]?.kind === "tool" && overlaid[0].status, status);
  }
  assert.equal(presentComputerResult("computer_action", undefined)?.status, "unknown");
  assert.equal(presentComputerResult("computer_action", { ok: true, effect: "partial" })?.status, "unknown");
  assert.equal(presentComputerResult("computer_action", { ok: false, error: { code: "TOOL_DENIED" } })?.status, "denied");
  assert.equal(presentComputerResult("computer_observe", { ok: false })?.status, "failed");
  const truncated = rowsFromToolActivity([{ toolCallId: "action-1", toolName: "computer_action", status: "completed", summary: '{"ok":true', truncated: true }]);
  assert.equal(truncated[0]?.kind === "tool" && truncated[0].status, "incomplete");
});

it("does not turn a truncated Shell receipt into success when applying final receipts", () => {
  const rows = overlayExecutionReceipts([], [receipt({ toolName: "shell_exec", resultTruncated: true,
    shell: { exitCode: 7, timedOut: false, cancelled: false } })]);
  assert.equal(rows[0]?.kind === "tool" && rows[0].status, "failed");
});

it("previews exact target and full text without inventing missing window data", () => {
  const approval: PendingApproval = { approvalId: "approval-1", toolCallId: "action-1", toolName: "computer_action", preview: "",
    input: { bundleId: "com.apple.TextEdit", pid: 123, windowId: 456, action: "type_text",
      observationId: "observe-1", elementToken: "element-1", text: "<script>not executable</script>\n" + "完整文本".repeat(100) } };
  const view = describeComputerApproval(approval);
  assert.equal(view?.text, (approval.input as { text: string }).text);
  assert.equal(view?.allowLabel, "允许本次输入");
  assert.equal(view?.windowId, 456);
  assert.equal(describeComputerApproval({ ...approval, input: { bundleId: "com.apple.TextEdit", action: "click" } }), undefined);
  const list = describeComputerApproval({ ...approval, toolName: "computer_observe", input: { bundleId: "com.apple.TextEdit" } });
  assert.equal(list?.windowId, null);
  assert.equal(list?.allowLabel, "允许本次观察");
});
