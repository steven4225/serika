import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelUsagePanel, costLabel } from "./model-usage.js";
import type { ModelCallRecord, ModelPurpose } from "@serika/example-cli/dist/model-usage.js";
import { toListRunsResponse } from "../../shared/execution-records.js";
import { RecordsPanel } from "./records.js";

const at = "2026-10-11T00:00:00.000Z";
const call = (purpose: ModelPurpose): ModelCallRecord => ({ id: purpose, threadId: "thread", runId: "run", purpose,
  provider: "fixture", modelId: "mock", status: "returned", startedAt: at, finishedAt: at, usage: { inputTokens: 12, outputTokens: 2, totalTokens: 14, cacheReadTokens: 0 } });
test("four purposes are visible in execution records, cache absence is unknown and explicit zero remains zero", () => {
  const page = { calls: (["chat", "memory_consolidation", "query_rewrite", "context_compaction"] as const).map(call), droppedCount: 2 };
  const html = renderToStaticMarkup(createElement(RecordsPanel, { records: { status: "ready", runs: [], modelUsage: page }, detail: { status: "idle" }, onRefresh() {}, onOpen() {}, onBack() {} }));
  for (const label of ["聊天", "记忆沉淀", "查询改写", "上下文压缩", "缓存读取 0", "缓存写入 未知", "未配置价格", "2 条较早调用未保留", "估算≠账单"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /缓存写入 0|0 次调用/);
  assert.deepEqual(toListRunsResponse({ ok: true, value: [] }, page), { ok: true, runs: [], modelUsage: page });
  assert.deepEqual(toListRunsResponse({ ok: true, value: [] }), { ok: true, runs: [] });
});
test("explicit prices estimate per call with currency; missing data or failed calls are not zero-cost", () => {
  const priced = { ...call("chat"), usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, price: { provider: "fixture", modelId: "mock", currency: "CNY", inputPerMillion: 2, outputPerMillion: 4 } };
  assert.equal(costLabel(priced), "估算 CNY 0.000280（估算≠账单）");
  assert.match(costLabel({ ...priced, usage: { inputTokens: 100, outputTokens: 20 } }), /未知/);
  assert.match(costLabel({ ...priced, status: "failed" }), /未知/);
});
test("Run filtering cannot attribute manual compact or another Run's rewrite; old ledger coverage is not invented", () => {
  const manual = call("context_compaction"); delete manual.runId;
  const html = renderToStaticMarkup(createElement(ModelUsagePanel, { page: { calls: [call("chat"), manual, { ...call("query_rewrite"), runId: "another" }], droppedCount: 0 }, runId: "run" }));
  assert.match(html, /聊天 · 1 次调用/);
  assert.doesNotMatch(html, /上下文压缩 ·|查询改写 ·/);
  assert.match(renderToStaticMarkup(createElement(ModelUsagePanel)), /旧版本未记录/);
});
test("pre-dispatch cancellation is shown separately and excluded from invocation count", () => {
  const html = renderToStaticMarkup(createElement(ModelUsagePanel, { page: { calls: [{ ...call("chat"), status: "not_dispatched", usage: {} }], droppedCount: 0 } }));
  assert.match(html, /聊天 · 0 次调用尝试/);
  assert.match(html, /派发前取消 · 未调用供应商/);
  assert.match(html, /不计调用/);
});
