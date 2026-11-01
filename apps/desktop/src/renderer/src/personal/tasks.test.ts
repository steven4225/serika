import { readAppSource } from "../../test-support/app-source.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { presentReminderConfirmation, presentReminderReply } from "../reminder-copy.js";
import { TasksPage, type TasksPageProps } from "./tasks-page.js";
import {
  SCHEDULE_TEMPLATES,
  TASK_CREATE_PROMPT,
  groupTaskRows,
  inboxReturnTitle,
  nextComposerText,
  nextTaskInstruction,
  planScheduleContinueHandoff,
  planTaskContinueHandoff,
  planTaskCreateHandoff,
  planTaskFollowUpHandoff,
  returnedTaskSource,
  scheduledTaskRows,
  settledReminderRows,
  taskDayBucket,
  taskReturnLabel,
  workTaskRows,
} from "./tasks-model.js";

const now = new Date(2026, 9, 12, 15, 0, 0);
const at = (monthDay: number, hour = 10, minute = 30) => new Date(2026, 9, monthDay, hour, minute, 0).toISOString();
const task = (id: string, goal: string, day: number, phase: "paused" | "awaiting_acceptance" | "needs_review" | "ready" | "running" | "completed" | "cancelled" = "paused"): WorkTask => ({
  id, revision: 1, threadId: "thread_hidden_alpha", goal, constraints: [], acceptance: [], kind: "work",
  status: phase === "running" || phase === "completed" || phase === "cancelled" ? phase : "pending",
  effectReviewRequired: phase === "needs_review", acceptanceOpen: phase === "awaiting_acceptance",
  runIds: phase === "ready" ? [] : ["run"], delivery: null, reconciliations: [], createdAt: at(day), updatedAt: at(day),
});
const noop = () => {};
const page = (overrides: Partial<TasksPageProps> = {}) => renderToStaticMarkup(createElement(TasksPage, {
  tasksEnabled: true,
  tasks: [],
  openedTask: null,
  loading: false,
  error: null,
  busy: false,
  now,
  segment: "tasks",
  reminders: [],
  reminderOther: 0,
  remindersLoading: false,
  remindersError: "",
  openedReminder: null,
  pendingCancel: null,
  onSegment: noop,
  onOpenTask: noop,
  onOpenReminder: noop,
  onBack: noop,
  onCreate: noop,
  onContinue: noop,
  onCancelReminder: noop,
  onConfirmCancel: noop,
  onDismissCancel: noop,
  onOpenSettings: noop,
  advanced: null,
  ...overrides,
}));

describe("task day buckets", () => {
  it("keeps 今天, 昨天 and 近 7 天 exclusive and local", () => {
    assert.equal(taskDayBucket(at(12, 9), now), "今天");
    assert.equal(taskDayBucket(at(11, 23), now), "昨天");
    assert.equal(taskDayBucket(at(10, 8), now), "近 7 天");
    assert.equal(taskDayBucket(at(6, 8), now), "近 7 天");
    assert.equal(taskDayBucket(at(5, 8), now), "更早");
    assert.equal(taskDayBucket(at(13, 9), now), "即将");
    assert.equal(taskDayBucket("not-a-time", now), "时间未定");
    const groups = groupTaskRows([
      { title: "更早的研究", at: at(5) },
      { title: "三线关联分析", at: at(9) },
      { title: "起床提醒", at: at(11) },
      { title: "今天的说明", at: at(12, 8) },
    ], now);
    assert.deepEqual(groups.map(group => group.bucket), ["今天", "昨天", "近 7 天", "更早"]);
    assert.equal(groups[1]?.items[0]?.title, "起床提醒");
  });
});

describe("tasks page", () => {
  it("shows 效果待核对 on the task list and blocks a start affordance", () => {
    const review = task("task_hidden_review", "核对这次写入", 12, "needs_review");
    const list = page({ tasks: [review] });
    assert.match(list, /class="task-review"[^>]*role="status"/);
    assert.match(list, /效果待核对/);
    assert.doesNotMatch(list, /开始执行|开始任务|取消此任务/);
    const opened = page({ tasks: [review], openedTask: review });
    assert.match(opened, /task-thread-meta task-review/);
    assert.match(opened, /效果待核对/);
    assert.match(opened, /不会自动重做/);
    assert.doesNotMatch(opened, /开始执行|开始任务/);
  });

  it("shows a saved reminder result on the scheduled task entry", () => {
    const clock = { now, timeZone: "Asia/Shanghai" };
    const rows = settledReminderRows([{
      id: "task_hidden_review_reminder", promptPreview: "复核这份改动", resultPreview: "复核这份改动",
      status: "completed", runAt: at(12, 16), arrangement: { kind: "reminder" },
    }], clock);
    assert.equal(rows[0]?.resultText, "复核这份改动");
    assert.equal(rows[0]?.canCancel, false);
    const html = page({ segment: "scheduled", reminders: rows, openedReminder: rows[0] });
    assert.match(html, /aria-label="提醒结果"/);
    assert.match(html, /复核这份改动/);
    assert.match(html, /标为已读不改变这条结果/);
    assert.match(html, /<summary>编号<\/summary><code>task_hidden_review_reminder<\/code>/);
  });

  it("shows the segmented control, human rows, and no engineering ids", () => {
    const html = page({ tasks: [
      task("task_hidden_wake", "起床提醒", 11),
      task("task_hidden_research", "三线关联分析：agent-memory-map × Serika PR #113 × pi-learn", 9),
      task("task_hidden_blank", "task_hidden_blank", 12),
    ] });
    assert.match(html, /role="tablist"/);
    assert.match(html, /aria-selected="true"[^>]*>任务/);
    assert.match(html, /aria-selected="false"[^>]*>.*?定时任务/);
    assert.match(html, /＋ 创建任务/);
    assert.match(html, /昨天/);
    assert.match(html, /近 7 天/);
    assert.match(html, /起床提醒/);
    assert.match(html, /三线关联分析：agent-memory-map × Serika PR #113 × pi-learn/);
    assert.match(html, /未命名任务/);
    assert.doesNotMatch(html, /task_|thread_/);
    assert.doesNotMatch(html, /任务目标|创建任务，不执行|<textarea/);
  });

  it("switches the scheduled segment to templates instead of a blank page", () => {
    const html = page({ segment: "scheduled" });
    assert.match(html, /aria-selected="true"[^>]*>[\s\S]*?定时任务/);
    assert.match(html, /为你推荐/);
    for (const template of SCHEDULE_TEMPLATES) {
      assert.match(html, new RegExp(template.title));
      assert.match(html, new RegExp(`aria-label="用「${template.title}」开始"`));
    }
    assert.match(html, /task-template-add/);
    assert.doesNotMatch(html, /task_|thread_|已定|已记下/);
    assert.doesNotMatch(page({ segment: "tasks" }), /为你推荐/);
  });

  it("keeps a saved reminder on the scheduled list and its id in the detail only", () => {
    const clock = { now, timeZone: "Asia/Shanghai" };
    const view = scheduledTaskRows({
      scheduled: [{ id: "task_hidden_water", promptPreview: "喝水", status: "pending", runAt: at(12, 20), arrangement: { kind: "reminder" } }],
      recurring: [],
    }, clock);
    const row = view.rows[0];
    assert.ok(row);
    assert.equal(row.title, "喝水");
    const list = page({ segment: "scheduled", reminders: view.rows });
    assert.match(list, /喝水/);
    assert.doesNotMatch(list, /task_hidden_water|为你推荐/);
    const detail = page({ segment: "scheduled", reminders: view.rows, openedReminder: row });
    assert.match(detail, /<summary>编号<\/summary><code>task_hidden_water<\/code>/);
    assert.match(detail, /和 Serika 聊这件提醒/);
    assert.match(detail, /取消提醒/);
    assert.match(detail, /已经提醒到你/);
    assert.doesNotMatch(detail, /已定|已记下/);
  });

  it("shows a cancel failure on the open detail and keeps the list warning", () => {
    const clock = { now, timeZone: "Asia/Shanghai" };
    const view = scheduledTaskRows({
      scheduled: [{ id: "task_hidden_water", promptPreview: "喝水", status: "pending", runAt: at(12, 20), arrangement: { kind: "reminder" } }],
      recurring: [],
    }, clock);
    const row = view.rows[0];
    assert.ok(row);
    const message = "取消结果未确认，请刷新核对；不会自动重试。";
    const detail = page({ segment: "scheduled", reminders: view.rows, openedReminder: row, pendingCancel: row, remindersError: message });
    assert.match(detail, /取消结果未确认，请刷新核对/);
    assert.match(detail, /请回到列表重新读取并核对这项安排是否还在/);
    assert.match(detail, /不会自动重试/);
    assert.match(detail, /确认取消/);
    assert.doesNotMatch(detail, /task-group/);
    const list = page({ segment: "scheduled", reminders: view.rows, remindersError: message });
    assert.match(list, /取消结果未确认/);
    assert.match(list, /读取失败不代表没有提醒/);
  });

  it("opens non-reminder schedules in 定时任务 instead of hiding them behind 设置", () => {
    const clock = { now, timeZone: "Asia/Shanghai" };
    const view = scheduledTaskRows({
      scheduled: [
        { id: "task_hidden_water", promptPreview: "喝水", status: "pending", runAt: at(12, 20), arrangement: { kind: "reminder" } },
        { id: "task_hidden_digest", promptPreview: "邮件今日速览", status: "pending", runAt: at(12, 21), arrangement: { kind: "todoist-brief" } },
      ],
      recurring: [{
        id: "task_hidden_rss",
        promptPreview: "订阅摘要",
        status: "active",
        nextRunAt: at(13, 8),
        recurrence: { kind: "daily", time: "08:00", utcOffset: "+08:00" },
        arrangement: { kind: "rss-digest" },
      }],
    }, clock);
    assert.equal(view.other, 0);
    assert.deepEqual(view.rows.map(row => row.title), ["喝水", "邮件今日速览", "订阅摘要"]);
    const digest = view.rows.find(row => row.id === "task_hidden_digest");
    const rss = view.rows.find(row => row.id === "task_hidden_rss");
    assert.equal(digest?.family, "schedule");
    assert.equal(digest?.kindLabel, "Todoist 日报");
    assert.equal(rss?.family, "schedule");
    assert.equal(rss?.kindLabel, "RSS 资讯");
    const list = page({ segment: "scheduled", reminders: view.rows, reminderOther: view.other });
    assert.match(list, /邮件今日速览/);
    assert.match(list, /Todoist 日报/);
    assert.match(list, /订阅摘要/);
    assert.match(list, /RSS 资讯/);
    assert.doesNotMatch(list, /另有/);
    assert.ok(digest);
    const detail = page({ segment: "scheduled", reminders: view.rows, openedReminder: digest });
    assert.match(detail, /邮件今日速览/);
    assert.match(detail, /<summary>编号<\/summary><code>task_hidden_digest<\/code>/);
    assert.match(detail, /取消这项安排/);
    assert.match(detail, /和 Serika 聊这项安排/);
    assert.doesNotMatch(detail, /已经提醒到你|另有/);
  });

  it("opens a task as a thread with artifacts, continue input, and the id only under 编号", () => {
    const item = task("task_hidden_wake", "起床提醒", 11, "awaiting_acceptance");
    item.delivery = { summary: "起床啦。先喝口水，慢慢坐起来。", artifactRefs: ["notes/morning.md"], evidence: [], unresolved: [] };
    item.acceptance = [{ id: "file", description: "留下说明", method: "automatic", verification: { kind: "artifact_exists", path: "notes/morning.md", requireReadback: true }, required: true, status: "passed", evidenceRefs: [], note: null }];
    const html = page({ tasks: [item], openedTask: item, advanced: "保留验收" });
    assert.match(html, /起床提醒/);
    assert.match(html, /notes\/morning\.md/);
    assert.match(html, /aria-label="和 Serika 聊这件任务"/);
    assert.match(html, /<summary>编号<\/summary><code>task_hidden_wake<\/code>/);
    assert.doesNotMatch(html, /thread_hidden_alpha/);
    assert.match(html, /<summary>验收与核对<\/summary>保留验收/);
    const handoff = planTaskContinueHandoff(item, "");
    assert.equal(handoff.mode, "chat");
    assert.equal(planTaskContinueHandoff({ ...item, status: "pending", acceptanceOpen: false, effectReviewRequired: false }, "继续写完").mode, "task");
  });
});

describe("conversational create and return chip", () => {
  it("fills an empty composer and leaves an existing draft untouched", () => {
    const handoff = planTaskCreateHandoff();
    assert.equal(handoff.mode, "chat");
    assert.equal(handoff.policy, "fill");
    assert.equal(nextComposerText("", handoff), "");
    assert.equal(nextComposerText("已经在写", handoff), "已经在写");
    assert.doesNotMatch(TASK_CREATE_PROMPT, /已定|已记下/);
    for (const template of SCHEDULE_TEMPLATES) assert.doesNotMatch(`${template.prompt} ${template.blurb}`, /已定|已记下/);
  });

  it("keeps an unsent draft when 继续追问 or a task supplement would otherwise replace it", () => {
    const source = returnedTaskSource({
      id: "task_hidden_left",
      status: "completed",
      prompt: "项目周报",
      resultText: "结论是通过",
      runAt: at(12),
    }, now);
    const followUp = planTaskFollowUpHandoff(source);
    assert.equal(followUp.policy, "fill");
    assert.equal(nextComposerText("未发送的草稿", followUp), "未发送的草稿");
    assert.equal(nextComposerText("", followUp), followUp.text);
    assert.match(followUp.text, /结论是通过/);
    const runnable = task("task_hidden_wake", "起床提醒", 11, "paused");
    const supplement = planTaskContinueHandoff(runnable, "");
    assert.equal(supplement.mode, "task");
    assert.equal(supplement.policy, "fill");
    assert.equal(nextTaskInstruction("先补这一段", supplement), null);
    assert.equal(nextTaskInstruction("", supplement), supplement.text);
    const reminder = planScheduleContinueHandoff({ title: "喝水", family: "reminder" }, "");
    assert.equal(reminder.policy, "fill");
    assert.equal(nextComposerText("提醒草稿还在", reminder), "提醒草稿还在");
  });

  it("keeps two same-prefix results distinguishable when continuing", () => {
    const head = "项目周报".repeat(12);
    const left = returnedTaskSource({
      id: "task_hidden_left",
      status: "completed",
      prompt: "项目周报",
      resultText: `${head}结论是通过`,
      runAt: at(12),
      arrangement: { kind: "rss-digest" },
    }, now);
    const right = returnedTaskSource({
      id: "task_hidden_right",
      status: "completed",
      prompt: "项目周报",
      resultText: `${head}结论是退回`,
      runAt: at(12),
      arrangement: { kind: "rss-digest" },
    }, now);
    assert.equal(inboxReturnTitle(left), inboxReturnTitle(right));
    const chip = taskReturnLabel(inboxReturnTitle(left));
    assert.match(chip, /继续追问/);
    assert.doesNotMatch(chip, /task_hidden|结论是通过|结论是退回/);
    const a = planTaskFollowUpHandoff(left);
    const b = planTaskFollowUpHandoff(right);
    assert.equal(a.mode, "chat");
    assert.equal(a.taskId, null);
    assert.equal(b.taskId, null);
    assert.notEqual(a.text, b.text);
    assert.match(a.text, /task_hidden_left/);
    assert.match(b.text, /task_hidden_right/);
    assert.match(a.text, /结论是通过/);
    assert.match(b.text, /结论是退回/);
    assert.match(a.text, /实际状态：completed/);
    assert.match(b.text, /实际状态：completed/);
    const failed = returnedTaskSource({
      id: "task_hidden_failed",
      status: "failed",
      prompt: "喝水",
      resultText: "已定：喝水",
      error: { message: "没有发出" },
      runAt: at(12),
      arrangement: { kind: "reminder" },
    }, now);
    assert.equal(inboxReturnTitle(failed), "喝水");
    assert.doesNotMatch(taskReturnLabel(inboxReturnTitle(failed)), /已定/);
    const failedHandoff = planTaskFollowUpHandoff(failed);
    assert.match(failedHandoff.text, /task_hidden_failed/);
    assert.match(failedHandoff.text, /实际状态：failed/);
    assert.match(failedHandoff.text, /没有发出/);
    assert.match(failedHandoff.text, /已定：喝水/);
  });

  it("names a returned result in the chat chip and does not turn a failure into a saved reminder", () => {
    assert.equal(taskReturnLabel("起床提醒"), "来自任务：起床提醒 · 继续追问");
    assert.equal(taskReturnLabel("task_hidden_return"), "来自任务：这项任务 · 继续追问");
    assert.equal(inboxReturnTitle({ status: "failed", prompt: "喝水", resultText: "已定：喝水" }), "喝水");
    assert.equal(inboxReturnTitle({ status: "interrupted", prompt: "thread_hidden_alpha", resultText: "已记下：完成了" }), "这项任务");
    assert.equal(inboxReturnTitle({ status: "completed", prompt: "起床提醒", resultText: "起床啦。先喝口水。" }), "起床啦。先喝口水。");
  });

  it("keeps reminder confirmation and failure copy on the existing cards", () => {
    const card = presentReminderConfirmation({
      reminder: { action: "reschedule", time: "10:00", repeat: "不重复", subject: "喝水", previous: "9:00" },
    });
    assert.equal(card?.title.startsWith("调整提醒"), true);
    const created = presentReminderConfirmation({
      reminder: { action: "save", time: "9:00", repeat: "不重复", subject: "喝水" },
    });
    assert.match(created?.title ?? "", /^设置提醒/);
    const failed = presentReminderReply("已定：明天 9:00 提醒喝水", { toolName: "task_create", status: "failed" });
    assert.equal(failed.primary, "这次提醒没有设成。");
    assert.match(failed.aside ?? "", /已定/);
    assert.doesNotMatch(failed.primary, /已定|已记下/);
  });
});

it("the tasks shell hands create and returned results to the main composer", async () => {
  const app = await readAppSource();
  assert.match(app, /<TasksHome/);
  assert.doesNotMatch(app, /<TaskReturnChip/);
  assert.match(app, /createAndStartTask\(window.runloom/);
  const wired = app.slice(app.indexOf("onCreate={handoff"), app.indexOf("onContinue={applyTaskHandoff}"));
  assert.match(wired, /purpose === "arrangement" \|\| handoff\.mode === "chat"/);
  assert.match(wired, /newConversation\(handoff\.text\)/);
  assert.doesNotMatch(wired, /openCreateTask/);
  assert.doesNotMatch(app, /planTaskFollowUpHandoff\(source\)/);
  const handoff = app.slice(app.indexOf("const applyTaskHandoff"), app.indexOf("const openCreateTask"));
  assert.match(handoff, /nextTaskInstruction\(workTasks\.instruction, handoff\)/);
  assert.match(handoff, /nextComposerText\(current, handoff\)/);
  assert.doesNotMatch(handoff, /setInstruction\(handoff\.text\)/);
  const model = await readFile(new URL("./tasks-model.ts", import.meta.url), "utf8");
  const pageSource = await readFile(new URL("./tasks-page.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(`${model}\n${pageSource}`, /policy:\s*"replace"/);
  const createTask = app.slice(app.indexOf("const openCreateTask"), app.indexOf("const openMemory"));
  assert.match(createTask, /createThread\(\{ preserveDraft: true, taskDraft: text \}\)/);
  assert.doesNotMatch(createTask, /setCreateTaskRequest|setTaskDraft/);
  assert.match(app, /onAutomation=\{\(\) => openDetails\("reminders"\)\}/);
  assert.match(app, /\["手札", "任务", "记忆"\]/);
  assert.match(app, /setCreateTaskRequest\(value => value \+ 1\)/);
  const rows = workTaskRows([task("task_hidden_wake", "起床提醒", 11)]);
  assert.equal(rows[0]?.title, "起床提醒");
  assert.notEqual(rows[0]?.key, rows[0]?.title);
});
