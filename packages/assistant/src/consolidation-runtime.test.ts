import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";
import { createMemoryStore } from "./memory-v6-store.js";
import { createMemoryExtraction, extractionThreshold } from "./memory-extraction.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG, defaultContextBudget } from "./context-budget.js";
import { observeModelUsage } from "./model-usage-observer.js";
import { createExecutionRecordStore } from "./execution-record-store.js";
import { ModelCallLog } from "./model-call-log.js";
import type { UIMessage } from "ai";

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
test("extraction thresholds share the effective-window baseline and stay below the block", () => {
  assert.equal(extractionThreshold({ ...DEFAULT_CONTEXT_BUDGET_CONFIG, safetyMarginTokens: 2048 }), 3328);
  assert.equal(extractionThreshold(defaultContextBudget()), 31999);
});
test("background extraction commits memory with progress and never appends a synthetic Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-extract-"));
  const messages: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: "我喝咖啡不加糖。" + "x".repeat(4000) }] }, { id: "a", role: "assistant", parts: [{ type: "text", text: "y".repeat(4000) }] }];
  let updated!: () => void; const update = new Promise<void>(resolve => { updated = resolve; });
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    assert.equal(options.tools?.length ?? 0, 0);
    return { content: [{ type: "text", text: JSON.stringify({ proposals: [{ operation: "add", category: "preference", text: "我喝咖啡不加糖", sourceMessageId: "u", sourceQuote: "我喝咖啡不加糖", identity: { subject: "user", attribute: "coffee", value: "不加糖" } }], outcomes: [{ messageId: "u", status: "extracted" }] }) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  } });
  const store = createMemoryStore(join(root, ".runloom/memory.json")), extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => messages, model: observeModelUsage(model, { records: createExecutionRecordStore(root), threadId: "t", enabled: () => true, callLog: new ModelCallLog(root), scope: () => ({ purpose: "memory_consolidation" }) }), budget: { ...DEFAULT_CONTEXT_BUDGET_CONFIG, summaryMaxOutputTokens: 1024 }, updated });
  try {
    extraction.idle();
    await update;
    await extraction.pause();
    const document = await store.readV6!(); assert.ok(document.ok);
    assert.equal(document.value.entries.length, 1); assert.equal(document.value.progress[0]!.throughMessageId, "u");
    assert.equal(messages.length, 2); assert.equal(extraction.diagnostics().calls, 1);
    assert.equal(extraction.diagnostics().completed, 1);
    const rows = (await Promise.all((await readdir(root)).filter(name => name.startsWith("model-calls-")).map(name => readFile(join(root, name), "utf8")))).flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
    assert.equal(rows.filter(row => row.event === "started").length, 1); assert.equal(rows[0].purpose, "memory_consolidation"); assert.equal(rows[0].runId, undefined);
    if (process.env.SERIKA_CM4_EVIDENCE_DIR) { await mkdir(process.env.SERIKA_CM4_EVIDENCE_DIR, { recursive: true }); await writeFile(join(process.env.SERIKA_CM4_EVIDENCE_DIR, "background.json"), JSON.stringify({ fixture: true, calls: 1, rows }, null, 2) + "\n"); }
  } finally { await extraction.close(); await rm(root, { recursive: true, force: true }); }
});
