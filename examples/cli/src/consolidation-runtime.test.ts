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
import { selectModelContext } from "./context-window.js";
import { createModuleHost } from "./module-host.js";
import type { MemoryEntry, WorkspaceMemoryStore } from "./memory-store.js";
import { createMemoryModule } from "./modules/memory-module.js";

const definition = {
  id: "consolidation-runtime-test",
  version: "1",
  instructions: "Prepare and explain memory suggestions.",
  model: "consolidation-test-model",
  tools: ["memory_prepare_consolidation"],
  limits: { maxSteps: 2, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
};

function message(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function prepareResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "consolidation-call",
          toolName: "memory_prepare_consolidation",
          input: JSON.stringify({ turns: 1 }),
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

function suggestionResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: "建议保存项目约定。" },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  };
}

describe("memory consolidation Runtime integration", () => {
  it("feeds committed material to the next model step without writing memory", async () => {
    const threadId = "consolidation-runtime";
    const store = new InMemoryAgentStore();
    await store.save(threadId, [
      message("previous-user", "user", "项目约定是先 review 再提交。"),
      message("previous-assistant", "assistant", "我会遵守这个约定。"),
    ]);

    const entries: MemoryEntry[] = [
      { id: "existing", text: "已有项目约定", enabled: false },
    ];
    let addCalls = 0;
    let updateCalls = 0;
    const memoryStore: WorkspaceMemoryStore = {
      list: async () => ({ ok: true as const, entries: entries.map((entry) => ({ ...entry })) }),
      get: async () => ({ ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "not found" } }),
      add: async () => {
        addCalls += 1;
        throw new Error("memory_add must wait for the user's save request");
      },
      update: async () => {
        updateCalls += 1;
        throw new Error("memory_update must wait for the user's save request");
      },
      delete: async () => ({ ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "not found" } }),
    };

    const moduleHost = createModuleHost(
      [createMemoryModule(memoryStore, () => store.getMessages(threadId))],
      { notify: () => undefined },
    );
    const prompts: string[] = [];
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        modelCalls += 1;
        prompts.push(JSON.stringify(prompt));
        return modelCalls === 1 ? prepareResponse() : suggestionResponse();
      },
    });
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ [definition.model]: model }),
        tools: new ToolRegistry(moduleHost.tools),
      }),
      prepareModelContext: ({ messages }) => selectModelContext(messages),
      beforeToolExecute: async () => ({ allow: true }),
      store,
    });

    try {
      const handle = await runtime.run({
        agentId: definition.id,
        threadId,
        messages: [message("consolidate-user", "user", "请整理最近对话并给出记忆建议。")],
      });
      const result = await handle.result;

      assert.equal(result.status, "completed");
      assert.equal(modelCalls, 2);
      assert.match(prompts[1]!, /项目约定是先 review 再提交/);
      assert.match(prompts[1]!, /已有项目约定/);
      assert.equal(addCalls, 0);
      assert.equal(updateCalls, 0);
    } finally {
      moduleHost.dispose();
    }
  });
});
