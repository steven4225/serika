import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppInfo } from "../../shared/ui-contract.js";
import type { MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import { MemoryConsolidationPanel, consolidationStatusLabel, previewAutomaticMemoryUndo, memoryReceiptPresentation, memoryReceiptSummary } from "./memory-consolidation.js";
import { memoryConsolidationFailureText } from "@aisdk-agent/example-cli/dist/memory-failure.js";

function maintenance(state: MemoryMaintenance["consolidation"]["state"]): MemoryMaintenance {
  return {
    stored: 0, pending: 0, expired: 0, disabled: 0, duplicateSuggestions: 0,
    capacity: { entries: 200, bytes: 1024, assertionsPerEntry: 10 },
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

  it("keeps human policy status in the main path and advanced setup collapsed", () => {
    const info = { workspaceRoot: "/workspace", configPath: "/config.json", memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic", queryRewriteEnabled: true } } as AppInfo;
    const html = renderToStaticMarkup(createElement(MemoryConsolidationPanel, { info, busy: false, refreshToken: 0 }));
    assert.ok(html.includes("明确偏好会自动记住；有歧义才需要你点一下。"));
    assert.match(html, /<details class="memory-maintenance-disclosure"><summary>高级：记忆整理与历史补整理/);
    assert.equal(html.includes("改为自动记住"), false);
    const review = renderToStaticMarkup(createElement(MemoryConsolidationPanel, { info: { ...info, memory: { ...info.memory, writePolicy: "review" } }, busy: false, refreshToken: 0 }));
    assert.ok(review.indexOf("在工作区设置") < review.indexOf("memory-maintenance-disclosure"));
    assert.equal(review.includes("改为自动记住"), false, "the actual configuration action lives only in workspace");
    assert.equal(review.includes("明确偏好会自动记住；"), false);
  });
  it("distinguishes disabled, loading, failed reads, processing and review", () => {
    assert.equal(consolidationStatusLabel(false, null, ""), "记忆未启用");
    assert.equal(consolidationStatusLabel(true, null, ""), "正在读取记忆状态…");
    assert.equal(consolidationStatusLabel(true, null, "读取失败"), "记忆整理状态读取失败");
    assert.equal(consolidationStatusLabel(true, maintenance("off"), ""), "记忆自动整理：关");
    assert.equal(consolidationStatusLabel(true, maintenance("backlog"), ""), "等待记忆整理");
    assert.equal(consolidationStatusLabel(true, maintenance("running"), ""), "正在整理记忆");
    assert.equal(consolidationStatusLabel(true, maintenance("failed"), ""), "记忆整理失败");
    assert.equal(consolidationStatusLabel(true, maintenance("awaiting_review"), ""), "等待你审核候选");
  });

  it("only calls a successful completed zero-candidate attempt empty", () => {
    const value = maintenance("idle");
    assert.equal(consolidationStatusLabel(true, value, ""), "没有待整理的新增记忆材料");
    value.consolidation.lastAttempt = { mode: "incremental", runId: "run-a", status: "failed", processedCount: 0, candidateCount: 0 };
    assert.equal(consolidationStatusLabel(true, value, ""), "没有待整理的新增记忆材料");
    value.consolidation.lastAttempt.status = "completed";
    assert.equal(consolidationStatusLabel(true, value, ""), "记忆整理完成，没有新增候选");
    value.consolidation.state = "awaiting_review";
    assert.equal(consolidationStatusLabel(true, value, ""), "等待你审核候选");
    assert.equal(consolidationStatusLabel(true, value, "IO failure"), "记忆整理状态读取失败");
  });

  it("separates saved formal-memory receipts from pending suggestions and failed attempts", () => {
    const value = maintenance("idle");
    value.consolidation.lastAttempt = { mode: "incremental", runId: "run-a", status: "completed", processedCount: 1, candidateCount: 0,
      accepted: [{ candidateId: "candidate-1", memoryId: "memory-1", revision: 2 }] };
    assert.equal(consolidationStatusLabel(true, value, ""), "已处理 1 条记忆", "unknown legacy operations are not called new saves");
    value.consolidation.state = "awaiting_review";
    value.consolidation.lastAttempt.candidateCount = 1;
    assert.equal(consolidationStatusLabel(true, value, ""), "已处理 1 条记忆；另有候选需要审核");
    value.consolidation.state = "failed";
    value.consolidation.lastAttempt.status = "failed";
    assert.equal(consolidationStatusLabel(true, value, ""), "记忆整理失败", "saved receipts never hide a failed batch");
  });

  it("presents actual operation and does not offer another retraction after retract or disable", async () => {
    const receipt = { candidateId: "candidate-1", memoryId: "memory-1", revision: 2 };
    assert.deepEqual(memoryReceiptPresentation({ ...receipt, operation: "add" }), { label: "已记住", undoLabel: "撤回…" });
    for (const operation of ["update", "correct", "change"] as const) assert.deepEqual(memoryReceiptPresentation({ ...receipt, operation }), { label: "已更新", undoLabel: "撤回整条记忆…" });
    assert.deepEqual(memoryReceiptPresentation({ ...receipt, operation: "retract" }), { label: "已撤回", undoLabel: null });
    assert.deepEqual(memoryReceiptPresentation({ ...receipt, operation: "disable" }), { label: "已停用", undoLabel: null });
    assert.equal(memoryReceiptSummary([{ ...receipt, operation: "add" }]), "已记住 1 条信息");
    assert.equal(memoryReceiptSummary([{ ...receipt, operation: "add" }, { ...receipt, operation: "retract" }]), "已处理 2 条记忆");
    const noRead = { getMemory: async () => { throw new Error("must not read"); } } as unknown as Parameters<typeof previewAutomaticMemoryUndo>[1];
    for (const operation of ["retract", "disable"] as const) assert.equal((await previewAutomaticMemoryUndo({ ...receipt, operation }, noRead)).ok, false);
  });

  it("undo previews only the exact saved version and never makes a write", async () => {
    const receipt = { candidateId: "candidate-1", memoryId: "memory-1", revision: 2 };
    const inputs: unknown[] = [];
    const api = {
      getMemory: async () => ({ ok: true as const, value: { id: "memory-1", revision: 2, text: "Prefer short reports" } }),
      previewMemoryAction: async (input: unknown) => { inputs.push(input); return { ok: false as const, error: { code: "TEST", message: "preview boundary" } }; },
    } as unknown as Parameters<typeof previewAutomaticMemoryUndo>[1];
    const result = await previewAutomaticMemoryUndo(receipt, api);
    assert.equal(result.ok, false);
    assert.deepEqual(inputs, [{ operation: "retract", id: "memory-1", expectedRevision: 2 }]);
    const changed = { ...api, getMemory: async () => ({ ok: true as const, value: { id: "memory-1", revision: 3, text: "A newer fact" } }) } as Parameters<typeof previewAutomaticMemoryUndo>[1];
    const stale = await previewAutomaticMemoryUndo(receipt, changed);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "MEMORY_REVISION_CONFLICT");
    assert.equal(inputs.length, 1, "no preview or write against a newer fact");
  });
});
