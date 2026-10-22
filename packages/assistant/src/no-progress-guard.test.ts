import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  AgentError,
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
  type AgentEvent,
  type BeforeToolExecute,
  type RunSteering,
} from "@serika/core";
import { AiSdkAgentLoop, InMemoryModelRegistry, ToolRegistry } from "@serika/ai-sdk-adapter";
import { createNoProgressGuard } from "./no-progress-guard.js";

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

describe("no-progress tool guard", () => {
  function fixture(options: {
    name?: string;
    names?: string[];
    risk?: "read" | "write";
    idempotent?: boolean;
    inputs?: Record<string, unknown>[];
    output?: (invocation: number, name: string) => unknown;
    beforeToolExecute?: BeforeToolExecute;
    signal?: AbortSignal;
    steering?: RunSteering;
    onEvent?: (event: AgentEvent) => void;
  } = {}) {
    const name = options.name ?? "web_fetch";
    const inputs = options.inputs ?? [{ url: "https://example.com" }, { url: "https://example.com" }, { url: "https://example.com" }];
    let modelCalls = 0, executions = 0, ids = 0;
    const prompts: unknown[] = [], events: AgentEvent[] = [];
    const emit = createEmit(events);
    const model = new MockLanguageModelV3({ doStream: async request => {
      prompts.push(request.prompt);
      const index = modelCalls++;
      if (index >= inputs.length) return textResponse("done");
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId: `guard-${index}`, toolName: options.names?.[index] ?? name, input: JSON.stringify(inputs[index]) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ] }) };
    } });
    const names = [...new Set(options.names ?? [name])];
    const tools = new ToolRegistry(names.map(name => ({ metadata: { name, version: "1", risk: options.risk ?? "read",
      idempotent: options.idempotent ?? true, timeoutMs: 1_000 },
      tool: tool({ inputSchema: z.record(z.string(), z.unknown()), execute: () => {
        executions++;
        return options.output?.(executions, name) ?? { ok: true, value: { text: "same", fetchedAt: `time-${executions}` } };
      } }),
    })));
    const loop = new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }), tools });
    const afterToolCall = createNoProgressGuard(name => tools.metadata(name));
    const run = () => loop.execute({ afterToolCall, definition: { ...definition, tools: names, limits: { ...definition.limits, maxSteps: 8 } },
      messages: [userMessage()], signal: options.signal ?? new AbortController().signal,
      generateId: () => `guard-message-${++ids}`,
      emit: async (type, data) => { await emit(type, data); options.onEvent?.(events.at(-1)!); },
      ...(options.beforeToolExecute ? { beforeToolExecute: options.beforeToolExecute } : {}),
      ...(options.steering ? { steering: options.steering } : {}),
    });
    return { run, loop, afterToolCall, events, prompts, counts: () => ({ modelCalls, executions }), resetModel: () => { modelCalls = 0; } };
  }

  it("ABAB timestamp-only reads warn on the second cycle and stop on the third cycle", async () => {
    const names = ["web_fetch", "read_file", "web_fetch", "read_file", "web_fetch", "read_file"];
    const f = fixture({ names, inputs: Array.from({ length: 6 }, (_, index) => index % 2 ? { path: "report.md" } : { url: "https://example.com" }),
      output: (invocation, name) => ({ ok: true, value: { text: name, ...(name === "web_fetch" ? { fetchedAt: `time-${invocation}` } : {}) } }) });
    await assert.rejects(f.run(), error => error instanceof AgentError && error.data.code === "RUN_LIMIT_EXCEEDED" && /没有新进展/.test(error.data.message));
    assert.deepEqual(f.counts(), { modelCalls: 6, executions: 6 });
    assert.match(JSON.stringify(f.prompts[4]), /NO_PROGRESS/);
    assert.doesNotMatch(JSON.stringify(f.prompts.slice(0, 4)), /NO_PROGRESS/);
    assert.equal(f.events.filter(event => event.type === "tool.call.completed").length, 6);
    assert.equal(f.events.filter(event => event.type === "tool.call.failed").length, 0);
  });

  it("guard feedback is system-only context, not assistant transcript or visible chat events", async () => {
    const f = fixture({ inputs: [{}, {}] });
    const result = await f.run();
    assert.match(JSON.stringify(f.prompts[2]), /NO_PROGRESS/);
    assert.doesNotMatch(JSON.stringify(result.messages), /NO_PROGRESS/);
    assert.doesNotMatch(JSON.stringify(f.events), /NO_PROGRESS/);
    const prompt = f.prompts[2] as Array<{ role: string; content: unknown }>;
    assert.ok(prompt.some(message => message.role === "system" && JSON.stringify(message.content).includes("NO_PROGRESS")));
    assert.ok(!prompt.some(message => message.role !== "system" && JSON.stringify(message.content).includes("NO_PROGRESS")));
  });

  it("successful Runtime persistence excludes internal feedback and retains original read receipts", async () => {
    const f = fixture({ inputs: [{}, {}] });
    const store = new InMemoryAgentStore();
    const runtime = new DefaultAgentRuntime({ catalog: new InMemoryAgentCatalog([{ ...definition, tools: ["web_fetch"] }]), store, loop: f.loop, afterToolCall: f.afterToolCall });
    const handle = await runtime.run({ agentId: "test", threadId: "guard-persisted", messages: [userMessage()] });
    assert.equal((await handle.result).status, "completed");
    const persisted = await store.getMessages("guard-persisted");
    assert.doesNotMatch(JSON.stringify(persisted), /NO_PROGRESS|请换个方法/);
    assert.equal(persisted.flatMap(message => message.parts).filter(part => part.type === "dynamic-tool").length, 2);
    assert.match(JSON.stringify(f.prompts[2]), /NO_PROGRESS/);
    assert.doesNotMatch(JSON.stringify(await store.list(handle.runId)), /NO_PROGRESS/);
  });

  it("a two-argument cycle of the same built-in tool is also bounded", async () => {
    const f = fixture({ inputs: Array.from({ length: 6 }, (_, index) => ({ url: index % 2 ? "https://two.test" : "https://one.test" })) });
    await assert.rejects(f.run(), error => error instanceof AgentError && error.data.code === "RUN_LIMIT_EXCEEDED");
    assert.equal(f.counts().executions, 6);
  });

  it("changing either tool's business result breaks the repeated cycle", async () => {
    const names = ["web_fetch", "read_file", "web_fetch", "read_file", "web_fetch", "read_file"];
    const f = fixture({ names, inputs: Array.from({ length: 6 }, () => ({})), output: (invocation, name) => ({
      value: { text: `${name}-${Math.ceil(invocation / 2)}`, ...(name === "web_fetch" ? { fetchedAt: `${invocation}` } : {}) },
    }) });
    assert.equal((await f.run()).text, "done");
    assert.equal(f.counts().executions, 6);
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
  });

  it("a denied cycle step breaks continuity without bypassing its approval", async () => {
    let approvals = 0;
    const f = fixture({ inputs: Array.from({ length: 6 }, (_, index) => ({ url: index % 2 ? "https://two.test" : "https://one.test" })),
      beforeToolExecute: () => ++approvals === 4 ? { allow: false, reason: "denied" } : { allow: true } });
    assert.equal((await f.run()).text, "done");
    assert.equal(approvals, 6); assert.equal(f.counts().executions, 5);
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
  });

  it("new user steering after the second cycle clears both history and pending feedback", async () => {
    let pending = false, completed = 0, applied = 0;
    const steering: RunSteering = { signal: new AbortController().signal, hasPending: () => pending,
      drain: async () => { pending = false; return [{ id: "change", text: "这是新方向，请重新查看" }]; },
      applied: async () => { applied++; }, sealIfEmpty: () => !pending, close: async () => {} };
    const f = fixture({ steering, inputs: Array.from({ length: 6 }, (_, index) => ({ url: index % 2 ? "https://two.test" : "https://one.test" })),
      onEvent: event => { if (event.type === "tool.call.completed" && ++completed === 4) pending = true; } });
    const result = await f.run();
    assert.equal(result.text, "done"); assert.equal(f.counts().executions, 6); assert.equal(applied, 1);
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
    assert.ok(result.messages.some(message => message.role === "user" && JSON.stringify(message.metadata ?? {}).includes('"source":"steer"')));
  });

  it("cancellation after the second cycle takes priority over feedback or a third cycle", async () => {
    const abort = new AbortController(); let completed = 0;
    const f = fixture({ signal: abort.signal, inputs: Array.from({ length: 6 }, (_, index) => ({ url: index % 2 ? "https://two.test" : "https://one.test" })),
      onEvent: event => { if (event.type === "tool.call.completed" && ++completed === 4) abort.abort(new Error("cancel cycle")); } });
    await assert.rejects(f.run(), /cancel cycle/);
    assert.deepEqual(f.counts(), { modelCalls: 4, executions: 4 });
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
  });

  it("timestamp-only web results warn the next model step then stop honestly on the third call", async () => {
    const f = fixture();
    await assert.rejects(f.run(), error => error instanceof AgentError && error.data.code === "RUN_LIMIT_EXCEEDED" &&
      error.data.retryable === false && /重复查询.*没有新进展/.test(error.data.message));
    assert.deepEqual(f.counts(), { modelCalls: 3, executions: 3 });
    assert.match(JSON.stringify(f.prompts[2]), /NO_PROGRESS.*结果没有变化/);
    assert.equal(f.events.filter(event => event.type === "tool.call.completed").length, 3);
    assert.equal(f.events.filter(event => event.type === "tool.call.failed").length, 0);
    assert.deepEqual(f.events.filter(event => event.type === "tool.call.completed").map(event => event.data.output),
      [1, 2, 3].map(invocation => ({ ok: true, value: { text: "same", fetchedAt: `time-${invocation}` } })),
      "normalization affects comparison only, never the original result evidence");
  });

  it("the Runtime exposes the stuck reason as a failed Run rather than successful completion", async () => {
    const f = fixture();
    const runtime = new DefaultAgentRuntime({ catalog: new InMemoryAgentCatalog([{ ...definition, tools: ["web_fetch"] }]),
      store: new InMemoryAgentStore(), loop: f.loop, afterToolCall: f.afterToolCall });
    const handle = await runtime.run({ agentId: "test", threadId: "guard-visible", messages: [userMessage()] });
    const result = await handle.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "RUN_LIMIT_EXCEEDED");
    assert.match(result.error?.message ?? "", /重复查询 web_fetch 三次没有新进展/);
    assert.equal(f.counts().executions, 3);
  });

  it("all exact built-in file/search registration names participate in the guard", async () => {
    for (const name of ["read_file", "list_directory", "search_files", "web_search"]) {
      const f = fixture({ name, output: () => ({ ok: true, value: { text: "same" } }) });
      await assert.rejects(f.run(), error => error instanceof AgentError && error.data.code === "RUN_LIMIT_EXCEEDED", name);
      assert.equal(f.counts().executions, 3, name);
    }
  });

  it("canonical argument and business-result key order cannot evade the guard", async () => {
    const f = fixture({ name: "read_file", inputs: [{ path: "report.md", limit: 10 }, { limit: 10, path: "report.md" }, { path: "report.md", limit: 10 }],
      output: invocation => invocation % 2 ? { ok: true, value: { text: "same", mtime: "fixed" } } : { value: { mtime: "fixed", text: "same" }, ok: true } });
    await assert.rejects(f.run(), error => error instanceof AgentError && error.data.code === "RUN_LIMIT_EXCEEDED");
    assert.equal(f.counts().executions, 3);
  });

  it("changing business text, mtime or scheduled time is real progress", async () => {
    for (const field of ["text", "mtime", "runAt", "requestId"]) {
      const f = fixture({ name: "read_file", output: invocation => ({ value: { [field]: `${invocation}` } }) });
      assert.equal((await f.run()).text, "done", field);
      assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/, field);
    }
  });

  it("web normalization ignores only its exact fetchedAt field, not other timestamps", async () => {
    const f = fixture({ output: invocation => ({ value: { text: "same", fetchedAt: `${invocation}`, publishedAt: `${invocation}` } }) });
    assert.equal((await f.run()).text, "done");
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
  });

  it("changed arguments break the consecutive no-progress sequence", async () => {
    const f = fixture({ inputs: [{ url: "https://one.test" }, { url: "https://two.test" }, { url: "https://one.test" }] });
    assert.equal((await f.run()).text, "done");
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
  });

  it("the same loop instance isolates its no-progress state between Runs", async () => {
    const f = fixture({ inputs: [{ url: "https://example.com" }, { url: "https://example.com" }] });
    assert.equal((await f.run()).text, "done");
    f.resetModel();
    assert.equal((await f.run()).text, "done");
    assert.equal(f.counts().executions, 4);
  });

  it("legal polling and non-allowlisted read tools retain their original step budgets", async () => {
    for (const name of ["task_get", "task_list", "feed_read", "custom_read"]) {
      const f = fixture({ name, inputs: [{}, {}, {}, {}], output: () => ({ status: "scheduled", runAt: "fixed" }) });
      assert.equal((await f.run()).text, "done", name);
      assert.equal(f.counts().executions, 4, name);
      assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/, name);
    }
  });

  it("an allowlisted name is not sufficient for writes or unclassified effects", async () => {
    for (const metadata of [{ risk: "write" as const }, { idempotent: false }]) {
      const f = fixture({ ...metadata, name: "read_file", output: () => ({ ok: true }) });
      assert.equal((await f.run()).text, "done");
      assert.equal(f.counts().executions, 3);
    }
  });

  it("unknown write outcomes still stop immediately without replay or guard feedback", async () => {
    const f = fixture({ name: "write_file", risk: "write", idempotent: false, output: () => { throw new Error("lost acknowledgement"); } });
    const outcome = await f.run();
    assert.equal(outcome.stopReason, "failed");
    assert.ok(outcome.stopReason === "failed");
    assert.equal(outcome.error.code, "TOOL_OUTCOME_UNKNOWN");
    assert.match(JSON.stringify(outcome.messages), /TOOL_OUTCOME_UNKNOWN/);
    assert.deepEqual(f.counts(), { modelCalls: 1, executions: 1 });
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
  });

  it("a denied call breaks the successful consecutive sequence without bypassing approval", async () => {
    let approvals = 0;
    const f = fixture({ inputs: [{}, {}, {}, {}], beforeToolExecute: () => ++approvals === 2 ? { allow: false, reason: "denied" } : { allow: true } });
    assert.equal((await f.run()).text, "done");
    assert.equal(approvals, 4);
    assert.equal(f.counts().executions, 3);
  });

  it("cancellation after a repeat result prevents feedback and any next model request", async () => {
    const abort = new AbortController(); let completed = 0;
    const f = fixture({ signal: abort.signal, onEvent: event => {
      if (event.type === "tool.call.completed" && ++completed === 2) abort.abort(new Error("cancel guard"));
    } });
    await assert.rejects(f.run(), /cancel guard/);
    assert.deepEqual(f.counts(), { modelCalls: 2, executions: 2 });
    assert.doesNotMatch(JSON.stringify(f.prompts), /NO_PROGRESS/);
  });
});
