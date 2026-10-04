import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  JsonlAgentStore,
} from "@aisdk-agent/core";
import { AiSdkAgentLoop, InMemoryModelRegistry, ToolRegistry } from "@aisdk-agent/ai-sdk-adapter";
import { ContextCompactor } from "./context-compactor.js";
import type { ContextBudgetConfig } from "./context-budget.js";
import type { Summarizer } from "./context-compaction.js";

const threadId = "auto-compaction-runtime";
const definition = {
  id: "auto-compaction-runtime",
  version: "1",
  instructions: "Read the source before answering.",
  model: "mock",
  tools: ["read_source"],
  limits: { maxSteps: 2, totalTimeoutMs: 5_000, stepTimeoutMs: 2_000 },
};
const budget: ContextBudgetConfig = {
  enabled: true,
  contextWindowTokens: 1_600,
  maxOutputTokens: 100,
  safetyMarginTokens: 50,
  keepRecentTokens: 40,
  summaryMaxOutputTokens: 100,
};
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};
const message = (id: string, role: "user" | "assistant", text: string): UIMessage => ({
  id, role, parts: [{ type: "text", text }],
});
const summary = JSON.stringify({
  version: 2,
  goal: { text: "Answer using the opened source", evidenceMessageIds: ["old-user"] },
  constraints: [], decisions: [], actions: [], pending: [], files: [], nextStep: null,
});

function response(kind: "tool" | "text") {
  if (kind === "tool") {
    return { stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId: "read-1", toolName: "read_source", input: "{}" },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ],
    }) };
  }
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: "The source was read." },
        { type: "text-end" as const, id: "answer" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
    }),
  };
}

it("automatically compacts a same-Run tool result, continues, and restores JSONL summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-auto-compact-"));
  try {
    const store = new JsonlAgentStore({ directory });
    await store.save(threadId, [
      message("old-user", "user", "Earlier decision: use the source. ".repeat(22)),
      message("old-assistant", "assistant", "Earlier answer. ".repeat(22)),
    ]);
    let summaryCalls = 0;
    const summarizer: Summarizer = {
      async complete() {
        summaryCalls += 1;
        return { text: summary };
      },
    };
    const compactor = new ContextCompactor({
      store, threadId, modelId: "mock", summarizer, budget,
      fixedContext: () => ({ instructions: definition.instructions, tools: [], dynamicContext: "" }),
    });
    const prompts: string[] = [];
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        modelCalls += 1;
        return response(modelCalls === 1 ? "tool" : "text");
      },
    });
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ mock: model }),
        tools: new ToolRegistry([{
          metadata: { name: "read_source", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
          tool: tool({
            inputSchema: z.object({}), outputSchema: z.object({ body: z.string() }),
            execute: async () => ({ body: "Source paragraph. ".repeat(75) }),
          }),
        }]),
      }),
      store,
      prepareModelContext: ({ messages, signal }) => compactor.prepare(messages, signal),
      beforeToolExecute: async () => ({ allow: true }),
    });
    const handle = await runtime.run({
      agentId: definition.id, threadId,
      messages: [message("current-user", "user", "Open the source and answer.")],
    });
    const result = await handle.result;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(modelCalls, 2);
    assert.equal(summaryCalls, 3, "lossless old user text requires bounded merges, not head/tail clipping");
    assert.doesNotMatch(prompts[0]!, /runloom-context-summary/);
    assert.match(prompts[1]!, /Context summary/);
    assert.match(prompts[1]!, /Source paragraph/);

    const reopened = new JsonlAgentStore({ directory });
    assert.equal((await reopened.getContextCompactions(threadId)).length, 1);
    const restarted = new ContextCompactor({
      store: reopened, threadId, modelId: "mock", budget,
      summarizer: { async complete() { throw new Error("persisted summary should be reused"); } },
      fixedContext: () => ({ instructions: definition.instructions, tools: [], dynamicContext: "" }),
    });
    const prepared = await restarted.prepare(await reopened.getMessages(threadId), new AbortController().signal);
    assert.ok(prepared.some((item) => item.id === "runloom-context-summary"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("cancelled automatic summary does not persist a partial record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-auto-compact-cancel-"));
  try {
    const store = new JsonlAgentStore({ directory });
    const controller = new AbortController();
    const compactor = new ContextCompactor({
      store, threadId, modelId: "mock", budget,
      summarizer: {
        async complete() {
          controller.abort(new DOMException("cancel summary", "AbortError"));
          return { text: summary };
        },
      },
      fixedContext: () => ({ instructions: "short", tools: [], dynamicContext: "" }),
    });
    await assert.rejects(
      compactor.prepare([
        message("old-user", "user", "Earlier work. ".repeat(65)),
        message("old-assistant", "assistant", "Earlier result. ".repeat(65)),
        message("current-user", "user", "Continue."),
      ], controller.signal, true),
      /cancel summary/,
    );
    assert.deepEqual(await new JsonlAgentStore({ directory }).getContextCompactions(threadId), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
