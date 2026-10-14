import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import type { MemoryReferenceSnapshot } from "@aisdk-agent/example-cli/dist/memory-query-rewrite.js";
import { MemoryReferenceDetails } from "./memory-references.js";

const baseline: MemoryReferenceSnapshot & { runId: string } = {
  runId: "run", messageId: "message", preparedAt: "2026-10-14T04:00:00.000Z",
  temporalView: { validAt: "2026-10-14T04:00:00.000Z", knownAt: "2026-10-14T04:00:00.000Z" },
  selected: [], truncated: false, queryTruncated: false, rewrite: "off",
};
const html = (patch: Partial<MemoryReferenceSnapshot> = {}, hideEmpty = false) => renderToStaticMarkup(createElement(MemoryReferenceDetails, { reference: { ...baseline, ...patch }, hideEmpty }));

describe("truthful semantic and derived-reference presentation", () => {
  it("labels semantic, hybrid and stable-profile selections without implying guaranteed relevance", () => {
    const markup = html({ semantic: { state: "ready", modelId: "local-embedding" }, selected: [
      { id: "semantic", revision: 1, text: "one", reason: "semantic" },
      { id: "hybrid", revision: 1, text: "two", reason: "hybrid" },
      { id: "profile", revision: 1, text: "three", reason: "stable_profile" },
    ] });
    for (const label of ["语义相似召回", "关键词与语义融合", "当前有效稳定偏好", "本轮语义检索：就绪", "local-embedding", "不保证相关性"]) assert.ok(markup.includes(label), label);
    const cloud = html({ semantic: { state: "ready", modelId: "text-embedding-v3" } });
    assert.ok(cloud.includes("text-embedding-v3"));
    assert.equal(cloud.includes("本地语义检索"), false, "cloud service must not be described as local");
    assert.equal(markup.includes("词法检索，同义改写未启用"), false);
  });

  it("does not claim lexical-only fallback when query rewriting fails but semantic path works", () => {
    const markup = html({ rewrite: "degraded", semantic: { state: "ready" } });
    assert.ok(markup.includes("同义改写失败或超时"));
    assert.equal(markup.includes("已退回原词法检索"), false);
  });

  it("keeps degraded or warming empty references visible with keyword fallback disclosure", () => {
    for (const state of ["degraded", "warming"] as const) {
      const markup = html({ semantic: { state } }, true);
      assert.ok(markup.includes(state === "degraded" ? "语义检索暂不可用" : "语义索引正在建立"));
      assert.ok(markup.includes("关键词检索"));
      assert.ok(markup.includes("不代表记忆库为空"));
    }
  });

  it("does not hide partial semantic hits or claim keyword-only fallback while the index is warming", () => {
    const markup = html({ rewrite: "degraded", semantic: { state: "warming" }, selected: [
      { id: "partial", revision: 1, text: "已索引事实", reason: "semantic" },
    ] }, true);
    for (const label of ["语义索引正在建立", "仅覆盖部分记忆", "关键词检索仍保留", "已索引事实", "语义相似召回"]) assert.ok(markup.includes(label), label);
    assert.equal(markup.includes("已退回原词法检索"), false);
  });

  it("distinguishes disabled, not-applicable and a working index with no matching result", () => {
    assert.ok(html({ semantic: { state: "off" } }).includes("语义检索未启用"));
    assert.ok(html({ semantic: { state: "not_applicable" } }).includes("本轮不适用语义检索"));
    assert.ok(html({ semantic: { state: "ready" } }).includes("本轮语义检索：就绪"));
    assert.equal(html({ semantic: { state: "ready" } }).includes("暂不可用"), false);
  });

  it("shows derived continuation even when no query memory was selected, and shares byte-budget diagnostics", () => {
    const markup = html({ contextView: { profileCount: 0, continuationCount: 2, truncated: true }, referenceBytes: 7150 }, true);
    for (const label of ["稳定偏好 0 条", "当前对话待续任务 2 条", "7150", "有界预算", "不代表自动继续或恢复权限"]) assert.ok(markup.includes(label), label);
    assert.equal(html({}, true), "");
  });

  it("keeps legacy rewrite degradation visible and its original lexical fallback statement", () => {
    const markup = html({ rewrite: "degraded" }, true);
    assert.ok(markup.includes("已退回原词法检索"));
  });
});
