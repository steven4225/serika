import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ExecutionRunRecord, ExecutionToolRecord } from "../../shared/ui-contract.js";
import { runTimeline, durationLabel, usageLabel } from "./run-timeline.js";
import { RunTimeline, RecordsPanel } from "./records.js";
import { ZCodeTool } from "./ui-kit/conversation.js";
import { applyEvent, emptyLiveRun, overlayExecutionReceipts, type ToolRow } from "./conversation.js";

const at = (seconds: number) => `2026-10-08T01:00:${String(seconds).padStart(2, "0")}.000Z`;
const tool: ExecutionToolRecord = { toolCallId: "call", toolName: "write_file", status: "unknown", requestedAt: at(2), startedAt: at(4), finishedAt: null,
  inputPreview: '{"path":"note.md"}', inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: null, shell: null };
const run: ExecutionRunRecord = { runId: "run", threadId: "thread", phase: "primary", status: "interrupted", startedAt: at(0), finishedAt: at(9),
  resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [tool], trace: { version: 1, truncated: false, incomplete: false, events: [
    { type: "step.started", stepNumber: 1, sequence: 1, occurredAt: at(0) },
    { type: "model.retry.scheduled", stepNumber: 1, sequence: 2, occurredAt: at(1), nextAttempt: 2, maxAttempts: 3, delayMs: 250, errorCode: "MODEL_TIMEOUT" },
    { type: "step.completed", stepNumber: 1, sequence: 3, occurredAt: at(2), finishReason: "tool-calls", usage: { inputTokens: 10 } },
    { type: "tool.call.approval_required", sequence: 4, occurredAt: at(3), toolCallId: "call" },
    { type: "step.started", stepNumber: 2, sequence: 5, occurredAt: at(6) },
  ] } };
it("orders model, retry, approval and execution; unknown effects and unfinished steps never become completed", () => {
  const nodes = runTimeline(run);
  assert.deepEqual(nodes.map(n => n.id), ["start", "event-1", "event-2", "event-4", "tool-call", "event-5", "end"]);
  assert.equal(nodes[1]?.duration, "2.0 秒");
  assert.equal(nodes[3]?.duration, "1.0 秒");
  assert.equal(nodes[4]?.status, "需人工核对");
  assert.equal(nodes[4]?.duration, undefined);
  assert.equal(nodes[5]?.status, "结束未记录");
  assert.match(nodes[2]?.detail ?? "", /计划不证明/);
});
it("old records are truthful, and details are collapsed/escaped instead of a wall of JSON", () => {
  const { trace, ...legacy } = run;
  const html = renderToStaticMarkup(createElement(RunTimeline, { run: { ...legacy, tools: [{ ...tool, inputPreview: '<script>secret</script>' }] } }));
  assert.match(html, /旧记录未记录模型步骤/);
  assert.match(html, /需人工核对/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|details[^>]*open=/);
  assert.match(html, /中断时间为发现时间/);
});
it("missing usage is not zero, zero stays zero, and no provider cost is invented", () => {
  assert.match(usageLabel(), /输入 未报告/);
  assert.match(usageLabel({ inputTokens: 0 }), /输入 0/);
  assert.equal(durationLabel(at(1), at(0)), "耗时不可用");
  const html = renderToStaticMarkup(createElement(RunTimeline, { run: { ...run, trace: { ...run.trace!, truncated: true, incomplete: true } } }));
  assert.match(html, /追踪达到保留上限/);
  assert.match(html, /保存失败/);
  assert.match(html, /费用未记录/);
});
it("only Run-bound tool rows expose a trace link; repeated historical IDs are not mapped to the latest Run", () => {
  const live = applyEvent(emptyLiveRun, { type: "tool.call.requested", id: "e", sequence: 1, occurredAt: at(1), runId: "run", threadId: "thread", data: { toolCallId: "call", toolName: "write_file", input: {} } });
  const row = live.rows.find(row => row.kind === "tool")! as ToolRow;
  assert.equal(row.runId, "run");
  assert.match(renderToStaticMarkup(createElement(ZCodeTool, { row, onTrace: () => {} })), /查看本次执行追踪/);
  const { runId, ...historical } = row;
  assert.doesNotMatch(renderToStaticMarkup(createElement(ZCodeTool, { row: historical, onTrace: () => {} })), /查看本次执行追踪/);
  const rows = overlayExecutionReceipts([{ kind: "text", role: "user", key: "old", text: "old", committed: true }, historical,
    { kind: "text", role: "user", key: "new", text: "new", committed: true }, { ...historical, key: "new-tool" }], [tool], { reuseHistory: true, runId: "new-run" });
  assert.equal((rows[1] as ToolRow).runId, undefined);
  assert.equal((rows[3] as ToolRow).runId, "new-run");
});
it("completion correction and confirmation labels do not claim human quality acceptance", () => {
  const nodes = runTimeline({ ...run, status: "running", trace: { ...run.trace!, events: [{ type: "run.completion.checked", sequence: 1, occurredAt: at(1), decision: "continue", corrections: 1 }] } });
  assert.equal(nodes[1]?.status, "继续补齐证据");
  assert.match(nodes[1]?.detail ?? "", /人工质量审核分开/);
  assert.equal(nodes.at(-1)?.id, "tool-call");
});
it("actual Controller approval metadata adds a wait node; auto-approved tools do not", () => {
  const { trace, ...legacy } = run;
  assert.equal(runTimeline(legacy).some(node => node.id === "approval-call"), false);
  const nodes = runTimeline({ ...legacy, tools: [{ ...tool, approvalRequestedAt: at(3) }] });
  assert.equal(nodes.find(node => node.id === "approval-call")?.duration, "1.0 秒");
});
it("opening a Run replaces the list with its timeline and offers a clear return", () => {
  const html = renderToStaticMarkup(createElement(RecordsPanel, { records: { status: "ready", runs: [run] }, detail: { status: "ready", run }, onBack: () => {}, onOpen: () => {}, onRefresh: () => {} }));
  assert.match(html, /返回执行列表/);
  assert.match(html, /本轮执行时间线/);
  assert.doesNotMatch(html, /class="record-list"/);
});
it("a returned ok:false or nonzero Shell exit remains visibly failed in a collapsed node", () => {
  for (const receipt of [{ ...tool, status: "completed" as const, resultPreview: '{"ok":false}' },
    { ...tool, toolName: "shell_exec", status: "completed" as const, shell: { exitCode: 1, timedOut: false, cancelled: false } }]) {
    const node = runTimeline({ ...run, tools: [receipt] }).find(n => n.tool);
    assert.equal(node?.status, "返回失败结果");
    assert.equal(node?.tone, "fail");
  }
});
