import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildTaskContextMessage,
  buildTaskInstructions,
} from "./task-instructions.js";

describe("task instructions", () => {
  it("gives the model a verifiable current-time context and task contract", () => {
    const instructions = buildTaskInstructions({
      now: new Date("2026-09-15T01:02:03.000Z"),
      timeZone: "Asia/Shanghai",
    });

    assert.match(instructions, /一分钟后提醒我喝水/);
    assert.match(instructions, /task_create/);
    assert.match(instructions, /2026-09-15T01:02:03\.000Z/);
    assert.match(instructions, /Asia\/Shanghai/);
    assert.match(instructions, /ISO 8601/);
    assert.match(instructions, /exact time and timezone/);
    assert.match(instructions, /task ID, runAt, and prompt/);
    assert.match(instructions, /task_list/);
    assert.match(instructions, /task_cancel/);
  });

  it("refreshes the injected current time for each model context", () => {
    const first = buildTaskContextMessage({
      now: new Date("2026-09-15T01:02:03.000Z"),
      timeZone: "Asia/Shanghai",
    });
    const second = buildTaskContextMessage({
      now: new Date("2026-09-15T01:03:03.000Z"),
      timeZone: "Asia/Shanghai",
    });

    const firstText = first.parts[0];
    const secondText = second.parts[0];
    assert.equal(first.id, "runloom-task-instructions");
    assert.equal(second.id, first.id);
    assert.equal(firstText?.type, "text");
    assert.equal(secondText?.type, "text");
    if (firstText?.type !== "text" || secondText?.type !== "text") return;
    assert.match(firstText.text, /2026-09-15T01:02:03\.000Z/);
    assert.doesNotMatch(firstText.text, /2026-09-15T01:03:03\.000Z/);
    assert.match(secondText.text, /2026-09-15T01:03:03\.000Z/);
  });
});
