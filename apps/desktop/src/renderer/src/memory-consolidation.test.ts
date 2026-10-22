import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryMaintenance } from "@serika/assistant";
import { consolidationStatusLabel } from "./memory-consolidation.js";
import { savedMemoryNoticeText } from "./memory-copy.js";
import { memoryConsolidationFailureText } from "@serika/assistant";

function maintenance(state: MemoryMaintenance["consolidation"]["state"]): MemoryMaintenance {
  return {
    stored: 0, disabled: 0,
    capacity: { entries: 200, bytes: 1024 },
    consolidation: { enabled: true, state },
  };
}

describe("daily memory consolidation state", () => {
  it("reports unsaved versus uncertain memory in Chinese without raw model/storage errors", () => {
    const failed = memoryConsolidationFailureText("MEMORY_BATCH_INVALID: Candidate change effectiveAt must be an ISO timestamp");
    assert.match(failed, /不能当作已经记住.*旧记忆仍保留/);
    assert.doesNotMatch(failed, /MEMORY_BATCH_INVALID|ISO|effectiveAt/);
    const uncertain = memoryConsolidationFailureText("MEMORY_COMMIT_UNCERTAIN: directory sync failed");
    assert.match(uncertain, /是否写入尚未确认.*先查看.*不会自动重复/);
    assert.doesNotMatch(uncertain, /未写入|directory sync/);
  });

  it("distinguishes disabled, loading, failed reads, processing and review", () => {
    assert.equal(consolidationStatusLabel(false, null, ""), "记忆未启用");
    assert.equal(consolidationStatusLabel(true, null, ""), "正在读取记忆状态…");
    assert.equal(consolidationStatusLabel(true, null, "读取失败"), "记忆整理状态读取失败");
    assert.equal(consolidationStatusLabel(true, maintenance("off"), ""), "记忆自动整理：关");
    assert.equal(consolidationStatusLabel(true, maintenance("backlog"), ""), "等待记忆整理");
    assert.equal(consolidationStatusLabel(true, maintenance("running"), ""), "正在整理记忆");
    assert.equal(consolidationStatusLabel(true, maintenance("failed"), ""), "记忆整理失败");
  });

  it("keeps disk-write and uncertain-commit warnings in the daily summary", () => {
    const value = maintenance("failed");
    value.consolidation.error = "WRITE_FAILED: disk failed";
    assert.match(consolidationStatusLabel(true, value, ""), /保存失败.*旧记忆仍保留/);
    value.consolidation.error = "MEMORY_COMMIT_UNCERTAIN: directory sync failed";
    assert.match(consolidationStatusLabel(true, value, ""), /是否写入尚未确认.*不会自动重复/);
  });

});
