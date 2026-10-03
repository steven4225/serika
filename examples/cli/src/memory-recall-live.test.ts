import assert from "node:assert/strict";
import { it } from "node:test";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import { createMemoryQueryRewriter } from "./memory-query-rewrite.js";
import { retrieveMemories } from "./memory-retrieval.js";

it("opt-in real-model recall comparison (no per-case retries or budget changes)", { skip: process.env.RUNLOOM_MEMORY_RECALL_ACCEPTANCE !== "1", timeout: 25000 }, async () => {
  const { model, modelAlias } = configureCliModel(createDemoModel);
  assert.ok(!modelAlias.startsWith("mock"), "Select a configured real provider");
  const rewrite = createMemoryQueryRewriter(model);
  const now = new Date();
  const entries = [{ id: "writing-fixture", revision: 1, text: "复盘先给一行结论，再列两条可执行步骤。", enabled: true }];
  const cases = [
    { query: "复盘偏好的格式是什么？", expected: ["writing-fixture"] },
    { query: "回顾要怎样组织内容？", expected: ["writing-fixture"] },
    { query: "明天天气怎么样？", expected: [] },
  ];
  const report = [];
  for (const [i, test] of cases.entries()) {
    const before = retrieveMemories(entries, { query: test.query, now }).selected.map(entry => entry.id);
    const expanded = await rewrite(`live-${i}`, test.query, AbortSignal.timeout(6000));
    const after = retrieveMemories(entries, { query: test.query, now, rewrittenQueries: expanded.queries }).selected.map(entry => entry.id);
    report.push({ query: test.query, state: expanded.state, queries: expanded.queries, before, after, expected: test.expected, passed: JSON.stringify(after) === JSON.stringify(test.expected) });
  }
  console.log(JSON.stringify({ modelAlias, cases: report, passed: report.every(row => row.passed), electronAcceptance: "not_run" }, null, 2));
  assert.ok(report.every(row => row.passed), "Fixed recall cases include a miss or false positive; see report, do not hide it with retries");
});
