import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatOnceWhen,
  formatReminderConfirmation,
  reminderConfirmation,
  reminderConfirmationText,
  reminderReadback,
  reminderSubject,
} from "./reminder-speech.js";

const clock = { now: new Date("2026-10-10T04:00:00.000Z"), timeZone: "Asia/Shanghai" };
const tomorrowNine = "2026-10-11T01:00:00.000Z";

describe("reminder speech", () => {
  it("distant absolute reminder dates include the local year in confirmation and readback", () => {
    assert.equal(formatOnceWhen("2027-10-20T01:00:00.000Z", clock), "2027年10月20日 9:00");
    assert.equal(formatOnceWhen("2026-11-20T01:00:00.000Z", clock), "2026年11月20日 9:00");
    assert.match(formatReminderConfirmation({ action: "save", prompt: "复查", runAt: "2027-10-20T01:00:00.000Z", clock }), /时间：2027年10月20日 9:00/);
    assert.match(reminderReadback("schedule", { prompt: "复查", runAt: "2027-10-20T01:00:00.000Z", clock }), /2027年10月20日/);
    assert.equal(formatOnceWhen("2027-01-01T00:00:00.000Z", {
      now: new Date("2026-12-31T01:00:00.000Z"), timeZone: "Asia/Shanghai",
    }), "明天 8:00", "nearby dates keep unambiguous relative wording");
    assert.equal(formatOnceWhen("2026-12-31T18:00:00.000Z", clock), "2027年1月1日 2:00", "year follows the display timezone, not UTC");
  });

  it("reads a saved one-time reminder back as plain Chinese", () => {
    assert.equal(reminderSubject("提醒我开会"), "开会");
    assert.equal(
      reminderReadback("schedule", { prompt: "开会", runAt: tomorrowNine, clock }),
      "已定：明天 9:00 提醒开会",
    );
    assert.equal(
      reminderReadback("reschedule", { prompt: "开会", runAt: "2026-10-11T02:00:00.000Z", clock }),
      "已改到：明天 10:00 提醒开会",
    );
    assert.equal(
      reminderReadback("cancel", { prompt: "提醒我开会", runAt: tomorrowNine, clock }),
      "已取消：明天 9:00 提醒开会",
    );
    assert.equal(formatOnceWhen(tomorrowNine, clock), "明天 9:00");
    assert.equal(formatOnceWhen("2026-10-10T01:00:00.000Z", clock), "今天 9:00");
    assert.equal(formatOnceWhen("2026-10-12T01:00:00.000Z", clock), "周一 9:00");
    assert.equal(formatOnceWhen("2026-10-20T01:00:00.000Z", clock), "2026年10月20日 9:00");
    assert.equal(formatOnceWhen("过会儿", clock), "过会儿");
  });

  it("shows time, repeat, and text on the confirmation card", () => {
    const once = formatReminderConfirmation({
      action: "save",
      prompt: "提醒我开会",
      runAt: tomorrowNine,
      clock,
      footnote: "到期通知只提交一次，这次确认不代表已经送达。",
    });
    assert.match(once, /时间：明天 9:00/);
    assert.match(once, /重复：不重复/);
    assert.match(once, /内容：开会/);
    assert.match(once, /允许这次保存？ \[y\/n\] /);
    assert.doesNotMatch(once, /"kind"/);
    assert.doesNotMatch(once, /runAt/);

    const daily = formatReminderConfirmation({
      action: "save",
      prompt: "喝水",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
      clock,
    });
    assert.match(daily, /时间：9:00/);
    assert.match(daily, /重复：每天/);
    assert.match(daily, /内容：喝水/);
    assert.equal(
      reminderReadback("schedule", {
        prompt: "喝水",
        recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
        clock,
      }),
      "已定：每天 9:00 提醒喝水",
    );

    const weekly = formatReminderConfirmation({
      action: "save",
      prompt: "开会",
      recurrence: { kind: "weekly", weekday: 1, time: "09:00", utcOffset: "+08:00" },
      clock,
    });
    assert.match(weekly, /重复：每周一/);
    assert.equal(
      reminderReadback("schedule", {
        prompt: "开会",
        recurrence: { kind: "weekly", weekday: 1, time: "09:00", utcOffset: "+08:00" },
        clock,
      }),
      "已定：每周一 9:00 提醒开会",
    );

    const moved = formatReminderConfirmation({
      action: "reschedule",
      prompt: "开会",
      runAt: "2026-10-11T02:00:00.000Z",
      previousRunAt: tomorrowNine,
      clock,
    });
    assert.match(moved, /时间：明天 10:00/);
    assert.match(moved, /原时间：明天 9:00（预览，不锁定这条提醒）/);
    assert.match(moved, /允许这次改期？/);
  });

  it("builds the confirmation card from its fields, and the text only from those fields", () => {
    const moved = reminderConfirmation({
      action: "reschedule",
      prompt: "请提醒我 开会",
      runAt: "2026-10-11T02:00:00.000Z",
      previousRunAt: tomorrowNine,
      clock,
      footnote: "保存时会再次核对状态。",
    });
    assert.deepEqual(moved.reminder, {
      action: "reschedule",
      time: "明天 10:00",
      repeat: "不重复",
      subject: "开会",
      previous: "明天 9:00（预览，不锁定这条提醒）",
      footnote: "保存时会再次核对状态。",
    });
    assert.equal(moved.text, reminderConfirmationText(moved.reminder));
    assert.equal(moved.text, "\n提醒确认\n时间：明天 10:00\n重复：不重复\n内容：开会\n原时间：明天 9:00（预览，不锁定这条提醒）\n保存时会再次核对状态。\n允许这次改期？ [y/n] \n");
    const paused = reminderConfirmation({ action: "pause", prompt: "喝水", recurrence: { kind: "weekly", weekday: 1, time: "09:00", utcOffset: "+08:00" }, clock, footnote: "" });
    assert.deepEqual(paused.reminder, { action: "pause", time: "9:00", repeat: "每周一", subject: "喝水" }, "no previous time, an empty footnote is left out");
    assert.equal(formatReminderConfirmation({ action: "pause", prompt: "喝水", recurrence: { kind: "weekly", weekday: 1, time: "09:00", utcOffset: "+08:00" }, clock }), paused.text);
  });
});
