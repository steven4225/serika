import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkTask } from "../../../shared/work-tasks.js";
import { presentReminderConfirmation, presentReminderReply } from "../reminder-copy.js";
import { TaskReturnChipView, TasksPage, type TasksPageProps } from "./tasks-page.js";
import {
  SCHEDULE_TEMPLATES,
  TASK_CREATE_PROMPT,
  groupTaskRows,
  inboxReturnTitle,
  nextComposerText,
  planTaskContinueHandoff,
  planTaskCreateHandoff,
  scheduledTaskRows,
  taskDayBucket,
  taskReturnLabel,
  workTaskRows,
} from "./tasks-model.js";

const now = new Date(2026, 9, 12, 15, 0, 0);
const at = (monthDay: number, hour = 10, minute = 30) => new Date(2026, 9, monthDay, hour, minute, 0).toISOString();
const task = (id: string, goal: string, day: number, status: WorkTask["status"] = "paused"): WorkTask => ({
  id, revision: 1, threadId: "thread_hidden_alpha", goal, constraints: [], acceptance: [], status,
  runIds: [], delivery: null, reconciliations: [], createdAt: at(day), updatedAt: at(day),
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
  it("shows the segmented control, human rows, and no engineering ids", () => {
    const html = page({ tasks: [
      task("task_hidden_wake", "起床提醒", 11),
      task("task_hidden_research", "三线关联分析：agent-memory-map × Runloom PR #113 × pi-learn", 9),
      task("task_hidden_blank", "task_hidden_blank", 12),
    ] });
    assert.match(html, /role="tablist"/);
    assert.match(html, /aria-selected="true"[^>]*>任务/);
    assert.match(html, /aria-selected="false"[^>]*>.*?定时任务/);
    assert.match(html, /＋ 创建任务/);
    assert.match(html, /昨天/);
    assert.match(html, /近 7 天/);
    assert.match(html, /起床提醒/);
    assert.match(html, /三线关联分析：agent-memory-map × Runloom PR #113 × pi-learn/);
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
      scheduled: [{ id: "task_hidden_water", promptPreview: "喝水", status: "scheduled", runAt: at(12, 20), arrangement: { kind: "reminder" } }],
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
    assert.doesNotMatch(detail, /已定|已记下/);
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
    assert.equal(planTaskContinueHandoff({ ...item, status: "paused" }, "继续写完").mode, "task");
  });
});

describe("conversational create and return chip", () => {
  it("fills an empty composer and leaves an existing draft untouched", () => {
    const handoff = planTaskCreateHandoff();
    assert.equal(handoff.mode, "chat");
    assert.equal(handoff.policy, "fill");
    assert.equal(nextComposerText("", handoff), TASK_CREATE_PROMPT);
    assert.equal(nextComposerText("已经在写", handoff), "已经在写");
    assert.doesNotMatch(TASK_CREATE_PROMPT, /已定|已记下/);
    for (const template of SCHEDULE_TEMPLATES) assert.doesNotMatch(`${template.prompt} ${template.blurb}`, /已定|已记下/);
  });

  it("names a returned result in the chat chip and does not turn a failure into a saved reminder", () => {
    assert.equal(taskReturnLabel("起床提醒"), "来自任务：起床提醒 · 继续追问");
    assert.equal(taskReturnLabel("task_hidden_return"), "来自任务：这项任务 · 继续追问");
    assert.equal(inboxReturnTitle({ status: "failed", prompt: "喝水", resultText: "已定：喝水" }), "喝水");
    assert.equal(inboxReturnTitle({ status: "interrupted", prompt: "thread_hidden_alpha", resultText: "已记下：完成了" }), "这项任务");
    assert.equal(inboxReturnTitle({ status: "completed", prompt: "起床提醒", resultText: "起床啦。先喝口水。" }), "起床啦。先喝口水。");
    const html = renderToStaticMarkup(createElement(TaskReturnChipView, { label: taskReturnLabel("起床提醒"), onContinue: noop }));
    assert.match(html, /来自任务：起床提醒 · 继续追问/);
    assert.doesNotMatch(html, /已定|已记下|task_/);
  });

  it("keeps reminder confirmation and failure copy on the existing cards", () => {
    const card = presentReminderConfirmation({
      toolName: "task_reschedule",
      preview: ["提醒确认", "时间：10:00", "重复：不重复", "内容：喝水", "原时间：9:00"].join("\n"),
    });
    assert.equal(card?.title.startsWith("调整提醒"), true);
    const created = presentReminderConfirmation({
      toolName: "task_create",
      preview: ["提醒确认", "时间：9:00", "内容：喝水"].join("\n"),
    });
    assert.match(created?.title ?? "", /^设置提醒/);
    const failed = presentReminderReply("已定：明天 9:00 提醒喝水", { toolName: "task_create", status: "failed" });
    assert.equal(failed.primary, "这次提醒没有设成。");
    assert.match(failed.aside ?? "", /已定/);
    assert.doesNotMatch(failed.primary, /已定|已记下/);
  });
});

it("the tasks shell hands create and returned results to the main composer", async () => {
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(app, /<TasksHome/);
  assert.match(app, /<TaskReturnChip/);
  assert.match(app, /planTaskCreateHandoff\(\)/);
  assert.match(app, /planTaskFollowUpHandoff\(title\)/);
  const createTask = app.slice(app.indexOf("const openCreateTask"), app.indexOf("const openMemory"));
  assert.match(createTask, /planTaskCreateHandoff\(\)/);
  assert.doesNotMatch(createTask, /setCreateTaskRequest|setTaskDraft/);
  assert.match(app, /onAutomation=\{\(\) => openDetails\("reminders"\)\}/);
  assert.match(app, /\["手札", "任务", "记忆", "serika"\]/);
  assert.match(app, /setCreateTaskRequest\(value => value \+ 1\)/);
  const rows = workTaskRows([task("task_hidden_wake", "起床提醒", 11)]);
  assert.equal(rows[0]?.title, "起床提醒");
  assert.notEqual(rows[0]?.key, rows[0]?.title);
});
