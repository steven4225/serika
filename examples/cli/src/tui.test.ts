import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import type {
  AgentEvent,
  MessageStore,
  RunHandle,
  RunRequest,
  RunResult,
} from "@aisdk-agent/core";
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
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
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
});
