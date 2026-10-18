import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppInfo } from "../../../shared/ui-contract.js";
import type { WorkTask } from "../../../shared/work-tasks.js";
import type { TaskListV3 } from "@serika/assistant";
import { TodayPanel, type TodayPanelProps } from "./today.js";
import { buildTodayBrief, inboxNotificationNote, nextBriefSlot, visibleBriefCards, type BriefContinueTarget, type TodayBriefFeeds, type TodayFeedInbox } from "./today-brief.js";
import { briefContinueTarget, planBriefContinue, readBriefContinue, writeBriefContinue, clearBriefContinue } from "./today-continue.js";
import { projectInboxFeeds, projectReminderFeeds } from "./today-feeds.js";
import type { AutomationOverview } from "@serika/assistant";
import { readAppSource } from "../../test-support/app-source.js";

const info = { threadId: "thread_abc12345", workTasks: true, memory: { enabled: true, autoConsolidate: true }, workspaceRoot: "/workspace" } as AppInfo;
const now = new Date("2026-10-08T01:00:00Z");
const offFeeds: TodayBriefFeeds = { reminders: [], remindersState: "ready", inbox: [], inboxState: "ready", worker: { ok: true, registered: false, running: false, rssEnabled: false }, workerState: "ready" };
const task = (status: WorkTask["status"], goal = `任务 ${status}`, updatedAt = "2026-10-08T00:30:00.000Z"): WorkTask => ({
  id: `task_abc12345-${status}`, revision: 1, threadId: "thread_abc12345", goal, constraints: [], acceptance: [], status, runIds: ["run_abc12345"], delivery: null, reconciliations: [], createdAt: updatedAt, updatedAt,
});
const noop = () => undefined;

it("viewed terminal reminders stay in history, not in the current brief or upcoming arrangements", () => {
  const item = { id: "done", promptPreview: "睡觉", runAt: now.toISOString(), status: "completed", finishedAt: now.toISOString(), resultPreview: "该睡觉了", acknowledgedAt: null, error: null };
  const list = { tasks: [item], truncated: false } as TaskListV3;
  assert.deepEqual(projectInboxFeeds(list, now, () => true), []);
  assert.equal(list.tasks[0]?.acknowledgedAt, null);
  assert.deepEqual(projectReminderFeeds({ scheduled: [item], recurring: [] } as unknown as AutomationOverview, now), []);
});
function render(overrides: Partial<TodayPanelProps> = {}) {
  return renderToStaticMarkup(createElement(TodayPanel, {
    info, tasks: [], tasksLoading: false, tasksError: null,
    feeds: offFeeds, now, onContinue: noop, onPomodoro: noop, onAutomation: noop, ...overrides,
  }));
}
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("today brief stream", () => {
  it("splits morning and evening sections and keeps the summary to three cards", () => {
    const inbox: TodayFeedInbox[] = ["备份对话框", "移动端确认", "模型测试", "真机通道"].map(subject => ({
      eyebrow: "定时结果", subject, at: "2026-10-08T00:20:00.000Z", status: "执行中断，结果未确定", attention: true, notification: null,
    }));
    const model = buildTodayBrief({
      now, info, tasks: [task("needs_review", "周末交付的成本说明"), task("paused", "长对话分页")], tasksLoading: false, tasksError: null,
     
      feeds: { ...offFeeds, worker: { ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true }, reminders: [{ eyebrow: "提醒", subject: "喝水", whenLabel: "今天 20:30", at: "2026-10-08T12:30:00.000Z", status: "已设好，到点提醒" }], inbox },
    });
    assert.equal(model.mode, "stream");
    assert.deepEqual(model.sections.map(section => section.name), ["晚间简报", "晨间简报"]);
    const morning = model.sections.find(section => section.name === "晨间简报");
    assert.ok(morning && morning.cards.length > 3);
    assert.equal(visibleBriefCards(morning.cards, false).length, 3);
    assert.equal(visibleBriefCards(morning.cards, true).length, morning.cards.length);
    const html = render({ tasks: [task("needs_review", "周末交付的成本说明"), task("paused", "长对话分页")], feeds: { ...offFeeds, worker: { ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true }, reminders: [{ eyebrow: "提醒", subject: "喝水", whenLabel: "今天 20:30", at: "2026-10-08T12:30:00.000Z", status: "已设好，到点提醒" }], inbox } });
    assert.match(html, /晨间简报/);
    assert.match(html, /晚间简报/);
    assert.match(html, /展开更多/);
    assert.match(html, /周末交付的成本说明/);
    assert.doesNotMatch(html, /真机通道/);
    assert.doesNotMatch(html, /已提醒到你|通知已送达|提醒已送达/);
    assert.doesNotMatch(html, /task_abc12345|thread_abc12345|run_abc12345|mem_/);
  });

  it("routes progress and direction choices back to the existing thread or task", () => {
    const tasks = [task("paused", "长对话分页"), task("needs_review", "周末交付的成本说明", "2026-10-08T00:10:00.000Z")];
    const model = buildTodayBrief({ now, info, tasks, tasksLoading: false, tasksError: null, feeds: { ...offFeeds, worker: { ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true }, workerState: "ready" } });
    const cards = model.sections.flatMap(section => section.cards);
    const progress = cards.flatMap(card => card.actions).find(action => action.label === "查看进度");
    const review = cards.find(card => card.eyebrow === "待确认");
    assert.equal(progress?.target.compose, true);
    assert.equal(progress?.target.kind, "task");
    assert.equal(progress?.target.taskId, "task_abc12345-paused");
    assert.equal(progress?.target.threadId, "thread_abc12345");
    assert.deepEqual(review?.actions.map(action => action.label), ["先核对效果", "先讲情况"]);
    const direction = review?.actions[0]?.target;
    assert.equal(direction?.compose, false);
    assert.match(direction?.draft ?? "", /不要自动重做/);
    assert.equal(planBriefContinue(progress!.target).composerTaskId, "task_abc12345-paused");
    assert.equal(planBriefContinue(progress!.target).ordinaryDraft, null);
    const chatPlan = planBriefContinue(direction!);
    assert.equal(chatPlan.composerTaskId, null);
    assert.match(chatPlan.ordinaryDraft ?? "", /不要自动重做/);
    assert.equal(chatPlan.closeDashboard, true);
    const html = render({ tasks, feeds: { ...offFeeds, worker: { ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true } } });
    assert.match(html, /查看进度/);
    assert.match(html, /先核对效果/);
    assert.match(html, /效果待核对/);
    assert.doesNotMatch(html, /task_abc12345|thread_abc12345|run_abc12345/);
  });

  it("shows the next brief without background diagnostics when no arrangements exist", () => {
    const afternoon = new Date("2026-10-08T06:00:00Z");
    assert.deepEqual(nextBriefSlot(afternoon), { when: "今天 20:00", name: "晚间简报" });
    assert.deepEqual(nextBriefSlot(new Date("2026-10-08T16:30:00Z")), { when: "今天 8:00", name: "晨间简报" });
    const html = render({ now: afternoon, feeds: { ...offFeeds, worker: { ok: false, message: "pid 4242 thread_abc12345" } } });
    assert.match(html, /今天 20:00/);
    assert.match(html, /晚间简报/);
    assert.doesNotMatch(html, /后台状态读取失败|today-background-notice/);
    assert.match(html, /还没有工作任务/);
    assert.doesNotMatch(html, /聊聊这个/);
    assert.doesNotMatch(html, /4242|thread_abc12345|task_|run_|mem_|pid/);
    assert.doesNotMatch(html, /today-task-counts/);
  });

  it("shows a compact settings notice only when saved arrangements need attention", () => {
    const reminders = [{ eyebrow: "提醒", subject: "喝水", whenLabel: "今天 20:30", at: "2026-10-08T12:30:00.000Z", status: "已设好，到点提醒" }];
    const html = render({ onBackgroundSettings: noop, feeds: { ...offFeeds, reminders, worker: { ok: false, message: "pid 4242 thread_abc12345" } } });
    assert.match(html, /<aside class="today-background-notice"/);
    assert.match(html, /暂时无法确认已设安排能否按时执行/);
    assert.match(html, /查看设置/);
    assert.doesNotMatch(html.match(/<aside[^>]*>[\s\S]*?<\/aside>/)?.[0] ?? "", /聊聊这个/);
    assert.doesNotMatch(html, /后台状态读取失败|服务已停止|pid 4242|thread_abc12345/);
    const healthy = render({ feeds: { ...offFeeds, reminders, worker: { ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true } } });
    assert.doesNotMatch(healthy, /today-background-notice/);
  });

  it("keeps foreground omission distinct from a submitted notification", () => {
    assert.notEqual(inboxNotificationNote("omitted"), inboxNotificationNote("submitted"));
    assert.match(inboxNotificationNote("omitted") ?? "", /没有向系统提交/);
    assert.doesNotMatch(inboxNotificationNote("omitted") ?? "", /已提交系统通知/);
    assert.match(inboxNotificationNote("submitted") ?? "", /已提交系统通知，不代表你已经看到/);
    assert.doesNotMatch(`${inboxNotificationNote("omitted")}${inboxNotificationNote("submitted")}`, /已经送达/);
    const card = (notification: TodayFeedInbox["notification"]) => render({
      tasks: [task("paused", "长对话分页")],
      feeds: { ...offFeeds, worker: { ok: true, registered: true, running: true, rssEnabled: true, notifyEnabled: true, notificationRoutingEnabled: true }, inbox: [{ eyebrow: "提醒", subject: "喝水", at: "2026-10-08T00:20:00.000Z", status: "执行结束", attention: false, notification }] },
    });
    const omitted = card("omitted");
    const submitted = card("submitted");
    assert.match(omitted, /没有向系统提交/);
    assert.match(submitted, /已提交系统通知/);
    assert.notEqual(omitted.includes("没有向系统提交"), submitted.includes("没有向系统提交"));
    const projected = projectInboxFeeds({ tasks: [{ id: "task_abc12345", promptPreview: "task_abc12345 喝水", runAt: "2026-10-08T00:20:00.000Z", status: "failed", finishedAt: "2026-10-08T00:20:00.000Z", resultPreview: null, error: null, acknowledgedAt: null }], truncated: false } as TaskListV3, now);
    assert.equal(projected[0]?.notification, null);
    assert.equal(projected[0]?.subject, "喝水");
    assert.equal(projected[0]?.attention, true);
  });

  it("does not draw zero task counts while connecting, loading, disabled or failed", () => {
    for (const [overrides, text] of [
      [{ info: null }, "正在连接工作区"],
      [{ info: { ...info, workTasks: false } }, "工作任务未启用"],
      [{ tasksLoading: true }, "正在读取当前会话的任务"],
      [{ tasksError: "WORK_TASK_FILE_INVALID: 任务文件损坏", tasks: [task("completed", "已完成的事")] }, "任务文件损坏"],
    ] as const) {
      const html = render(overrides);
      assert.match(html, new RegExp(text));
      assert.doesNotMatch(html, /today-task-counts|还没有工作任务/);
    }
  });

  it("stores a continuation without accepting a run instruction", () => {
    const target: BriefContinueTarget = { kind: "thread", threadId: "thread_abc12345", taskId: null, compose: false, draft: "先核对效果" };
    const box = storage();
    writeBriefContinue(box, target);
    assert.deepEqual(readBriefContinue(box), target);
    clearBriefContinue(box);
    assert.equal(readBriefContinue(box), null);
    assert.equal(briefContinueTarget({ kind: "thread", threadId: "thread_abc12345", taskId: null, compose: true, draft: "no" }), null);
    assert.equal(briefContinueTarget({ kind: "task", threadId: "thread_abc12345", taskId: null, compose: true, draft: "" }), null);
    assert.equal(planBriefContinue({ kind: "task", threadId: "thread_abc12345", taskId: "task_abc12345-running", compose: false, draft: "" }).composerTaskId, undefined);
  });
});

it("brief continuation focuses chat and does not start a run", async () => {
  const app = await readAppSource();
  const body = app.slice(app.indexOf("const continueBrief"), app.indexOf("const scrollToLatest"));
  assert.match(body, /writeBriefContinue/);
  assert.doesNotMatch(body, /runWorkTask|window\.runloom\.run\(/);
  const effect = app.slice(app.indexOf("const pending = readBriefContinue"), app.indexOf("workTasks.draftReady, workTasks.task"));
  assert.doesNotMatch(effect, /runWorkTask|window\.runloom\.run\(/);
});
