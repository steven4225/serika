import assert from "node:assert/strict";
import { it } from "node:test";
import type { UIMessage } from "ai";
import {
  type ContextCompactionStore,
  type MessageStore,
  type ThreadContextCompactionRecord,
} from "@aisdk-agent/core";
import { ContextCompactor } from "./context-compactor.js";
import { createAiSdkSummarizer, parseContextSummary, type ContextSummaryV2 } from "./context-compaction.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import type { ContextBudgetConfig } from "./context-budget.js";

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
        text: "在 notes/plan.md 新建一份三段计划；目标是整理 ALPHA-2026，只可修改 notes/，不得写 protected/。 ".repeat(40),
      }],
    },
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
