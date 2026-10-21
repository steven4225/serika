import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
} from "@serika/core";
import {
  AiSdkAgentLoop,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@serika/ai-sdk-adapter";
import { buildTaskContextMessage, buildTaskInstructions, formatLocalTaskTime } from "./task-instructions.js";

const runtimeDefinition = {
  id: "calculator",
  version: "1",
  instructions: "Answer briefly.",
  model: "task-instructions-test-model",
  tools: [],
  limits: { maxSteps: 1, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
};

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  };
}

describe("task instructions", () => {
  for (const [utc, local] of [
    ["2026-10-12T16:30:00.000Z", "2026-10-13T00:30+08:00"],
    ["2026-10-31T16:30:00.000Z", "2026-11-01T00:30+08:00"],
    ["2026-12-31T16:30:00.000Z", "2027-01-01T00:30+08:00"],
  ]) it(`local-clock Demo: midnight reference uses the Beijing calendar date (${local})`, () => {
    const instructions = buildTaskInstructions({ now: new Date(utc!), timeZone: "Asia/Shanghai" });
    assert.ok(instructions.includes(local!), "the model must see a local date and its numeric offset together");
    assert.ok(!instructions.includes(utc!), "do not present the previous UTC day as now");
  });

  it("formats the actual timezone offset, including UTC, fractional offsets and DST", () => {
    for (const [utc, zone, local] of [
      ["2026-10-12T16:30:00.123Z", "UTC", "2026-10-12T16:30+00:00"],
      ["2026-10-12T16:30:00.000Z", "Asia/Kathmandu", "2026-10-12T22:15+05:45"],
      ["2026-03-08T06:59:00.000Z", "America/New_York", "2026-03-08T01:59-05:00"],
      ["2026-03-08T07:01:00.000Z", "America/New_York", "2026-03-08T03:01-04:00"],
    ]) {
      assert.equal(formatLocalTaskTime(new Date(utc!), zone!), local);
      assert.equal(new Date(formatLocalTaskTime(new Date(utc!), zone!)).toISOString(), new Date(new Date(utc!).setUTCSeconds(0, 0)).toISOString());
    }
    assert.throws(() => formatLocalTaskTime(new Date(), "Invalid/Zone"), RangeError);
  });

  it("gives the model a verifiable current-time context and task contract", () => {
    const instructions = buildTaskInstructions({
      now: new Date("2026-09-15T01:02:03.000Z"),
      timeZone: "Asia/Shanghai",
    });

    assert.match(instructions, /一分钟后提醒我喝水/);
    assert.match(instructions, /明早九点提醒我开会/);
    assert.match(instructions, /task_create/);
    assert.match(instructions, /2026-09-15T09:02\+08:00/);
    assert.match(instructions, /Asia\/Shanghai/);
    assert.match(instructions, /ISO 8601/);
    assert.match(instructions, /kind: "reminder"/);
    assert.match(instructions, /Do not ask「你想几点」/);
    assert.match(instructions, /过会儿/);
    assert.match(instructions, /周末/);
    assert.match(instructions, /已定：明天 9:00 提醒开会/);
    assert.match(instructions, /COMPLETE readback/);
    assert.match(instructions, /background-unavailable warning/);
    assert.match(instructions, /taskSaved.*backgroundReady/);
    assert.match(instructions, /readback/);
    assert.match(instructions, /改到十点/);
    assert.match(instructions, /task_repeat_pause/);
    assert.match(instructions, /not an automation Hook/);
    assert.match(instructions, /task_list/);
    assert.match(instructions, /does not start a worker/);
    assert.match(instructions, /every day or every week, use task_repeat_create rather than task_create/);
    assert.match(instructions, /weekday: 1\.\.7 \(Monday\.\.Sunday\)/);
    assert.match(instructions, /does not follow daylight saving time/);
    assert.match(instructions, /For a daily work brief, include the requested evidence and observation time, one priority, a 15-minute first step, and unknowns in that task prompt/);
    assert.match(instructions, /do not apply this format to other scheduled tasks/);
    assert.match(instructions, /Do not add the task id, ISO timestamp, JSON, series ID or nextRunAt/);
    assert.match(instructions, /If the tool fails or is denied, do not claim the reminder exists/);
    assert.match(instructions, /inbox: true/);
    assert.match(instructions, /task_get/);
    assert.match(instructions, /matches more than one task/);
    assert.match(instructions, /task_cancel/);
    assert.match(instructions, /task_reschedule/);
    assert.match(instructions, /Never implement rescheduling as task_cancel followed by task_create/);
    assert.match(instructions, /before rescheduling, cancelling, or acknowledging/);
    assert.match(instructions, /Scheduled does not mean a worker is running or a desktop notification was delivered/);
    assert.match(instructions, /task_ack/);
    assert.match(instructions, /never acknowledge automatically/);
    assert.match(instructions, /worker Run 正常结束/);
    assert.match(instructions, /does not prove business success or desktop notification delivery/);
    assert.match(instructions, /failed means the Run failed/);
    assert.match(instructions, /interrupted means the worker stopped/);
    assert.match(instructions, /Do not promise a desktop notification when creating a task/);
    assert.doesNotMatch(instructions, /unless an actual notification result says so/);
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
    assert.match(firstText.text, /2026-09-15T09:02\+08:00/);
    assert.doesNotMatch(firstText.text, /2026-09-15T09:03\+08:00/);
    assert.match(secondText.text, /2026-09-15T09:03\+08:00/);
  });

});
