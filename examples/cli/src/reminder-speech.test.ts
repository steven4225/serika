import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatOnceWhen,
  formatReminderConfirmation,
  reminderReadback,
  reminderSubject,
} from "./reminder-speech.js";

const clock = { now: new Date("2026-10-10T04:00:00.000Z"), timeZone: "Asia/Shanghai" };
const tomorrowNine = "2026-10-11T01:00:00.000Z";

describe("reminder speech", () => {
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
    assert.equal(formatOnceWhen("2026-10-20T01:00:00.000Z", clock), "10月20日 9:00");
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
});
