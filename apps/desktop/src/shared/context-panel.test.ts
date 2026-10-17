import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextDiagnostics } from "@serika/example-cli/dist/context-diagnostics.js";
import { contextInputBudget, contextModeLabel, contextOverview, contextPanelReducer, contextUsageLabel, initialContextPanel, preparationLabel } from "./context-panel.js";
import { contextBudgetForMode } from "@serika/example-cli/dist/context-budget.js";

const value: ContextDiagnostics = {
  threadId: "thread",
  enabled: true,
  estimatorVersion: "char-half/v1",
  budget: { enabled: true, contextWindowTokens: 32768, maxOutputTokens: 4096, safetyMarginTokens: 1024, keepRecentTokens: 8192, summaryMaxOutputTokens: 1024 },
  latestValidCompaction: null,
  lastPreparation: null,
};

describe("context diagnostics panel", () => {
  it("uses prepared input rather than an oversized historical prefix for budget status", () => {
    const actual = { ...value, budget: { ...value.budget, inputBudgetTokens: 27_648 },
      latestValidCompaction: { id: "compacted", createdAt: "now", modelId: "small", firstKeptMessageIndex: 20, firstKeptMessageId: "recent",
        metrics: { estimatedInputBefore: 100_000, estimatedInputAfter: 12_000, durationMs: 1, attempts: 1 } },
      lastPreparation: { at: "now", outcome: "written" as const, compactionId: "compacted", estimatedInputTokens: 12_000, error: null } };
    assert.doesNotMatch(contextUsageLabel(actual), /超过预算/);
    assert.equal(contextUsageLabel(actual), "下次准备会检查是否需要压缩上下文");
  });
  it("shows explicit input ceilings and conservative 70/85 percent labels without inventing a live measurement", () => {
    const daily = contextBudgetForMode("daily"), long = contextBudgetForMode("long-task");
    assert.equal(contextInputBudget(daily), 256_000); assert.equal(contextInputBudget(long), 400_000);
    assert.equal(contextInputBudget(value.budget), 27_648);
    assert.match(contextModeLabel(value.budget), /旧配置.*未切换/); assert.equal(contextModeLabel(daily), "日常");
    assert.equal(contextUsageLabel({ ...value, budget: daily }), "尚无输入估算");
    const status = (tokens: number, outcome: "noop" | "failed" = "noop") => contextUsageLabel({ ...value, budget: daily,
      lastPreparation: { at: "now", outcome, compactionId: null, estimatedInputTokens: tokens, error: null } });
    assert.equal(status(100_000), "上下文充足"); assert.equal(status(179_200), "接近压缩区间");
    assert.match(status(217_600), /下次准备.*检查/); assert.match(status(256_001), /超过预算/);
    assert.match(status(100_000, "failed"), /压缩失败/);
  });
  it("explains automatic management without inventing a current measurement or hiding a failed preparation behind old records", () => {
    assert.match(contextOverview(value).title, /自动压缩已开启/);
    assert.match(contextOverview(value).description, /继续聊天即可/);
    assert.doesNotMatch(contextOverview(value).description, /0.*tokens|使用率/);
    assert.match(contextOverview({ ...value, enabled: false }).description, /完整对话记录不会.*删除/);
    const lastPreparation = { at: "now", outcome: "failed" as const, compactionId: null, estimatedInputTokens: null, error: { code: "MODEL_TIMEOUT", message: "超时" } };
    assert.equal(contextOverview({ ...value, lastPreparation }).failed, true);
    assert.match(contextOverview({ ...value, lastPreparation }).title, /失败/);
    assert.match(contextOverview({ ...value, lastPreparation: { ...lastPreparation, outcome: "reused", error: null } }).title, /上次发送前/);
  });
  it("keeps the last successful read when a refresh fails, without claiming it is current", () => {
    const loaded = contextPanelReducer(
      contextPanelReducer(initialContextPanel, { type: "start", request: 1 }),
      { type: "result", request: 1, result: { ok: true, value } },
    );
    const failed = contextPanelReducer(
      contextPanelReducer(loaded, { type: "start", request: 2 }),
      { type: "result", request: 2, result: { ok: false, error: { code: "READ_FAILED", message: "broken" } } },
    );
    assert.equal(failed.value, value);
    assert.equal(failed.loading, false);
    assert.match(failed.error ?? "", /读取.*失败.*刷新/);
    assert.doesNotMatch(failed.error ?? "", /READ_FAILED|broken/);
  });

  it("ignores stale success and stale failure from earlier requests", () => {
    const loading = contextPanelReducer(initialContextPanel, { type: "start", request: 2 });
    assert.equal(contextPanelReducer(loading, { type: "result", request: 1, result: { ok: true, value } }), loading);
    assert.equal(contextPanelReducer(loading, { type: "result", request: 1, result: { ok: false, error: { code: "OLD", message: "old" } } }), loading);
    assert.equal(contextPanelReducer(loading, { type: "start", request: 1 }), loading);
  });

  it("does not turn an absent process preparation into historical success", () => {
    const restarted = contextPanelReducer(
      contextPanelReducer(initialContextPanel, { type: "start", request: 1 }),
      { type: "result", request: 1, result: { ok: true, value } },
    );
    assert.equal(restarted.value?.lastPreparation, null);
    assert.match(preparationLabel("failed"), /未证明安装成功/);
    assert.match(preparationLabel("reused"), /复用/);
  });
});
