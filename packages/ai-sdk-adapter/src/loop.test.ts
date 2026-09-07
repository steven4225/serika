import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  AgentError,
  type AgentEvent,
  type BeforeToolExecute,
} from "@aisdk-agent/core";
import { AiSdkAgentLoop } from "./loop.js";
import { InMemoryModelRegistry, ToolRegistry } from "./registries.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const definition = {
  id: "test",
  version: "1",
  instructions: "Use tools",
  model: "test",
  tools: ["double", "increment"],
  limits: { maxSteps: 4, totalTimeoutMs: 5_000, stepTimeoutMs: 2_000 },
};

function userMessage(text = "calculate"): UIMessage {
  return { id: "user-1", role: "user", parts: [{ type: "text", text }] };
}

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text-1" },
        { type: "text-delta" as const, id: "text-1", delta: text },
        { type: "text-end" as const, id: "text-1" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function finishResponse(finishReason: string, text = "") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(text.length > 0
          ? [
              { type: "text-start" as const, id: "text-1" },
              { type: "text-delta" as const, id: "text-1", delta: text },
              { type: "text-end" as const, id: "text-1" },
            ]
          : []),
        {
          type: "finish" as const,
          finishReason: { unified: finishReason as never, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function toolCallResponse(finishReason: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "finish-check-call",
          toolName: "double",
          input: JSON.stringify({ value: 2 }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: finishReason as never, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function doubleTool(execute: () => Promise<{ value: number }> | { value: number }) {
  return new ToolRegistry([
    {
      metadata: {
        name: "double",
        version: "1",
        risk: "read",
        timeoutMs: 1_000,
        idempotent: true,
      },
      tool: tool({
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        execute,
      }),
    },
  ]);
}

function createEmit(events: AgentEvent[]) {
  let eventId = 0;
  return async (type: AgentEvent["type"], data: unknown) => {
    events.push({
      id: `event-${++eventId}`,
      type,
      data,
      runId: "run",
      threadId: "thread",
      sequence: eventId,
      occurredAt: new Date(0).toISOString(),
    } as AgentEvent);
  };
}

describe("AiSdkAgentLoop", () => {
  it("does not call the model after cancellation during step setup", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return textResponse("unexpected");
      },
    });
    const controller = new AbortController();
    const execution = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: controller.signal,
      generateId: () => "unused",
      emit: async (type) => {
        if (type === "step.started") controller.abort("before model");
      },
    });

    await assert.rejects(execution);
    assert.equal(modelCalls, 0);
  });

  it("prepares a cloned transcript for the model", async () => {
    let prepareCalls = 0;
    let modelPrompt: unknown;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        modelPrompt = prompt;
        return textResponse("prepared answer");
      },
    });
    const original = userMessage("original");
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [original],
      context: { userId: "user-1" },
      signal: new AbortController().signal,
      generateId: () => "assistant-1",
      prepareModelContext: ({ messages, context }) => {
        prepareCalls += 1;
        assert.deepEqual(context, { userId: "user-1" });
        messages[0]!.parts = [{ type: "text", text: "prepared" }];
        return messages;
      },
      emit: async () => undefined,
    });

    assert.equal(prepareCalls, 1);
    assert.match(JSON.stringify(modelPrompt), /prepared/);
    assert.deepEqual(outcome.messages[0], original);
  });

  it("fails before the model when context preparation returns a non-array", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return textResponse("unexpected");
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "unused",
        prepareModelContext: () => "invalid" as never,
        emit: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code ===
          "CONTEXT_PREPARE_FAILED",
    );
    assert.equal(modelCalls, 0);
  });

  it("preserves a context preparation AgentError", async () => {
    const error = new AgentError({
      code: "CONTEXT_PREPARE_FAILED",
      message: "known preparation failure",
      retryable: false,
      phase: "runtime",
    });
    const model = new MockLanguageModelV3({
      doStream: async () => textResponse("unexpected"),
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "unused",
        prepareModelContext: () => {
          throw error;
        },
        emit: async () => undefined,
      }),
      (received: unknown) => received === error,
    );
  });

  it("stops waiting for context preparation when the run is aborted", async () => {
    let modelCalls = 0;
    let preparationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      preparationStarted = resolve;
    });
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return textResponse("unexpected");
      },
    });
    const controller = new AbortController();
    const execution = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: controller.signal,
      generateId: () => "unused",
      prepareModelContext: async () => {
        preparationStarted();
        return new Promise<UIMessage[]>(() => undefined);
      },
      emit: async () => undefined,
    });

    await started;
    controller.abort("cancel context preparation");
    await assert.rejects(execution);
    assert.equal(modelCalls, 0);
  });

  it("allows an empty response with a normal stop finish reason", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => finishResponse("stop"),
    });

    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => "assistant-1",
      emit: async () => undefined,
    });

    assert.equal(outcome.text, "");
    assert.equal(outcome.stopReason, "completed");
  });

  it("rejects inconsistent and unsupported finish reasons before tool execution", async () => {
    const cases = [
      { finishReason: "tool-calls", response: () => finishResponse("tool-calls") },
      { finishReason: "stop", response: () => toolCallResponse("stop") },
      { finishReason: "content-filter", response: () => finishResponse("content-filter") },
      { finishReason: "error", response: () => finishResponse("error") },
      { finishReason: "other", response: () => finishResponse("other") },
      { finishReason: "unrecognized", response: () => finishResponse("unrecognized") },
    ];

    for (const testCase of cases) {
      let modelCalls = 0;
      let executeCount = 0;
      const events: AgentEvent[] = [];
      const model = new MockLanguageModelV3({
        doStream: async () => {
          modelCalls += 1;
          return testCase.response();
        },
      });

      await assert.rejects(
        new AiSdkAgentLoop({
          models: new InMemoryModelRegistry({ test: model }),
          tools: doubleTool(() => {
            executeCount += 1;
            return { value: 4 };
          }),
        }).execute({
          definition: { ...definition, tools: ["double"] },
          messages: [userMessage()],
          signal: new AbortController().signal,
          generateId: () => "assistant-1",
          emit: createEmit(events),
        }),
        (error: unknown) =>
          error instanceof AgentError &&
          error.data.code === "MODEL_BAD_RESPONSE" &&
          error.message.includes(testCase.finishReason),
      );

      assert.equal(modelCalls, 1, testCase.finishReason);
      assert.equal(executeCount, 0, testCase.finishReason);
      assert.ok(
        events.some(
          (event) =>
            event.type === "step.completed" &&
            event.data.finishReason === testCase.finishReason,
        ),
        testCase.finishReason,
      );
      assert.equal(
        events.some((event) => event.type === "tool.call.started"),
        false,
        testCase.finishReason,
      );
    }
  });

  it("does not execute a legal tool call when the model output is truncated", async () => {
    let executeCount = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => toolCallResponse("length"),
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: doubleTool(() => {
          executeCount += 1;
          return { value: 4 };
        }),
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "MODEL_BAD_RESPONSE" &&
        error.message.includes("finishReason: length") &&
        error.message.includes("1 tool call(s)"),
    );

    assert.equal(executeCount, 0);
    assert.equal(
      events.some((event) => event.type === "tool.call.started"),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "step.completed" && event.data.finishReason === "length",
      ),
    );
  });

  it("owns the model-tool-model loop and executes multiple calls sequentially", async () => {
    let modelCall = 0;
    let prepareCalls = 0;
    const modelPrompts: unknown[] = [];
    const executionOrder: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        modelCall += 1;
        modelPrompts.push(options.prompt);
        if (modelCall === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "call-double",
                  toolName: "double",
                  input: JSON.stringify({ value: 20 }),
                },
                {
                  type: "tool-call" as const,
                  toolCallId: "call-increment",
                  toolName: "increment",
                  input: JSON.stringify({ value: 41 }),
                },
                {
                  type: "finish" as const,
                  finishReason: { unified: "tool-calls" as const, raw: undefined },
                  usage,
                },
              ],
            }),
          };
        }
        return textResponse("42");
      },
    });
    const double = tool({
      title: "Double a number",
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        executionOrder.push("double:start");
        await Promise.resolve();
        executionOrder.push("double:end");
        return { value: value * 2 };
      },
    });
    const increment = tool({
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ value: z.number() }),
      execute: async ({ value }) => {
        executionOrder.push("increment:start");
        await Promise.resolve();
        executionOrder.push("increment:end");
        return { value: value + 1 };
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: double,
      },
      {
        metadata: {
          name: "increment",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: increment,
      },
    ]);
    const modelDefinition = tools.definitions(definition.tools).double!;
    assert.equal("execute" in modelDefinition, false);
    assert.equal(modelDefinition.title, "Double a number");

    const events: AgentEvent[] = [];
    let messageId = 0;
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition,
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `assistant-${++messageId}`,
      prepareModelContext: ({ messages }) => {
        prepareCalls += 1;
        return messages;
      },
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "42");
    assert.equal(outcome.steps, 2);
    assert.equal(outcome.messages.length, 3);
    assert.deepEqual(executionOrder, [
      "double:start",
      "double:end",
      "increment:start",
      "increment:end",
    ]);
    assert.equal(modelCall, 2);
    assert.equal(prepareCalls, 2);
    assert.match(JSON.stringify(modelPrompts[1]), /"role":"tool"/);
    assert.match(JSON.stringify(modelPrompts[1]), /"value":40/);
    assert.ok(events.some((event) => event.type === "tool.call.completed"));
    assert.deepEqual(outcome.usage, {
      inputTokens: 6,
      outputTokens: 4,
      totalTokens: 10,
    });
  });

  it("feeds the SDK-marked invalid tool input back without executing the tool", async () => {
    let modelCall = 0;
    let executeCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "bad-call",
                  toolName: "double",
                  input: JSON.stringify({ value: "not-a-number" }),
                },
                {
                  type: "finish" as const,
                  finishReason: { unified: "tool-calls" as const, raw: undefined },
                  usage,
                },
              ],
            }),
          };
        }
        return textResponse("Please provide a number.");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => {
            executeCount += 1;
            return { value: value * 2 };
          },
        }),
      },
    ]);
    const events: AgentEvent[] = [];
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: { ...definition, tools: ["double"] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `message-${modelCall}`,
      emit: createEmit(events),
    });

    assert.equal(executeCount, 0);
    assert.equal(modelCall, 2);
    assert.equal(outcome.steps, 2);
    assert.match(JSON.stringify(outcome.messages), /TOOL_INVALID_INPUT/);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.code === "TOOL_INVALID_INPUT",
      ),
    );
  });

  it("feeds a tool execution error back to the model and continues", async () => {
    let modelCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "failed-call",
                  toolName: "double",
                  input: JSON.stringify({ value: 2 }),
                },
                {
                  type: "finish" as const,
                  finishReason: { unified: "tool-calls" as const, raw: undefined },
                  usage,
                },
              ],
            }),
          };
        }
        return textResponse("The tool failed.");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async () => {
            throw new Error("private tool failure");
          },
        }),
      },
    ]);
    const events: AgentEvent[] = [];
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: { ...definition, tools: ["double"] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `message-${modelCall}`,
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "The tool failed.");
    assert.match(JSON.stringify(outcome.messages), /TOOL_EXECUTION_FAILED/);
    assert.doesNotMatch(JSON.stringify(outcome.messages), /private tool failure/);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.code === "TOOL_EXECUTION_FAILED",
      ),
    );
  });

  it("runs the precheck on a cloned input and passes through context", async () => {
    let modelCall = 0;
    let executeInput: unknown;
    let hookInput: unknown;
    let hookDefinition: unknown;
    let hookContext: unknown;
    const context = { userId: "user-1" };
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) return toolCallResponse("tool-calls");
        return textResponse("allowed");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async (input) => {
            executeInput = input;
            return { value: input.value * 2 };
          },
        }),
      },
    ]);
    const runDefinition = { ...definition, tools: ["double"] };
    const events: AgentEvent[] = [];
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: runDefinition,
      messages: [userMessage()],
      context,
      signal: new AbortController().signal,
      generateId: () => `message-${modelCall}`,
      beforeToolExecute: (input) => {
        hookInput = input.input;
        hookDefinition = input.definition;
        hookContext = input.context;
        (input.input as { value: number }).value = 99;
        return { allow: true };
      },
      emit: createEmit(events),
    });

    assert.equal((hookInput as { value: number }).value, 99);
    assert.deepEqual(executeInput, { value: 2 });
    assert.equal(hookDefinition, runDefinition);
    assert.equal(hookContext, context);
    assert.match(JSON.stringify(outcome.messages), /"value":4/);
  });

  it("denies a tool call as a tool result and continues the loop", async () => {
    let modelCall = 0;
    let executeCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) return toolCallResponse("tool-calls");
        return textResponse("I could not use that tool.");
      },
    });
    const events: AgentEvent[] = [];
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: doubleTool(async () => {
        executeCount += 1;
        return { value: 4 };
      }),
    }).execute({
      definition: { ...definition, tools: ["double"] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `message-${modelCall}`,
      beforeToolExecute: () => ({ allow: false, reason: "not permitted" }),
      emit: createEmit(events),
    });

    assert.equal(modelCall, 2);
    assert.equal(executeCount, 0);
    assert.equal(outcome.text, "I could not use that tool.");
    assert.match(JSON.stringify(outcome.messages), /TOOL_DENIED/);
    assert.equal(
      events.some((event) => event.type === "tool.call.started"),
      false,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.code === "TOOL_DENIED",
      ),
    );
  });

  it("fails the run when the precheck throws or returns an invalid decision", async () => {
    const hooks: Array<() => unknown> = [
      () => {
        throw new Error("policy unavailable");
      },
      () => ({ allow: false }),
    ];
    for (const beforeToolExecute of hooks) {
      let executeCount = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => toolCallResponse("tool-calls"),
      });
      await assert.rejects(
        new AiSdkAgentLoop({
          models: new InMemoryModelRegistry({ test: model }),
          tools: doubleTool(async () => {
            executeCount += 1;
            return { value: 4 };
          }),
        }).execute({
          definition: { ...definition, tools: ["double"] },
          messages: [userMessage()],
          signal: new AbortController().signal,
          generateId: () => "assistant-1",
          beforeToolExecute: beforeToolExecute as BeforeToolExecute,
          emit: async () => undefined,
        }),
        (error: unknown) =>
          error instanceof AgentError &&
          error.data.code === "TOOL_PRECHECK_FAILED",
      );
      assert.equal(executeCount, 0);
    }
  });

  it("stops waiting for a precheck when the run is aborted", async () => {
    let executeCount = 0;
    let hookStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    const controller = new AbortController();
    const execution = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({
        test: new MockLanguageModelV3({
          doStream: async () => toolCallResponse("tool-calls"),
        }),
      }),
      tools: doubleTool(async () => {
        executeCount += 1;
        return { value: 4 };
      }),
    }).execute({
      definition: { ...definition, tools: ["double"] },
      messages: [userMessage()],
      signal: controller.signal,
      generateId: () => "assistant-1",
      beforeToolExecute: async () => {
        hookStarted();
        return new Promise(() => undefined);
      },
      emit: async () => undefined,
    });

    await hookStarted;
    controller.abort("cancel precheck");
    await assert.rejects(execution);
    assert.equal(executeCount, 0);
  });

  it("does not apply the tool timeout while the precheck is waiting", async () => {
    let modelCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) return toolCallResponse("tool-calls");
        return textResponse("precheck finished");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 5,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => ({ value: value * 2 }),
        }),
      },
    ]);
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: { ...definition, tools: ["double"] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `message-${modelCall}`,
      beforeToolExecute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { allow: true };
      },
      emit: async () => undefined,
    });

    assert.equal(outcome.text, "precheck finished");
    assert.equal(modelCall, 2);
  });

  it("feeds a tool timeout back to the model with its timeout reason", async () => {
    let modelCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "timeout-call",
                  toolName: "slow",
                  input: JSON.stringify({ value: 2 }),
                },
                {
                  type: "finish" as const,
                  finishReason: { unified: "tool-calls" as const, raw: undefined },
                  usage,
                },
              ],
            }),
          };
        }
        return textResponse("The tool timed out.");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "slow",
          version: "1",
          risk: "read",
          timeoutMs: 10,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async () => new Promise<{ value: number }>(() => undefined),
        }),
      },
    ]);
    const events: AgentEvent[] = [];
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: { ...definition, tools: ["slow"] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `message-${modelCall}`,
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "The tool timed out.");
    assert.match(JSON.stringify(outcome.messages), /timed out after 10ms/);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.message.includes("timed out after 10ms"),
      ),
    );
  });

  it("does not execute a tool after cancellation during tool setup", async () => {
    let executeCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: "cancelled-call",
              toolName: "double",
              input: JSON.stringify({ value: 2 }),
            },
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async () => {
            executeCount += 1;
            return { value: 4 };
          },
        }),
      },
    ]);
    const controller = new AbortController();
    const execution = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: { ...definition, tools: ["double"] },
      messages: [userMessage()],
      signal: controller.signal,
      generateId: () => "unused",
      emit: async (type) => {
        if (type === "tool.call.started") controller.abort("before tool");
      },
    });

    await assert.rejects(execution);
    assert.equal(executeCount, 0);
  });

  it("does not let a model step timeout cut off an already running tool", async () => {
    let modelCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        if (modelCall === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start" as const, warnings: [] },
                {
                  type: "tool-call" as const,
                  toolCallId: "slow-but-valid",
                  toolName: "slow",
                  input: JSON.stringify({ value: 2 }),
                },
                {
                  type: "finish" as const,
                  finishReason: { unified: "tool-calls" as const, raw: undefined },
                  usage,
                },
              ],
            }),
          };
        }
        return textResponse("tool finished");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "slow",
          version: "1",
          risk: "read",
          timeoutMs: 100,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return { value: value * 2 };
          },
        }),
      },
    ]);
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: {
        ...definition,
        tools: ["slow"],
        limits: { ...definition.limits, stepTimeoutMs: 10 },
      },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `message-${modelCall}`,
      emit: async () => undefined,
    });

    assert.equal(outcome.text, "tool finished");
    assert.equal(modelCall, 2);
  });

  it("stops waiting for a tool when the run is aborted", async () => {
    let modelCalls = 0;
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "slow-call",
                toolName: "double",
                input: JSON.stringify({ value: 2 }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: undefined },
                usage,
              },
            ],
          }),
        };
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 10_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async () => {
            toolStarted();
            return new Promise<{ value: number }>(() => undefined);
          },
        }),
      },
    ]);
    const controller = new AbortController();
    const execution = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition: { ...definition, tools: ["double"] },
      messages: [userMessage()],
      signal: controller.signal,
      generateId: () => "unused",
      emit: async () => undefined,
    });

    await started;
    controller.abort("test cancellation");
    await assert.rejects(execution);
    assert.equal(modelCalls, 1);
  });

  it("fails instead of completing a partial transcript at maxSteps", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: "call-double",
              toolName: "double",
              input: JSON.stringify({ value: 2 }),
            },
            {
              type: "finish" as const,
              finishReason: { unified: "tool-calls" as const, raw: undefined },
              usage,
            },
          ],
        }),
      }),
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => ({ value: value * 2 }),
        }),
      },
    ]);

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools,
      }).execute({
        definition: { ...definition, tools: ["double"], limits: { ...definition.limits, maxSteps: 1 } },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code ===
          "RUN_LIMIT_EXCEEDED",
    );
  });
});
