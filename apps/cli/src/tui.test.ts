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
} from "@serika/core";
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
import { createDemoModel, type MemoryConsolidation } from "@serika/assistant";
import {
  AUTO_CONSOLIDATION_SOURCE,
  CHECKPOINT_FILE_NAME,
  createCheckpointModule,
  createCheckpointStore,
  createModuleHost,
  createReadFileModule,
  createToolConfirmation,
  createWebModule,
  createWriteFileTool,
  type CheckpointDraft,
  type ReadFileResult,
  type RunAuthorization,
} from "@serika/assistant/testing";
import { runTui } from "./tui.js";

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
  input: unknown = {},
): AgentEvent {
  return {
    id: `${runId}-tool-requested`,
    type: "tool.call.requested",
    occurredAt: new Date(0).toISOString(),
    runId,
    threadId,
    sequence: 1,
    data: { toolCallId: `${runId}-tool-call`, toolName, input },
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

function toolFailedEvent(
  runId: string,
  threadId: string,
  toolName: string,
  code: string,
  message: string,
): AgentEvent {
  return {
    id: `${runId}-tool-failed`,
    type: "tool.call.failed",
    occurredAt: new Date(0).toISOString(),
    runId,
    threadId,
    sequence: 3,
    data: {
      toolCallId: `${runId}-tool-call`,
      toolName,
      error: {
        code,
        message,
        retryable: false,
        phase: "tool",
      },
    },
  } as AgentEvent;
}

function modelRetryScheduledEvent(
  runId: string,
  threadId: string,
): AgentEvent {
  return {
    id: `${runId}-retry`,
    type: "model.retry.scheduled",
    occurredAt: new Date(0).toISOString(),
    runId,
    threadId,
    sequence: 1,
    data: {
      stepNumber: 1,
      nextAttempt: 2,
      maxAttempts: 3,
      delayMs: 250,
      error: {
        code: "MODEL_UNAVAILABLE",
        message: "temporary model failure",
        retryable: true,
        phase: "model",
      },
    },
  } as AgentEvent;
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

const checkpointTestDraft: CheckpointDraft = {
  status: "active",
  goal: "Continue Serika",
  summary: "The checkpoint has a concise verified progress snapshot.",
  completed: ["Freeze M5 contract"],
  inProgress: ["Implement TUI integration"],
  nextActions: ["Run acceptance"],
  blockers: [],
  artifacts: [{ label: "Plan", path: "docs/m5-plan.md" }],
};

function checkpointSaveCallResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "call-checkpoint-save",
          toolName: "checkpoint_save",
          input: JSON.stringify({ expectedVersion: null, draft: checkpointTestDraft }),
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

function createCheckpointSaveModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const results = currentTurnToolResults(prompt);
      if (results.length === 0) return checkpointSaveCallResponse();
      const result = results[0]?.output;
      return isRecord(result) && result.type === "error-text"
        ? writeFileTextResponse("The checkpoint save was denied.")
        : writeFileTextResponse("The checkpoint is saved.");
    },
  });
}

async function createCheckpointConfirmationRuntime(): Promise<{
  runtime: DefaultAgentRuntime;
  store: CountingStore;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
  confirmation: ReturnType<typeof createToolConfirmation>;
  output: Writable & { text(): string };
  workspace: string;
  dispose(): void;
}> {
  const workspace = await mkdtemp(join(tmpdir(), "runloom-tui-checkpoint-"));
  const output = ttyOutput();
  const confirmation = createToolConfirmation(output);
  const store = new CountingStore();
  const checkpointStore = createCheckpointStore(workspace, {
    generateId: () => "checkpoint-test",
  });
  const host = createModuleHost([
    createCheckpointModule(checkpointStore, { threadId: "thread-1" }),
  ], { notify: (_moduleId, message) => output.write(message) });
  const runtime = new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([{
      id: "calculator",
      version: "1",
      instructions: "Use checkpoint_save when asked to save the project checkpoint.",
      model: "mock",
      tools: host.tools.map(({ metadata }) => metadata.name),
      limits: { maxSteps: 4, totalTimeoutMs: 5_000, stepTimeoutMs: 1_000 },
    }]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ mock: createCheckpointSaveModel() }),
      tools: new ToolRegistry(host.tools),
    }),
    beforeToolExecute: confirmation.beforeToolExecute,
    store,
  });
  return {
    runtime,
    store,
    checkpointStore,
    confirmation,
    output,
    workspace,
    dispose: () => host.dispose(),
  };
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
  definitionId = "test",
): Parameters<BeforeToolExecute>[0] {
  return {
    toolName,
    toolCallId: `${toolName}-call`,
    input,
    definition: {
      id: definitionId,
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
  it("finishes startup Home after history and before the first prompt without a Run", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const homeStarted = deferred<void>();
    const finishHome = deferred<void>();
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [message("old-user", "user", "old question")] },
      input,
      output,
      async renderHome() {
        output.write("Home start\n");
        homeStarted.resolve();
        await finishHome.promise;
        output.write("Home end\n");
      },
    });

    await homeStarted.promise;
    assert.match(output.text(), /old question\n\nHome start\n/);
    assert.equal(output.text().includes("Home end"), false);
    assert.equal(output.text().includes("> "), false);
    assert.equal(runtime.requests.length, 0);

    finishHome.resolve();
    await waitFor(() => output.text().includes("> "));
    assert.ok(output.text().indexOf("Home end") < output.text().indexOf("> "));
    input.end();
    await tui;
    assert.equal(runtime.requests.length, 0);
  });

  it("keeps the TUI usable if startup Home rendering fails", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      async renderHome() {
        throw new Error("checkpoint unavailable");
      },
    });

    await waitFor(() => output.text().includes("> "));
    assert.match(output.text(), /\[home\] Failed: Error: checkpoint unavailable/);
    input.end();
    await tui;
    assert.equal(runtime.requests.length, 0);
  });

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
    assert.deepEqual(runtime.requests[0]?.messages[0], { ...message("new-user-id", "user", "new prompt"), metadata: runtime.requests[0]?.messages[0]?.metadata });
    assert.equal(typeof (runtime.requests[0]?.messages[0]?.metadata as Record<string, unknown>).sentAt, "string");
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

  it("counts all consolidation requests and keeps a completed primary when proposal persistence throws", async () => {
    const input = ttyInput(), output = ttyOutput();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([handleFor({ runId: "run-1", threadId: "thread-1", events, result: Promise.resolve(completedResult("run-1", "thread-1", "primary succeeded")) })]);
    const calls: unknown[] = [];
    const service: MemoryConsolidation = {
      begin: (id) => { calls.push(id); }, discard: () => { calls.push("discard"); },
      prepare: async () => { throw new Error("unused prepare"); }, stage: async () => { throw new Error("unused stage"); },
      canStart: async () => ({ ok: true, value: { canStart: true, pendingCount: 0 } }),
      finalize: async (result) => { calls.push(result); throw new Error("write failed"); },
    };
    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store: { getMessages: async () => [] }, input, output, memoryConsolidation: service });
    await nextTurn(); input.write("整理\n"); await waitFor(() => runtime.requests.length === 1);
    events.push(toolRequestedEvent("run-1", "thread-1", "memory_prepare_consolidation"));
    events.push(toolRequestedEvent("run-1", "thread-1", "memory_stage_candidates"));
    events.push(toolRequestedEvent("run-1", "thread-1", "memory_stage_candidates", { invalid: true }));
    events.close(); input.end(); await tui;
    assert.deepEqual(calls, ["calculator", { status: "completed", consolidationAttempts: { prepare: 1, stage: 2 } }, "discard"]);
    assert.match(output.text(), /整理确认失败.*write failed/);
    assert.match(output.text(), /primary succeeded/);
    assert.doesNotMatch(output.text(), /Run could not finish/);
  });

  it("skips automatic consolidation before a model call when the candidate queue is full", async () => {
    const input = ttyInput(), output = ttyOutput(), events = asyncQueue<AgentEvent>(); events.close();
    const runtime = testRuntime([handleFor({ runId: "run-1", threadId: "thread-1", events, result: Promise.resolve(completedResult("run-1", "thread-1", "done")) })]);
    const service: MemoryConsolidation = {
      begin: () => {}, discard: () => {},
      prepare: async () => { throw new Error("unused prepare"); }, stage: async () => { throw new Error("unused stage"); },
      finalize: async () => ({ ok: true, value: { candidateIds: [], replayed: false } }),
      canStart: async () => ({ ok: true, value: { canStart: false, pendingCount: 64 } }),
    };
    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store: { getMessages: async () => [] }, input, output, memoryConsolidation: service, autoConsolidationAgentId: "memory-consolidator" });
    await nextTurn(); input.write("prompt\n"); await waitFor(() => output.text().includes("自动整理已跳过"));
    input.end(); await tui; assert.equal(runtime.requests.length, 1);
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
    assert.deepEqual(runtime.requests[0]?.context, { agentId: "calculator" });
    assert.deepEqual(runtime.requests[1]?.context, { agentId: "memory-consolidator" });
    assert.equal(runtime.requests[1]?.messages[0]?.role, "user");
    assert.match(output.text(), /正在自动整理记忆/);
    input.end();
    await tui;
    assert.equal(runtime.requests.length, 2);
  });

  it("host-prepares and stages a one-shot JSON extraction without model tool calls", async () => {
    const input = ttyInput(), output = ttyOutput();
    const firstEvents = asyncQueue<AgentEvent>(), secondEvents = asyncQueue<AgentEvent>();
    firstEvents.close(); secondEvents.close();
    const payload = { batchId: "fixed-batch", proposals: [], outcomes: [{ messageId: "source", status: "no_memory" }] };
    const runtime = testRuntime([
      handleFor({ runId: "primary", threadId: "thread-1", events: firstEvents, result: Promise.resolve(completedResult("primary", "thread-1", "done")) }),
      handleFor({ runId: "extraction", threadId: "thread-1", events: secondEvents, result: Promise.resolve(completedResult("extraction", "thread-1", JSON.stringify(payload))) }),
    ]);
    let agent = "", prepared = 0, staged = 0, finalized = false;
    const service: MemoryConsolidation = {
      begin: value => { agent = value; }, discard: () => {},
      canStart: async () => ({ ok: true, value: { canStart: true, pendingCount: 0 } }),
      prepare: async (value) => {
        assert.equal(agent, "memory-consolidator"); assert.deepEqual(value, { mode: "incremental" }); prepared++;
        return { ok: true, value: { batchId: "fixed-batch", memories: [], truncated: false, bootstrap: true,
          turns: [{ user: { messageId: "source", text: "一次性问题" }, assistant: [], tools: [] }] } };
      },
      stage: async value => { assert.deepEqual(value, payload); staged++; return { ok: true, value: { staged: true, batchId: value.batchId, count: 0 } }; },
      finalize: async value => {
        if (agent === "memory-consolidator") { assert.deepEqual(value, { status: "completed" }); finalized = true; }
        return { ok: true, value: { candidateIds: [], replayed: false } };
      },
    };
    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store: { getMessages: async () => [] }, input, output,
      memoryConsolidation: service, autoConsolidationAgentId: "memory-consolidator", hostConsolidationExtraction: true });
    await nextTurn(); input.write("普通对话\n"); await waitFor(() => finalized);
    input.end(); await tui;
    assert.equal(prepared, 1); assert.equal(staged, 1); assert.equal(runtime.requests.length, 2);
    assert.match(JSON.stringify(runtime.requests[1]!.messages), /一次性问题/);
    assert.doesNotMatch(output.text(), /整理未完成|整理确认失败/);
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

  it("lets ordinary input interrupt background consolidation and waits before starting the next Run", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const backgroundResult = deferred<RunResult>();
    const cancellationRequested = deferred<void>();
    const requests: RunRequest[] = [];
    const runtime = { async run<TContext>(request: RunRequest<TContext>): Promise<RunHandle> {
      requests.push(request as RunRequest);
      const events = asyncQueue<AgentEvent>(); events.close();
      if (request.agentId === "memory-consolidator") return handleFor({
        runId: "background", threadId: "thread-1", events, result: backgroundResult.promise,
        cancel: async () => { cancellationRequested.resolve(); },
      });
      const primaryEvents = asyncQueue<AgentEvent>();
      if (requests.length > 1) primaryEvents.push(toolRequestedEvent("next", "thread-1", "memory_list"));
      primaryEvents.close();
      return handleFor({ runId: requests.length === 1 ? "first" : "next", threadId: "thread-1", events: primaryEvents,
        result: Promise.resolve(completedResult(requests.length === 1 ? "first" : "next", "thread-1", "answer")) });
    } };
    const tui = runTui({ ...tuiOptions, runtime, store: { getMessages: async () => [] }, input, output, autoConsolidationAgentId: "memory-consolidator" });
    await nextTurn(); input.write("first\n");
    await waitFor(() => requests.length === 2);
    input.write("next question\n");
    await cancellationRequested.promise;
    assert.equal(requests.length, 2, "cancellation requested is not cancellation completed");
    input.write("do not queue\n");
    await waitFor(() => output.text().includes("Busy:"));
    backgroundResult.resolve(cancelledResult("background", "thread-1"));
    await waitFor(() => requests.length === 3);
    assert.equal(requests[2]?.messages[0]?.parts[0]?.type === "text" && requests[2].messages[0].parts[0].text, "next question");
    input.end(); await tui;
    assert.equal(requests.length, 3);
  });

  it("resumes only the supplied current-Thread backlog on TUI startup", async () => {
    const input = new PassThrough(); const output = outputBuffer();
    const pending = deferred<RunResult>();
    const events = asyncQueue<AgentEvent>(); events.close();
    const runtime = testRuntime([handleFor({ runId: "background", threadId: "thread-1", events, result: pending.promise,
      cancel: async () => { pending.resolve(cancelledResult("background", "thread-1")); } })]);
    const tui = runTui({ ...tuiOptions, runtime: runtime.runtime, store: { getMessages: async () => [] }, input, output,
      autoConsolidationAgentId: "memory-consolidator", getMemoryConsolidationBacklog: async () => ({ ok: true, value: 1 }) });
    await waitFor(() => runtime.requests.length === 1);
    assert.equal(runtime.requests[0]?.agentId, "memory-consolidator");
    assert.equal(runtime.requests[0]?.threadId, "thread-1");
    input.end(); await tui;
  });

  it("does not treat checkpoint tools as memory tools for automatic consolidation", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const firstEvents = asyncQueue<AgentEvent>();
    const secondEvents = asyncQueue<AgentEvent>();
    secondEvents.close();
    const runtime = testRuntime([
      handleFor({
        runId: "run-checkpoint",
        threadId: "thread-1",
        events: firstEvents,
        result: Promise.resolve(completedResult("run-checkpoint", "thread-1", "saved")),
      }),
      handleFor({
        runId: "run-consolidator",
        threadId: "thread-1",
        events: secondEvents,
        result: Promise.resolve(completedResult("run-consolidator", "thread-1", "reviewed")),
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
    input.write("save checkpoint\n");
    await waitFor(() => runtime.requests.length === 1);
    firstEvents.push(toolCompletedEvent("run-checkpoint", "thread-1", "checkpoint_save", {
      ok: true,
      checkpoint: { id: "checkpoint-1", version: 1, status: "active" },
    }));
    firstEvents.close();
    await waitFor(() => runtime.requests.length === 2);
    assert.equal(runtime.requests[1]?.agentId, "memory-consolidator");
    input.end();
    await tui;
  });

  it("reports a saved checkpoint when the Run fails after the write", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-checkpoint-failed-later",
        threadId: "thread-checkpoint",
        events,
        result: Promise.resolve(failedResult("run-checkpoint-failed-later", "thread-checkpoint")),
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
    input.write("save checkpoint\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(toolCompletedEvent("run-checkpoint-failed-later", "thread-checkpoint", "checkpoint_save", {
      ok: true,
      checkpoint: { id: "checkpoint-7", version: 3, status: "paused" },
    }));
    events.close();
    input.end();
    await tui;

    assert.match(output.text(), /Run failed/);
    assert.match(
      output.text(),
      /已完成的操作：\n- checkpoint_save: 已保存工作进度 checkpoint-7，版本 3，状态 paused/,
    );
  });

  it("does not report a checkpoint when save returns ok:false", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-checkpoint-conflict",
        threadId: "thread-checkpoint",
        events,
        result: Promise.resolve(failedResult("run-checkpoint-conflict", "thread-checkpoint")),
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
    input.write("save checkpoint\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(toolCompletedEvent("run-checkpoint-conflict", "thread-checkpoint", "checkpoint_save", {
      ok: false,
      error: { code: "CHECKPOINT_VERSION_CONFLICT", message: "stale version" },
    }));
    events.close();
    input.end();
    await tui;

    assert.match(output.text(), /Run failed/);
    assert.doesNotMatch(output.text(), /已保存工作进度/);
    assert.doesNotMatch(output.text(), /已完成的操作/);
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

  it("keeps the original result when consolidation returns a failed status", async () => {
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
        result: Promise.resolve(completedResult("run-1", "thread-1", "original")),
      }),
      handleFor({
        runId: "run-2",
        threadId: "thread-1",
        events: secondEvents,
        result: Promise.resolve({
          ...failedResult("run-2", "thread-1"),
          error: {
            code: "CONTEXT_PREPARE_FAILED",
            message: "Selected conversation and workspace memories exceed the consolidation input limit",
            retryable: false,
            phase: "runtime",
          },
        }),
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
    await waitFor(() => output.text().includes("Automatic consolidation failed"));

    input.end();
    await tui;
    assert.match(output.text(), /original/);
    assert.match(
      output.text(),
      /Automatic consolidation failed: Selected conversation and workspace memories exceed the consolidation input limit/,
    );
    assert.equal(output.text().includes("结果不确定"), false);
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

  it("renders scheduled model retries as transient run feedback", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-retry",
        threadId: "thread-1",
        events,
        result: Promise.resolve(failedResult("run-retry", "thread-1")),
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
    input.write("temporary model failure\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(modelRetryScheduledEvent("run-retry", "thread-1"));
    events.close();
    input.end();
    await tui;

    assert.match(
      output.text(),
      /\[model retry 2\/3 in 250ms: MODEL_UNAVAILABLE\]/,
    );
  });

  it("settles completed actions and unknown non-idempotent outcomes without replay", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-unknown",
        threadId: "thread-1",
        events,
        result: Promise.resolve(failedResult("run-unknown", "thread-1")),
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
    input.write("write and continue\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolRequestedEvent("run-unknown", "thread-1", "edit_file", {
        path: "notes/report.md",
      }),
    );
    events.push(
      toolCompletedEvent("run-unknown", "thread-1", "write_file", {
        ok: true,
        path: "notes/report.md",
        bytes: 42,
      }),
    );
    events.push(
      toolFailedEvent(
        "run-unknown",
        "thread-1",
        "edit_file",
        "TOOL_OUTCOME_UNKNOWN",
        "edit_file outcome is unknown after timeout",
      ),
    );
    events.close();
    input.end();
    await tui;

    assert.equal(runtime.requests.length, 1);
    assert.match(
      output.text(),
      /已完成的操作：\n- write_file: notes\/report\.md \(42 bytes\)/,
    );
    assert.match(
      output.text(),
      /结果不确定，重试前请先核查：\n- edit_file \(path=notes\/report\.md\): edit_file outcome is unknown after timeout\n本次 Run 不会自动重试该操作。/,
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

  it("reports a created task when the run fails afterward", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-task",
        threadId: "thread-task",
        events,
        result: Promise.resolve(failedResult("run-task", "thread-task")),
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
    input.write("一分钟后提醒我喝水。\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-task", "thread-task", "task_create", {
        ok: true,
        value: {
          id: "task-1",
          runAt: "2026-09-15T02:00:00.000Z",
          prompt: "提醒我喝水",
        },
      }),
    );
    events.close();
    input.end();
    await tui;

    assert.match(
      output.text(),
      /已完成的操作：\n- task_create: 已创建任务 task-1，执行时间 2026-09-15T02:00:00\.000Z，内容：提醒我喝水/,
    );
  });

  for (const [status, resultFor] of [
    ["failed", failedResult],
    ["cancelled", cancelledResult],
  ] as const) {
    it(`reports a rescheduled task when the run is ${status} afterward`, async () => {
      const input = new PassThrough();
      const output = outputBuffer();
      const events = asyncQueue<AgentEvent>();
      const runtime = testRuntime([
        handleFor({
          runId: "run-task-reschedule",
          threadId: "thread-task-reschedule",
          events,
          result: Promise.resolve(resultFor("run-task-reschedule", "thread-task-reschedule")),
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
      input.write("把喝水提醒改到下午三点。\n");
      await waitFor(() => runtime.requests.length === 1);
      events.push(
        toolCompletedEvent("run-task-reschedule", "thread-task-reschedule", "task_reschedule", {
          ok: true,
          value: { id: "task-1", runAt: "2026-09-15T07:00:00.000Z" },
        }),
      );
      events.close();
      input.end();
      await tui;

      assert.match(
        output.text(),
        /已完成的操作：\n- task_reschedule: 已改期任务 task-1，新执行时间 2026-09-15T07:00:00\.000Z/,
      );
    });
  }

  it("does not report a reschedule when the tool did not succeed", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-task-reschedule-denied",
        threadId: "thread-task-reschedule-denied",
        events,
        result: Promise.resolve(failedResult("run-task-reschedule-denied", "thread-task-reschedule-denied")),
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
    input.write("把喝水提醒改到下午三点。\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-task-reschedule-denied", "thread-task-reschedule-denied", "task_reschedule", {
        ok: false,
        error: { code: "TASK_NOT_RESCHEDULABLE", message: "task is running" },
      }),
    );
    events.close();
    input.end();
    await tui;

    assert.doesNotMatch(output.text(), /已完成的操作/);
    assert.doesNotMatch(output.text(), /已改期任务/);
  });

  it("does not report a task when creation is denied or fails", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-task-denied",
        threadId: "thread-task-denied",
        events,
        result: Promise.resolve(failedResult("run-task-denied", "thread-task-denied")),
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
    input.write("取消刚才的提醒。\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-task-denied", "thread-task-denied", "task_create", {
        ok: false,
        error: { code: "TASK_CREATE_FAILED", message: "user denied" },
      }),
    );
    events.close();
    input.end();
    await tui;

    assert.doesNotMatch(output.text(), /已完成的操作/);
    assert.doesNotMatch(output.text(), /task-1/);
  });

  it("reports a saved memory when the run fails afterward", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-memory",
        threadId: "thread-memory",
        events,
        result: Promise.resolve(failedResult("run-memory", "thread-memory")),
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
    input.write("记住我使用 pnpm。\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-memory", "thread-memory", "memory_add", {
        ok: true,
        entry: { id: "mem-1", revision: 2 },
      }),
    );
    events.push(
      toolCompletedEvent("run-memory", "thread-memory", "memory_update", {
        ok: true,
        entry: { id: "mem-1", revision: 3 },
      }),
    );
    events.push(toolCompletedEvent("run-memory", "thread-memory", "memory_apply_candidate", {
      ok: true, value: { candidateId: "candidate-1", status: "accepted", memoryId: "mem-2", memoryRevision: 1, replayed: false },
    }));
    events.close();
    input.end();
    await tui;

    assert.match(
      output.text(),
      /已完成的操作：\n- memory_add: 已保存记忆 mem-1，版本 2\n- memory_update: 已更新记忆 mem-1，版本 3\n- memory_apply_candidate: 已保存记忆 mem-2，版本 1/,
    );
  });

  it("does not report a memory when memory_add returns ok:false and the run fails", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-memory-denied",
        threadId: "thread-memory-denied",
        events,
        result: Promise.resolve(failedResult("run-memory-denied", "thread-memory-denied")),
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
    input.write("不要保存这条记忆。\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-memory-denied", "thread-memory-denied", "memory_add", {
        ok: false,
        error: { code: "MEMORY_WRITE_FAILED", message: "user denied" },
      }),
    );
    events.close();
    input.end();
    await tui;

    assert.match(output.text(), /Run failed/);
    assert.doesNotMatch(output.text(), /已完成的操作/);
    assert.doesNotMatch(output.text(), /已保存记忆/);
  });

  it("does not repeat a saved memory receipt when the run completes", async () => {
    const input = new PassThrough();
    const output = outputBuffer();
    const events = asyncQueue<AgentEvent>();
    const runtime = testRuntime([
      handleFor({
        runId: "run-memory-completed",
        threadId: "thread-memory-completed",
        events,
        result: Promise.resolve(
          completedResult("run-memory-completed", "thread-memory-completed", "已记住。"),
        ),
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
    input.write("记住我使用 pnpm。\n");
    await waitFor(() => runtime.requests.length === 1);
    events.push(
      toolCompletedEvent("run-memory-completed", "thread-memory-completed", "memory_add", {
        ok: true,
        entry: { id: "mem-1", revision: 1 },
      }),
    );
    events.push(messageDeltaEvent("run-memory-completed", "thread-memory-completed", "已记住。"));
    events.close();
    input.end();
    await tui;

    assert.match(output.text(), /已记住。/);
    assert.doesNotMatch(output.text(), /已完成的操作/);
    assert.doesNotMatch(output.text(), /已保存记忆 mem-1，版本 1/);
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
        ["workspace", { execute: (value: string) => { args.push(value); } }],
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

  it("redraws the idle prompt after a later module notification", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    let redraw: (() => void) | undefined;
    const tui = runTui({
      ...tuiOptions,
      runtime: testRuntime([]).runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      registerNotificationRedraw: (callback) => { redraw = callback; },
    });

    await waitFor(() => redraw !== undefined);
    const promptsBefore = (output.text().match(/> /g) ?? []).length;
    output.write("\n[module:pomodoro] finished\n");
    redraw?.();
    assert.equal((output.text().match(/> /g) ?? []).length, promptsBefore + 1);
    input.end();
    await tui;
  });

  it("runs /compact without creating a Run and rejects input while compacting", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const started = deferred<AbortSignal>();
    const gate = deferred<void>();
    let signal!: AbortSignal;
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      compaction: {
        async compact(compactionSignal) {
          signal = compactionSignal;
          started.resolve(compactionSignal);
          await gate.promise;
        },
      },
    });

    await nextTurn();
    input.write("/compact\nqueued prompt\n");
    await started.promise;
    await waitFor(() => output.text().includes("Busy: context compaction is in progress."));
    assert.equal(runtime.requests.length, 0);
    assert.equal(signal.aborted, false);

    pressCtrlC(input);
    await waitFor(() => signal.aborted);
    gate.resolve();
    await waitFor(() => output.text().includes("[compact] Cancelled."));
    assert.equal(runtime.requests.length, 0);
    input.end();
    await tui;
  });

  it("reports a completed /compact operation without consuming a user Run", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    let calls = 0;
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      compaction: {
        async compact(signal) {
          calls += 1;
          assert.equal(signal.aborted, false);
          return { message: "saved summary" };
        },
      },
    });

    await nextTurn();
    input.write("/compact\n");
    await waitFor(() => output.text().includes("[compact] saved summary"));
    assert.equal(calls, 1);
    assert.equal(runtime.requests.length, 0);
    input.end();
    await tui;
  });

  it("uses /resume only for the next primary Run, not an idle command or consolidation", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const seen: Array<{ agentId: string; observation: string | undefined }> = [];
    let pending: string | undefined;
    let active: string | undefined;
    const runtime = {
      async run<TContext>(request: RunRequest<TContext>): Promise<RunHandle> {
        seen.push({ agentId: request.agentId, observation: active });
        const runId = `run-${seen.length}`;
        const events = asyncQueue<AgentEvent>();
        events.close();
        return handleFor({
          runId,
          threadId: "thread-1",
          events,
          result: Promise.resolve(completedResult(runId, "thread-1", "done")),
        });
      },
    };
    let commandCalls = 0;
    const tui = runTui({
      ...tuiOptions,
      runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      autoConsolidationAgentId: "memory-consolidator",
      commands: new Map([["history", { execute() { commandCalls += 1; } }]]),
      resume: {
        async inspect(signal) {
          assert.equal(signal.aborted, false);
          pending = "stale HEAD";
          return "stale HEAD";
        },
        clear() { pending = undefined; active = undefined; },
        beginRun() { active = pending; pending = undefined; },
        endRun() { active = undefined; },
      },
    });

    await nextTurn();
    input.write("/resume\n");
    await waitFor(() => output.text().includes("[resume] stale HEAD"));
    await waitFor(() => /\[resume\] stale HEAD[\s\S]*> /.test(output.text()));
    assert.equal(seen.length, 0);
    input.write("/history\n");
    await waitFor(() => commandCalls === 1);
    assert.equal(pending, "stale HEAD");
    input.write("first prompt\n");
    await waitFor(() => seen.length === 2);
    assert.deepEqual(seen, [
      { agentId: "calculator", observation: "stale HEAD" },
      { agentId: "memory-consolidator", observation: undefined },
    ]);
    input.write("second prompt\n");
    await waitFor(() => seen.length === 4);
    assert.deepEqual(seen.slice(2), [
      { agentId: "calculator", observation: undefined },
      { agentId: "memory-consolidator", observation: undefined },
    ]);
    input.end();
    await tui;
  });

  it("aborts /resume without creating a Run and clears a late inspection result", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const runtime = testRuntime([]);
    const started = deferred<AbortSignal>();
    const gate = deferred<void>();
    let pending = false;
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      resume: {
        async inspect(signal) {
          started.resolve(signal);
          await gate.promise;
          pending = true;
          return "should not be shown";
        },
        clear() { pending = false; },
        beginRun() { assert.equal(pending, false); },
        endRun() {},
      },
    });

    await nextTurn();
    input.write("/resume\nqueued prompt\n");
    const signal = await started.promise;
    await waitFor(() => output.text().includes("Busy: Git inspection is in progress."));
    pressCtrlC(input);
    await waitFor(() => signal.aborted);
    gate.resolve();
    await waitFor(() => output.text().includes("[resume] Cancelled."));
    assert.equal(pending, false);
    assert.equal(runtime.requests.length, 0);
    assert.doesNotMatch(output.text(), /should not be shown/);
    input.end();
    await tui;
  });

  it("clears /resume observation when the primary Run fails to start", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    let pending = false;
    let active = false;
    let endCalls = 0;
    const tui = runTui({
      ...tuiOptions,
      runtime: {
        async run() {
          assert.equal(active, true);
          throw new Error("startup failed");
        },
      },
      store: { getMessages: async () => [] },
      input,
      output,
      resume: {
        async inspect() { pending = true; return "consistent"; },
        clear() { pending = false; active = false; },
        beginRun() { active = pending; pending = false; },
        endRun() { active = false; endCalls += 1; },
      },
    });

    await nextTurn();
    input.write("/resume\n");
    await waitFor(() => output.text().includes("[resume] consistent"));
    input.write("prompt\n");
    await waitFor(() => output.text().includes("Run could not start: Error: startup failed"));
    assert.equal(endCalls, 1);
    assert.equal(active, false);
    assert.equal(pending, false);
    input.end();
    await tui;
  });

  it("waits for an async idle command before accepting the next line", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const gate = deferred<void>();
    let commandStarted = false;
    const events = asyncQueue<AgentEvent>();
    events.close();
    const runtime = testRuntime([
      handleFor({
        runId: "run-1",
        threadId: "thread-1",
        events,
        result: Promise.resolve(completedResult("run-1", "thread-1", "done")),
      }),
    ]);
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      commands: new Map([
        [
          "history",
          {
            async execute() {
              commandStarted = true;
              await gate.promise;
              output.write("\n[history] done\n");
            },
          },
        ],
      ]),
    });

    await nextTurn();
    input.write("/history u0\nnext user message\n");
    await waitFor(() => commandStarted);
    await nextTurn();
    assert.equal(runtime.requests.length, 0);
    assert.equal(output.text().includes("[history] done"), false);
    gate.resolve();
    await waitFor(() => output.text().includes("[history] done"));
    await waitFor(() => runtime.requests.length === 1);
    assert.equal(runtime.requests[0]?.messages.length, 1);
    assert.deepEqual(
      runtime.requests[0]?.messages[0],
      { ...message("new-user-id", "user", "next user message"), metadata: runtime.requests[0]?.messages[0]?.metadata },
    );
    input.end();
    await tui;
  });

  it("restores the prompt after an async command notification, not before it", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const started = deferred<void>();
    const gate = deferred<void>();
    const runtime = testRuntime([]);
    const tui = runTui({
      ...tuiOptions,
      runtime: runtime.runtime,
      store: { getMessages: async () => [] },
      input,
      output,
      commands: new Map([
        ["task", { async execute() { started.resolve(); await gate.promise; output.write("\n[module:task] Task: task-1\n"); } }],
      ]),
    });

    await nextTurn();
    input.write("/task show task-1\n");
    await started.promise;
    assert.equal(output.text().includes("Task: task-1"), false);
    gate.resolve();
    await waitFor(() => output.text().includes("Task: task-1"));
    await waitFor(() => output.text().lastIndexOf("> ") > output.text().lastIndexOf("Task: task-1"));
    assert.equal(runtime.requests.length, 0);
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
        getPending: () => undefined,
        resolveApproval: () => false,
        subscribePending: () => () => undefined,
        setPendingAuthorization: () => undefined,
        setPendingShellAuthorization: () => undefined,
        setPendingWebAuthorization: () => undefined,
        beginRun: () => undefined,
        endRun: () => undefined,
        listRemembered: () => [],
        forgetRemembered: () => false,
      },
      commands: new Map([
        ["workspace", { execute: (args: string) => { commandCalls.push(args); } }],
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
        ["workspace", { execute: (args: string) => { commandCalls.push(args); } }],
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
        ["workspace", { execute: (args: string) => { commandCalls.push(args); } }],
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
  it("approval preview guard: delayed preview cannot be approved before publication", async () => {
    const preview = deferred<string>();
    const confirmation = createToolConfirmation(outputBuffer(), { generateId: () => "delayed", prompt: () => preview.promise });
    const controller = new AbortController();
    const decision = Promise.resolve(confirmation.beforeToolExecute(toolInput("task_reschedule", controller.signal, { id: "task-1" })));
    try {
      assert.equal(confirmation.resolveApproval({ approvalId: "delayed", decision: "allow" }), false);
      assert.equal(confirmation.getPending()?.approvalId, "delayed");
      preview.resolve("时间：明天，内容：喝水\n允许这次改期？ [y/n] ");
      await Promise.resolve();
      assert.equal(confirmation.resolveApproval({ approvalId: "delayed", decision: "allow" }), true);
      assert.deepEqual(await decision, { allow: true });
    } finally { controller.abort("cleanup"); await decision.catch(() => undefined); }
  });

  it("approval preview guard: whitespace is not ready, but denial remains available", async () => {
    const confirmation = createToolConfirmation(outputBuffer(), { generateId: () => "blank", prompt: () => " \n\t " });
    const controller = new AbortController();
    const decision = Promise.resolve(confirmation.beforeToolExecute(toolInput("write_file", controller.signal, { path: "a.txt", content: "x" })));
    try {
      assert.equal(confirmation.resolveApproval({ approvalId: "blank", decision: "allow" }), false);
      assert.equal(confirmation.resolveApproval({ approvalId: "blank", decision: "deny" }), true);
      assert.equal((await decision).allow, false);
    } finally { controller.abort("cleanup"); await decision.catch(() => undefined); }
  });

  it("approval replacement race: late old preview and stale decisions cannot approve the new call", async () => {
    const oldPreview = deferred<string>();
    let sequence = 0;
    const confirmation = createToolConfirmation(outputBuffer(), { generateId: () => `race-${++sequence}`,
      prompt: () => sequence === 1 ? oldPreview.promise : "内容：新操作\nAllow this call? [y/n] " });
    const oldController = new AbortController();
    const first = Promise.resolve(confirmation.beforeToolExecute(toolInput("write_file", oldController.signal, { path: "old.txt", content: "old" })));
    oldController.abort("cancelled");
    await assert.rejects(first, error => error === "cancelled");
    const nextController = new AbortController();
    const second = Promise.resolve(confirmation.beforeToolExecute(toolInput("write_file", nextController.signal, { path: "new.txt", content: "new" })));
    try {
      oldPreview.resolve("内容：旧操作迟到"); await Promise.resolve();
      assert.equal(confirmation.getPending()?.approvalId, "race-2");
      assert.match(confirmation.getPending()?.preview ?? "", /新操作/);
      assert.equal(confirmation.resolveApproval({ approvalId: "race-1", decision: "allow" }), false);
      assert.equal(confirmation.resolveApproval({ approvalId: "race-2", decision: "deny" }), true);
      assert.equal((await second).allow, false);
    } finally { nextController.abort("cleanup"); await second.catch(() => undefined); }
  });

  it("resolves only the matching approval and rejects stale or repeated decisions", async () => {
    const output = outputBuffer();
    const changes: Array<string | undefined> = [];
    let nextId = 0;
    const confirmation = createToolConfirmation(output, {
      generateId: () => `approval-${++nextId}`,
    });
    const unsubscribe = confirmation.subscribePending((pending) => {
      changes.push(pending?.approvalId);
    });

    const first = Promise.resolve(confirmation.beforeToolExecute(
      toolInput("write_file", new AbortController().signal, { path: "a.txt", content: "one" }),
    ));
    const firstApproval = confirmation.getPending();
    assert.equal(firstApproval?.approvalId, "approval-1");
    assert.equal(firstApproval?.toolName, "write_file");
    assert.match(firstApproval?.preview ?? "", /Content: "one"/);
    assert.equal(confirmation.resolveApproval({ approvalId: "unknown", decision: "allow" }), false);
    assert.equal(confirmation.resolveApproval({ approvalId: "approval-1", decision: "deny" }), true);
    assert.deepEqual(await first, { allow: false, reason: "User denied this tool call" });
    assert.equal(confirmation.getPending(), undefined);

    const second = Promise.resolve(confirmation.beforeToolExecute(
      toolInput("write_file", new AbortController().signal, { path: "b.txt", content: "two" }),
    ));
    assert.equal(confirmation.getPending()?.approvalId, "approval-2");
    assert.equal(confirmation.resolveApproval({ approvalId: "approval-1", decision: "allow" }), false);
    assert.equal(confirmation.getPending()?.approvalId, "approval-2");
    assert.equal(confirmation.resolveApproval({ approvalId: "approval-2", decision: "allow" }), true);
    assert.deepEqual(await second, { allow: true });
    assert.equal(confirmation.resolveApproval({ approvalId: "approval-2", decision: "allow" }), false);
    // Each approval notifies twice: once at creation, once when the preview is written.
    assert.deepEqual(changes, [
      "approval-1", "approval-1", undefined,
      "approval-2", "approval-2", undefined,
    ]);
    unsubscribe();
  });

  it("publishes the completed async preview and clears approval on cancellation", async () => {
    const output = outputBuffer();
    const preview = deferred<string>();
    const changes: Array<string | undefined> = [];
    const confirmation = createToolConfirmation(output, {
      generateId: () => "approval-async",
      prompt: () => preview.promise,
      onPendingChange: (pending) => { changes.push(pending?.preview); },
    });
    const controller = new AbortController();
    const decision = Promise.resolve(confirmation.beforeToolExecute(
      toolInput("memory_update", controller.signal, { id: "memory-1" }),
    ));
    assert.equal(confirmation.getPending()?.approvalId, "approval-async");
    assert.equal(confirmation.getPending()?.preview, "");
    // Observers hear about the approval at creation, before the async preview.
    assert.deepEqual(changes, [""]);

    preview.resolve("Current memory: old\nAllow this call? [y/n] ");
    await Promise.resolve();
    assert.deepEqual(changes, ["", "Current memory: old\nAllow this call? [y/n] "]);
    assert.match(output.text(), /Current memory: old/);

    controller.abort("cancelled");
    await assert.rejects(decision, (error: unknown) => error === "cancelled");
    assert.equal(confirmation.getPending(), undefined);
    assert.deepEqual(changes, ["", "Current memory: old\nAllow this call? [y/n] ", undefined]);
    assert.equal(confirmation.resolveApproval({ approvalId: "approval-async", decision: "allow" }), false);
  });

  it("keeps approval pending when a UI observer throws", async () => {
    const output = outputBuffer();
    const changes: Array<string | undefined> = [];
    const confirmation = createToolConfirmation(output, {
      onPendingChange: () => { throw new Error("renderer disconnected"); },
    });
    confirmation.subscribePending(() => { throw new Error("stale listener"); });
    confirmation.subscribePending((pending) => { changes.push(pending?.approvalId); });

    const decision = Promise.resolve(confirmation.beforeToolExecute(
      toolInput("write_file", new AbortController().signal, { path: "a.txt", content: "one" }),
    ));
    const approvalId = confirmation.getPending()?.approvalId;
    assert.ok(approvalId);
    assert.match(output.text(), /Allow this call\? \[y\/n\]/);
    assert.deepEqual(changes, [approvalId, approvalId]);

    assert.equal(confirmation.resolveApproval({ approvalId, decision: "allow" }), true);
    assert.deepEqual(await decision, { allow: true });
    assert.deepEqual(changes, [approvalId, approvalId, undefined]);
  });

  it("allows only the consolidator's prepare and stage without prompting", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);

    const decision = confirmation.beforeToolExecute(
      toolInput(
        "memory_prepare_consolidation",
        new AbortController().signal,
        {},
        "memory-consolidator",
      ),
    );

    assert.deepEqual(await Promise.resolve(decision), { allow: true });
    assert.deepEqual(await confirmation.beforeToolExecute(toolInput("memory_stage_candidates", new AbortController().signal, {}, "memory-consolidator")), { allow: true });
    assert.equal(output.text(), "");
  });

  it("keeps memory tools on normal confirmation paths outside the consolidator read", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);

    const primaryRead = confirmation.beforeToolExecute(
      toolInput("memory_prepare_consolidation", new AbortController().signal),
    );
    assert.match(output.text(), /Allow this call\? \[y\/n\]/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await primaryRead, {
      allow: false,
      reason: "User denied this tool call",
    });

    const consolidatorWrite = confirmation.beforeToolExecute(
      toolInput(
        "memory_add",
        new AbortController().signal,
        {},
        "memory-consolidator",
      ),
    );
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await consolidatorWrite, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("keeps checkpoint reads and writes on normal y/n confirmation even with file authorization", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      workspaceRoot: "/workspace",
      persistentAuthorizations: [{
        tools: ["read_file", "write_file"],
        allowedPaths: ["."],
        lifetime: "run",
      }],
    });

    for (const toolName of ["checkpoint_prepare", "checkpoint_get", "checkpoint_save"]) {
      const pending = confirmation.beforeToolExecute(
        toolInput(toolName, new AbortController().signal, { version: 1, expectedVersion: 1 }),
      );
      assert.match(output.text(), new RegExp(`Tool: ${toolName}`));
      assert.match(output.text(), /Allow this call\? \[y\/n\]/);
      assert.equal(confirmation.handleLine("n"), true);
      assert.deepEqual(await pending, {
        allow: false,
        reason: "User denied this tool call",
      });
    }
  });

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

  it("shows shell command and workspace-relative cwd before confirmation", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output);
    const pending = confirmation.beforeToolExecute(
      toolInput("shell_exec", new AbortController().signal, {
        command: "pnpm test",
        cwd: "packages/core",
      }),
    );

    assert.match(output.text(), /Tool: shell_exec/);
    assert.match(output.text(), /Command: "pnpm test"/);
    assert.match(output.text(), /Cwd: "packages\/core" \(relative to workspace\)/);
    assert.match(output.text(), /not an operating-system sandbox/);
    assert.match(output.text(), /Allow this call\? \[y\/n\]/);

    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await pending, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("describes Docker sandbox isolation in the shell confirmation prompt", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      shellSandboxMode: "docker",
    });
    const pending = confirmation.beforeToolExecute(
      toolInput("shell_exec", new AbortController().signal, {
        command: "pwd",
        cwd: "src",
      }),
    );

    assert.match(output.text(), /Tool: shell_exec/);
    assert.match(output.text(), /Command: "pwd"/);
    assert.match(output.text(), /Cwd: "src" \(relative to sandbox mounts\)/);
    assert.match(output.text(), /Docker sandbox/);
    assert.match(output.text(), /no network/);
    assert.match(output.text(), /Unmounted host files are not visible/);
    assert.doesNotMatch(output.text(), /not an operating-system sandbox/);
    assert.match(output.text(), /Allow this call\? \[y\/n\]/);

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

  it("keeps confirmation open beyond the Run budget and executes only after y", async () => {
    const input = ttyInput();
    const output = ttyOutput();
    const { runtime, store, confirmation, executeCount } =
      createConfirmationRuntime(output, { totalTimeoutMs: 250 });
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
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    assert.equal(output.text().includes("Run timed_out"), false);
    assert.equal(executeCount.value, 0);
    input.write("y\n");
    await waitFor(() => output.text().includes("20 + 22 = 42"));
    await waitFor(() => store.saveCount === saveCountBeforeRun + 1);
    input.end();
    await tui;

    assert.equal(executeCount.value, 1);
    assert.equal(store.saveCount, saveCountBeforeRun + 1);
    assert.notDeepEqual(await store.getMessages("thread-1"), savedBeforeRun);
    const run = await store.getRun(store.runIds[0] as string);
    assert.equal(run?.status, "completed");
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

  it("keeps read_file unexecuted beyond the Run budget until n", async () => {
    const fixture = await createReadFileConfirmationRuntime({ totalTimeoutMs: 250 });
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
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      assert.equal(fixture.output.text().includes("Run timed_out"), false);
      input.write("n\n");
      await waitFor(() => fixture.output.text().includes("The requested file read was denied."));

      assert.equal(fixture.readCount.value, 0);
      await waitFor(() => fixture.store.saveCount === 1);
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

describe("runTui checkpoint confirmation", () => {
  it("shows expectedVersion and the full draft, then writes only after y", async () => {
    const fixture = await createCheckpointConfirmationRuntime();
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
      input.write("Save the current project checkpoint.\n");
      await waitFor(() => fixture.output.text().includes("Allow this call? [y/n]"));
      assert.match(fixture.output.text(), /expectedVersion\":null/);
      assert.match(fixture.output.text(), /The checkpoint has a concise verified progress snapshot/);
      assert.match(fixture.output.text(), /docs\/m5-plan\.md/);
      await assert.rejects(readFile(join(fixture.workspace, CHECKPOINT_FILE_NAME), "utf8"), {
        code: "ENOENT",
      });

      input.write("y\n");
      await waitFor(() => fixture.output.text().includes("The checkpoint is saved."));
      const current = await fixture.checkpointStore.getCurrent();
      assert.equal(current.ok, true);
      if (current.ok) {
        assert.equal(current.current?.version, 1);
        assert.deepEqual(current.current?.source, { threadId: "thread-1" });
      }
      input.end();
      await tui;
    } finally {
      fixture.dispose();
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });

  it("leaves no checkpoint file after n", async () => {
    const fixture = await createCheckpointConfirmationRuntime();
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
      input.write("Save the current project checkpoint.\n");
      await waitFor(() => fixture.output.text().includes("Allow this call? [y/n]"));
      input.write("n\n");
      await waitFor(() => fixture.output.text().includes("The checkpoint save was denied."));
      assert.deepEqual(await fixture.checkpointStore.getCurrent(), { ok: true, current: null });
      await assert.rejects(readFile(join(fixture.workspace, CHECKPOINT_FILE_NAME), "utf8"), {
        code: "ENOENT",
      });
      input.end();
      await tui;
    } finally {
      fixture.dispose();
      await rm(fixture.workspace, { recursive: true, force: true });
    }
  });
});

describe("createToolConfirmation run-scoped authorization", () => {
  const workspaceRoot = "/tmp/runloom-r2a-workspace";

  function authorizeFileScope(
    confirmation: ReturnType<typeof createToolConfirmation>,
    options: {
      tools?: ("read_file" | "search_files" | "write_file" | "edit_file")[];
      allowedPaths?: string[];
    } = {},
  ): void {
    confirmation.setPendingAuthorization({
      tools: options.tools ?? ["read_file", "search_files", "write_file", "edit_file"],
      allowedPaths: options.allowedPaths ?? ["docs/", "reports/"],
      lifetime: "run",
    });
    confirmation.beginRun();
  }

  it("allows normalized in-scope paths for explicitly authorized tools", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, { workspaceRoot });
    authorizeFileScope(confirmation, {
      tools: ["read_file"],
      allowedPaths: ["docs/"],
    });

    const normalized = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/../docs/guide.md",
      }),
    );
    assert.deepEqual(await normalized, { allow: true });
    assert.equal(output.text(), "");

    const normalizedPath = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/./guide.md",
      }),
    );
    assert.deepEqual(await normalizedPath, { allow: true });
    assert.equal(output.text(), "");
    confirmation.endRun();
  });

  it("does not widen authorization to tools outside the explicit whitelist", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, { workspaceRoot });
    authorizeFileScope(confirmation, {
      tools: ["read_file"],
      allowedPaths: ["docs/"],
    });

    const pending = confirmation.beforeToolExecute(
      toolInput("shell_exec", new AbortController().signal, {
        command: "cat docs/guide.md",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: shell_exec/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await pending, {
      allow: false,
      reason: "User denied this tool call",
    });
    confirmation.endRun();
  });

  it("asks again for an out-of-scope normalized path and never executes it after denial", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, { workspaceRoot });
    authorizeFileScope(confirmation, {
      tools: ["read_file"],
      allowedPaths: ["docs/"],
    });

    const first = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/guide.md",
      }),
    );
    assert.deepEqual(await first, { allow: true });

    const outside = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/../secrets.txt",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: read_file/);
    assert.match(output.text(), /secrets\.txt/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await outside, {
      allow: false,
      reason: "User denied this tool call",
    });

    const retry = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "secrets.txt",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Allow this call\? \[y\/n\]/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await retry, {
      allow: false,
      reason: "User denied this tool call",
    });
    confirmation.endRun();
  });

  it("clears authorization when the Run ends and does not reuse it on the next Run", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, { workspaceRoot });
    authorizeFileScope(confirmation, {
      tools: ["read_file"],
      allowedPaths: ["docs/"],
    });

    const firstRun = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/guide.md",
      }),
    );
    assert.deepEqual(await firstRun, { allow: true });
    confirmation.endRun();

    const nextRun = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/guide.md",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: read_file/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await nextRun, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("does not let an aborted Run leave an authorization active", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, { workspaceRoot });
    authorizeFileScope(confirmation, {
      tools: ["read_file"],
      allowedPaths: ["docs/"],
    });
    confirmation.endRun();

    const controller = new AbortController();
    const pending = confirmation.beforeToolExecute(
      toolInput("read_file", controller.signal, { path: "docs/guide.md" }),
    );
    controller.abort("run stopped");
    await assert.rejects(
      Promise.resolve(pending),
      (reason: unknown) => reason === "run stopped",
    );
    assert.equal(confirmation.handleLine("y"), false);
  });
});

describe("createToolConfirmation persistent authorization", () => {
  const workspaceRoot = "/tmp/runloom-r2b-workspace";

  function persistentFileScope(
    options: {
      tools?: RunAuthorization["tools"];
      allowedPaths?: readonly string[];
    } = {},
  ): RunAuthorization {
    return {
      workspaceRoot,
      tools: options.tools ?? ["read_file"],
      allowedPaths: options.allowedPaths ?? ["docs"],
      lifetime: "run",
    };
  }

  it("allows every listed file tool under a persisted path scope", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      workspaceRoot,
      persistentAuthorizations: [
        persistentFileScope({
          tools: ["read_file", "search_files", "list_directory", "write_file", "edit_file"],
          allowedPaths: ["docs"],
        }),
      ],
    });

    for (const toolName of [
      "read_file",
      "search_files",
      "list_directory",
      "write_file",
      "edit_file",
    ] as const) {
      const decision = confirmation.beforeToolExecute(
        toolInput(toolName, new AbortController().signal, { path: "docs/guide.md" }),
      );
      assert.deepEqual(await decision, { allow: true });
    }
    assert.equal(output.text(), "");
  });

  it("keeps path and tool boundaries under persisted authorization", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      workspaceRoot,
      persistentAuthorizations: [persistentFileScope()],
    });

    const outside = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, {
        path: "docs/../secrets.txt",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: read_file/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await outside, {
      allow: false,
      reason: "User denied this tool call",
    });

    const omittedPath = confirmation.beforeToolExecute(
      toolInput("search_files", new AbortController().signal, {}),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: search_files/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await omittedPath, {
      allow: false,
      reason: "User denied this tool call",
    });

    const shell = confirmation.beforeToolExecute(
      toolInput("shell_exec", new AbortController().signal, {
        command: "cat docs/guide.md",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: shell_exec/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await shell, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("does not clear persisted authorization when a Run ends", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      workspaceRoot,
      persistentAuthorizations: [persistentFileScope()],
    });

    confirmation.beginRun();
    const firstRun = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, { path: "docs/guide.md" }),
    );
    assert.deepEqual(await firstRun, { allow: true });
    confirmation.endRun();

    confirmation.beginRun();
    const secondRun = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, { path: "docs/guide.md" }),
    );
    assert.deepEqual(await secondRun, { allow: true });
    confirmation.endRun();
    assert.equal(output.text(), "");
  });

  it("restores y/n after persisted rules are removed and the TUI is restarted", async () => {
    const firstOutput = outputBuffer();
    const first = createToolConfirmation(firstOutput, {
      workspaceRoot,
      persistentAuthorizations: [persistentFileScope()],
    });
    const allowed = first.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, { path: "docs/guide.md" }),
    );
    assert.deepEqual(await allowed, { allow: true });

    const secondOutput = outputBuffer();
    const restarted = createToolConfirmation(secondOutput, { workspaceRoot });
    const prompted = restarted.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, { path: "docs/guide.md" }),
    );
    await Promise.resolve();
    assert.match(secondOutput.text(), /Tool: read_file/);
    assert.equal(restarted.handleLine("n"), true);
    assert.deepEqual(await prompted, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("does not restore next-Run /authorize after a new confirmation is created", async () => {
    const firstOutput = outputBuffer();
    const first = createToolConfirmation(firstOutput, { workspaceRoot });
    first.setPendingAuthorization({
      tools: ["write_file"],
      allowedPaths: ["docs/"],
      lifetime: "run",
    });

    const secondOutput = outputBuffer();
    const restarted = createToolConfirmation(secondOutput, { workspaceRoot });
    const prompted = restarted.beforeToolExecute(
      toolInput("write_file", new AbortController().signal, { path: "docs/report.md" }),
    );
    await Promise.resolve();
    assert.match(secondOutput.text(), /Tool: write_file/);
    assert.equal(firstOutput.text(), "");
    assert.equal(restarted.handleLine("n"), true);
    assert.deepEqual(await prompted, {
      allow: false,
      reason: "User denied this tool call",
    });
  });
});

describe("createToolConfirmation sandbox shell authorization", () => {
  it("allows shell calls for one Docker-sandboxed Run only", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      shellSandboxMode: "docker",
    });

    confirmation.setPendingShellAuthorization();
    confirmation.beginRun();

    for (const command of ["pwd", "printf ok"]) {
      const decision = confirmation.beforeToolExecute(
        toolInput("shell_exec", new AbortController().signal, { command }),
      );
      assert.deepEqual(await decision, { allow: true });
    }
    assert.equal(output.text(), "");

    confirmation.endRun();
    const nextRun = confirmation.beforeToolExecute(
      toolInput("shell_exec", new AbortController().signal, { command: "pwd" }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: shell_exec/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await nextRun, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("keeps host and unsandboxed shell on per-call confirmation", async () => {
    for (const shellSandboxMode of ["host", "none"] as const) {
      const output = outputBuffer();
      const confirmation = createToolConfirmation(output, { shellSandboxMode });
      assert.throws(
        () => confirmation.setPendingShellAuthorization(),
        /requires Docker sandbox mode/,
      );

      const pending = confirmation.beforeToolExecute(
        toolInput("shell_exec", new AbortController().signal, { command: "pwd" }),
      );
      await Promise.resolve();
      assert.match(output.text(), /Allow this call\? \[y\/n\]/);
      assert.equal(confirmation.handleLine("n"), true);
      assert.deepEqual(await pending, {
        allow: false,
        reason: "User denied this tool call",
      });
    }
  });

  it("does not let shell authorization widen to file or other tools", async () => {
    const output = outputBuffer();
    const confirmation = createToolConfirmation(output, {
      shellSandboxMode: "docker",
    });
    confirmation.setPendingShellAuthorization();
    confirmation.beginRun();

    const pending = confirmation.beforeToolExecute(
      toolInput("read_file", new AbortController().signal, { path: "notes.md" }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: read_file/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await pending, {
      allow: false,
      reason: "User denied this tool call",
    });
    confirmation.endRun();
  });
});

/** Confirmation with the permission facts the web module declares, as the app assembles it. */
function webConfirmation(output: Writable) {
  const facts = createModuleHost([createWebModule({ searchEnabled: true, feedEnabled: true })], { notify() {} }).toolPermissions;
  return createToolConfirmation(output, { toolPermissions: name => facts.get(name) });
}

describe("createToolConfirmation web authorization", () => {
  it("allows only exact authorized origins for one Run", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.setPendingWebAuthorization([
      "https://example.com/",
      "http://docs.example.test",
    ]);
    confirmation.beginRun();

    for (const url of [
      "https://example.com/docs/start",
      "http://docs.example.test:80/guide",
    ]) {
      const allowed = confirmation.beforeToolExecute(
        toolInput("web_fetch", new AbortController().signal, { url }),
      );
      assert.deepEqual(await allowed, { allow: true });
    }
    assert.equal(output.text(), "");

    const differentOrigin = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://example.com.evil.test/docs",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: web_fetch/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await differentOrigin, {
      allow: false,
      reason: "User denied this tool call",
    });

    const otherOrigin = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://other.example/article",
      }),
    );
    await Promise.resolve();
    assert.equal(confirmation.handleLine("y"), true);
    assert.deepEqual(await otherOrigin, { allow: true });
    confirmation.endRun();
  });

  it("does not reuse web authorization after the Run ends", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.setPendingWebAuthorization(["https://example.com"]);
    confirmation.beginRun();
    const first = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://example.com/a",
      }),
    );
    assert.deepEqual(await first, { allow: true });
    confirmation.endRun();

    const next = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://example.com/b",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Allow this call\? \[y\/n\]/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await next, {
      allow: false,
      reason: "User denied this tool call",
    });
  });

  it("rejects non-origin web authorization values", () => {
    const confirmation = webConfirmation(outputBuffer());
    assert.throws(
      () => confirmation.setPendingWebAuthorization(["https://example.com/docs"]),
      /exact origin/,
    );
    assert.throws(
      () => confirmation.setPendingWebAuthorization(["file:///tmp"]),
      /http or https/,
    );
  });

  it("still prompts for feed_read after /authorize-web and honors n", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.setPendingWebAuthorization(["https://example.com"]);
    confirmation.beginRun();

    const feed = confirmation.beforeToolExecute(
      toolInput("feed_read", new AbortController().signal, {
        url: "https://example.com/feed.xml",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: feed_read/);
    assert.match(output.text(), /https:\/\/example\.com\/feed\.xml/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await feed, {
      allow: false,
      reason: "User denied this tool call",
    });
    confirmation.endRun();
  });

  it("denies feed_read without another prompt after web_search is refused", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.beginRun();

    const search = confirmation.beforeToolExecute(
      toolInput("web_search", new AbortController().signal, { query: "Node.js" }),
    );
    await Promise.resolve();
    assert.equal(confirmation.handleLine("n"), true);
    await search;

    const prompted = output.text();
    const feed = confirmation.beforeToolExecute(
      toolInput("feed_read", new AbortController().signal, {
        url: "https://nodejs.org/feed.xml",
      }),
    );
    assert.deepEqual(await feed, {
      allow: false,
      reason: "web_search was denied in this Run",
    });
    assert.equal(output.text(), prompted);
    assert.doesNotMatch(output.text(), /Tool: feed_read/);
    confirmation.endRun();
  });

  it("denies later web_fetch without a prompt after web_search is refused", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.beginRun();

    const search = confirmation.beforeToolExecute(
      toolInput("web_search", new AbortController().signal, {
        query: "Node.js event loop",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: web_search/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await search, {
      allow: false,
      reason: "User denied this tool call",
    });

    const prompted = output.text();
    const fetch = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick",
      }),
    );
    assert.deepEqual(await fetch, {
      allow: false,
      reason: "web_search was denied in this Run",
    });
    assert.equal(output.text(), prompted);
    assert.doesNotMatch(output.text(), /Tool: web_fetch/);
    assert.equal(confirmation.handleLine("n"), false);
    confirmation.endRun();
  });

  it("does not let /authorize-web bypass a denied web_search in the same Run", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.setPendingWebAuthorization(["https://nodejs.org"]);
    confirmation.beginRun();

    const search = confirmation.beforeToolExecute(
      toolInput("web_search", new AbortController().signal, { query: "event loop" }),
    );
    await Promise.resolve();
    assert.equal(confirmation.handleLine("n"), true);
    await search;

    const fetch = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick",
      }),
    );
    assert.deepEqual(await fetch, {
      allow: false,
      reason: "web_search was denied in this Run",
    });
    assert.doesNotMatch(output.text(), /Tool: web_fetch/);
    confirmation.endRun();
  });

  it("clears the search-denial latch when the Run ends", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.beginRun();
    const search = confirmation.beforeToolExecute(
      toolInput("web_search", new AbortController().signal, { query: "event loop" }),
    );
    await Promise.resolve();
    assert.equal(confirmation.handleLine("n"), true);
    await search;
    confirmation.endRun();

    confirmation.beginRun();
    const fetch = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: web_fetch/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await fetch, {
      allow: false,
      reason: "User denied this tool call",
    });
    confirmation.endRun();
  });

  it("still asks for web_fetch after an approved web_search", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.beginRun();
    const search = confirmation.beforeToolExecute(
      toolInput("web_search", new AbortController().signal, { query: "event loop" }),
    );
    await Promise.resolve();
    assert.equal(confirmation.handleLine("y"), true);
    assert.deepEqual(await search, { allow: true });

    const fetch = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: web_fetch/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await fetch, {
      allow: false,
      reason: "User denied this tool call",
    });
    confirmation.endRun();
  });

  it("does not latch web_fetch denial after an aborted search confirmation", async () => {
    const output = outputBuffer();
    const confirmation = webConfirmation(output);
    confirmation.beginRun();
    const controller = new AbortController();
    const search = confirmation.beforeToolExecute(
      toolInput("web_search", controller.signal, { query: "event loop" }),
    );
    await Promise.resolve();
    controller.abort(new Error("cancelled"));
    await assert.rejects(Promise.resolve(search), /cancelled/);

    const fetch = confirmation.beforeToolExecute(
      toolInput("web_fetch", new AbortController().signal, {
        url: "https://nodejs.org/learn/asynchronous-work/event-loop-timers-and-nexttick",
      }),
    );
    await Promise.resolve();
    assert.match(output.text(), /Tool: web_fetch/);
    assert.equal(confirmation.handleLine("n"), true);
    assert.deepEqual(await fetch, {
      allow: false,
      reason: "User denied this tool call",
    });
    confirmation.endRun();
  });
});
