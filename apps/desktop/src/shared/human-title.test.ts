import assert from "node:assert/strict";
import { it } from "node:test";
import { humanFacingTitle, isRawIdentifier, localScheduleLabel, moduleNotificationCopy, taskNoticeTitle } from "./human-title.js";

it("hides raw ids from conversation titles and keeps human text", () => {
  const id = "6f1c2a90-7b34-41d2-9abc-0d11e22f3344";
  assert.equal(isRawIdentifier(id), true);
  assert.equal(isRawIdentifier("mem_saved_fact"), true);
  assert.equal(isRawIdentifier("task-water"), true);
  assert.equal(isRawIdentifier("task_repeat_create"), true);
  assert.equal(isRawIdentifier("revision 4"), true);
  assert.equal(humanFacingTitle(id, "当前对话"), "当前对话");
  assert.equal(humanFacingTitle(`周复盘 ${id}`, "当前对话"), "周复盘");
  assert.equal(humanFacingTitle("周复盘的写作格式", "当前对话"), "周复盘的写作格式");
});

it("chrome titles drop business tokens that the reminder card keeps", () => {
  // The reminder card itself keeps the token (reminder-copy.test.ts); only chrome titles drop it.
  assert.equal(humanFacingTitle("检查订单 task_12345678", "当前对话"), "检查订单");
});

it("names a saved reminder from its result and formats schedule times without the raw timestamp", () => {
  assert.equal(taskNoticeTitle({
    prompt: "不是正文来源", resultText: "该喝水了，起来活动一下。", status: "completed", arrangementKind: "reminder",
  }), "该喝水了，起来活动一下。");
  assert.equal(taskNoticeTitle({
    prompt: "task-water", resultText: null, status: "completed", arrangementKind: "todoist-brief",
  }), "Todoist 日报已保存");
  const label = localScheduleLabel("2026-10-12T01:00:00.000Z");
  assert.doesNotMatch(label, /T01:00:00|000Z/);
  assert.match(label, /\d/);
  assert.equal(localScheduleLabel("task-water"), "时间未记录");
  const year = new Date().getFullYear();
  const at = (value: number) => new Date(value, 0, 1, 9, 0, 0).toISOString();
  const next = localScheduleLabel(at(year + 1));
  const after = localScheduleLabel(at(year + 2));
  assert.notEqual(next, after);
  assert.match(next, new RegExp(String(year + 1)));
  assert.match(after, new RegExp(String(year + 2)));
});

it("module notifications lead with the human sentence, not the module id", () => {
  const copy = moduleNotificationCopy("pomodoro", "番茄钟结束，已完成 1 分钟专注。 task-water");
  assert.equal(copy.title, "番茄钟结束，已完成 1 分钟专注。");
  assert.doesNotMatch(`${copy.title}\n${copy.body}`, /pomodoro|task-water/);
  const unnamed = moduleNotificationCopy("task", "task-water");
  assert.equal(unnamed.title, "提醒");
  assert.doesNotMatch(unnamed.body, /task-water/);
});
