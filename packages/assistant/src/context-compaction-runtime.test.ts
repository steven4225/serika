import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  AgentError,
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  JsonlAgentStore,
} from "@serika/core";
import { AiSdkAgentLoop, InMemoryModelRegistry, ToolRegistry } from "@serika/ai-sdk-adapter";
import { ContextCompactor } from "./context-compactor.js";
import { defaultContextBudget, effectiveContextBudget, estimateContextBudget, type ContextBudgetConfig } from "./context-budget.js";
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
const budget = effectiveContextBudget(defaultContextBudget(), { provider: "mock", modelId: "mock", contextWindowTokens: 32768, source: "configuration" });
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

it("retains a same-Run tool result until background publication and restores JSONL layers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runloom-auto-compact-"));
  try {
    const store = new JsonlAgentStore({ directory });
    await store.save(threadId, [
      message("old-user", "user", "Earlier decision: use the source. ".repeat(500)),
      message("old-assistant", "assistant", "Earlier answer. ".repeat(500)),
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
            inputSchema: z.object({}), outputSchema: z.object({ ok: z.literal(true), body: z.string() }),
            execute: async () => ({ ok: true as const, body: "Source paragraph. ".repeat(1000) }),
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
    assert.equal(summaryCalls, 0, "the primary Run never waits for summaries");
    assert.doesNotMatch(prompts[0]!, /Historical index/);
    assert.doesNotMatch(prompts[1]!, /masked pending/);
    assert.match(prompts[1]!, /Source paragraph/);
    assert.match(JSON.stringify(await store.getMessages(threadId)), /Source paragraph/);
    while (compactor.pending) await compactor.runPending(new AbortController().signal);
    assert.equal(compactor.backgroundError, undefined); assert.ok(summaryCalls > 0);

    const reopened = new JsonlAgentStore({ directory });
    assert.ok((await reopened.getContextCompactions(threadId)).length > 0);
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
    const messages = [message("old-user", "user", "Earlier work. ".repeat(1000)),
      message("old-assistant", "assistant", "Earlier result. ".repeat(1000)), message("current-user", "user", "Continue.")];
    await store.save(threadId, messages);
    await compactor.prepare(messages, controller.signal);
    await compactor.runPending(controller.signal);
    assert.deepEqual(await new JsonlAgentStore({ directory }).getContextCompactions(threadId), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["daily", "long-task"] as const) {
  it(`Demo: ${mode} retains unpublished full-size JSONL history, drains one background call per block, and reopens without replay`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `serika-${mode}-context-`));
    try {
      const store = new JsonlAgentStore({ directory });
      const modeBudget = ({ ...defaultContextBudget(), ...(mode === "long-task" ? { inputBudgetTokens: 400_000, keepRecentTokens: 64_000, summaryMaxOutputTokens: 8_000 } : {}) });
      const oldMessages = Array.from({ length: mode === "daily" ? 20 : 32 }, (_, index) => [
        message(`old-user-${index}`, "user", `Constraint ${index}: do not modify protected/. ${"u".repeat(8_000)}`),
        message(`old-answer-${index}`, "assistant", "a".repeat(13_000)),
      ]).flat();
      await store.save(threadId, oldMessages);
      let summaryCalls = 0;
      const modeSummary = JSON.stringify({
        version: 2,
        goal: { text: "Continue the original task", evidenceMessageIds: ["old-user-0"] },
        constraints: [{ text: "Do not modify protected/", evidenceMessageIds: ["old-user-0"] }],
        decisions: [], actions: [], pending: [], files: [], nextStep: null,
      });
      const compactor = new ContextCompactor({
        store, threadId, modelId: "mock", budget: modeBudget,
        summarizer: { async complete() { summaryCalls += 1; return { text: modeSummary.slice(0, -1) + ',"farIndex":"Earlier task; do not modify protected/"}' }; } },
        fixedContext: () => ({ instructions: definition.instructions, tools: [], dynamicContext: "" }),
      });
      const raw = estimateContextBudget({ instructions: definition.instructions, messages: oldMessages }, modeBudget);
      assert.ok(raw.inputTokens < modeBudget.inputBudgetTokens! * .85, "forecast must trigger before the actual 85% threshold");
      let modelCalls = 0;
      const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
        modelCalls += 1;
        assert.doesNotMatch(JSON.stringify(prompt), /masked pending/);
        assert.match(JSON.stringify(prompt), /old-user-0|Constraint 0/);
        assert.match(JSON.stringify(prompt), /Continue without any tool/);
        return response("text");
      } });
      const runtime = new DefaultAgentRuntime({
        catalog: new InMemoryAgentCatalog([{ ...definition, tools: [] }]),
        store,
        loop: new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ mock: model }), tools: new ToolRegistry() }),
        prepareModelContext: ({ messages, signal }) => compactor.prepare(messages, signal),
      });
      const handle = await runtime.run({ agentId: definition.id, threadId,
        messages: [message("current-user", "user", "Continue without any tool.")] });
      const events = (async () => { for await (const _event of handle.events) { /* drain */ } })();
      const result = await handle.result;
      assert.equal(result.status, "completed", JSON.stringify(result));
      await events;
      assert.equal(modelCalls, 1, "compaction must not create a second primary Run or replay tools");
      assert.equal(summaryCalls, 0);
      while (compactor.pending) await compactor.runPending(new AbortController().signal);
      assert.equal(compactor.backgroundError, undefined); assert.ok(summaryCalls > 1);
      const reopened = new JsonlAgentStore({ directory });
      const records = await reopened.getContextCompactions(threadId);
      assert.equal(records.length, summaryCalls);
      assert.ok((await reopened.getMessages(threadId)).length > oldMessages.length, "physical history remains intact");
      const restored = new ContextCompactor({
        store: reopened, threadId, modelId: "mock", budget: modeBudget,
        summarizer: { async complete() { throw new Error("reopening a valid summary must not resummarize old history"); } },
        fixedContext: () => ({ instructions: definition.instructions, tools: [], dynamicContext: "" }),
      });
      const prepared = await restored.prepare(await reopened.getMessages(threadId), new AbortController().signal);
      const final = estimateContextBudget({ instructions: definition.instructions, messages: prepared }, modeBudget);
      assert.ok(final.inputTokens < modeBudget.inputBudgetTokens! * .7);
      assert.equal(prepared.some(item => item.id === "runloom-context-summary"), true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const sizedBudget of [budget, defaultContextBudget()]) it(`unknown write failure retains the original request and receipt in the next request, compaction and cold restart (${sizedBudget.contextWindowTokens})`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "serika-unknown-history-"));
  const request = "请只调用一次 write_file；结果未知就停止，不重试、不读回，不说成成功或失败";
  const unknownDefinition = { ...definition, tools: ["write_file"] };
  let invocations = 0;
  try {
    const store = new JsonlAgentStore({ directory });
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: "unknown-write", toolName: "write_file", input: "{}" },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
    ] }) }) });
    const runtime = new DefaultAgentRuntime({ catalog: new InMemoryAgentCatalog([unknownDefinition]), store,
      loop: new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ mock: model }), tools: new ToolRegistry([{
        metadata: { name: "write_file", version: "1", risk: "write", timeoutMs: 1_000, idempotent: false },
        tool: tool({ inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }), execute: async () => {
          invocations++;
          throw new AgentError({ code: "TOOL_OUTCOME_UNKNOWN", message: "Receipt lost after dispatch", retryable: false, phase: "tool" });
        } }),
      }]) }),
    });
    const failed = await (await runtime.run({ agentId: definition.id, threadId,
      messages: [message("unknown-request", "user", request)] })).result;
    assert.equal(failed.status, "failed"); assert.equal(failed.error?.code, "TOOL_OUTCOME_UNKNOWN");
    const saved = await store.getMessages(threadId);
    assert.equal(saved[0]?.parts[0]?.type === "text" && saved[0].parts[0].text, request);
    assert.match(JSON.stringify(saved), /TOOL_OUTCOME_UNKNOWN/);
    const next = async (currentStore: JsonlAgentStore, compactor?: ContextCompactor) => {
      const checking = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
        const text = JSON.stringify(prompt);
        assert.ok(text.includes(request), "exact failed request must reach the provider input");
        assert.match(text, /unknown-write/); assert.match(text, /unknown|TOOL_OUTCOME_UNKNOWN/);
        return response("text");
      } });
      const nextRuntime = new DefaultAgentRuntime({ catalog: new InMemoryAgentCatalog([{ ...definition, tools: [] }]), store: currentStore,
        loop: new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ mock: checking }), tools: new ToolRegistry() }),
        ...(compactor ? { prepareModelContext: ({ messages, signal }) => compactor.prepare(messages, signal) } satisfies Pick<ConstructorParameters<typeof DefaultAgentRuntime>[0], "prepareModelContext"> : {}),
      });
      assert.equal((await (await nextRuntime.run({ agentId: definition.id, threadId,
        messages: [message(`next-${(await currentStore.getMessages(threadId)).length}`, "user", "继续说明当前状态，不调用工具")] })).result).status, "completed");
    };
    await next(store);
    await store.save(threadId, [...await store.getMessages(threadId), ...Array.from({ length: 12 }, (_, i) => [
      message(`padding-user-${i}`, "user", "旧讨论 ".repeat(1_200)), message(`padding-answer-${i}`, "assistant", "旧回复 ".repeat(1_200)),
    ]).flat()]);
    const makeCompactor = (currentStore: JsonlAgentStore) => new ContextCompactor({ store: currentStore, threadId, modelId: "mock", budget: sizedBudget,
      summarizer: { async complete() { return { text: JSON.stringify({ version: 2, goal: { text: "继续当前工作", evidenceMessageIds: ["unknown-request"] },
        constraints: [], decisions: [], actions: [], pending: [], files: [], nextStep: null, farIndex: "Earlier conversation" }) }; } },
      fixedContext: () => ({ instructions: definition.instructions, tools: [], dynamicContext: "" }),
    });
    const compactor = makeCompactor(store);
    await compactor.prepare(await store.getMessages(threadId), new AbortController().signal);
    while (compactor.pending) await compactor.runPending(new AbortController().signal);
    assert.equal(compactor.backgroundError, undefined);
    const records = await store.getContextCompactions(threadId);
    assert.ok(records.length > 0, "exercise a persisted compaction, not a no-op");
    assert.ok(records.some(record => typeof record.firstKeptMessageIndex === "number" && record.firstKeptMessageIndex >= 2), "failed turn must be inside the summarized prefix");
    await next(store, compactor);
    await compactor.close();
    const reopened = new JsonlAgentStore({ directory });
    await next(reopened, makeCompactor(reopened));
    assert.equal(invocations, 1, "failed write is never replayed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
