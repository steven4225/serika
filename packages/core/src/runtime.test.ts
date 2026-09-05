import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
  type AgentEvent,
  type RunRecord,
  type RunResult,
  type RunStatus,
  type AgentLoop,
} from "./index.js";

const definition = {
  id: "test",
  version: "1",
  instructions: "test",
  model: "mock",
  tools: [],
  limits: { maxSteps: 2, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
};

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

class FailingCompletedNotificationStore extends InMemoryAgentStore {
  override async append(event: AgentEvent): Promise<void> {
    if (event.type === "run.completed") {
      throw new Error("notification unavailable");
    }
    await super.append(event);
  }
}

class FailingCompletedTransitionStore extends InMemoryAgentStore {
  override async transition(
    runId: string,
    expectedVersion: number,
    status: RunStatus,
    result?: RunResult,
  ): Promise<RunRecord> {
    if (status === "completed") {
      throw new Error("terminal transition unavailable");
    }
    return super.transition(runId, expectedVersion, status, result);
  }
}

class CountingStore extends InMemoryAgentStore {
  createCount = 0;
  saveCount = 0;

  override async create(record: RunRecord): Promise<void> {
    this.createCount += 1;
    await super.create(record);
  }

  override async save(threadId: string, messages: UIMessage[]): Promise<void> {
    this.saveCount += 1;
    await super.save(threadId, messages);
  }
}

class DelayedCreateStore extends CountingStore {
  readonly started: Promise<void>;
  release!: () => void;

  constructor() {
    super();
    let releaseStarted!: () => void;
    this.started = new Promise((resolve) => {
      releaseStarted = resolve;
    });
    this.#releaseStarted = releaseStarted;
  }

  #releaseStarted: () => void;

  override async create(record: RunRecord): Promise<void> {
    this.#releaseStarted();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    await super.create(record);
  }
}

class DelayedSaveStore extends CountingStore {
  readonly started: Promise<void>;
  release!: () => void;

  constructor() {
    super();
    let releaseStarted!: () => void;
    this.started = new Promise((resolve) => {
      releaseStarted = resolve;
    });
    this.#releaseStarted = releaseStarted;
  }

  #releaseStarted: () => void;

  override async save(threadId: string, messages: UIMessage[]): Promise<void> {
    this.#releaseStarted();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    await super.save(threadId, messages);
  }
}

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

describe("DefaultAgentRuntime", () => {
  it("rejects an already aborted request before creating a run", async () => {
    const controller = new AbortController();
    controller.abort("already stopped");
    const store = new CountingStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: { execute: async () => { throw new Error("should not execute"); } },
      store,
    });

    await assert.rejects(
      runtime.run({
        agentId: "test",
        threadId: "thread-aborted-entry",
        messages: [userMessage("user-1", "hello")],
        signal: controller.signal,
      }),
      (error: unknown) =>
        error instanceof Error &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code === "RUN_CANCELLED",
    );
    assert.equal(store.createCount, 0);
  });

  it("cancels a run aborted while creating it without entering the loop", async () => {
    const controller = new AbortController();
    const store = new DelayedCreateStore();
    let loopCalls = 0;
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: {
        async execute() {
          loopCalls += 1;
          throw new Error("should not execute");
        },
      },
      store,
    });

    const pending = runtime.run({
      agentId: "test",
      threadId: "thread-create-abort",
      messages: [userMessage("user-1", "hello")],
      signal: controller.signal,
    });
    await store.started;
    controller.abort("create cancelled");
    store.release();
    const handle = await pending;
    const result = await handle.result;

    assert.equal(result.status, "cancelled");
    assert.equal(loopCalls, 0);
    assert.equal((await store.getRun(handle.runId))?.status, "cancelled");
  });

  it("keeps the first stop reason when cancellation and timeout compete", async () => {
    const shortDefinition = {
      ...definition,
      limits: { ...definition.limits, totalTimeoutMs: 25 },
    };
    const store = new CountingStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([shortDefinition]),
      loop: { execute: async ({ signal }) => waitForAbort(signal) },
      store,
    });
    const handle = await runtime.run({
      agentId: "test",
      threadId: "thread-stop-order",
      messages: [userMessage("user-1", "hello")],
    });

    await handle.cancel("manual stop");
    const result = await handle.result;
    assert.equal(result.status, "cancelled");
    await new Promise((resolve) => setTimeout(resolve, shortDefinition.limits.totalTimeoutMs + 10));
    assert.equal((await store.getRun(handle.runId))?.status, "cancelled");
  });

  it("keeps a run timeout when cancellation arrives afterwards", async () => {
    const shortDefinition = {
      ...definition,
      limits: { ...definition.limits, totalTimeoutMs: 10 },
    };
    const store = new CountingStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([shortDefinition]),
      loop: { execute: async ({ signal }) => waitForAbort(signal) },
      store,
    });
    const handle = await runtime.run({
      agentId: "test",
      threadId: "thread-timeout-order",
      messages: [userMessage("user-1", "hello")],
    });

    const result = await handle.result;
    await handle.cancel("late manual stop");
    assert.equal(result.status, "timed_out");
    assert.equal(store.saveCount, 0);
    assert.equal((await store.getRun(handle.runId))?.status, "timed_out");
  });

  it("does not save when cancelled before the commit boundary", async () => {
    const controller = new AbortController();
    const store = new CountingStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: { execute: async ({ signal }) => waitForAbort(signal) },
      store,
    });
    const handle = await runtime.run({
      agentId: "test",
      threadId: "thread-no-save-on-cancel",
      messages: [userMessage("user-1", "hello")],
      signal: controller.signal,
    });

    controller.abort("cancel before save");
    assert.equal((await handle.result).status, "cancelled");
    assert.equal(store.saveCount, 0);
  });

  it("does not turn a late cancellation during save into a cancelled result", async () => {
    const store = new DelayedSaveStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: {
        async execute({ messages, generateId }) {
          return {
            text: "saved",
            messages: [
              ...messages,
              { id: generateId(), role: "assistant", parts: [{ type: "text", text: "saved" }] },
            ],
            steps: 1,
            usage: {},
            stopReason: "completed" as const,
          };
        },
      },
      store,
    });
    const handle = await runtime.run({
      agentId: "test",
      threadId: "thread-save-boundary",
      messages: [userMessage("user-1", "hello")],
    });

    await store.started;
    await handle.cancel("late cancellation");
    store.release();
    assert.equal((await handle.result).status, "completed");
    assert.equal((await store.getMessages("thread-save-boundary")).length, 2);
  });

  it("persists a completed run and contiguous events", async () => {
    const store = new InMemoryAgentStore();
    const loop: AgentLoop = {
      async execute({ emit, generateId, messages }) {
        await emit("step.started", { stepNumber: 1 });
        await emit("message.delta", { text: "hello" });
        return {
          text: "hello",
          messages: [
            ...messages,
            {
              id: generateId(),
              role: "assistant",
              parts: [{ type: "text", text: "hello" }],
            },
          ],
          steps: 1,
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          stopReason: "completed",
        };
      },
    };
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop,
      store,
      idGenerator: (() => {
        let value = 0;
        return () => `id-${++value}`;
      })(),
    });

    const handle = await runtime.run({
      agentId: "test",
      threadId: "thread-1",
      messages: [userMessage("user-1", "hello")],
    });
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of handle.events) events.push(event);
      return events;
    })();
    const result = await handle.result;
    const events = await eventsPromise;

    assert.equal(result.status, "completed");
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.map((event) => event.type), [
      "run.started",
      "step.started",
      "message.delta",
      "run.completed",
    ]);
    assert.equal((await store.getRun(handle.runId))?.status, "completed");
  });

  it("rejects concurrent active runs on one thread", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop: AgentLoop = {
      async execute({ messages }) {
        await blocked;
        return {
          text: "ok",
          messages,
          steps: 1,
          usage: {},
          stopReason: "completed",
        };
      },
    };
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop,
      store: new InMemoryAgentStore(),
    });
    const first = await runtime.run({
      agentId: "test",
      threadId: "same-thread",
      messages: [userMessage("user-1", "first")],
    });

    await assert.rejects(
      runtime.run({
        agentId: "test",
        threadId: "same-thread",
        messages: [userMessage("user-2", "second")],
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code === "RUN_CONFLICT",
    );

    release();
    await first.result;
  });

  it("rejects a run unless it contains exactly one new user message", async () => {
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: {
        async execute({ messages }) {
          return {
            text: "unused",
            messages,
            steps: 1,
            usage: {},
            stopReason: "completed",
          };
        },
      },
      store: new InMemoryAgentStore(),
    });
    const invalidMessages: UIMessage[][] = [
      [],
      [userMessage("user-1", "one"), userMessage("user-2", "two")],
      [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "not user input" }],
        },
      ],
    ];

    for (const messages of invalidMessages) {
      await assert.rejects(
        runtime.run({ agentId: "test", threadId: "thread-invalid", messages }),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "data" in error &&
          (error as { data?: { code?: string } }).data?.code === "INVALID_REQUEST",
      );
    }
  });

  it("loads the committed transcript before the next run", async () => {
    const seenMessages: UIMessage[][] = [];
    let reply = 0;
    const store = new InMemoryAgentStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: {
        async execute({ messages, generateId }) {
          seenMessages.push(structuredClone(messages));
          reply += 1;
          return {
            text: `reply-${reply}`,
            messages: [
              ...messages,
              {
                id: generateId(),
                role: "assistant",
                parts: [{ type: "text", text: `reply-${reply}` }],
              },
            ],
            steps: 1,
            usage: {},
            stopReason: "completed",
          };
        },
      },
      store,
    });

    await (
      await runtime.run({
        agentId: "test",
        threadId: "thread-history",
        messages: [userMessage("user-1", "first")],
      })
    ).result;
    await (
      await runtime.run({
        agentId: "test",
        threadId: "thread-history",
        messages: [userMessage("user-2", "second")],
      })
    ).result;

    assert.deepEqual(
      seenMessages[1]?.map((message) => message.role),
      ["user", "assistant", "user"],
    );
    assert.equal((await store.getMessages("thread-history")).length, 4);
  });

  it("does not overwrite the transcript when the next run fails", async () => {
    let shouldFail = false;
    const store = new InMemoryAgentStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: {
        async execute({ messages, generateId }) {
          if (shouldFail) throw new Error("model failed");
          return {
            text: "saved",
            messages: [
              ...messages,
              {
                id: generateId(),
                role: "assistant",
                parts: [{ type: "text", text: "saved" }],
              },
            ],
            steps: 1,
            usage: {},
            stopReason: "completed",
          };
        },
      },
      store,
    });

    await (
      await runtime.run({
        agentId: "test",
        threadId: "thread-failure",
        messages: [userMessage("user-1", "save this")],
      })
    ).result;
    const committed = await store.getMessages("thread-failure");

    shouldFail = true;
    const failed = await runtime.run({
      agentId: "test",
      threadId: "thread-failure",
      messages: [userMessage("user-2", "do not save this")],
    });
    assert.equal((await failed.result).status, "failed");
    assert.deepEqual(await store.getMessages("thread-failure"), committed);
  });

  it("keeps a completed result when its notification fails", async () => {
    const store = new FailingCompletedNotificationStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: {
        async execute({ messages, generateId }) {
          return {
            text: "saved",
            messages: [
              ...messages,
              {
                id: generateId(),
                role: "assistant",
                parts: [{ type: "text", text: "saved" }],
              },
            ],
            steps: 1,
            usage: {},
            stopReason: "completed",
          };
        },
      },
      store,
    });

    const first = await runtime.run({
      agentId: "test",
      threadId: "thread-notification",
      messages: [userMessage("user-1", "first")],
    });
    assert.equal((await first.result).status, "completed");
    assert.equal((await store.getMessages("thread-notification")).length, 2);

    const second = await runtime.run({
      agentId: "test",
      threadId: "thread-notification",
      messages: [userMessage("user-2", "second")],
    });
    assert.equal((await second.result).status, "completed");
  });

  it("rejects when finalization fails after saving the transcript", async () => {
    const store = new FailingCompletedTransitionStore();
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: {
        async execute({ messages, generateId }) {
          return {
            text: "saved",
            messages: [
              ...messages,
              {
                id: generateId(),
                role: "assistant",
                parts: [{ type: "text", text: "saved" }],
              },
            ],
            steps: 1,
            usage: {},
            stopReason: "completed",
          };
        },
      },
      store,
    });

    const handle = await runtime.run({
      agentId: "test",
      threadId: "thread-finalization",
      messages: [userMessage("user-1", "first")],
    });
    await assert.rejects(
      handle.result,
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        (error as { data?: { phase?: string } }).data?.phase === "storage",
    );
    assert.equal((await store.getMessages("thread-finalization")).length, 2);

    await assert.rejects(
      runtime.run({
        agentId: "test",
        threadId: "thread-finalization",
        messages: [userMessage("user-2", "second")],
      }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code === "RUN_CONFLICT",
    );
  });
});
