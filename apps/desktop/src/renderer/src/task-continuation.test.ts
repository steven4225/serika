import { dirname } from "node:path";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkTask, WorkTaskContinuation } from "../../shared/work-tasks.js";
import type { ContextDiagnostics } from "@serika/assistant";
import { ContinuationSummary, taskRecoveryGuidance } from "./task-continuation.js";
import { TASK_TEMPLATES } from "./work-task-data.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { RuntimeBridge, TeeOutput } from "../../main/runtime-bridge.js";

const task = { id: "task", runIds: ["latest"] } as WorkTask;
const data: WorkTaskContinuation = { taskId: "task", revision: 2, receiptUnavailable: false, requiresReview: true,
  previousDelivery: { summary: "旧计划", artifactRefs: ["plan.md"], unresolved: ["来源尚未核验"], truncated: false },
  latestRun: { runId: "latest", status: "interrupted", conclusion: "已修改", conclusionTruncated: false,
    tools: [{ toolCallId: "edit", toolName: "edit_file", status: "unknown", path: "plan.md" }], toolsTruncated: false } };
const diagnostics = { latestValidCompaction: { id: "historical" },
  lastPreparationSource: { messageId: "user", workTaskId: "task", runId: "latest" },
  lastPreparation: { at: "now", outcome: "reused", compactionId: "historical", estimatedInputTokens: 2000, error: null },
} as ContextDiagnostics;
function render(value: ContextDiagnostics | null) {
  return renderToStaticMarkup(createElement(ContinuationSummary, { task, data, diagnostics: value, onRun: () => undefined }));
}

it("continuation separates unknown receipts, historical delivery and unresolved work", () => {
  const html = render(null);
  for (const text of ["效果未知", "不会自动重做", "来源尚未核验", "历史参考", "先读当前文件", "调用结束不等于业务成功"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /验收通过/);
});

it("shows actionable recovery reasons without treating a Run conclusion as acceptance", () => {
  const paused = { ...task, status: "paused" as const };
  const clean = { ...data, requiresReview: false, latestRun: { ...data.latestRun!, status: "completed" as const } };
  for (const [reason, text] of [["needs_confirmation", "未获允许"], ["needs_information", "补充缺失信息"],
    ["budget_exhausted", "预算"], ["needs_review", "不要直接重复执行"], ["delivered", "尚未确认交付"]] as const) {
    const value = { ...clean, latestRun: { ...clean.latestRun, completion: { reason, corrections: 1 } } };
    assert.ok(taskRecoveryGuidance(paused, value)?.includes(text));
    assert.match(taskRecoveryGuidance({ ...paused, status: "needs_review" }, value)!, /先核对实际效果/);
    assert.equal(taskRecoveryGuidance({ ...paused, status: "completed" }, value), null);
  }
  assert.match(taskRecoveryGuidance(paused, { ...clean, latestRun: { ...clean.latestRun, status: "interrupted" } })!, /没有自动续跑/);
  assert.match(taskRecoveryGuidance(paused, { ...clean, receiptUnavailable: true })!, /不要直接重复操作/);
});
it("compaction usage requires both latest Run and task binding, never merely a historical record", () => {
  assert.match(render(diagnostics), /复用了已有压缩记录/);
  for (const source of [null, { messageId: "user", workTaskId: "foreign", runId: "latest" }, { messageId: "user", workTaskId: "task", runId: "old" }]) {
    const html = render({ ...diagnostics, lastPreparationSource: source });
    assert.doesNotMatch(html, /复用了已有压缩记录/);
    assert.match(html, /不等于这轮已经使用/);
  }
  const html = render({ ...diagnostics, lastPreparation: { ...diagnostics.lastPreparation!, outcome: "failed", error: { code: "CONTEXT_LIMIT", message: "budget exceeded" } } });
  assert.match(html, /准备失败/);
  assert.match(html, /budget exceeded/);
  assert.doesNotMatch(html, /复用了已有压缩记录/);
});
it("maintenance template stays a draft with concrete quality requirements and no automatic recovery", () => {
  const template = TASK_TEMPLATES.maintain;
  assert.equal(template.draft.artifacts, "work-plan.md");
  assert.match(template.draft.constraints, /每轮先读当前材料/);
  assert.match(template.draft.constraints, /保留未要求修改/);
  assert.match(template.draft.human, /可追溯/);
  assert.match(template.draft.human, /完成条件/);
});

it("renders actual Controller/bridge preparation for the latest task Run, but not after restart or ordinary chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-continuation-panel-"));
  let bridge: RuntimeBridge | undefined;
  try {
    await mkdir(join(root, "workspace"));
    await mkdir(join(root, "transcripts"));
    await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, authorizedDirectories: [{ path: "./workspace", access: "readwrite" }], modules: {} }));
    const open = async () => {
      const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] }, { type: "text-start", id: "answer" },
        { type: "text-delta", id: "answer", delta: "等待另行验收。" }, { type: "text-end", id: "answer" },
        { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        } },
      ] }) }) });
      const output = new TeeOutput(() => undefined);
      const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(dirname(join(root, "config.json")), "workspace/.runloom"), threadId: "panel-thread", configPath: join(root, "config.json") }, modelAlias: "mock", model, output, env: {}, cwd: root });
      const controller = createAssistantController(app);
      output.attach(controller);
      return new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => undefined);
    };
    const waitIdle = async () => {
      const deadline = Date.now() + 8_000;
      while (bridge!.snapshot().state.kind !== "idle" && Date.now() < deadline) await delay(10);
      assert.equal(bridge!.snapshot().state.kind, "idle");
    };
    bridge = await open();
    const created = await bridge.createWorkTask({ goal: "讨论项目下一步", acceptance: [{ id: "human", description: "用户核对", method: "human", verification: { kind: "human" }, required: true }] });
    assert.ok(created.ok);
    assert.ok((await bridge.runWorkTask({ id: created.value.id, expectedRevision: created.value.revision })).ok);
    await waitIdle();
    const paused = await bridge.getWorkTask(created.value.id);
    assert.ok(paused.ok);
    const continuation = await bridge.getWorkTaskContinuation({ id: paused.value.id, expectedRevision: paused.value.revision });
    assert.ok(continuation.ok);
    const panel = async () => {
      const context = await bridge!.getContextDiagnostics();
      assert.ok(context.ok);
      return renderToStaticMarkup(createElement(ContinuationSummary, { task: paused.value, data: continuation.value, diagnostics: context.value, onRun: () => undefined }));
    };
    const html = await panel();
    assert.ok(html.includes(`Run ${paused.value.runIds.at(-1)}`));
    assert.match(html, /本次未使用摘要压缩/);
    assert.doesNotMatch(html, /没有与此任务最新 Run 对得上的准备结果/);
    await bridge.shutdown();
    bridge = await open();
    assert.match(await panel(), /没有与此任务最新 Run 对得上的准备结果/);
    assert.ok((await bridge.run("普通对话，不续做任务")).ok);
    await waitIdle();
    assert.match(await panel(), /没有与此任务最新 Run 对得上的准备结果/);
  } finally {
    await bridge?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
