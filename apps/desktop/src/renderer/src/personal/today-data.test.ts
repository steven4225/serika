import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { todayClock, todayMemorySummary, todayTaskSummary } from "./today-data.js";
import { TodayPanel, type TodayPanelProps } from "./today.js";

const info = { threadId: "current", workTasks: true, memory: { enabled: true, autoConsolidate: true } } as AppInfo;
const task = (status: WorkTask["status"]): WorkTask => ({ id: status, revision: 1, threadId: "thread", goal: `任务 ${status}`, constraints: [], acceptance: [], status, runIds: [], delivery: null, reconciliations: [], createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z" });
const noop = () => undefined;
function render(overrides: Partial<TodayPanelProps> = {}) {
  return renderToStaticMarkup(createElement(TodayPanel, { info, tasks: [], tasksLoading: false, tasksError: null, pendingMemory: 0, pendingMemoryError: null,
    now: new Date("2026-10-08T06:00:00Z"), onContinue: noop, onPomodoro: noop, onAutomation: noop, ...overrides }));
}

describe("personal Today view", () => {
  it("uses Shanghai date at midnight rather than the host timezone and chooses time-aware greetings", () => {
    assert.deepEqual(todayClock(new Date("2026-10-08T16:01:00Z")), { time: "00:01", date: "10月9日星期五", greeting: "夜深了" });
    assert.equal(todayClock(new Date("2026-10-08T00:00:00Z")).greeting, "早上好");
    assert.equal(todayClock(new Date("2026-10-08T06:00:00Z")).greeting, "下午好");
    assert.equal(todayClock(new Date("2026-10-08T12:00:00Z")).greeting, "晚上好");
  });
  it("projects only supplied tasks and preserves unknown and pending acceptance rather than claiming success", () => {
    const tasks = ["ready", "running", "paused", "needs_review", "awaiting_acceptance", "completed", "cancelled"].map(status => task(status as WorkTask["status"]));
    const summary = todayTaskSummary(info, tasks, false, null);
    assert.equal(summary.state, "ready");
    if (summary.state !== "ready") return;
    assert.deepEqual([summary.ongoing, summary.awaiting, summary.completed], [3, 2, 1]);
    assert.equal(summary.current?.status, "needs_review");
    assert.equal(summary.currentStatus, "效果待核对");
    assert.equal(tasks[3]!.status, "needs_review");
    const html = render({ tasks });
    assert.match(html, /仅当前会话已加载的任务/);
    assert.match(html, /效果待核对/);
    assert.doesNotMatch(html, /今日完成|所有任务|重新执行|全部成功/);
  });
  it("distinguishes connecting, disabled, loading and failure without drawing zero counts", () => {
    for (const [overrides, text] of [
      [{ info: null }, "正在连接工作区"],
      [{ info: { ...info, workTasks: false } }, "工作任务未启用"],
      [{ tasksLoading: true }, "正在读取当前会话的任务"],
      [{ tasksError: "任务文件损坏", tasks: [task("completed")] }, "任务文件损坏"],
    ] as const) {
      const html = render(overrides);
      assert.match(html, new RegExp(text));
      assert.doesNotMatch(html, /today-task-counts|还没有工作任务/);
    }
    assert.match(render(), /还没有工作任务/);
    assert.match(render({ tasks: [task("completed")] }), /当前没有待推进的任务/);
  });
  it("keeps a chat action and real memory states, without fabricated weather or research", () => {
    const html = render({ pendingMemory: 2 });
    assert.match(html, /class="today-chat-button"/);
    assert.match(html, /当前会话有 2 条记忆等你确认/);
    assert.match(html, /查看我的提醒|打开番茄钟/);
    assert.doesNotMatch(html, /天气|研究结果|ryan|自动开始/);
    assert.equal(todayMemorySummary(null, 0, null), "正在连接记忆…");
    assert.equal(todayMemorySummary({ ...info, memory: { enabled: false, autoConsolidate: false } }, 0, null), "记忆未启用。");
    assert.match(todayMemorySummary(info, 0, "坏文件"), /读取失败：坏文件/);
    assert.doesNotMatch(render({ pendingMemoryError: "坏文件" }), /查看已保存的信息/);
  });
});
