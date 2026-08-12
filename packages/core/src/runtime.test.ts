import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

describe("DefaultAgentRuntime", () => {
  it("persists a completed run and contiguous events", async () => {
    const store = new InMemoryAgentStore();
    const loop: AgentLoop = {
      async execute({ emit }) {
        await emit("step.started", { stepNumber: 1 });
        await emit("message.delta", { text: "hello" });
        return {
          text: "hello",
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
      messages: [],
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
      async execute() {
        await blocked;
        return { text: "ok", steps: 1, usage: {}, stopReason: "completed" };
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
      messages: [],
    });

    await assert.rejects(
      runtime.run({ agentId: "test", threadId: "same-thread", messages: [] }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "data" in error &&
        (error as { data?: { code?: string } }).data?.code === "RUN_CONFLICT",
    );

    release();
    await first.result;
  });
});
