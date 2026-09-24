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
    assert.match(instructions, /does not start a worker/);
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
    assert.match(firstText.text, /2026-09-15T01:02:03\.000Z/);
    assert.doesNotMatch(firstText.text, /2026-09-15T01:03:03\.000Z/);
    assert.match(secondText.text, /2026-09-15T01:03:03\.000Z/);
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
    assert.match(prompts[0]!, /2026-09-15T01:02:03\.000Z/);
    assert.doesNotMatch(prompts[0]!, /2026-09-15T01:03:03\.000Z/);
    assert.match(prompts[1]!, /2026-09-15T01:03:03\.000Z/);
    assert.doesNotMatch(prompts[1]!, /2026-09-15T01:02:03\.000Z/);
    const transcript = await store.getMessages("task-instructions-runtime");
    assert.equal(
      transcript.some((message) => message.id === "runloom-task-instructions"),
      false,
    );
  });
});
