import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
} from "@aisdk-agent/core";
import {
  AiSdkAgentLoop,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@aisdk-agent/ai-sdk-adapter";
import {
  buildTaskContextMessage,
  buildTaskInstructions,
  formatLocalTaskTime,
  injectTaskContext,
} from "./task-instructions.js";

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
    ["2026-10-12T16:30:00.000Z", "2026-10-13T00:30:00.000+08:00"],
    ["2026-10-31T16:30:00.000Z", "2026-11-01T00:30:00.000+08:00"],
    ["2026-12-31T16:30:00.000Z", "2027-01-01T00:30:00.000+08:00"],
  ]) it(`local-clock Demo: midnight reference uses the Beijing calendar date (${local})`, () => {
    const instructions = buildTaskInstructions({ now: new Date(utc!), timeZone: "Asia/Shanghai" });
    assert.ok(instructions.includes(local!), "the model must see a local date and its numeric offset together");
    assert.ok(!instructions.includes(utc!), "do not present the previous UTC day as now");
  });

  it("formats the actual timezone offset, including UTC, fractional offsets and DST", () => {
    for (const [utc, zone, local] of [
      ["2026-10-12T16:30:00.123Z", "UTC", "2026-10-12T16:30:00.123+00:00"],
      ["2026-10-12T16:30:00.000Z", "Asia/Kathmandu", "2026-10-12T22:15:00.000+05:45"],
      ["2026-03-08T06:59:00.000Z", "America/New_York", "2026-03-08T01:59:00.000-05:00"],
      ["2026-03-08T07:01:00.000Z", "America/New_York", "2026-03-08T03:01:00.000-04:00"],
    ]) {
      assert.equal(formatLocalTaskTime(new Date(utc!), zone!), local);
      assert.equal(new Date(formatLocalTaskTime(new Date(utc!), zone!)).toISOString(), utc);
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
    assert.match(instructions, /2026-09-15T09:02:03\.000\+08:00/);
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
    assert.match(firstText.text, /2026-09-15T09:02:03\.000\+08:00/);
    assert.doesNotMatch(firstText.text, /2026-09-15T09:03:03\.000\+08:00/);
    assert.match(secondText.text, /2026-09-15T09:03:03\.000\+08:00/);
  });

  it("injects task guidance only for the enabled calculator agent", () => {
    const messages = [{
      id: "user",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "hello" }],
    }];
    const context = {
      now: new Date("2026-09-15T01:02:03.000Z"),
      timeZone: "Asia/Shanghai",
    };

    assert.deepEqual(
      injectTaskContext(messages, {
        ...context,
        taskEnabled: false,
        definitionId: "calculator",
      }),
      messages,
    );
    assert.deepEqual(
      injectTaskContext(messages, {
        ...context,
        taskEnabled: true,
        definitionId: "scheduled-responder",
      }),
      messages,
    );
    assert.equal(
      injectTaskContext(messages, {
        ...context,
        taskEnabled: true,
        definitionId: "calculator",
      })[0]?.id,
      "runloom-task-instructions",
    );
  });

  it("refreshes task time context across real Runtime runs without saving it", async () => {
    const store = new InMemoryAgentStore();
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        return textResponse("done");
      },
    });
    const times = [
      new Date("2026-09-15T01:02:03.000Z"),
      new Date("2026-09-15T01:03:03.000Z"),
    ];
    let contextCalls = 0;
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([runtimeDefinition]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ [runtimeDefinition.model]: model }),
        tools: new ToolRegistry(),
      }),
      store,
      prepareModelContext: ({ messages, definition }) => injectTaskContext(messages, {
        taskEnabled: true,
        definitionId: definition.id,
        now: times[contextCalls++]!,
        timeZone: "Asia/Shanghai",
      }),
    });

    for (const [index, text] of ["一分钟后提醒我喝水", "再安排一分钟后提醒我站起来"].entries()) {
      const handle = await runtime.run({
        agentId: runtimeDefinition.id,
        threadId: "task-instructions-runtime",
        messages: [{
          id: `user-${index}`,
          role: "user",
          parts: [{ type: "text", text }],
        }],
      });
      assert.equal((await handle.result).status, "completed");
    }

    assert.equal(contextCalls, 2);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /2026-09-15T09:02:03\.000\+08:00/);
    assert.doesNotMatch(prompts[0]!, /2026-09-15T09:03:03\.000\+08:00/);
    assert.match(prompts[1]!, /2026-09-15T09:03:03\.000\+08:00/);
    assert.doesNotMatch(prompts[1]!, /2026-09-15T09:02:03\.000\+08:00/);
    const transcript = await store.getMessages("task-instructions-runtime");
    assert.equal(
      transcript.some((message) => message.id === "runloom-task-instructions"),
      false,
    );
  });
});
