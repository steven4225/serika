import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { simulateReadableStream, type UIMessage } from "ai";
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
  MAX_CONTEXT_BYTES,
  selectModelContext,
} from "./context-window.js";
import { createModuleHost } from "./module-host.js";
import { createMemoryModule } from "./modules/memory-module.js";
import type { MemoryEntry, WorkspaceMemoryStore } from "./memory-store.js";

const definition = {
  id: "context-window-test",
  version: "1",
  instructions: "Answer briefly.",
  model: "context-test-model",
  tools: [],
  limits: { maxSteps: 1, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
};

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

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
            inputTokens: {
              total: 3,
              noCache: 3,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: 1,
              text: 1,
              reasoning: undefined,
            },
          },
        },
      ],
    }),
  };
}

function memoryAddResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "memory-add-call",
          toolName: "memory_add",
          input: JSON.stringify({ text: "remember this" }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  };
}

class CountingStore extends InMemoryAgentStore {
  saveCount = 0;

  override async save(threadId: string, messages: UIMessage[]): Promise<void> {
    this.saveCount += 1;
    await super.save(threadId, messages);
  }
}

function runtimeFor(
  model: MockLanguageModelV3,
  store: InMemoryAgentStore,
): DefaultAgentRuntime {
  return new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([definition]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ [definition.model]: model }),
      tools: new ToolRegistry(),
    }),
    prepareModelContext: ({ messages }) => selectModelContext(messages),
    store,
  });
}

describe("context window Runtime integration", () => {
  it("trims only the model prompt while saving the complete transcript", async () => {
    const threadId = "context-window-trim";
    const committed: UIMessage[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      committed.push(
        userMessage(`history-user-${turn}`, `history-user-${turn}`),
        assistantMessage(`history-assistant-${turn}`, `history-assistant-${turn}`),
      );
    }

    const store = new CountingStore();
    await store.save(threadId, committed);
    store.saveCount = 0;
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        return textResponse("done");
      },
    });
    const runtime = runtimeFor(model, store);

    const handle = await runtime.run({
      agentId: definition.id,
      threadId,
      messages: [userMessage("current-user", "current question")],
    });
    const result = await handle.result;

    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]!.includes("history-user-0"), false);
    assert.equal(prompts[0]!.includes("history-user-1"), false);
    assert.equal(prompts[0]!.includes("history-user-2"), true);
    assert.equal(prompts[0]!.includes("history-assistant-9"), true);
    assert.equal(prompts[0]!.includes("current question"), true);

    assert.equal(store.saveCount, 1);
    const saved = await store.getMessages(threadId);
    assert.deepEqual(
      saved.slice(0, committed.length).map((message) => message.id),
      committed.map((message) => message.id),
    );
    assert.equal(saved.some((message) => message.id === "current-user"), true);
  });

  it("fails before the model and transcript save when the current turn is oversized", async () => {
    const threadId = "context-window-too-large";
    const store = new CountingStore();
    const committed = [
      userMessage("old-user", "old history"),
      assistantMessage("old-assistant", "old answer"),
    ];
    await store.save(threadId, committed);
    store.saveCount = 0;

    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return textResponse("must not run");
      },
    });
    const runtime = runtimeFor(model, store);
    const handle = await runtime.run({
      agentId: definition.id,
      threadId,
      messages: [
        userMessage("oversized-current", "x".repeat(MAX_CONTEXT_BYTES)),
      ],
    });
    const result = await handle.result;

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "CONTEXT_PREPARE_FAILED");
    assert.equal(modelCalls, 0);
    assert.equal(store.saveCount, 0);
    assert.deepEqual(await store.getMessages(threadId), committed);
  });

  it("reads newly added memory on the next model step without saving the injected message", async () => {
    const threadId = "context-window-memory";
    const store = new CountingStore();
    const entries: MemoryEntry[] = [];
    const memoryStore: WorkspaceMemoryStore = {
      list: async () => ({ ok: true as const, entries: entries.map((entry) => ({ ...entry })) }),
      get: async (id) => {
        const entry = entries.find((value) => value.id === id);
        return entry
          ? { ok: true as const, entry: { ...entry } }
          : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "not found" } };
      },
      add: async ({ text, enabled }) => {
        const entry = { id: "memory-1", text, enabled: enabled ?? true };
        entries.push(entry);
        return { ok: true as const, entry: { ...entry } };
      },
      update: async () => ({ ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "not found" } }),
      delete: async (id) => ({ ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: `not found: ${id}` } }),
    };
    const moduleHost = createModuleHost([createMemoryModule(memoryStore)], {
      notify: () => undefined,
    });
    const prompts: string[] = [];
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        modelCalls += 1;
        prompts.push(JSON.stringify(prompt));
        return modelCalls === 1 ? memoryAddResponse() : textResponse("memory seen");
      },
    });
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([
        {
          ...definition,
          tools: ["memory_add"],
          limits: { maxSteps: 2, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
        },
      ]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ [definition.model]: model }),
        tools: new ToolRegistry(moduleHost.tools),
      }),
      prepareModelContext: async ({ messages, signal }) => {
        const listed = await memoryStore.list(signal);
        if (!listed.ok) throw new Error(listed.error.message);
        return selectModelContext(messages, listed.entries);
      },
      beforeToolExecute: async () => ({ allow: true }),
      store,
    });

    try {
      const handle = await runtime.run({
        agentId: definition.id,
        threadId,
        messages: [userMessage("memory-user", "remember something")],
      });
      const result = await handle.result;

      assert.equal(result.status, "completed");
      assert.equal(modelCalls, 2);
      assert.equal(prompts[1]!.includes("remember this"), true);
      const saved = await store.getMessages(threadId);
      assert.equal(saved.some((message) => message.id === "runloom-workspace-memory"), false);
    } finally {
      moduleHost.dispose();
    }
  });
});
