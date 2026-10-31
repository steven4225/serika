import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReminderHome } from "./reminders.js";
import {
  inboxPrimaryLine,
  presentHomeTaskItem,
  presentReminderConfirmation,
  presentReminderReply,
  reminderRows,
  reminderSpeechLine,
  scheduleStatusLabel,
  type ReminderSpeechClock,
  type ReminderReplyResult,
} from "./reminder-copy.js";

const clock: ReminderSpeechClock = { now: new Date("2026-10-10T04:00:00.000Z"), timeZone: "Asia/Shanghai" };
const reminder = { kind: "reminder" as const };
const savedReply = (readback: string, backgroundReady = true): ReminderReplyResult => ({ toolName: "task_create", status: "ok", reminder: { readback, backgroundReady } });
const failedCreate: ReminderReplyResult = { toolName: "task_create", status: "failed" };

it("preserves ordinary technical explanations and successful reminder subjects containing failure words", () => {
  const explanation = "解释 task_create 的 error 字段：保存失败时返回错误；这不是在设置提醒。";
  assert.deepEqual(presentReminderReply(explanation), { primary: explanation, aside: null });
  const readback = "已定：明天9:00提醒我查看 task_create 的 error 日志";
  assert.equal(presentReminderReply(readback).primary, readback);
});

it("confirmation card keeps the business token in the text being approved", () => {
  const subject = "检查订单 task_12345678";
  const card = presentReminderConfirmation({ reminder: { action: "save", time: "9:00", repeat: "不重复", subject } });
  assert.match(card?.title ?? "", /task_12345678/);
  assert.equal(card?.subject, subject);
});

it("confirmation card leads with the Chinese reminder, not the tool name", () => {
  const card = presentReminderConfirmation({
    reminder: {
      action: "save",
      time: "9:00",
      repeat: "每天",
      subject: "喝水",
      footnote: "后台已注册且正在运行。确认后保存这条提醒，并按需启用该工作区后台服务；启用失败时提醒仍保存。到期通知只提交一次，这次确认不代表已经送达。结果投递目的地很长，任务保存与投递登记并非原子。",
    },
  });
  assert.ok(card);
  assert.equal(card.title, "设置提醒：每天 9:00 喝水");
  assert.equal(card.allowLabel, "确认保存");
  assert.match(card.safety, /保存不等于已经提醒到你/);
  assert.doesNotMatch(card.title + card.safety, /task_repeat_create|scheduled|runAt/);
  assert.match(card.details, /并非原子/);
  assert.doesNotMatch(card.safety, /并非原子/);
});

it("a due reminder no longer reads as if it were still waiting to be scheduled", () => {
  assert.equal(scheduleStatusLabel("scheduled", "2026-10-10T01:00:00.000Z", clock.now, "reminder"), "已到点，尚未执行");
  assert.equal(scheduleStatusLabel("scheduled", "2026-10-10T10:00:00.000Z", clock.now, "reminder"), "已设好，到点提醒");
  assert.doesNotMatch(scheduleStatusLabel("scheduled", "2026-10-10T01:00:00.000Z", clock.now, "reminder"), /已排期/);
  const view = reminderRows({
    scheduled: [
      { id: "task-water", promptPreview: "喝水", status: "scheduled", runAt: "2026-10-10T01:00:00.000Z", arrangement: reminder },
      { id: "skill-1", promptPreview: "复盘", status: "scheduled", runAt: "2026-10-11T01:00:00.000Z", arrangement: { kind: "skill" } },
    ],
    recurring: [{
      id: "series-water",
      promptPreview: "喝水",
      status: "active",
      nextRunAt: "2026-10-11T01:00:00.000Z",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
      arrangement: reminder,
    }],
  }, clock);
  assert.equal(view.other, 1);
  assert.equal(view.rows[0]?.when, "今天 9:00");
  assert.equal(view.rows[0]?.status, "已到点，尚未执行");
  assert.equal(view.rows[1]?.when, "每天 9:00 · 下次 明天 9:00");
  assert.equal(view.rows[1]?.status, "按这个时间重复");
});

it("home and inbox lines stay Chinese and keep ids off the primary line", () => {
  const home = presentHomeTaskItem({
    text: "scheduled · task-water · 喝水 · runAt 2026-10-11T01:00:00.000Z",
    task: { status: "scheduled", id: "task-water", prompt: "喝水", runAt: "2026-10-11T01:00:00.000Z", detail: null },
  }, clock);
  assert.equal(home.primary, "喝水 · 明天 9:00 · 已设好，到点提醒");
  assert.match(home.detail ?? "", /task-water/);
  assert.doesNotMatch(home.primary, /scheduled|task-water|2026-10-11T01:00:00/);
  assert.match(presentHomeTaskItem({ text: "  最近创建的 pending/running（仅展示前 5 条）：", taskList: "pending" }, clock).primary, /即将到来的提醒/);
  const inbox = inboxPrimaryLine({
    promptPreview: "喝水", status: "completed", runAt: "2026-10-11T01:00:00.000Z", finishedAt: "2026-10-11T01:00:05.000Z", arrangement: reminder,
  }, clock);
  assert.equal(inbox.subject, "喝水");
  assert.match(inbox.when, /明天 9:00/);
  assert.equal(inbox.status, "执行结束");
  assert.doesNotMatch(`${inbox.subject} ${inbox.when} ${inbox.status}`, /scheduled|T01:00/);
});

it("reply primary line keeps the natural-language reminder and drops English scheduled", () => {
  assert.equal(reminderSpeechLine("已定：明天 9:00 提醒开会 scheduled"), "已定：明天 9:00 提醒开会");
  const mixed = presentReminderReply("已定：每天 9:00 提醒喝水\nstatus: scheduled", savedReply("已定：每天 9:00 提醒喝水"));
  assert.equal(mixed.primary, "已定：每天 9:00 提醒喝水");
  assert.match(mixed.aside ?? "", /scheduled/);
  const dump = presentReminderReply('{"status":"scheduled","runAt":"2026-10-11T01:00:00.000Z"}');
  assert.equal(dump.primary, '{"status":"scheduled","runAt":"2026-10-11T01:00:00.000Z"}', "unassociated prose stays intact and does not invent a save");
  assert.doesNotMatch(dump.primary, /已定|已记下/);
  assert.equal(presentReminderReply("明天的会已经 scheduled 在日历里，我们按原计划走。").primary, "明天的会已经 scheduled 在日历里，我们按原计划走。");
});

it("keeps a background-unavailable warning on the primary line instead of collapsing to 已定 or 已记下", () => {
  const text = "已定：每天 9:00 提醒喝水。但后台当前不可用或尚未就绪，到点不能保证执行；请在后台提醒中核对并启用服务，不要重复创建。\nstatus: scheduled";
  const folded = "已定：每天 9:00 提醒喝水\n但后台当前不可用或尚未就绪，到点不能保证执行；请在后台提醒中核对并启用服务，不要重复创建。\nstatus: scheduled";
  const result = savedReply(text.replace("\nstatus: scheduled", ""), false);
  const noted = presentReminderReply(text.replace("已定：", "已记下："), result);
  const view = presentReminderReply(text, result);
  const split = presentReminderReply(folded, result);
  for (const primary of [view.primary, noted.primary, split.primary]) {
    assert.match(primary, /后台当前不可用或尚未就绪/);
    assert.match(primary, /不要重复创建/);
    assert.doesNotMatch(primary, /已定|已记下/);
  }
  assert.equal(presentReminderConfirmation({ reminder: { action: "reschedule", time: "明天 9:00", repeat: "不重复", subject: "开会" } })?.title, "调整提醒：明天 9:00 开会");
});

it("save failure after a scheduled line does not keep 已定 as the primary", () => {
  const view = presentReminderReply("已定：每天 9:00 提醒喝水 scheduled\n但保存失败了", failedCreate);
  assert.match(view.primary, /没有设成/);
  assert.match(view.aside ?? "", /保存失败/);
  assert.doesNotMatch(view.primary, /已定|已记下/);
  assert.notEqual(view.primary, "已定：每天 9:00 提醒喝水");
});

it("a long reply containing task_create failed does not keep 已定 as the primary", () => {
  const text = `已定：每天 9:00 提醒喝水 scheduled\n${"垫".repeat(520)}\ntask_create failed: cannot create scheduled reminder`;
  assert.ok(text.length > 500);
  const view = presentReminderReply(text, failedCreate);
  assert.match(view.primary, /没有设成/);
  assert.doesNotMatch(view.primary, /已定|已记下/);
});

it("an english backend unavailable warning does not keep 已定 as the primary", () => {
  const view = presentReminderReply("已定：每天 9:00 提醒喝水 scheduled\nwarning: backend unavailable", savedReply("已记下：每天 9:00 提醒喝水\nwarning: backend unavailable", false));
  assert.match(view.primary, /backend unavailable/);
  assert.doesNotMatch(view.primary, /已定|已记下/);
});

it("后台服务未运行 does not keep 已记下 as the primary", () => {
  const view = presentReminderReply("已记下：每天 9:00 提醒喝水\n后台服务未运行", savedReply("已记下：每天 9:00 提醒喝水\n后台服务未运行", false));
  assert.match(view.primary, /未运行/);
  assert.doesNotMatch(view.primary, /已定|已记下/);
});

it("keeps a failed create or reschedule as a Chinese failure instead of 已记下", () => {
  const created = presentReminderReply("task_create failed: cannot create scheduled reminder", failedCreate);
  const moved = presentReminderReply("task_reschedule failed: cannot create scheduled reminder", { toolName: "task_reschedule", status: "failed" });
  assert.match(created.primary, /没有设成/);
  assert.match(moved.primary, /没有改成/);
  assert.doesNotMatch(`${created.primary}\n${moved.primary}`, /已定|已记下/);
  assert.match(created.aside ?? "", /cannot create scheduled reminder/);
});

it("reminder home shows the subject and local time without the task id on the primary line", () => {
  const html = renderToStaticMarkup(createElement(ReminderHome, {
    rows: [{ id: "task-water", subject: "喝水", when: "每天 9:00", status: "按这个时间重复", kind: "recurring", canCancel: true }],
    other: 0, truncated: false, loading: false, error: "", pendingCancel: null, working: false,
    onCancel() {}, onConfirmCancel() {}, onDismissCancel() {},
  }));
  assert.match(html, /aria-label="我的提醒"/);
  assert.match(html, /<strong>喝水<\/strong><p>每天 9:00 · 按这个时间重复<\/p>/);
  assert.match(html, /<details><summary>编号<\/summary><code>task-water<\/code>/);
  assert.doesNotMatch(html, /<p>[^<]*task-water|scheduled|task_create/);
});
