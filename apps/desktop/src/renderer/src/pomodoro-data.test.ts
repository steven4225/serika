import assert from "node:assert/strict";
import { test } from "node:test";
import { validPomodoroMinutes } from "./pomodoro-data.js";

test("pomodoro accepts only whole minute durations within the backend range", () => {
  for (const value of ["1", "25", "180"]) assert.equal(validPomodoroMinutes(value), true);
  for (const value of ["", "0", "181", "1.5", "-1", "1e2", "25 status"]) assert.equal(validPomodoroMinutes(value), false);
});
