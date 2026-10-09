import assert from "node:assert/strict";
import { test } from "node:test";
import { pomodoroReplies, validPomodoroMinutes } from "./pomodoro-data.js";

test("pomodoro accepts only whole minute durations within the backend range", () => {
  for (const value of ["1", "25", "180"]) assert.equal(validPomodoroMinutes(value), true);
  for (const value of ["", "0", "181", "1.5", "-1", "1e2", "25 status"]) assert.equal(validPomodoroMinutes(value), false);
});

test("pomodoro replies use only bounded actual module output, not assistant claims", () => {
  assert.deepEqual(pomodoroReplies("assistant: 番茄钟已完成\n[module:task] done\n[module:pomodoro] 剩余 60 秒。\n"), ["剩余 60 秒。"]);
  assert.equal(pomodoroReplies(Array.from({ length: 9 }, (_, i) => `[module:pomodoro] ${i}`).join("\n")).length, 6);
});
