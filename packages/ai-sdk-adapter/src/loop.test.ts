import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APICallError, simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  AgentError,
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
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

function multipleToolCallResponse(finishReason: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "first-call",
          toolName: "double",
          input: JSON.stringify({ value: 2 }),
        },
        {
          type: "tool-call" as const,
          toolCallId: "second-call",
          toolName: "double",
          input: JSON.stringify({ value: 3 }),
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

function apiError(statusCode: number, isRetryable = statusCode >= 500) {
  return new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://model.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    isRetryable,
  });
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

class CountingStore extends InMemoryAgentStore {
  saveCount = 0;

  override async save(threadId: string, messages: UIMessage[]): Promise<void> {
    this.saveCount += 1;
    await super.save(threadId, messages);
  }
}

async function within400ms<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("still pending after 400ms")), 400);
    })]);
  } finally { clearTimeout(timer); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["request-hangs", "stream-hangs"] as const) {
  for (const stop of ["step-timeout", "total-timeout", "cancel"] as const) {
    it(`cancel wait Demo: ${mode} settles on ${stop} without provider cooperation`, async () => {
      const started = deferred<void>();
      const release = deferred<ReturnType<typeof toolCallResponse>>();
      let close = () => {}, calls = 0, executions = 0, approvals = 0;
      const events: AgentEvent[] = [];
      const model = new MockLanguageModelV3({ doStream: async () => {
        calls++;
        started.resolve();
        if (mode === "request-hangs") return release.promise;
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          close = () => controller.close();
        } }) };
      } });
      const store = new CountingStore();
      const runtime = new DefaultAgentRuntime({
        catalog: new InMemoryAgentCatalog([{ ...definition, tools: ["double"], limits: {
          maxSteps: 4, stepTimeoutMs: stop === "step-timeout" ? 40 : 2_000,
          totalTimeoutMs: stop === "total-timeout" ? 100 : 5_000,
        } }]), store,
        loop: new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }),
          tools: doubleTool(() => { executions++; return { value: 4 }; }) }),
        beforeToolExecute: async () => { approvals++; return { allow: true }; },
      });
      const handle = await runtime.run({ agentId: "test", threadId: "cancel-wait", messages: [userMessage()] });
      const observed = (async () => { for await (const event of handle.events) events.push(event); })();
      try {
        await within400ms(started.promise);
        if (stop === "cancel") await handle.cancel("cancel wait Demo");
        const result = await within400ms(handle.result);
        await observed;
        assert.equal(result.status, stop === "step-timeout" ? "failed" : stop === "total-timeout" ? "timed_out" : "cancelled");
        assert.equal(result.error?.code, stop === "step-timeout" ? "MODEL_TIMEOUT" : stop === "total-timeout" ? "RUN_TIMEOUT" : "RUN_CANCELLED");
        const terminalEvents = events.length;
        release.resolve(toolCallResponse("tool-calls")); // A late request may still return a tool call.
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(events.length, terminalEvents, "late output cannot reopen the terminal Run");
        assert.equal(calls, 1);
        assert.equal(approvals, 0);
        assert.equal(executions, 0);
        assert.equal(store.saveCount, 0);
      } finally {
        await handle.cancel("fixture cleanup");
        release.resolve(toolCallResponse("tool-calls"));
        close();
        await handle.result;
        await observed;
      }
    });
  }
}

it("cancel wait Demo: a late next-step tool call never replays an already completed tool", async () => {
  const started = deferred<void>();
  const release = deferred<ReturnType<typeof toolCallResponse>>();
  let calls = 0, executions = 0, approvals = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    if (++calls === 1) return toolCallResponse("tool-calls");
    started.resolve();
    return release.promise;
  } });
  const runtime = new DefaultAgentRuntime({ catalog: new InMemoryAgentCatalog([{ ...definition, tools: ["double"] }]),
    store: new CountingStore(), loop: new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }),
      tools: doubleTool(() => { executions++; return { value: 4 }; }) }),
    beforeToolExecute: async () => { approvals++; return { allow: true }; },
  });
  const handle = await runtime.run({ agentId: "test", threadId: "no-replay", messages: [userMessage()] });
  try {
    await within400ms(started.promise);
    await handle.cancel("cancel after completed tool");
    assert.equal((await within400ms(handle.result)).status, "cancelled");
    release.resolve(toolCallResponse("tool-calls"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    assert.equal(approvals, 1);
    assert.equal(executions, 1);
  } finally {
    await handle.cancel("fixture cleanup");
    release.resolve(toolCallResponse("tool-calls"));
    await handle.result;
  }
});

it("finish corrections keep the same loop, original tool confirmation and remaining step budget", async () => {
  const events: AgentEvent[] = [];
  let calls = 0, approvals = 0, executions = 0;
  const model = new MockLanguageModelV3({ doStream: async () => ++calls === 2 ? toolCallResponse("tool-calls") : textResponse("done") });
  const loop = new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }), tools: doubleTool(() => { executions++; return { value: 4 }; }) });
  let id = 0;
  const outcome = await loop.execute({ definition: { ...definition, tools: ["double"] }, messages: [userMessage()], signal: new AbortController().signal,
    generateId: () => `id-${++id}`, emit: createEmit(events),
    beforeToolExecute: async () => { approvals++; return { allow: true }; },
    beforeRunFinish: async input => input.corrections === 0 ? { kind: "continue", feedback: "Need a successful double tool receipt" } : { kind: "stop", reason: "delivered" },
  });
  assert.equal(calls, 3); assert.equal(approvals, 1); assert.equal(executions, 1);
  assert.deepEqual(outcome.completion, { reason: "delivered", corrections: 1 });
  assert.equal(outcome.messages.filter(message => message.role === "user").length, 1);
  assert.ok(events.every(event => event.runId === "run"));
  const bounded = await loop.execute({ definition: { ...definition, tools: ["double"], limits: { ...definition.limits, maxSteps: 1 } },
    messages: [userMessage()], signal: new AbortController().signal, generateId: () => `id-${++id}`, emit: createEmit([]),
    beforeRunFinish: async () => ({ kind: "continue", feedback: "missing" }),
  });
  assert.deepEqual(bounded.completion, { reason: "budget_exhausted", corrections: 0 });
});

it("cancellation interrupts an unfinished completion check without another model request", async () => {
  const abort = new AbortController(); let calls = 0;
  const loop = new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: new MockLanguageModelV3({ doStream: async () => { calls++; return textResponse("done"); } }) }), tools: doubleTool(() => ({ value: 4 })) });
  const pending = loop.execute({ definition: { ...definition, tools: ["double"] }, messages: [userMessage()], signal: abort.signal,
    generateId: () => "id", emit: createEmit([]), beforeRunFinish: async () => {
      abort.abort(new Error("cancel completion")); return await new Promise<never>(() => {});
    },
  });
  await assert.rejects(pending, /cancel completion/); assert.equal(calls, 1);
});

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

async function createPrecheckRuntime(options: {
  beforeToolExecute: BeforeToolExecute;
  threadId: string;
  totalTimeoutMs?: number;
}) {
  const committed: UIMessage[] = [
    { ...userMessage("remember this"), id: "old-user" },
    {
      id: "old-assistant",
      role: "assistant",
      parts: [{ type: "text", text: "I remember it." }],
    },
  ];
  const store = new CountingStore();
  await store.save(options.threadId, committed);
  store.saveCount = 0;

  let markHookStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markHookStarted = resolve;
  });

  const modelCalls = { value: 0 };
  const executeCount = { value: 0 };
  const model = new MockLanguageModelV3({
    doStream: async () => {
      modelCalls.value += 1;
      return toolCallResponse("tool-calls");
    },
  });
  const runtime = new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([
      {
        ...definition,
        tools: ["double"],
        limits: {
          maxSteps: 2,
          totalTimeoutMs: options.totalTimeoutMs ?? 1_000,
          stepTimeoutMs: 500,
        },
      },
    ]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: doubleTool(() => {
        executeCount.value += 1;
        return { value: 4 };
      }),
    }),
    beforeToolExecute: async (input) => {
      markHookStarted();
      return options.beforeToolExecute(input);
    },
    store,
  });

  return { committed, executeCount, modelCalls, runtime, started, store };
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

  it("retries a transient model request within the same step", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) throw apiError(503);
        return textResponse("recovered");
      },
    });

    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
      modelRetryDelaysMs: [0],
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => "assistant-1",
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "recovered");
    assert.equal(modelCalls, 2);
    assert.deepEqual(
      events
        .filter((event) => event.type === "model.retry.scheduled")
        .map((event) => event.data),
      [{
        stepNumber: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        delayMs: 0,
        error: {
          code: "MODEL_UNAVAILABLE",
          message: "Model service is temporarily unavailable",
          retryable: true,
          phase: "model",
        },
      }],
    );
  });

  it("does not retry a host-declared one-shot Agent even for an empty transient failure", async () => {
    let calls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({ doStream: async () => { calls++; throw apiError(503); } });
    const loop = new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }), tools: new ToolRegistry(),
      modelRetryDelaysMs: [0, 0], modelRetryDisabledAgentIds: [definition.id] });
    await assert.rejects(loop.execute({ definition: { ...definition, tools: [], limits: { ...definition.limits, maxSteps: 1 } },
      messages: [userMessage()], signal: new AbortController().signal, generateId: () => "assistant-1", emit: createEmit(events),
    }), error => error instanceof AgentError && error.data.code === "MODEL_UNAVAILABLE");
    assert.equal(calls, 1);
    assert.equal(events.some(event => event.type === "model.retry.scheduled"), false);
  });

  it("keeps model retries disabled unless the caller opts in", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        throw apiError(503);
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
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "MODEL_UNAVAILABLE",
    );
    assert.equal(modelCalls, 1);
    assert.equal(
      events.some((event) => event.type === "model.retry.scheduled"),
      false,
    );
  });

  it("retries a model request when the network error is nested in cause", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          const networkError = Object.assign(new Error("dns lookup failed"), {
            code: "ENOTFOUND",
          });
          throw new Error("provider wrapper", { cause: networkError });
        }
        return textResponse("recovered");
      },
    });

    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
      modelRetryDelaysMs: [0],
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => "assistant-1",
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "recovered");
    assert.equal(modelCalls, 2);
    assert.equal(
      (events.find((event) => event.type === "model.retry.scheduled")?.data as { error: { code: string } }).error.code,
      "MODEL_UNAVAILABLE",
    );
  });

  it("exhausts transient model retries at the configured attempt count", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        throw apiError(503);
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_UNAVAILABLE",
    );

    assert.equal(modelCalls, 3);
    assert.equal(
      events.filter((event) => event.type === "model.retry.scheduled").length,
      2,
    );
  });

  it("does not retry authentication failures", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        throw apiError(401, false);
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_AUTH",
    );
    assert.equal(modelCalls, 1);
  });

  it("does not retry forbidden responses", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        throw apiError(403, false);
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_AUTH",
    );
    assert.equal(modelCalls, 1);
  });

  it("retries a rate-limited model request", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) throw apiError(429, true);
        return textResponse("recovered");
      },
    });

    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
      modelRetryDelaysMs: [0],
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => "assistant-1",
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "recovered");
    assert.equal(modelCalls, 2);
    assert.equal(
      events.find((event) => event.type === "model.retry.scheduled")?.data.error.code,
      "MODEL_RATE_LIMIT",
    );
  });

  it("retries HTTP 408 and 502 as unavailable", async () => {
    for (const statusCode of [408, 502]) {
      let modelCalls = 0;
      const events: AgentEvent[] = [];
      const model = new MockLanguageModelV3({
        doStream: async () => {
          modelCalls += 1;
          if (modelCalls === 1) throw apiError(statusCode, true);
          return textResponse("recovered");
        },
      });

      const outcome = await new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
        modelRetryDelaysMs: [0],
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      });

      assert.equal(outcome.text, "recovered", String(statusCode));
      assert.equal(modelCalls, 2, String(statusCode));
      assert.equal(
        events.find((event) => event.type === "model.retry.scheduled")?.data.error.code,
        "MODEL_UNAVAILABLE",
        String(statusCode),
      );
    }
  });

  it("does not retry HTTP 501 even when the SDK marks it retryable", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        throw apiError(501, true);
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_BAD_RESPONSE",
    );
    assert.equal(modelCalls, 1);
    assert.equal(
      events.some((event) => event.type === "model.retry.scheduled"),
      false,
    );
  });

  it("does not retry HTTP 400 even when the SDK marks it retryable", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        throw apiError(400, true);
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_BAD_RESPONSE",
    );
    assert.equal(modelCalls, 1);
  });

  it("retries a nested APICallError from the cause chain", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) {
          throw new Error("provider wrapper", { cause: apiError(503) });
        }
        return textResponse("recovered");
      },
    });

    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
      modelRetryDelaysMs: [0],
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => "assistant-1",
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "recovered");
    assert.equal(modelCalls, 2);
    assert.equal(
      events.find((event) => event.type === "model.retry.scheduled")?.data.error.code,
      "MODEL_UNAVAILABLE",
    );
  });

  it("retries an empty model step timeout", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ abortSignal }) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          await new Promise<never>((_, reject) => {
            const fail = () => {
              reject(
                abortSignal?.reason ??
                  new DOMException("Model stream aborted", "AbortError"),
              );
            };
            if (abortSignal?.aborted) {
              fail();
              return;
            }
            abortSignal?.addEventListener("abort", fail, { once: true });
          });
        }
        return textResponse("recovered");
      },
    });

    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
      modelRetryDelaysMs: [0],
    }).execute({
      definition: {
        ...definition,
        tools: [],
        limits: { ...definition.limits, stepTimeoutMs: 40 },
      },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => "assistant-1",
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "recovered");
    assert.equal(modelCalls, 2);
    assert.equal(
      events.find((event) => event.type === "model.retry.scheduled")?.data.error.code,
      "MODEL_TIMEOUT",
    );
  });

  it("does not retry after a partial model output", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "text-1" },
              { type: "text-delta" as const, id: "text-1", delta: "partial" },
              { type: "error" as const, error: apiError(503) },
            ],
          }),
        };
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_UNAVAILABLE",
    );
    assert.equal(modelCalls, 1);
    assert.ok(events.some((event) => event.type === "message.delta"));
    assert.equal(
      events.some((event) => event.type === "model.retry.scheduled"),
      false,
    );
  });

  it("does not retry after a tool call is requested", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
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
              { type: "error" as const, error: apiError(503) },
            ],
          }),
        };
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: doubleTool(() => ({ value: 4 })),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_UNAVAILABLE",
    );
    assert.equal(modelCalls, 1);
    assert.ok(events.some((event) => event.type === "tool.call.requested"));
    assert.equal(
      events.some((event) => event.type === "model.retry.scheduled"),
      false,
    );
  });

  it("does not retry after a tool-input-start chunk", async () => {
    let modelCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-input-start" as const,
                id: "finish-check-call",
                toolName: "double",
              },
              { type: "error" as const, error: apiError(503) },
            ],
          }),
        };
      },
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: doubleTool(() => ({ value: 4 })),
        modelRetryDelaysMs: [0, 0],
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "MODEL_UNAVAILABLE",
    );
    assert.equal(modelCalls, 1);
    assert.equal(
      events.some((event) => event.type === "tool.call.requested"),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "model.retry.scheduled"),
      false,
    );
  });

  it("stops before the next model attempt when cancelled during retry delay", async () => {
    let modelCalls = 0;
    const controller = new AbortController();
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        throw apiError(503);
      },
    });

    const execution = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry(),
      modelRetryDelaysMs: [10_000],
    }).execute({
      definition: { ...definition, tools: [] },
      messages: [userMessage()],
      signal: controller.signal,
      generateId: () => "assistant-1",
      emit: async (type) => {
        if (type === "model.retry.scheduled") controller.abort("cancel retry");
      },
    });

    await assert.rejects(
      execution,
      (error: unknown) =>
        error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(modelCalls, 1);
  });

  it("does not repeat a successful tool when the following model step retries", async () => {
    let modelCalls = 0;
    let executeCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) return toolCallResponse("tool-calls");
        if (modelCalls === 2) throw apiError(503);
        return textResponse("done after tool");
      },
    });

    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: doubleTool(() => {
        executeCount += 1;
        return { value: 4 };
      }),
      modelRetryDelaysMs: [0],
    }).execute({
      definition: { ...definition, tools: ["double"], limits: { ...definition.limits, maxSteps: 3 } },
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `assistant-${modelCalls}`,
      emit: async () => undefined,
    });

    assert.equal(outcome.text, "done after tool");
    assert.equal(modelCalls, 3);
    assert.equal(executeCount, 1);
  });

  it("stops after an unknown outcome from a non-idempotent tool", async () => {
    let modelCalls = 0;
    let executeCount = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return toolCallResponse("tool-calls");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "external_side_effect",
          timeoutMs: 1_000,
          idempotent: false,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ ok: z.boolean() }),
          execute: async () => {
            executeCount += 1;
            throw new Error("connection lost after dispatch");
          },
        }),
      },
    ]);

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools,
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "TOOL_OUTCOME_UNKNOWN",
    );

    assert.equal(modelCalls, 1);
    assert.equal(executeCount, 1);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.code === "TOOL_OUTCOME_UNKNOWN",
      ),
    );
  });

  it("stops after a non-idempotent tool times out without a result", async () => {
    let modelCalls = 0;
    let executeCount = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return toolCallResponse("tool-calls");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "external_side_effect",
          timeoutMs: 10,
          idempotent: false,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ ok: z.boolean() }),
          execute: async () => {
            executeCount += 1;
            return new Promise<{ ok: boolean }>(() => undefined);
          },
        }),
      },
    ]);

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools,
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "TOOL_OUTCOME_UNKNOWN",
    );

    assert.equal(modelCalls, 1);
    assert.equal(executeCount, 1);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.code === "TOOL_OUTCOME_UNKNOWN" &&
          event.data.error.message.includes("timed out after 10ms"),
      ),
    );
  });

  it("does not execute later tool calls after an unknown outcome", async () => {
    const executed: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => multipleToolCallResponse("tool-calls"),
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "external_side_effect",
          timeoutMs: 1_000,
          idempotent: false,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ ok: z.boolean() }),
          execute: async (_input, context) => {
            executed.push(context.toolCallId);
            throw new Error("connection lost after dispatch");
          },
        }),
      },
    ]);

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools,
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        emit: async () => undefined,
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "TOOL_OUTCOME_UNKNOWN",
    );

    assert.deepEqual(executed, ["first-call"]);
  });

  it("keeps an explicit non-idempotent tool failure as a known result", async () => {
    let modelCalls = 0;
    let executeCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        if (modelCalls === 1) return toolCallResponse("tool-calls");
        return textResponse("reported failure");
      },
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "external_side_effect",
          timeoutMs: 1_000,
          idempotent: false,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ ok: z.boolean() }),
          execute: async () => {
            executeCount += 1;
            return { ok: false };
          },
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
      generateId: () => `assistant-${modelCalls}`,
      emit: async () => undefined,
    });

    assert.equal(outcome.text, "reported failure");
    assert.equal(modelCalls, 2);
    assert.equal(executeCount, 1);
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
      let beforeToolCalls = 0;
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
          beforeToolExecute: () => {
            beforeToolCalls += 1;
            return { allow: true };
          },
          emit: createEmit(events),
        }),
        (error: unknown) =>
          error instanceof AgentError &&
          error.data.code === "MODEL_BAD_RESPONSE" &&
          error.message.includes(testCase.finishReason),
      );

      assert.equal(modelCalls, 1, testCase.finishReason);
      assert.equal(executeCount, 0, testCase.finishReason);
      assert.equal(beforeToolCalls, 0, testCase.finishReason);
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
    let beforeToolCalls = 0;
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
        beforeToolExecute: () => {
          beforeToolCalls += 1;
          return { allow: true };
        },
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "MODEL_BAD_RESPONSE" &&
        error.message.includes("finishReason: length") &&
        error.message.includes("1 tool call(s)"),
    );

    assert.equal(executeCount, 0);
    assert.equal(beforeToolCalls, 0);
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
    let beforeToolCalls = 0;
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
      beforeToolExecute: () => {
        beforeToolCalls += 1;
        return { allow: true };
      },
      emit: createEmit(events),
    });

    assert.equal(executeCount, 0);
    assert.equal(beforeToolCalls, 0);
    assert.equal(modelCall, 2);
    assert.equal(outcome.steps, 2);
    assert.match(JSON.stringify(outcome.messages), /TOOL_INVALID_INPUT/);
    assert.match(JSON.stringify(outcome.messages), /value: invalid type/);
    assert.match(JSON.stringify(outcome.messages), /No tool was executed/);
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.code === "TOOL_INVALID_INPUT",
      ),
    );
  });

  it("lets the model correct a case-sensitive argument without bypassing approval or replaying the invalid call", async () => {
    let modelCall = 0;
    let executeCount = 0;
    let approvals = 0;
    const model = new MockLanguageModelV3({
      doStream: async (params) => {
        modelCall += 1;
        if (modelCall === 2) {
          assert.match(JSON.stringify(params.prompt), /value: required/);
        }
        if (modelCall === 3) return textResponse("4");
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: modelCall === 1 ? "invalid" : "corrected",
            toolName: "double", input: JSON.stringify(modelCall === 1 ? { Value: 2 } : { value: 2 }) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
        ] }) };
      },
    });
    const events: AgentEvent[] = [];
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools: new ToolRegistry([{
        metadata: { name: "double", version: "1", risk: "write", timeoutMs: 1_000, idempotent: false },
        tool: tool({ inputSchema: z.object({ value: z.number() }), execute: ({ value }) => {
          executeCount += 1; return { value: value * 2 };
        } }),
      }]),
    }).execute({
      definition: { ...definition, tools: ["double"] }, messages: [userMessage()],
      signal: new AbortController().signal, generateId: () => `message-${modelCall}`,
      beforeToolExecute: (call) => {
        approvals += 1;
        assert.equal(call.toolCallId, "corrected");
        assert.deepEqual(call.input, { value: 2 });
        return { allow: true };
      },
      emit: createEmit(events),
    });
    assert.equal(modelCall, 3);
    assert.equal(executeCount, 1);
    assert.equal(approvals, 1);
    assert.equal(outcome.text, "4");
    assert.ok(events.some((event) => event.type === "tool.call.failed" && event.data.toolCallId === "invalid"));
    assert.equal(events.filter((event) => event.type === "tool.call.started").length, 1);
  });

  for (const scenario of [
    { name: "wrong kind with text present", input: '{"text":"PRIVATE_TEXT","kind":"PRIVATE_VALUE"}', expected: /kind: invalid value/, validateCount: 0 },
    { name: "wrong sourceQuote type", input: '{"text":"PRIVATE_TEXT","sourceQuote":42}', expected: /sourceQuote: invalid type/, validateCount: 0 },
    { name: "missing text", input: '{"kind":"preference"}', expected: /text: required/, validateCount: 0 },
    { name: "root field combination", input: '{"text":"PRIVATE_TEXT","sourceQuote":"PRIVATE_QUOTE"}', expected: /Field combination or object constraints failed/, validateCount: 1 },
    { name: "malformed JSON", input: '{"text":"PRIVATE_TEXT",', expected: /Invalid JSON arguments/, validateCount: 0 },
    { name: "untrusted field name", input: '{"text":"PRIVATE_TEXT","PRIVATE_FIELD":"PRIVATE_VALUE"}', expected: /Field combination or object constraints failed/, validateCount: 0 },
  ]) {
    it(`invalid-input diagnostic: ${scenario.name} without leaking input or revalidating`, async () => {
      let modelCalls = 0;
      let validations = 0;
      let executions = 0;
      let approvals = 0;
      const events: AgentEvent[] = [];
      const model = new MockLanguageModelV3({ doStream: async () => {
        if (++modelCalls > 1) return textResponse("Please correct the arguments.");
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: "invalid", toolName: "remember", input: scenario.input },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
        ] }) };
      } });
      const inputSchema = z.object({ text: z.string(), kind: z.enum(["preference", "fact"]).optional(),
        sourceQuote: z.string().optional(), sourceMessageId: z.string().optional() }).strict().superRefine(async (value, ctx) => {
        validations++;
        if ((value.sourceQuote === undefined) !== (value.sourceMessageId === undefined)) {
          ctx.addIssue({ code: "custom", message: `PRIVATE_VALIDATION_MESSAGE ${value.text}` });
        }
      });
      await new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry([{
          metadata: { name: "remember", version: "1", risk: "write", timeoutMs: 1_000, idempotent: false },
          tool: tool({ inputSchema, execute: () => { executions++; return { ok: true }; } }),
        }]),
      }).execute({
        definition: { ...definition, tools: ["remember"] }, messages: [userMessage()],
        signal: new AbortController().signal, generateId: () => `message-${modelCalls}`,
        beforeToolExecute: () => { approvals++; return { allow: true }; }, emit: createEmit(events),
      });
      const failure = events.find(event => event.type === "tool.call.failed");
      assert.ok(failure?.type === "tool.call.failed");
      assert.equal(failure.data.error.code, "TOOL_INVALID_INPUT");
      assert.match(failure.data.error.message, scenario.expected);
      assert.match(failure.data.error.message, /No tool was executed/);
      assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_|Required fields/);
      assert.equal(executions, 0);
      assert.equal(approvals, 0);
      assert.equal(validations, scenario.validateCount, "diagnostics must reuse the SDK validation result");
      assert.equal(modelCalls, 2);
    });
  }

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

  it("fails the run when an idempotent tool throws CONTEXT_PREPARE_FAILED", async () => {
    let modelCall = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCall += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "oversized-call",
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
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async () => {
            throw new AgentError({
              code: "CONTEXT_PREPARE_FAILED",
              message: "Selected conversation exceeds the consolidation input limit",
              retryable: false,
              phase: "runtime",
            });
          },
        }),
      },
    ]);

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools,
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => `message-${modelCall}`,
        emit: createEmit([]),
      }),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "CONTEXT_PREPARE_FAILED",
    );
    assert.equal(modelCall, 1);
  });

  it("fails an unknown tool without calling the precheck", async () => {
    let modelCalls = 0;
    let beforeToolCalls = 0;
    const events: AgentEvent[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "unknown-call",
                toolName: "missing",
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

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(),
      }).execute({
        definition: { ...definition, tools: [] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        beforeToolExecute: () => {
          beforeToolCalls += 1;
          return { allow: true };
        },
        emit: createEmit(events),
      }),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "TOOL_NOT_FOUND",
    );

    assert.equal(modelCalls, 1);
    assert.equal(beforeToolCalls, 0);
    assert.equal(
      events.some((event) => event.type === "tool.call.started"),
      false,
    );
  });

  it("runs the precheck on a cloned input and passes through context", async () => {
    let modelCall = 0;
    let executeInput: unknown;
    let hookInput: unknown;
    let hookDefinition: unknown;
    let hookContext: unknown;
    let hookToolName: string | undefined;
    let hookToolCallId: string | undefined;
    let hookSignal: AbortSignal | undefined;
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
        hookToolName = input.toolName;
        hookToolCallId = input.toolCallId;
        hookSignal = input.signal;
        (input.input as { value: number }).value = 99;
        return { allow: true };
      },
      emit: createEmit(events),
    });

    assert.equal((hookInput as { value: number }).value, 99);
    assert.deepEqual(executeInput, { value: 2 });
    assert.equal(hookDefinition, runDefinition);
    assert.equal(hookContext, context);
    assert.equal(hookToolName, "double");
    assert.equal(hookToolCallId, "finish-check-call");
    assert.equal(hookSignal?.aborted, false);
    const toolPart = outcome.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "dynamic-tool");
    assert.equal(toolPart?.type, "dynamic-tool");
    if (toolPart?.type === "dynamic-tool") {
      assert.deepEqual(toolPart.input, { value: 2 });
      assert.deepEqual(toolPart.output, { value: 4 });
    }
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

  it("checks same-step tools in order and continues after denying one", async () => {
    let modelCall = 0;
    const modelPrompts: unknown[] = [];
    const precheckOrder: string[] = [];
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
                  toolCallId: "deny-double",
                  toolName: "double",
                  input: JSON.stringify({ value: 20 }),
                },
                {
                  type: "tool-call" as const,
                  toolCallId: "allow-increment",
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
        return textResponse("continued after the denial");
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
            executionOrder.push("double");
            return { value: value * 2 };
          },
        }),
      },
      {
        metadata: {
          name: "increment",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => {
            executionOrder.push("increment");
            return { value: value + 1 };
          },
        }),
      },
    ]);
    const events: AgentEvent[] = [];
    const outcome = await new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ test: model }),
      tools,
    }).execute({
      definition,
      messages: [userMessage()],
      signal: new AbortController().signal,
      generateId: () => `assistant-${modelCall}`,
      beforeToolExecute: ({ toolName }) => {
        precheckOrder.push(toolName);
        return toolName === "double"
          ? { allow: false, reason: "double is not permitted" }
          : { allow: true };
      },
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "continued after the denial");
    assert.equal(modelCall, 2);
    assert.deepEqual(precheckOrder, ["double", "increment"]);
    assert.deepEqual(executionOrder, ["increment"]);
    assert.match(JSON.stringify(outcome.messages), /TOOL_DENIED/);
    assert.match(JSON.stringify(modelPrompts[1]), /TOOL_DENIED/);
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool.call.started" &&
          event.data.toolName === "double",
      ),
      false,
    );
    assert.equal(
      events.filter(
        (event) =>
          event.type === "tool.call.completed" &&
          event.data.toolName === "increment",
      ).length,
      1,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.toolCallId === "deny-double" &&
          event.data.error.code === "TOOL_DENIED",
      ),
    );
  });

  it("fails the run when the precheck throws or returns an invalid decision", async () => {
    const policyError = new Error("policy unavailable");
    const hooks: Array<() => unknown> = [
      () => {
        throw policyError;
      },
      () => ({ allow: false }),
      () => null,
      () => undefined,
      () => ({ allow: "yes" }),
      () => ({ allow: false, reason: "   " }),
    ];
    for (const beforeToolExecute of hooks) {
      let executeCount = 0;
      let receivedError: unknown;
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
        (error: unknown) => {
          receivedError = error;
          return (
            error instanceof AgentError &&
            error.data.code === "TOOL_PRECHECK_FAILED"
          );
        },
      );
      assert.equal(executeCount, 0);
      if (beforeToolExecute === hooks[0]) {
        assert.equal((receivedError as AgentError).cause, policyError);
      }
    }
  });

  it("preserves a TOOL_PRECHECK_FAILED thrown by the precheck", async () => {
    const error = new AgentError({
      code: "TOOL_PRECHECK_FAILED",
      message: "policy is unavailable",
      retryable: false,
      phase: "tool",
    });
    const model = new MockLanguageModelV3({
      doStream: async () => toolCallResponse("tool-calls"),
    });

    await assert.rejects(
      new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: doubleTool(async () => ({ value: 4 })),
      }).execute({
        definition: { ...definition, tools: ["double"] },
        messages: [userMessage()],
        signal: new AbortController().signal,
        generateId: () => "assistant-1",
        beforeToolExecute: () => {
          throw error;
        },
        emit: async () => undefined,
      }),
      (received: unknown) => received === error,
    );
  });

  it("stops waiting for a precheck when the run is aborted", async () => {
    let executeCount = 0;
    let modelCalls = 0;
    let hookStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hookStarted = resolve;
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const execution = new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({
        test: new MockLanguageModelV3({
          doStream: async () => {
            modelCalls += 1;
            return toolCallResponse("tool-calls");
          },
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
      emit: createEmit(events),
    });

    await started;
    controller.abort("cancel precheck");
    await assert.rejects(execution);
    assert.equal(modelCalls, 1);
    assert.equal(executeCount, 0);
    assert.equal(
      events.some((event) => event.type === "tool.call.started"),
      false,
    );
  });

  it("does not apply the tool timeout while the precheck is waiting", async () => {
    let modelCall = 0;
    let executeCount = 0;
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
      beforeToolExecute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { allow: true };
      },
      emit: createEmit(events),
    });

    assert.equal(outcome.text, "precheck finished");
    assert.equal(modelCall, 2);
    assert.equal(executeCount, 1);
    const toolPart = outcome.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "dynamic-tool");
    assert.equal(toolPart?.type, "dynamic-tool");
    if (toolPart?.type === "dynamic-tool") {
      assert.equal(toolPart.state, "output-available");
      assert.deepEqual(toolPart.output, { value: 4 });
    }
    assert.equal(
      events.filter((event) => event.type === "tool.call.completed").length,
      1,
    );
    assert.equal(
      events.some(
        (event) =>
          event.type === "tool.call.failed" &&
          event.data.error.code === "TOOL_EXECUTION_FAILED",
      ),
      false,
    );
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
          timeoutMs: 300,
          idempotent: true,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async ({ value }) => {
            await new Promise((resolve) => setTimeout(resolve, 150));
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
        limits: { ...definition.limits, stepTimeoutMs: 100 },
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

describe("beforeToolExecute Runtime integration", () => {
  it("does not save when a non-idempotent tool outcome is unknown", async () => {
    const threadId = "thread-unknown-outcome";
    const committed: UIMessage[] = [
      { ...userMessage("remember this"), id: "old-user" },
      {
        id: "old-assistant",
        role: "assistant",
        parts: [{ type: "text", text: "I remember it." }],
      },
    ];
    const store = new CountingStore();
    await store.save(threadId, committed);
    store.saveCount = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => toolCallResponse("tool-calls"),
    });
    const tools = new ToolRegistry([
      {
        metadata: {
          name: "double",
          version: "1",
          risk: "external_side_effect",
          timeoutMs: 1_000,
          idempotent: false,
        },
        tool: tool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ ok: z.boolean() }),
          execute: async () => {
            throw new Error("connection lost after dispatch");
          },
        }),
      },
    ]);
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([
        {
          ...definition,
          tools: ["double"],
          limits: { ...definition.limits, maxSteps: 2 },
        },
      ]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools,
      }),
      store,
    });

    const handle = await runtime.run({
      agentId: "test",
      threadId,
      messages: [userMessage("run the tool")],
    });
    const result = await handle.result;

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "TOOL_OUTCOME_UNKNOWN");
    assert.equal(store.saveCount, 0);
    assert.deepEqual(await store.getMessages(threadId), committed);
  });

  it("does not save when beforeToolExecute fails in the real runtime loop", async () => {
    const threadId = "thread-precheck-failure";
    const { committed, executeCount, modelCalls, runtime, store } =
      await createPrecheckRuntime({
        threadId,
        beforeToolExecute: () => {
          throw new Error("policy unavailable");
        },
      });

    const handle = await runtime.run({
      agentId: "test",
      threadId,
      messages: [userMessage("run the tool")],
    });
    const eventsPromise = (async () => {
      const events: AgentEvent[] = [];
      for await (const event of handle.events) events.push(event);
      return events;
    })();
    const result = await handle.result;
    const events = await eventsPromise;

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "TOOL_PRECHECK_FAILED");
    assert.equal(modelCalls.value, 1);
    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, 0);
    assert.deepEqual(await store.getMessages(threadId), committed);
    assert.equal(events.some((event) => event.type === "run.completed"), false);
  });

  it("does not save when cancelling a pending beforeToolExecute in the real runtime loop", async () => {
    const threadId = "thread-precheck-cancel";
    const { committed, executeCount, modelCalls, runtime, started, store } =
      await createPrecheckRuntime({
        threadId,
        beforeToolExecute: ({ signal }) => waitForAbort(signal),
      });

    const handle = await runtime.run({
      agentId: "test",
      threadId,
      messages: [userMessage("run the tool")],
    });
    const eventsPromise = (async () => {
      const events: AgentEvent[] = [];
      for await (const event of handle.events) events.push(event);
      return events;
    })();
    await started;
    await handle.cancel("cancel precheck");
    const result = await handle.result;
    const events = await eventsPromise;

    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "RUN_CANCELLED");
    assert.equal(modelCalls.value, 1);
    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, 0);
    assert.deepEqual(await store.getMessages(threadId), committed);
    assert.equal(events.some((event) => event.type === "run.completed"), false);
  });

  it("does not spend the run timeout while beforeToolExecute awaits approval", async () => {
    const threadId = "thread-precheck-timeout";
    const { committed, executeCount, modelCalls, runtime, started, store } =
      await createPrecheckRuntime({
        threadId,
        totalTimeoutMs: 200,
        beforeToolExecute: ({ signal }) => waitForAbort(signal),
      });

    const handle = await runtime.run({
      agentId: "test",
      threadId,
      messages: [userMessage("run the tool")],
    });
    const eventsPromise = (async () => {
      const events: AgentEvent[] = [];
      for await (const event of handle.events) events.push(event);
      return events;
    })();
    await started;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await handle.cancel("cancel after approval wait");
    const result = await handle.result;
    const events = await eventsPromise;

    assert.equal(result.status, "cancelled");
    assert.equal(result.error?.code, "RUN_CANCELLED");
    assert.equal(modelCalls.value, 1);
    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, 0);
    assert.deepEqual(await store.getMessages(threadId), committed);
    assert.equal(events.some((event) => event.type === "run.completed"), false);
  });
});
