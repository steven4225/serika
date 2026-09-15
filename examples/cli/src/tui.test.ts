import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import type {
  AgentEvent,
  BeforeToolExecute,
  MessageStore,
  RunHandle,
  RunRequest,
  RunResult,
} from "@aisdk-agent/core";
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
import { createDemoModel } from "./demo-model.js";
import { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";
import { createModuleHost } from "./module-host.js";
import { createReadFileModule } from "./modules/read-file-module.js";
import type { ReadFileResult } from "./read-file.js";
import { createWriteFileTool } from "./write-file.js";
import { createToolConfirmation, runTui } from "./tui.js";

type TestRuntime = {
  requests: RunRequest[];
  runtime: {
    run<TContext>(request: RunRequest<TContext>): Promise<RunHandle>;
  };
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function outputBuffer(): Writable & { text(): string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { text(): string };
  output.text = () => chunks.join("");
  return output;
}

type AsyncQueue<T> = AsyncIterableIterator<T> & {
  push(value: T): void;
  close(): void;
};

function asyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = [];
  let closed = false;
  let waiter:
    | ((result: IteratorResult<T>) => void)
    | undefined;

  const iterator: AsyncQueue<T> = {
    next: () => {
      if (values.length > 0) {
        return Promise.resolve({
          done: false,
          value: values.shift() as T,
        });
      }
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise<IteratorResult<T>>((resolve) => {
        waiter = resolve;
      });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    push(value) {
      if (closed) throw new Error("Cannot push to a closed test queue");
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve({ done: false, value });
        return;
      }
      values.push(value);
    },
    close() {
      closed = true;
      if (waiter) {
        const resolve = waiter;
        waiter = undefined;
        resolve({ done: true, value: undefined });
      }
    },
  };
  return iterator;
}

function message(id: string, role: UIMessage["role"], text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function completedResult(
  runId: string,
  threadId: string,
  text: string,
): RunResult {
  return {
    runId,
    threadId,
    status: "completed",
    text,
    steps: 1,
    usage: {},
  };
}

function cancelledResult(runId: string, threadId: string): RunResult {
  return {
    runId,
    threadId,
    status: "cancelled",
    text: "",
    steps: 0,
    usage: {},
    error: {
      code: "RUN_CANCELLED",
      message: "Agent run was cancelled",
      retryable: false,
      phase: "runtime",
    },
  };
}

function failedResult(runId: string, threadId: string): RunResult {
  return {
    runId,
    threadId,
    status: "failed",
    text: "",
    steps: 1,
    usage: {},
    error: {
      code: "MODEL_BAD_RESPONSE",
      message: "Model stream returned an error",
      retryable: false,
      phase: "model",
    },
  };
}

function messageDeltaEvent(
  runId: string,
  threadId: string,
  text: string,
): AgentEvent {
  return {
    id: `${runId}-event-1`,
    type: "message.delta",
    occurredAt: new Date(0).toISOString(),
    runId,
    threadId,
    sequence: 1,
    data: { text },
  };
}

function completedEvent(runId: string, threadId: string): AgentEvent {
  return {
    id: `${runId}-event-2`,
    type: "run.completed",
    occurredAt: new Date(0).toISOString(),
    runId,
    threadId,
    sequence: 2,
    data: { text: "event result", steps: 1, usage: {} },
  };
}

function toolRequestedEvent(
  runId: string,
  threadId: string,
  toolName: string,
): AgentEvent {
  return {
    id: `${runId}-tool-requested`,
    type: "tool.call.requested",
    occurredAt: new Date(0).toISOString(),
    runId,
    threadId,
    sequence: 1,
    data: { toolCallId: `${runId}-tool-call`, toolName, input: {} },
  };
}

function toolCompletedEvent(
  runId: string,
  threadId: string,
  toolName: string,
  output: unknown,
): AgentEvent {
  return {
    id: `${runId}-tool-completed`,
    type: "tool.call.completed",
    occurredAt: new Date(0).toISOString(),
    runId,
    threadId,
    sequence: 2,
    data: {
      toolCallId: `${runId}-tool-call`,
      toolName,
      output,
    },
  };
}

function handleFor(options: {
  runId: string;
  threadId: string;
  events: AsyncIterable<AgentEvent>;
  result: Promise<RunResult>;
  cancel?: (reason?: string) => Promise<void>;
}): RunHandle {
  return {
    runId: options.runId,
    events: options.events,
    result: options.result,
    cancel: options.cancel ?? (async () => undefined),
  };
}

function testRuntime(handles: RunHandle[]): TestRuntime {
  const requests: RunRequest[] = [];
  return {
    requests,
    runtime: {
      async run<TContext>(request: RunRequest<TContext>): Promise<RunHandle> {
        requests.push(request as RunRequest);
        const handle = handles.shift();
        if (!handle) throw new Error("Unexpected run request");
        return handle;
      },
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for test condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function ttyInput(): PassThrough & { isTTY: boolean } {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  return input;
}

function ttyOutput(): Writable & { isTTY: boolean; text(): string } {
  const output = outputBuffer() as Writable & {
    isTTY: boolean;
    text(): string;
  };
  output.isTTY = true;
  return output;
}

function pressCtrlC(input: PassThrough): void {
  input.emit("keypress", "", {
    name: "c",
    ctrl: true,
    sequence: "\u0003",
  });
}

const tuiOptions = {
  threadId: "thread-1",
  agentId: "calculator",
  generateId: () => "new-user-id",
};

class CountingStore extends InMemoryAgentStore {
  saveCount = 0;
  runIds: string[] = [];

  override async create(record: Parameters<InMemoryAgentStore["create"]>[0]): Promise<void> {
    this.runIds.push(record.id);
    await super.create(record);
  }

  override async save(threadId: string, messages: UIMessage[]): Promise<void> {
    this.saveCount += 1;
    await super.save(threadId, messages);
  }
}

function createConfirmationRuntime(
  output: Writable,
  options: { totalTimeoutMs?: number } = {},
): {
  runtime: DefaultAgentRuntime;
  store: CountingStore;
  confirmation: ReturnType<typeof createToolConfirmation>;
  executeCount: { value: number };
} {
  const confirmation = createToolConfirmation(output);
  const store = new CountingStore();
  const executeCount = { value: 0 };
  const add = tool({
    description: "Add two numbers",
    inputSchema: z.object({ left: z.number(), right: z.number() }),
    outputSchema: z.object({ value: z.number() }),
    execute: async ({ left, right }) => {
      executeCount.value += 1;
      return { value: left + right };
    },
  });
  const runtime = new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([
      {
        id: "calculator",
        version: "1",
        instructions: "Use the add tool when arithmetic is requested.",
        model: "mock",
        tools: ["add"],
        limits: {
          maxSteps: 4,
          totalTimeoutMs: options.totalTimeoutMs ?? 5_000,
          stepTimeoutMs: 1_000,
        },
      },
    ]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ mock: createDemoModel() }),
      tools: new ToolRegistry([
        {
          metadata: {
            name: "add",
            version: "1",
            risk: "read",
            timeoutMs: 1_000,
            idempotent: true,
          },
          tool: add,
        },
      ]),
    }),
    beforeToolExecute: confirmation.beforeToolExecute,
    store,
  });
  return { runtime, store, confirmation, executeCount };
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function promptAfterLastUser(prompt: unknown): unknown[] {
  if (!Array.isArray(prompt)) return [];
  let lastUser = -1;
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const item = prompt[index];
    if (isRecord(item) && item.role === "user") {
      lastUser = index;
      break;
    }
  }
  return lastUser === -1 ? [] : prompt.slice(lastUser + 1);
}

function currentTurnToolResults(prompt: unknown): RecordValue[] {
  const results: RecordValue[] = [];
  for (const message of promptAfterLastUser(prompt)) {
    if (!isRecord(message) || message.role !== "tool" || !Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (isRecord(part) && part.type === "tool-result") results.push(part);
    }
  }
  return results;
}

function readFileModelUsage() {
  return {
    inputTokens: {
      total: 10,
      noCache: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 8,
      text: 8,
      reasoning: undefined,
    },
  };
}

function readFileTextResponse(text: string) {
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
          usage: readFileModelUsage(),
        },
      ],
    }),
  };
}

function readFileCallResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "call-read-file",
          toolName: "read_file",
          input: JSON.stringify({ path: "notes.txt" }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: readFileModelUsage(),
        },
      ],
    }),
  };
}

function writeFileUsage() {
  return {
    inputTokens: {
      total: 10,
      noCache: 10,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 8,
      text: 8,
      reasoning: undefined,
    },
  };
}

function writeFileTextResponse(text: string) {
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
          usage: writeFileUsage(),
        },
      ],
    }),
  };
}

function writeFileCallResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "call-write-file",
          toolName: "write_file",
          input: JSON.stringify({ path: "created.txt", content: "created" }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: writeFileUsage(),
        },
      ],
    }),
  };
}

function createWriteFileModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const results = currentTurnToolResults(prompt);
      if (results.length > 0) {
        const output = results[0]?.output;
        if (isRecord(output) && output.type === "error-text") {
          return writeFileTextResponse("The write was denied.");
        }
        return writeFileTextResponse("The file was written.");
      }
      return writeFileCallResponse();
    },
  });
}

async function createWriteFileConfirmationRuntime(options: {
  failAfterWrite?: boolean;
} = {}): Promise<{
  runtime: DefaultAgentRuntime;
  store: CountingStore;
  confirmation: ReturnType<typeof createToolConfirmation>;
  output: Writable & { text(): string };
  workspace: string;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "runloom-tui-write-file-"));
  const output = ttyOutput();
  const confirmation = createToolConfirmation(output);
  const store = new CountingStore();
  const runtime = new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([
      {
        id: "calculator",
        version: "1",
        instructions: "Use write_file when asked to create a file.",
        model: "mock",
        tools: ["write_file"],
        limits: {
          maxSteps: options.failAfterWrite === true ? 1 : 4,
          totalTimeoutMs: 5_000,
          stepTimeoutMs: 1_000,
        },
      },
    ]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({
        mock: createWriteFileModel(),
      }),
      tools: new ToolRegistry([
        {
          metadata: {
            name: "write_file",
            version: "1",
            risk: "write",
            timeoutMs: 1_000,
            idempotent: false,
          },
          tool: createWriteFileTool(workspace),
        },
      ]),
    }),
    beforeToolExecute: confirmation.beforeToolExecute,
    store,
  });
  return { runtime, store, confirmation, output, workspace };
}

function createReadFileModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const results = currentTurnToolResults(prompt);
      const output = results[0]?.output;
      if (isRecord(output) && output.type === "error-text") {
        return readFileTextResponse("The requested file read was denied.");
      }
      if (isRecord(output) && output.type === "json" && isRecord(output.value)) {
        if (output.value.ok === true && typeof output.value.content === "string") {
          return readFileTextResponse(`The file says: ${output.value.content}`);
        }
      }
      return readFileCallResponse();
    },
  });
}

async function createReadFileConfirmationRuntime(options: {
  totalTimeoutMs?: number;
} = {}): Promise<{
  runtime: DefaultAgentRuntime;
  store: CountingStore;
  confirmation: ReturnType<typeof createToolConfirmation>;
  output: Writable & { text(): string };
  readCount: { value: number };
  workspace: string;
  dispose(): void;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "runloom-tui-read-file-"));
  await writeFile(join(workspace, "notes.txt"), "hello from workspace");

  const output = ttyOutput();
  const confirmation = createToolConfirmation(output);
  const store = new CountingStore();
  const readCount = { value: 0 };
  const host = createModuleHost([createReadFileModule(workspace)], {
    notify: (_moduleId, message) => output.write(message),
  });
  const readFile = host.tools[0]!.tool;
  const execute = readFile.execute as unknown as (
    input: { path: string },
    toolOptions: Parameters<NonNullable<typeof readFile.execute>>[1],
  ) => Promise<ReadFileResult>;
  readFile.execute = async (input, toolOptions) => {
    readCount.value += 1;
    return execute(input, toolOptions);
  };

  const runtime = new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([
      {
        id: "calculator",
        version: "1",
        instructions: "Use read_file when the user asks about the workspace file.",
        model: "mock",
        tools: ["read_file"],
        limits: {
          maxSteps: 4,
          totalTimeoutMs: options.totalTimeoutMs ?? 5_000,
          stepTimeoutMs: 1_000,
        },
      },
    ]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ mock: createReadFileModel() }),
      tools: new ToolRegistry(host.tools),
    }),
    beforeToolExecute: confirmation.beforeToolExecute,
    store,
  });

  return {
    runtime,
    store,
    confirmation,
    output,
    readCount,
    workspace,
    dispose: () => host.dispose(),
  };
}

function toolInput(
  toolName: string,
  signal: AbortSignal,
  input: unknown = { value: 1 },
): Parameters<BeforeToolExecute>[0] {
  return {
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    definition: {
      id: "test",
      version: "1",
      instructions: "",
      model: "mock",
      tools: [toolName],
      limits: { maxSteps: 1, totalTimeoutMs: 1_000, stepTimeoutMs: 1_000 },
    },
    signal,
  };
}

describe("runTui", () => {
  it("renders committed history but sends exactly one new user message", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    events.close();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.resolve(
          completedResult("run-1", "thread-1", "answer from result"),
        ),
      }),
    ]);
    let loadedThreadId: string | undefined;
    const store: Pick<MessageStore, "getMessages"> = {
      async getMessages(threadId) {
        loadedThreadId = threadId;
        return [
          message("old-user", "user", "old user message"),
          {
            id: "old-assistant",
            role: "assistant",
            parts: [
              { type: "text", text: "old assistant answer" },
              {
                type: "dynamic-tool",
                toolName: "add",
                toolCallId: "call-add",
                state: "output-available",
                input: { left: 20, right: 22 },
                output: { value: 42 },
              },
            ],
          },
          {
            id: "old-auto",
            role: "user",
            metadata: { source: AUTO_CONSOLIDATION_SOURCE },
            parts: [{ type: "text", text: "自动整理请求" }],
          },
        ];
      },
    };

    input.write("new prompt\n");
    input.end();
    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store, input, output });
    await tui;

    assert.equal(loadedThreadId, "thread-1");
    assert.equal(runtime.requests.length, 1);
    assert.equal(runtime.requests[0]?.messages.length, 1);
    assert.deepEqual(runtime.requests[0]?.messages[0], message("new-user-id", "user", "new prompt"));
    assert.match(output.text(), /old user message/);
    assert.match(output.text(), /old assistant answer/);
    assert.match(output.text(), /\[tool add\] \{"value":42\}/);
    assert.match(output.text(), /auto-consolidation: 自动整理请求/);
    assert.match(output.text(), /answer from result/);
  });

  it("does not reprint the last-step result after streaming deltas", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.resolve(
          completedResult("run-1", "thread-1", "final answer"),
        ),
      }),
    ]);
    const store: Pick<MessageStore, "getMessages"> = {
      async getMessages() {
        return [];
      },
    };

    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store, input, output });
    await nextTurn();
    input.write("prompt\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(messageDeltaEvent("run-1", "thread-1", "partial "));
    events.push({
      id: "run-1-event-2",
      type: "message.delta",
      occurredAt: new Date(0).toISOString(),
      runId: "run-1",
      threadId: "thread-1",
      sequence: 2,
      data: { text: "stream" },
    });
    events.close();
    input.end();
    await tui;

    assert.match(output.text(), /partial stream/);
    assert.equal(output.text().includes("final answer"), false);
  });

  it("runs one marked consolidation turn after a completed user run", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const firstEvents = asyncQueue<AgentEvent>();
    firstEvents.close();
    const secondEvents = asyncQueue<AgentEvent>();
    secondEvents.close();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events: firstEvents,
        result: Promise.resolve(completedResult("run-1", "thread-1", "first")),
      }),
      handleFor({
        runId: "run-2",
        threadId: "thread-1",
        events: secondEvents,
        result: Promise.resolve(completedResult("run-2", "thread-1", "consolidated")),
      }),
    ]);

    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      autoConsolidationAgentId: "memory-consolidator",
    });
    await nextTurn();
    input.write("user prompt\n");
    await waitFor(() => runtime.requests.length === 2);

    assert.equal(runtime.requests[0]?.agentId, "calculator");
    assert.equal(runtime.requests[1]?.agentId, "memory-consolidator");
    assert.equal(runtime.requests[1]?.threadId, "thread-1");
    assert.deepEqual(runtime.requests[1]?.messages[0]?.metadata, {
      source: "auto-consolidation",
    });
    assert.equal(runtime.requests[1]?.messages[0]?.role, "user");
    assert.match(output.text(), /正在自动整理记忆/);
    input.end();
    await tui;
    assert.equal(runtime.requests.length, 2);
  });

  it("skips consolidation when the user run requests a memory tool", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.resolve(completedResult("run-1", "thread-1", "saved")),
      }),
    ]);

    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      autoConsolidationAgentId: "memory-consolidator",
    });
    await nextTurn();
    input.write("save memory\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(toolRequestedEvent("run-1", "thread-1", "memory_add"));
    events.close();
    await waitFor(() => output.text().includes("saved"));

    input.end();
    await tui;
    assert.equal(runtime.requests.length, 1);
  });

  it("does not consolidate a non-completed user run", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const events = asyncQueue<AgentEvent>();
    events.close();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.resolve(cancelledResult("run-1", "thread-1")),
      }),
    ]);

    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      autoConsolidationAgentId: "memory-consolidator",
    });
    await nextTurn();
    input.write("cancelled prompt\n");
    await waitFor(() => output.text().includes("Run cancelled"));
    input.end();
    await tui;

    assert.equal(runtime.requests.length, 1);
  });

  it("keeps the original result when consolidation fails", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const firstEvents = asyncQueue<AgentEvent>();
    firstEvents.close();
    const secondEvents = asyncQueue<AgentEvent>();
    secondEvents.close();
    const failedResult = deferred<RunResult>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events: firstEvents,
        result: Promise.resolve(completedResult("run-1", "thread-1", "original")),
      }),
      handleFor({
        runId: "run-2",
        threadId: "thread-1",
        events: secondEvents,
        result: failedResult.promise,
      }),
    ]);

    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      autoConsolidationAgentId: "memory-consolidator",
    });
    await nextTurn();
    input.write("user prompt\n");
    await waitFor(() => runtime.requests.length === 2);
    failedResult.reject(new Error("consolidation unavailable"));
    await waitFor(() => output.text().includes("Automatic consolidation failed"));

    input.end();
    await tui;
    assert.match(output.text(), /original/);
    assert.equal(runtime.requests.length, 2);
  });

  it("cancels a consolidation that is still starting on Ctrl+C", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const firstEvents = asyncQueue<AgentEvent>();
    firstEvents.close();
    const firstHandle = handleFor({
      runId: "run-1",
      threadId: "thread-1",
      events: firstEvents,
      result: Promise.resolve(completedResult("run-1", "thread-1", "original")),
    });
    const secondEvents = asyncQueue<AgentEvent>();
    secondEvents.close();
    const consolidationStarted = deferred<RunHandle>();
    const cancelReasons: (string | undefined)[] = [];
    const requests: RunRequest[] = [];
    const runtime = {
      async run<TContext>(request: RunRequest<TContext>): Promise<RunHandle> {
        requests.push(request as RunRequest);
        if (requests.length === 1) return firstHandle;
        return consolidationStarted.promise;
      },
    };

    const tui = runTui({
      ...tuiOptions,
      runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      autoConsolidationAgentId: "memory-consolidator",
    });
    await nextTurn();
    input.write("user prompt\n");
    await waitFor(() => requests.length === 2);
    input.write("should wait\n");
    await waitFor(() => output.text().includes("Busy: wait for the current run to finish."));
    pressCtrlC(input);
    consolidationStarted.resolve(
      handleFor({
        runId: "run-2",
        threadId: "thread-1",
        events: secondEvents,
        result: Promise.resolve(cancelledResult("run-2", "thread-1")),
        cancel: async (reason) => {
          cancelReasons.push(reason);
        },
      }),
    );
    await waitFor(() => output.text().includes("Run cancelled"));

    input.end();
    await tui;
    assert.deepEqual(cancelReasons, ["user_interrupt"]);
    assert.equal(requests.length, 2);
  });

  it("rejects input while running, renders events, and returns idle only after result", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const firstEvents = asyncQueue<AgentEvent>();
    const firstResult = deferred<RunResult>();
    const secondEvents = asyncQueue<AgentEvent>();
    secondEvents.close();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events: firstEvents,
        result: firstResult.promise,
      }),
      handleFor({
        runId: "run-2",
        threadId: "thread-1",
        events: secondEvents,
        result: Promise.resolve(
          completedResult("run-2", "thread-1", "second result"),
        ),
      }),
    ]);
    const store: Pick<MessageStore, "getMessages"> = {
      async getMessages() {
        return [];
      },
    };

    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store, input, output });
    await nextTurn();
    input.write("first prompt\n");
    await waitFor(() => runtime.requests.length === 1);

    firstEvents.push(messageDeltaEvent("run-1", "thread-1", "event text"));
    firstEvents.push(completedEvent("run-1", "thread-1"));
    firstEvents.close();
    input.write("queued prompt\n");
    await waitFor(() => output.text().includes("Busy: wait for the current run to finish."));
    assert.equal(runtime.requests.length, 1);

    firstResult.resolve(completedResult("run-1", "thread-1", "first result"));
    await waitFor(() => output.text().includes("event text"));
    await nextTurn();
    input.write("third prompt\n");
    await waitFor(() => runtime.requests.length === 2);
    input.end();
    await tui;

    assert.match(output.text(), /event text/);
    assert.doesNotMatch(output.text(), /first result/);
    assert.match(output.text(), /second result/);
    assert.deepEqual(
      runtime.requests.map((request) => request.messages[0]?.parts),
      [
        [{ type: "text", text: "first prompt" }],
        [{ type: "text", text: "third prompt" }],
      ],
    );
  });

  it("cancels a running handle on Ctrl+C and waits for its result", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const events = asyncQueue<AgentEvent>();
    events.close();
    const result = deferred<RunResult>();
    const cancelReasons: (string | undefined)[] = [];
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: result.promise,
        cancel: async (reason) => {
          cancelReasons.push(reason);
        },
      }),
    ]);
    const store: Pick<MessageStore, "getMessages"> = {
      async getMessages() {
        return [];
      },
    };

    let settled = false;
    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store, input, output });
    tui.finally(() => {
      settled = true;
    });
    await nextTurn();
    input.write("long prompt\n");
    await waitFor(() => runtime.requests.length === 1);
    pressCtrlC(input);
    await waitFor(() => cancelReasons.length === 1);
    assert.deepEqual(cancelReasons, ["user_interrupt"]);
    assert.equal(settled, false);

    result.resolve(cancelledResult("run-1", "thread-1"));
    await waitFor(() => output.text().includes("Run cancelled"));
    input.end();
    await tui;
  });

  it("reports a result rejection as a run completion failure", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    events.close();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.reject(new Error("finalization unavailable")),
      }),
    ]);
    const store: Pick<MessageStore, "getMessages"> = {
      async getMessages() {
        return [];
      },
    };

    input.write("prompt\n");
    input.end();
    await runTui({ ...tuiOptions, runtime: runtime.runtime, store, input, output });

    assert.match(output.text(), /Run could not finish: Error: finalization unavailable/);
    assert.doesNotMatch(output.text(), /Run could not start/);
  });

  it("reports a completed edit_file action when the run fails afterward", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.resolve(failedResult("run-1", "thread-1")),
      }),
    ]);

    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
    });
    await nextTurn();
    input.write("Update notes.\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-1", "thread-1", "edit_file", {
        ok: true,
        path: "notes/today.md",
        bytes: 17,
      }),
    );
    events.close();
    input.end();
    await tui;

    assert.match(
      output.text(),
      /已完成的操作：\n- edit_file: notes\/today\.md \(17 bytes\)/,
    );
  });

  it("reports a started pomodoro when the run fails afterward", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-pomodoro",
        threadId: "thread-pomodoro",
        events,
        result: Promise.resolve(failedResult("run-pomodoro", "thread-pomodoro")),
      }),
    ]);

    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
    });
    await nextTurn();
    input.write("保存资料并开始一个番茄钟。\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-pomodoro", "thread-pomodoro", "pomodoro_start", {
        outcome: "started",
        status: {
          state: "running",
          durationMinutes: 25,
          endsAt: "2026-09-15T01:25:00.000Z",
          remainingSeconds: 1_500,
        },
      }),
    );
    events.close();
    input.end();
    await tui;

    assert.match(
      output.text(),
      /已完成的操作：\n- pomodoro_start: 已启动 25 分钟番茄钟，预计 2026-09-15T01:25:00\.000Z 结束。/,
    );
  });

  it("exits when Ctrl+C is pressed while idle without submitting a run", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const store: Pick<MessageStore, "getMessages"> = {
      async getMessages() {
        return [];
      },
    };

    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store, input, output });
    await nextTurn();
    pressCtrlC(input);
    await tui;

    assert.equal(runtime.requests.length, 0);
  });

  it("dispatches idle slash commands with the complete argument string", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const args: string[] = [];
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      commands: new Map([
        ["workspace", { execute: (value: string) => args.push(value) }],
      ]),
    });

    await nextTurn();
    input.write("  /workspace   one  two  \n");
    await waitFor(() => args.length === 1);
    assert.deepEqual(args, ["one  two"]);
    assert.equal(runtime.requests.length, 0);
    assert.ok((output.text().match(/> /g) ?? []).length >= 2);
    input.end();
    await tui;
  });

  it("runs /workspace on the shared output without starting a run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-tui-module-"));
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const host = createModuleHost([createReadFileModule(workspace)], {
      notify: (moduleId, message) =>
        output.write(`[module:${moduleId}] ${message}\n`),
    });
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      commands: host.commands,
    });

    try {
      await nextTurn();
      input.write("/workspace\n");
      await waitFor(() =>
        output.text().includes(`[module:read-file] ${workspace}`),
      );
      assert.equal(runtime.requests.length, 0);
      input.end();
      await tui;
    } finally {
      host.dispose();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("treats unknown slash commands, including bare slash, as local errors", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      commands: new Map(),
    });

    await nextTurn();
    input.write("/\n/does-not-exist\n");
    await waitFor(() => output.text().includes("Unknown command: /does-not-exist"));
    input.end();
    await tui;

    assert.equal(runtime.requests.length, 0);
    assert.match(output.text(), /Unknown command: \/\n/);
  });

  it("lets pending confirmation consume slash input before command dispatch", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const lines: string[] = [];
    const commandCalls: string[] = [];
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      toolConfirmation: {
        beforeToolExecute: async () => ({ allow: true }),
        handleLine: (line) => {
          lines.push(line);
          return true;
        },
      },
      commands: new Map([
        ["workspace", { execute: (args: string) => commandCalls.push(args) }],
      ]),
    });

    await nextTurn();
    input.write("/workspace\n");
    await waitFor(() => lines.length === 1);
    input.end();
    await tui;

    assert.deepEqual(lines, ["/workspace"]);
    assert.deepEqual(commandCalls, []);
    assert.equal(runtime.requests.length, 0);
  });

  it("reports Busy for slash input while a run is starting", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const started = deferred<RunHandle>();
    const events = asyncQueue<AgentEvent>();
    events.close();
    const requests: RunRequest[] = [];
    const runtime = {
      async run<TContext>(request: RunRequest<TContext>): Promise<RunHandle> {
        requests.push(request as RunRequest);
        return started.promise;
      },
    };
    const commandCalls: string[] = [];
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      commands: new Map([
        ["workspace", { execute: (args: string) => commandCalls.push(args) }],
      ]),
    });

    await nextTurn();
    input.write("first prompt\n");
    await waitFor(() => requests.length === 1);
    input.write("/workspace\n");
    await waitFor(() => output.text().includes("Busy: wait for the current run to finish."));
    assert.deepEqual(commandCalls, []);

    started.resolve(
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.resolve(completedResult("run-1", "thread-1", "done")),
      }),
    );
    await waitFor(() => output.text().includes("done"));
    input.end();
    await tui;
  });

  it("reports Busy for slash input while a run is active", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const events = asyncQueue<AgentEvent>();
    events.close();
    const result = deferred<RunResult>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: result.promise,
      }),
    ]);
    const commandCalls: string[] = [];
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      commands: new Map([
        ["workspace", { execute: (args: string) => commandCalls.push(args) }],
      ]),
    });

    await nextTurn();
    input.write("first prompt\n");
    await waitFor(() => runtime.requests.length === 1);
    input.write("/workspace\n");
    await waitFor(() => output.text().includes("Busy: wait for the current run to finish."));
    assert.deepEqual(commandCalls, []);

    result.resolve(completedResult("run-1", "thread-1", "done"));
    await waitFor(() => output.text().includes("done"));
    input.end();
    await tui;
  });
});

describe("createToolConfirmation", () => {
  it("allows pomodoro tools without asking for y or n", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);

    for (const toolName of [
      "pomodoro_start",
      "pomodoro_status",
      "pomodoro_cancel",
    ]) {
      const pending = confirmation.beforeToolExecute(
        toolInput(toolName, new AbortController().signal),
      );
      assert.deepEqual(
        await Promise.resolve(pending),
        { allow: true },
      );
    }
    assert.equal(output.text(), "");
  });

  it("still rejects an already aborted pomodoro call", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await assert.rejects(
      Promise.resolve(
        confirmation.beforeToolExecute(toolInput("pomodoro_start", controller.signal)),
      ),
      /cancelled/,
    );
    assert.equal(output.text(), "");
  });

  it("identifies a read_file path and explains where file contents go", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);
    const pending = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/usage.md",
      }),
    );

    assert.match(output.text(), /Tool: read_file/);
    assert.match(output.text(), /Path: "docs\/usage\.md"/);
    assert.match(output.text(), /model context/);
    assert.match(output.text(), /committed transcript/);
    assert.doesNotMatch(output.text(), /Input:.*usage/);

    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await pending, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("shows the complete write_file confirmation input as JSON fields", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);
    const pending = confirmation.beforeToolExecute(
      toolInput("write_file", new AbortController().signal, {
        path: "notes/escape\n.txt",
        content: "hello\u001b[2J",
      }),
    );

    assert.match(output.text(), /Tool: write_file/);
    assert.match(output.text(), /Path: "notes\/escape\\n\.txt"/);
    assert.match(output.text(), /Content: "hello\\u001b\[2J"/);
    assert.doesNotMatch(output.text(), /Input:/);

    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await pending, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("shows the complete edit_file old and new text as JSON fields", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);
    const pending = confirmation.beforeToolExecute(
      toolInput("edit_file", new AbortController().signal, {
        path: "notes.txt",
        oldText: "port=3000\n",
        newText: "port=4000\n",
      }),
    );

    assert.match(output.text(), /Tool: edit_file/);
    assert.match(output.text(), /Path: "notes\.txt"/);
    assert.match(output.text(), /Old text: "port=3000\\n"/);
    assert.match(output.text(), /New text: "port=4000\\n"/);
    assert.doesNotMatch(output.text(), /Input:/);

    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await pending, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("supports an asynchronous custom confirmation prompt and keeps the default for other tools", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      prompt: async ({ toolName, input }) =>
        toolName === "memory_update"
          ? `Current memory: ${JSON.stringify(input)}\nAllow this call? [y/n] `
          : undefined,
    });
    const pending = confirmation.beforeToolExecute(
      toolInput("memory_update", new AbortController().signal, {
        id: "memory-1",
        text: "new text",
      }),
    );

    await Promise.resolve();
    assert.match(output.text(), /Current memory: \{"id":"memory-1","text":"new text"\}/);
    assert.doesNotMatch(output.text(), /Tool: memory_update/);
    assert.equal(confirmation.handleLine("y"), true);
    assert.deepEqual(await pending, { allow: true });

    const fallback = confirmation.beforeToolExecute(
      toolInput("add", new AbortController().signal, { left: 1, right: 2 }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: add/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await fallback, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("registers pending state before a synchronous prompt writer can answer", async () => {
    let confirmation!: ReturnType<typeof createToolConfirmation>;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        assert.equal(confirmation.handleLine("y"), true);
        callback();
      },
    });
    confirmation = createToolConfirmation(output);

    const decision = confirmation.beforeToolExecute(
      toolInput("add", new AbortController().signal),
    );

    assert.deepEqual(await decision, { allow: true });
  });

  it("keeps invalid input pending and treats abort as cancellation, not denial", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);
    const controller = new AbortController();
    const pending = Promise.resolve(
      confirmation.beforeToolExecute(toolInput("add", controller.signal)),
    );

    assert.match(output.text(), /Allow this call\? \[y\/n\]/);
    assert.equal(confirmation.handleLine("maybe"), true);
    assert.match(output.text(), /Please enter y or n/);

    controller.abort("run stopped");
    const reason = await pending.then(
      () => new Error("confirmation unexpectedly resolved"),
      (error: unknown) => error,
    );
    assert.equal(reason, "run stopped");
    assert.equal(confirmation.handleLine("y"), false);
  });

  it("registers one pending confirmation before prompting and clears it on y or n", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);
    const first = Promise.resolve(
      confirmation.beforeToolExecute(
        toolInput("add", new AbortController().signal),
      ),
    );

    assert.throws(
      () =>
        confirmation.beforeToolExecute(
          toolInput("other", new AbortController().signal),
        ),
      /already pending/,
    );
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await first, {
      allow: false,
      reason: "User denied this tool call",
    });
    assert.equal(confirmation.handleLine("y"), false);

    const second = Promise.resolve(
      confirmation.beforeToolExecute(
        toolInput("add", new AbortController().signal),
      ),
    );
    assert.equal(confirmation.handleLine("y"), true);
    assert.deepEqual(await second, { allow: true });
  });
});

describe("runTui tool confirmation", () => {
  it("executes a tool only after y and commits the completed transcript", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output);
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("What is 20 + 22?\n");
    await waitFor(() => output.text().includes("Allow this call? [y/n]"));
    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, 0);

    input.write("y\n");
    await waitFor(() => output.text().includes("20 + 22 = 42"));
    assert.equal(executeCount.value, 1);
    await waitFor(() => store.saveCount === 1);
    input.end();
    await tui;
    assert.equal(store.saveCount, 1);
  });

  it("turns n into a tool denial that the model can answer", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output);
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("What is 20 + 22?\n");
    await waitFor(() => output.text().includes("Allow this call? [y/n]"));
    input.write("n\n");
    await waitFor(() => output.text().includes("The add tool was denied."));
    assert.equal(executeCount.value, 0);
    await waitFor(() => store.saveCount === 1);
    input.end();
    await tui;

    assert.equal(store.saveCount, 1);
    assert.match(JSON.stringify(await store.getMessages("thread-1")), /TOOL_DENIED/);
  });

  it("cancels a pending confirmation without saving or executing the tool", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output);
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("What is 20 + 22?\n");
    await waitFor(() => output.text().includes("Allow this call? [y/n]"));
    pressCtrlC(input);
    await waitFor(() => output.text().includes("Run cancelled"));
    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, 0);
    input.end();
    await tui;
  });

  it("times out while confirmation is pending without executing or saving", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output, { totalTimeoutMs: 30 });
    await store.save("thread-1", [message("committed", "user", "old transcript")]);
    const savedBeforeRun = await store.getMessages("thread-1");
    const saveCountBeforeRun = store.saveCount;
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("What is 20 + 22?\n");
    await waitFor(() => output.text().includes("Allow this call? [y/n]"));
    await waitFor(() => output.text().includes("Run timed_out"));
    input.end();
    await tui;

    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, saveCountBeforeRun);
    assert.deepEqual(await store.getMessages("thread-1"), savedBeforeRun);
    const run = await store.getRun(store.runIds[0] as string);
    assert.equal(run?.status, "timed_out");
    assert.equal(run?.result?.error?.code, "RUN_TIMEOUT");
  });

  it("cancels a pending confirmation when stdin closes", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output);
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("What is 20 + 22?\n");
    await waitFor(() => output.text().includes("Allow this call? [y/n]"));
    input.end();
    await tui;

    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, 0);
    assert.match(output.text(), /Run cancelled/);
  });

  it("cancels a run that is still starting when Ctrl+C arrives", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const started = deferred<RunHandle>();
    const events = asyncQueue<AgentEvent>();
    events.close();
    const cancelReasons: (string | undefined)[] = [];
    const requests: RunRequest[] = [];
    const runtime = {
      async run<TContext>(request: RunRequest<TContext>): Promise<RunHandle> {
        requests.push(request as RunRequest);
        return started.promise;
      },
    };
    const handle = handleFor({
      runId: "run-starting",
      threadId: "thread-1",
      events,
      result: Promise.resolve(cancelledResult("run-starting", "thread-1")),
      cancel: async (reason) => {
        cancelReasons.push(reason);
      },
    });

    const tui = runTui({ ...tuiOptions, runtime, store: { getMessages: async () => [] }, input, output });
    await nextTurn();
    input.write("starting prompt\n");
    await waitFor(() => requests.length === 1);
    pressCtrlC(input);
    started.resolve(handle);
    await waitFor(() => output.text().includes("Run cancelled"));
    assert.deepEqual(cancelReasons, ["user_interrupt"]);
    input.end();
    await tui;
  });

  it("keeps the TUI alive after Ctrl+C so the next run gets a fresh confirmation", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output);
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("First calculation\n");
    await waitFor(() => output.text().includes("Allow this call? [y/n]"));
    pressCtrlC(input);
    await waitFor(() => output.text().includes("Run cancelled"));
    assert.equal(executeCount.value, 0);
    assert.equal(store.saveCount, 0);

    input.write("Second calculation\n");
    await waitFor(
      () => (output.text().match(/Allow this call\? \[y\/n\]/g) ?? []).length === 2,
    );
    assert.equal(executeCount.value, 0);
    input.write("y\n");
    await waitFor(() => output.text().includes("20 + 22 = 42"));
    await waitFor(() => store.saveCount === 1);
    input.end();
    await tui;

    assert.equal(executeCount.value, 1);
    assert.equal(store.saveCount, 1);
  });

  it("asks again on a new turn even when the committed previous result was 42", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output);
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("First calculation\n");
    await waitFor(() => output.text().includes("Allow this call? [y/n]"));
    input.write("y\n");
    await waitFor(() => output.text().includes("20 + 22 = 42"));
    await waitFor(() => store.saveCount === 1);

    input.write("Second calculation\n");
    await waitFor(
      () => (output.text().match(/Allow this call\? \[y\/n\]/g) ?? []).length === 2,
    );
    assert.equal(executeCount.value, 1);
    input.write("n\n");
    await waitFor(() => output.text().includes("The add tool was denied."));
    await waitFor(() => store.saveCount === 2);
    input.end();
    await tui;

    assert.equal(executeCount.value, 1);
    assert.equal(store.saveCount, 2);
  });

  it("handles two tool calls one confirmation at a time", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const confirmation = createToolConfirmation(output);
    const store = new CountingStore();
    const executions: string[] = [];
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
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
                  toolCallId: "double-call",
                  toolName: "double",
                  input: JSON.stringify({ value: 2 }),
                },
                {
                  type: "tool-call" as const,
                  toolCallId: "increment-call",
                  toolName: "increment",
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
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "done" },
              { type: "text-delta" as const, id: "done", delta: "done" },
              { type: "text-end" as const, id: "done" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: undefined },
                usage,
              },
            ],
          }),
        };
      },
    });
    const numberTool = (name: string, result: number) =>
      tool({
        inputSchema: z.object({ value: z.number() }),
        outputSchema: z.object({ value: z.number() }),
        execute: async () => {
          executions.push(name);
          return { value: result };
        },
      });
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([
        {
          id: "calculator",
          version: "1",
          instructions: "Use both tools.",
          model: "mock",
          tools: ["double", "increment"],
          limits: { maxSteps: 3, totalTimeoutMs: 5_000, stepTimeoutMs: 1_000 },
        },
      ]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ mock: model }),
        tools: new ToolRegistry([
          {
            metadata: { name: "double", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
            tool: numberTool("double", 4),
          },
          {
            metadata: { name: "increment", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
            tool: numberTool("increment", 3),
          },
        ]),
      }),
      beforeToolExecute: confirmation.beforeToolExecute,
      store,
    });
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store,
      input,
      output,
      toolConfirmation: confirmation,
    });

    await nextTurn();
    input.write("run both tools\n");
    await waitFor(() => output.text().includes("Tool: double"));
    input.write("y\n");
    await waitFor(() => output.text().includes("Tool: increment"));
    assert.deepEqual(executions, ["double"]);
    input.write("n\n");
    await waitFor(() => output.text().includes("done"));
    input.end();
    await tui;

    assert.deepEqual(executions, ["double"]);
  });
});

describe("runTui read_file confirmation", () => {
  it("reads the real workspace file after y and saves the answer", async () => {
    const fixture = await createReadFileConfirmationRuntime();
    const input = ttyInput();
    const tui = runTui({
      ...tuiOptions,
      runtime: fixture.runtime,
      store: fixture.store,
      input,
      output: fixture.output,
      toolConfirmation: fixture.confirmation,
    });

    try {
      await nextTurn();
      input.write("Read notes.txt and tell me what it says.\n");
      await waitFor(() => fixture.output.text().includes("Allow this call? [y/n]"));
      assert.equal(fixture.readCount.value, 0);
      assert.equal(fixture.store.saveCount, 0);

      input.write("y\n");
      await waitFor(() => fixture.output.text().includes("The file says: hello from workspace"));
      await waitFor(() => fixture.store.saveCount === 1);

      assert.equal(fixture.readCount.value, 1);
      assert.match(
        JSON.stringify(await fixture.store.getMessages("thread-1")),
        /hello from workspace/,
      );
      input.end();
      await tui;
    } finally {
      fixture.dispose();
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  it("denies read_file on n while the model can answer without reading", async () => {
    const fixture = await createReadFileConfirmationRuntime();
    const input = ttyInput();
    const tui = runTui({
      ...tuiOptions,
      runtime: fixture.runtime,
      store: fixture.store,
      input,
      output: fixture.output,
      toolConfirmation: fixture.confirmation,
    });

    try {
      await nextTurn();
      input.write("Read notes.txt.\n");
      await waitFor(() => fixture.output.text().includes("Allow this call? [y/n]"));
      input.write("n\n");
      await waitFor(() => fixture.output.text().includes("The requested file read was denied."));

      assert.equal(fixture.readCount.value, 0);
      await waitFor(() => fixture.store.saveCount === 1);
      assert.match(
        JSON.stringify(await fixture.store.getMessages("thread-1")),
        /TOOL_DENIED/,
      );
      input.end();
      await tui;
    } finally {
      fixture.dispose();
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  it("does not read or save when confirmation is cancelled", async () => {
    const fixture = await createReadFileConfirmationRuntime();
    const input = ttyInput();
    const tui = runTui({
      ...tuiOptions,
      runtime: fixture.runtime,
      store: fixture.store,
      input,
      output: fixture.output,
      toolConfirmation: fixture.confirmation,
    });

    try {
      await nextTurn();
      input.write("Read notes.txt.\n");
      await waitFor(() => fixture.output.text().includes("Allow this call? [y/n]"));
      pressCtrlC(input);
      await waitFor(() => fixture.output.text().includes("Run cancelled"));

      assert.equal(fixture.readCount.value, 0);
      assert.equal(fixture.store.saveCount, 0);
      input.end();
      await tui;
    } finally {
      fixture.dispose();
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  it("does not read or save when total timeout aborts confirmation", async () => {
    const fixture = await createReadFileConfirmationRuntime({ totalTimeoutMs: 30 });
    const input = ttyInput();
    const tui = runTui({
      ...tuiOptions,
      runtime: fixture.runtime,
      store: fixture.store,
      input,
      output: fixture.output,
      toolConfirmation: fixture.confirmation,
    });

    try {
      await nextTurn();
      input.write("Read notes.txt.\n");
      await waitFor(() => fixture.output.text().includes("Allow this call? [y/n]"));
      await waitFor(() => fixture.output.text().includes("Run timed_out"));

      assert.equal(fixture.readCount.value, 0);
      assert.equal(fixture.store.saveCount, 0);
      input.end();
      await tui;
    } finally {
      fixture.dispose();
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});

describe("runTui write_file confirmation", () => {
  it("does not create a file when the write is denied", async () => {
    const fixture = await createWriteFileConfirmationRuntime();
    const input = ttyInput();
    const tui = runTui({
      ...tuiOptions,
      runtime: fixture.runtime,
      store: fixture.store,
      input,
      output: fixture.output,
      toolConfirmation: fixture.confirmation,
    });

    try {
      await nextTurn();
      input.write("Create created.txt.\n");
      await waitFor(() => fixture.output.text().includes("Tool: write_file"));
      input.write("n\n");
      await waitFor(() => fixture.output.text().includes("The write was denied."));

      await assert.rejects(readFile(join(fixture.workspace, "created.txt")), {
        code: "ENOENT",
      });
      assert.doesNotMatch(fixture.output.text(), /已完成的操作/);
      await waitFor(() => fixture.store.saveCount === 1);
      input.end();
      await tui;
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  it("does not create a file when confirmation is cancelled", async () => {
    const fixture = await createWriteFileConfirmationRuntime();
    const input = ttyInput();
    const tui = runTui({
      ...tuiOptions,
      runtime: fixture.runtime,
      store: fixture.store,
      input,
      output: fixture.output,
      toolConfirmation: fixture.confirmation,
    });

    try {
      await nextTurn();
      input.write("Create created.txt.\n");
      await waitFor(() => fixture.output.text().includes("Tool: write_file"));
      pressCtrlC(input);
      await waitFor(() => fixture.output.text().includes("Run cancelled"));

      await assert.rejects(readFile(join(fixture.workspace, "created.txt")), {
        code: "ENOENT",
      });
      assert.equal(fixture.store.saveCount, 0);
      input.end();
      await tui;
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  it("keeps a completed write when the run fails afterward", async () => {
    const fixture = await createWriteFileConfirmationRuntime({ failAfterWrite: true });
    const input = ttyInput();
    const tui = runTui({
      ...tuiOptions,
      runtime: fixture.runtime,
      store: fixture.store,
      input,
      output: fixture.output,
      toolConfirmation: fixture.confirmation,
    });

    try {
      await nextTurn();
      input.write("Create created.txt.\n");
      await waitFor(() => fixture.output.text().includes("Tool: write_file"));
      input.write("y\n");
      await waitFor(() => fixture.output.text().includes("Run failed"));

      assert.equal(
        await readFile(join(fixture.workspace, "created.txt"), "utf8"),
        "created",
      );
      assert.match(
        fixture.output.text(),
        /已完成的操作：\n- write_file: created\.txt \(7 bytes\)/,
      );
      input.end();
      await tui;
    } finally {
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});
