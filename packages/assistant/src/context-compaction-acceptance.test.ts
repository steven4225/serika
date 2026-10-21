import assert from "node:assert/strict";
import { it } from "node:test";
import type { UIMessage } from "ai";
import {
  type ContextCompactionStore,
  type MessageStore,
  type ThreadContextCompactionRecord,
} from "@serika/core";
import { ContextCompactor } from "./context-compactor.js";
import { createAiSdkSummarizer, parseContextSummary, type ContextSummaryV2 } from "./context-compaction.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import { defaultContextBudget, estimateContextBudget, type ContextBudgetConfig } from "./context-budget.js";

const modelName = process.env.RUNLOOM_ACCEPTANCE_MODEL;

class MemoryStore implements MessageStore, ContextCompactionStore {
  messages: UIMessage[] = [];
  records: ThreadContextCompactionRecord[] = [];
  async save(_threadId: string, messages: UIMessage[]): Promise<void> {
    this.messages = structuredClone(messages);
  }
  async getMessages(_threadId: string): Promise<UIMessage[]> {
    return structuredClone(this.messages);
  }
  async appendContextCompaction(record: ThreadContextCompactionRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
  async getContextCompactions(_threadId: string): Promise<ThreadContextCompactionRecord[]> {
    return structuredClone(this.records);
  }
}

const budget: ContextBudgetConfig = {
  enabled: true,
  contextWindowTokens: 1_200,
  maxOutputTokens: 256,
  safetyMarginTokens: 64,
  keepRecentTokens: 80,
  summaryMaxOutputTokens: 1_024,
};

it("live DeepSeek summary JSON installs a compaction record", {
  skip: modelName !== "deepseek" && modelName !== "minimax-m3",
  timeout: 60_000,
}, async () => {
  const { model, modelAlias } = configureCliModel(createDemoModel);
  const store = new MemoryStore();
  const messages: UIMessage[] = [
    {
      id: "u1",
      role: "user",
      parts: [{
        type: "text",
        text: "在 notes/plan.md 新建一份三段计划；目标是整理 ALPHA-2026，只可修改 notes/，不得写 protected/。",
      }],
    },
    { id: "old-reference", role: "assistant", parts: [{ type: "text", text: "历史工作材料。".repeat(400) }] },
    {
      id: "write-1",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolName: "write_file",
        toolCallId: "write-1",
        state: "output-available",
        input: { path: "notes/plan.md", content: "# ALPHA-2026\n" },
        output: { ok: true, path: "notes/plan.md", bytes: 14 },
      }],
    },
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "下一步只补充约束：不改 protected/，先写目标。" }],
    },
  ];
  store.messages = messages;
  const compactor = new ContextCompactor({
    store,
    threadId: "phase2-compact-live",
    modelId: modelAlias,
    summarizer: createAiSdkSummarizer(model),
    budget,
    fixedContext: () => ({ instructions: "instructions", tools: [], memories: [], dynamicContext: "" }),
    generateId: () => "compact-live-1",
  });
  const prepared = await compactor.prepare(messages, AbortSignal.timeout(45_000), true);
  assert.equal(store.records.length, 1);
  const persisted = store.records[0]?.summary as unknown as ContextSummaryV2;
  assert.ok(parseContextSummary(JSON.stringify(persisted)));
  assert.equal(persisted.files[0]?.path, "notes/plan.md");
  assert.equal(prepared[0]?.id, "runloom-context-summary");
});

// Explicit opt-in: synthetic material only; never reads daily history or Memory.
for (const mode of ["daily", "long-task"] as const) {
  it(`live context mode Demo: ${mode} compacts forecast-sized history with the configured provider`, {
    skip: process.env.RUNLOOM_CONTEXT_MODES_LIVE !== "1",
    timeout: 620_000,
  }, async () => {
    assert.notEqual(process.env.RUNLOOM_MODEL, "mock", "live acceptance requires an explicitly configured real provider");
    const { model, modelAlias } = configureCliModel(createDemoModel);
    const modeBudget = ({ ...defaultContextBudget(), ...(mode === "long-task" ? { inputBudgetTokens: 400_000, keepRecentTokens: 64_000, summaryMaxOutputTokens: 8_000 } : {}) });
    const store = new MemoryStore();
    const constraints = "这是合成验收材料。目标：整理一份项目计划；不得修改 protected/；未执行的步骤不能宣称完成。";
    store.messages = Array.from({ length: mode === "daily" ? 20 : 32 }, (_, index): UIMessage[] => [
      { id: `user-${index}`, role: "user", parts: [{ type: "text", text: constraints + "只需保留上述约束。".repeat(1_000) }] },
      { id: `answer-${index}`, role: "assistant", parts: [{ type: "text", text: "这是重复的历史参考，并非新的任务或执行回执。".repeat(600) }] },
    ]).flat();
    store.messages.push({ id: "current-user", role: "user", parts: [{ type: "text", text: "继续，先列出下一步。" }] });
    const compactor = new ContextCompactor({
      store, threadId: `live-context-${mode}`, modelId: modelAlias,
      budget: modeBudget, summarizer: createAiSdkSummarizer(model),
      fixedContext: () => ({ instructions: "Maintain the original constraints.", tools: [], dynamicContext: "" }),
    });
    // Force exercises actual full-size source chunking even when tokenizer estimates differ.
    const prepared = await compactor.prepare(store.messages, new AbortController().signal, true);
    assert.equal(store.records.length, 1);
    const record = store.records[0] as unknown as { summary: ContextSummaryV2; metrics: { attempts: number; durationMs: number; estimatedInputBefore: number; estimatedInputAfter: number } };
    assert.ok(record.metrics.attempts > 4);
    assert.ok(parseContextSummary(JSON.stringify(record.summary)));
    assert.match(JSON.stringify(record.summary.constraints), /protected/);
    assert.ok(estimateContextBudget({ instructions: "Maintain the original constraints.", messages: prepared }, modeBudget).inputTokens <= modeBudget.inputBudgetTokens!);
    console.log(JSON.stringify({ mode, provider: modelAlias, ...record.metrics }));
  });
}
