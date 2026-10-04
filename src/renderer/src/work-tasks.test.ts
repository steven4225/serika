import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkTask } from "../../shared/work-tasks.js";
import { WorkTasksPanel, CurrentTask, type WorkTaskView } from "./work-tasks.js";

const baseTask: WorkTask = { id: "task", revision: 3, threadId: "thread", goal: "写计划", constraints: [], acceptance: [{ id: "human", description: "可执行", method: "human", verification: { kind: "human" }, required: true, status: "not_run", evidenceRefs: [], note: null }], status: "paused", runIds: ["run"], delivery: null, reconciliations: [], createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" };
const noChange = async () => false;
function view(task: WorkTask | null, overrides: Partial<WorkTaskView> = {}): WorkTaskView {
  return { tasks: task ? [task] : [], task, enabled: true, loading: false, error: null, notice: null, locked: false, acting: false, instruction: "", setInstruction: () => undefined, select: () => undefined, reread: () => undefined, create: noChange, run: noChange, deliver: noChange, accept: noChange, reconcile: noChange, cancel: noChange, rework: noChange, ...overrides };
}
function panel(state: WorkTaskView) { return renderToStaticMarkup(createElement(WorkTasksPanel, { view: state, onRun: () => undefined })); }

describe("work task controls", () => {
  it("renders the retained instruction after a task revision changes and exposes start-in-flight", () => {
    const instruction = "保留旧章节，只修改 Next";
    for (const revision of [3, 4]) {
      assert.match(panel(view({ ...baseTask, revision }, { instruction })), /保留旧章节，只修改 Next/);
    }
    assert.match(panel(view(baseTask, { instruction, acting: true, locked: true })), /aria-label="本轮任务指令" disabled=""/);
  });
  it("offers explicit rework only at acceptance and labels the retained delivery as historical", () => {
    const delivery = { summary: "上轮计划", artifactRefs: [], evidence: [], unresolved: [] };
    assert.match(panel(view({ ...baseTask, status: "awaiting_acceptance", delivery })), /退回修改…/);
    const paused = panel(view({ ...baseTask, delivery }));
    assert.match(paused, /上次交付（已退回，需重新提交）/);
    assert.match(paused, /沿用上次交付作为草稿/);
    assert.doesNotMatch(paused, /通过此项|退回修改…/);
    for (const status of ["completed", "cancelled", "needs_review", "running"] as const) {
      assert.doesNotMatch(panel(view({ ...baseTask, status, delivery })), /退回修改…/);
    }
  });
  it("a paused Run offers a separate next Run and delivery, not completion", () => {
    const html = panel(view(baseTask));
    assert.match(html, /开始下一轮/);
    assert.match(html, /提交交付，核验自动项/);
    assert.doesNotMatch(html, /通过此项/);
    assert.doesNotMatch(html, /task-completed/);
    assert.match(html, /取消此任务/);
  });
  it("unknown recovery exposes reconciliation but neither execution nor ordinary cancellation", () => {
    const html = panel(view({ ...baseTask, status: "needs_review" }));
    assert.match(html, /阅读最新回执/);
    assert.match(html, /仍然不确定时不能继续/);
    assert.match(html, /记录核对并取消/);
    assert.doesNotMatch(html, /取消此任务/);
    assert.doesNotMatch(html, /<button[^>]*>开始下一轮<\/button>/);
    assert.doesNotMatch(html, /提交交付，核验自动项/);
    // Both report buttons remain disabled until the receipt was inspected and a note entered.
    assert.match(html, /disabled="">记录核对，回到暂停/);
    assert.match(html, /disabled="">记录核对并取消/);
  });
  it("only a submitted delivery offers human acceptance and loading/error locks changes", () => {
    const task = { ...baseTask, status: "awaiting_acceptance" as const, delivery: { summary: "计划", artifactRefs: [], evidence: [], unresolved: [] } };
    const html = panel(view(task, { locked: true, loading: true, error: "文件坏了" }));
    assert.match(html, /disabled="">通过此项/);
    assert.match(html, /disabled="">此项未通过/);
    assert.match(html, /旧内容，操作已停用/);
    assert.match(html, /重置验收并提交/);
  });
  it("unavailable and empty task lists are not conflated, and chat shows a compact task summary", () => {
    assert.match(panel(view(null)), /还没有工作任务/);
    const error = panel(view(null, { error: "读取失败", locked: true }));
    assert.match(error, /读取失败/);
    assert.doesNotMatch(error, /还没有工作任务/);
    const current = renderToStaticMarkup(createElement(CurrentTask, { view: view(baseTask), onOpen: () => undefined }));
    assert.match(current, /写计划/);
    assert.match(current, /本轮结束 · 未验收/);
    assert.match(current, /检查产物并交付/);
    assert.doesNotMatch(current, /通过此项/);
  });
});
