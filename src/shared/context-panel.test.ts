import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ContextDiagnostics } from "@aisdk-agent/example-cli/dist/context-diagnostics.js";
import { contextPanelReducer, initialContextPanel, preparationLabel } from "./context-panel.js";

const value: ContextDiagnostics = {
  threadId: "thread",
  enabled: true,
  estimatorVersion: "char-half/v1",
  budget: { enabled: true, contextWindowTokens: 32768, maxOutputTokens: 4096, safetyMarginTokens: 1024, keepRecentTokens: 8192, summaryMaxOutputTokens: 1024 },
  latestValidCompaction: null,
  lastPreparation: null,
};

describe("context diagnostics panel", () => {
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
    assert.equal(failed.error, "READ_FAILED: broken");
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
