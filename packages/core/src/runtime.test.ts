import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
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

describe("DefaultAgentRuntime", () => {
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
});
