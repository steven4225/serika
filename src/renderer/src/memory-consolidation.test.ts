import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import { consolidationStatusLabel } from "./memory-consolidation.js";

function maintenance(state: MemoryMaintenance["consolidation"]["state"]): MemoryMaintenance {
  return {
    stored: 0, pending: 0, expired: 0, disabled: 0, duplicateSuggestions: 0,
    capacity: { entries: 200, bytes: 1024, assertionsPerEntry: 10 },
    consolidation: { enabled: true, state },
  };
}

describe("daily memory consolidation state", () => {
  it("distinguishes disabled, loading, failed reads, processing and review", () => {
    assert.equal(consolidationStatusLabel(false, null, ""), "记忆未启用");
    assert.equal(consolidationStatusLabel(true, null, ""), "正在读取记忆状态…");
    assert.equal(consolidationStatusLabel(true, null, "读取失败"), "记忆整理状态读取失败");
    assert.equal(consolidationStatusLabel(true, maintenance("off"), ""), "自动整理未启用");
    assert.equal(consolidationStatusLabel(true, maintenance("backlog"), ""), "等待整理");
    assert.equal(consolidationStatusLabel(true, maintenance("running"), ""), "正在整理记忆");
    assert.equal(consolidationStatusLabel(true, maintenance("failed"), ""), "整理失败");
    assert.equal(consolidationStatusLabel(true, maintenance("awaiting_review"), ""), "等待你审核候选");
  });

  it("only calls a successful completed zero-candidate attempt empty", () => {
    const value = maintenance("idle");
    assert.equal(consolidationStatusLabel(true, value, ""), "没有待整理的新增材料");
    value.consolidation.lastAttempt = { mode: "incremental", runId: "run-a", status: "failed", processedCount: 0, candidateCount: 0 };
    assert.equal(consolidationStatusLabel(true, value, ""), "没有待整理的新增材料");
    value.consolidation.lastAttempt.status = "completed";
    assert.equal(consolidationStatusLabel(true, value, ""), "整理完成，没有新增候选");
    value.consolidation.state = "awaiting_review";
    assert.equal(consolidationStatusLabel(true, value, ""), "等待你审核候选");
    assert.equal(consolidationStatusLabel(true, value, "IO failure"), "记忆整理状态读取失败");
  });
});
