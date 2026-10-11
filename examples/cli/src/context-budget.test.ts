import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  CONTEXT_ESTIMATOR_VERSION,
  MESSAGE_OVERHEAD_TOKENS,
  estimateContextBudget,
  estimateSerializedTokens,
  keepRecentCompactionUnits,
  partitionMessagesForCompaction,
  splitMessageCompactionUnits,
  validateContextBudgetConfig,
  availableInputTokens,
  contextBudgetForMode,
  contextBudgetThresholds,
  contextBudgetStatus,
} from "./context-budget.js";

function textMessage(id: string, role: UIMessage["role"], text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function toolMessage(
  id: string,
  toolCallId: string,
  state: "input-available" | "output-available",
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: state === "output-available"
      ? [{
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId,
          state,
          input: { path: "docs/a.md" },
          output: { ok: true, content: "ok" },
        }]
      : [{
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId,
          state,
          input: { path: "docs/a.md" },
        }],
  };
}

describe("context budget", () => {
  it("uses decimal daily/long-task input ceilings independent of physical window reserves", () => {
    for (const mode of ["daily", "long-task"] as const) {
      const config = contextBudgetForMode(mode);
      const ceiling = mode === "daily" ? 256_000 : 400_000;
      assert.equal(availableInputTokens(config), ceiling);
      assert.equal(validateContextBudgetConfig(config).ok, true);
      const limits = contextBudgetThresholds(config);
      assert.equal(limits.warningTokens, ceiling * 0.70);
      assert.equal(limits.triggerTokens, ceiling * 0.85);
      assert.equal(limits.predictedGrowthTokens, 12_288);
      assert.equal(contextBudgetStatus(limits.warningTokens, config), "warning");
      assert.equal(contextBudgetStatus(limits.triggerTokens - limits.predictedGrowthTokens, config), "compacting");
      assert.equal(contextBudgetStatus(ceiling + 1, config), "exceeded");
    }
  });

  it("validates new ratios, chunk size and physical-model ceiling without changing legacy input math", () => {
    const daily = contextBudgetForMode("daily");
    for (const invalid of [
      { ...daily, inputBudgetTokens: 1_000_000 },
      { ...daily, warningRatio: 0.85 },
      { ...daily, triggerRatio: 1.1 },
      { ...daily, summaryInputChunkTokens: 23_999 },
      { ...daily, summaryInputChunkTokens: 32_001 },
    ]) assert.equal(validateContextBudgetConfig(invalid).ok, false);
    const legacy = { enabled: true, contextWindowTokens: 16_000, maxOutputTokens: 2_000,
      safetyMarginTokens: 500, keepRecentTokens: 2_000, summaryMaxOutputTokens: 500 };
    assert.equal(availableInputTokens(legacy), 13_500);
    assert.equal(contextBudgetThresholds(legacy).triggerTokens, 13_500);
    assert.equal(contextBudgetThresholds(legacy).predictedGrowthTokens, 0);
  });
  it("uses the replaceable char-half estimator and counts message overhead", () => {
    assert.equal(estimateSerializedTokens("界"), 1);
    const estimate = estimateContextBudget(
      {
        instructions: "abcd",
        tools: [{ name: "read_file" }],
        memories: ["memory"],
        dynamicContext: "now",
        messages: [textMessage("user", "user", "question")],
      },
      { contextWindowTokens: 100, maxOutputTokens: 20, safetyMarginTokens: 10 },
    );
    assert.equal(estimate.estimatorVersion, CONTEXT_ESTIMATOR_VERSION);
    assert.equal(estimate.method, "estimated");
    assert.equal(estimate.breakdown.messages >= MESSAGE_OVERHEAD_TOKENS, true);
    assert.equal(estimate.availableInputTokens, 70);
    assert.equal(estimate.exceeds, false);
  });

  it("rejects a configuration that leaves no valid recent or fixed-input budget", () => {
    const result = validateContextBudgetConfig({
      enabled: true,
      contextWindowTokens: 100,
      maxOutputTokens: 80,
      safetyMarginTokens: 20,
      keepRecentTokens: 1,
      summaryMaxOutputTokens: 10,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /positive input budget|keepRecentTokens/);
  });

  it("keeps a tool call and its later result in one compaction unit", () => {
    const units = splitMessageCompactionUnits([
      textMessage("user", "user", "inspect"),
      toolMessage("call", "call-1", "input-available"),
      textMessage("between", "assistant", "working"),
      toolMessage("result", "call-1", "output-available"),
      textMessage("answer", "assistant", "done"),
    ]);
    assert.deepEqual(units.map((unit) => unit.messages.map((item) => item.id)), [
      ["user"],
      ["call", "between", "result"],
      ["answer"],
    ]);
    assert.equal(units[1]?.completeToolCalls, true);
    assert.equal(units[1]?.hasToolCall, true);
  });

  it("keeps history as complete turns and splits the current turn safely", () => {
    const partition = partitionMessagesForCompaction([
      textMessage("old-user", "user", "old request"),
      textMessage("old-answer", "assistant", "old answer"),
      textMessage("current-user", "user", "continue"),
      toolMessage("current-call", "call-2", "output-available"),
      textMessage("current-answer", "assistant", "current answer"),
    ]);
    assert.deepEqual(partition.history.map((unit) => unit.messages.map((item) => item.id)), [
      ["old-user", "old-answer"],
    ]);
    assert.deepEqual(partition.current.map((unit) => unit.messages.map((item) => item.id)), [
      ["current-user"],
      ["current-call"],
      ["current-answer"],
    ]);
    assert.equal(partition.currentUserIndex, 2);
  });

  it("selects a contiguous recent suffix without splitting a unit", () => {
    const units = splitMessageCompactionUnits([
      textMessage("a", "assistant", "a"),
      textMessage("b", "assistant", "b".repeat(20)),
      textMessage("c", "assistant", "c"),
    ]);
    const selection = keepRecentCompactionUnits(units, units[2]!.estimatedTokens);
    assert.deepEqual(selection.kept.map((unit) => unit.messages[0]?.id), ["c"]);
    assert.deepEqual(selection.omitted.map((unit) => unit.messages[0]?.id), ["a", "b"]);
  });
});
