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
} from "./reminder-copy.js";

const clock: ReminderSpeechClock = { now: new Date("2026-10-10T04:00:00.000Z"), timeZone: "Asia/Shanghai" };
const reminder = { kind: "reminder" as const };

it("confirmation card leads with the Chinese reminder, not the tool name", () => {
  const card = presentReminderConfirmation({
    toolName: "task_repeat_create",
    preview: [
      "提醒确认",
      "时间：9:00",
      "重复：每天",
      "内容：喝水",
      "后台已注册且正在运行。确认后保存这条提醒，并按需启用该工作区后台服务；启用失败时提醒仍保存。到期通知只提交一次，这次确认不代表已经送达。结果投递目的地很长，任务保存与投递登记并非原子。",
      "允许这次保存？ [y/n] ",
    ].join("\n"),
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
  const home = presentHomeTaskItem("scheduled · task-water · 喝水 · runAt 2026-10-11T01:00:00.000Z", clock);
  assert.equal(home.primary, "喝水 · 明天 9:00 · 已设好，到点提醒");
  assert.match(home.detail ?? "", /task-water/);
  assert.doesNotMatch(home.primary, /scheduled|task-water|2026-10-11T01:00:00/);
  assert.match(presentHomeTaskItem("  最近创建的 scheduled/running（仅展示前 5 条）：", clock).primary, /即将到来的提醒/);
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
  const mixed = presentReminderReply("已定：每天 9:00 提醒喝水\nstatus: scheduled");
  assert.equal(mixed.primary, "已定：每天 9:00 提醒喝水");
  assert.match(mixed.aside ?? "", /scheduled/);
  const dump = presentReminderReply('{"status":"scheduled","runAt":"2026-10-11T01:00:00.000Z"}');
  assert.equal(dump.primary, "这段英文不能说明提醒已经设好。");
  assert.doesNotMatch(dump.primary, /已定|已记下/);
  assert.equal(presentReminderReply("明天的会已经 scheduled 在日历里，我们按原计划走。").primary, "明天的会已经 scheduled 在日历里，我们按原计划走。");
});

it("keeps a background-unavailable warning on the primary line instead of collapsing to 已定 or 已记下", () => {
  const text = "已定：每天 9:00 提醒喝水。但后台当前不可用或尚未就绪，到点不能保证执行；请在后台提醒中核对并启用服务，不要重复创建。\nstatus: scheduled";
  const folded = "已定：每天 9:00 提醒喝水\n但后台当前不可用或尚未就绪，到点不能保证执行；请在后台提醒中核对并启用服务，不要重复创建。\nstatus: scheduled";
  const noted = presentReminderReply(text.replace("已定：", "已记下："));
  const view = presentReminderReply(text);
  const split = presentReminderReply(folded);
  for (const primary of [view.primary, noted.primary, split.primary]) {
    assert.match(primary, /后台当前不可用或尚未就绪/);
    assert.match(primary, /不要重复创建/);
    assert.doesNotMatch(primary, /已定|已记下/);
  }
  assert.equal(presentReminderConfirmation({ toolName: "task_reschedule", preview: "提醒确认\n时间：明天 9:00\n内容：开会\n允许这次改期？ [y/n]" })?.title, "调整提醒：明天 9:00 开会");
});

it("keeps a failed create or reschedule as a Chinese failure instead of 已记下", () => {
  const created = presentReminderReply("task_create failed: cannot create scheduled reminder");
  const moved = presentReminderReply("task_reschedule failed: cannot create scheduled reminder");
  assert.match(created.primary, /没有设成/);
  assert.match(moved.primary, /没有改成/);
  assert.doesNotMatch(`${created.primary}\n${moved.primary}`, /已定|已记下/);
  assert.match(created.aside ?? "", /cannot create scheduled reminder/);
});

it("reminder home shows the subject and local time without the task id on the primary line", () => {
  const html = renderToStaticMarkup(createElement(ReminderHome, {
    rows: [{ id: "task-water", subject: "喝水", when: "每天 9:00", status: "按这个时间重复", kind: "recurring", canCancel: true }],
    other: 0, truncated: false, loading: false, error: "", pendingCancel: null, working: false,
    onCancel() {}, onConfirmCancel() {}, onDismissCancel() {}, onSettings() {},
  }));
  assert.match(html, /aria-label="我的提醒"/);
  assert.match(html, /<strong>喝水<\/strong><p>每天 9:00 · 按这个时间重复<\/p>/);
  assert.match(html, /<details><summary>编号<\/summary><code>task-water<\/code>/);
  assert.doesNotMatch(html, /<p>[^<]*task-water|scheduled|task_create/);
});
