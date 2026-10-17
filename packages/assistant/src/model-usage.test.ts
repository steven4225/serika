import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { APICallError, generateText, simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { ExecutionRecordStore, EXECUTION_RECORD_FILE } from "./execution-record-store.js";
import { observeModelUsage } from "./model-usage-observer.js";
import { estimatedModelCost, validModelCall, validModelPrice, type ModelCallRecord, type ModelPurpose } from "./model-usage.js";
import { createMemoryQueryRewriter } from "./memory-query-rewrite.js";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";
import { readTuiModuleConfig } from "./tui-module-config.js";
import { ContextCompactor } from "./context-compactor.js";
import { createAiSdkSummarizer } from "./context-compaction.js";

const reported = { inputTokens: { total: 100, noCache: 60, cacheRead: 30, cacheWrite: 10 }, outputTokens: { total: 20, text: 20, reasoning: undefined } };
const price = { provider: "mock", modelId: "mock-model-id", currency: "CNY", inputPerMillion: 2, outputPerMillion: 4, cacheReadPerMillion: 0.2, cacheWritePerMillion: 3 };
const at = "2026-10-11T00:00:00.000Z";
function call(id: string, purpose: ModelPurpose = "chat"): ModelCallRecord {
  return { id, threadId: "thread", purpose, provider: price.provider, modelId: price.modelId, startedAt: at, finishedAt: null, status: "pending", usage: {} };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "serika-model-usage-"));
  const records = new ExecutionRecordStore(directory);
  return { directory, records, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
const response = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: undefined }, usage: reported, warnings: [] });
const streamResponse = (text: string) => ({ stream: simulateReadableStream({ chunks: [
  { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "answer" },
  { type: "text-delta" as const, id: "answer", delta: text }, { type: "text-end" as const, id: "answer" },
  { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: reported },
] }) });

test("explicit pricing only; unknown cache is not zero, invalid counts/currencies never fabricate cost", () => {
  const completed: ModelCallRecord = { ...call("one"), status: "returned", finishedAt: at,
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10 }, price };
  assert.equal(estimatedModelCost(completed), 0.000236);
  assert.equal(estimatedModelCost({ ...completed, price: undefined } as unknown as ModelCallRecord), undefined);
  assert.equal(estimatedModelCost({ ...completed, usage: { inputTokens: 100, outputTokens: 20 } }), undefined);
  assert.equal(estimatedModelCost({ ...completed, usage: { ...completed.usage, cacheReadTokens: 101 } }), undefined);
  assert.equal(estimatedModelCost({ ...completed, status: "unknown" }), undefined);
  assert.equal(estimatedModelCost({ ...completed, price: { ...price, inputPerMillion: Number.MAX_VALUE } }), undefined);
  assert.equal(validModelPrice({ ...price, currency: "￥" }), false);
  assert.equal(validModelPrice({ ...price, inputPerMillion: -1 }), false);
  assert.equal(validModelCall({ ...completed, price: { ...price, modelId: "other" } }), false);
  assert.equal(validModelCall({ ...completed, prompt: "secret" }), false);
});

test("trusted pricing config validates exact models, rejects duplicate rates and leaves absence unconfigured", async () => {
  const f = await fixture();
  try {
    const path = join(f.directory, "config.json");
    await writeFile(path, JSON.stringify({ version: 1, modules: {}, modelPricing: [price] }));
    assert.deepEqual((await readTuiModuleConfig(path)).modelPricing, [price]);
    await writeFile(path, JSON.stringify({ version: 1, modules: {}, modelPricing: [price, price] }));
    await assert.rejects(readTuiModuleConfig(path), /schema/);
    await writeFile(path, JSON.stringify({ version: 1, modules: {} }));
    assert.equal((await readTuiModuleConfig(path)).modelPricing, undefined);
  } finally { await f.cleanup(); }
});

test("journal persists per-call cache values, legacy reads, thread boundaries and interrupted unknown without replay", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, EXECUTION_RECORD_FILE), JSON.stringify({ version: 1, runs: [] }));
    assert.deepEqual(await f.records.listModelUsage("thread"), { calls: [], droppedCount: 0 });
    await f.records.startModelCall(call("one"));
    await f.records.finishModelCall("one", "returned", { inputTokens: 10, cacheReadTokens: 0 });
    await f.records.finishModelCall("one", "returned", { inputTokens: 999 });
    await f.records.startModelCall(call("two", "context_compaction"));
    await f.records.startModelCall({ ...call("foreign"), threadId: "foreign" });
    const reopened = new ExecutionRecordStore(f.directory);
    await reopened.recoverInterrupted("thread");
    const page = await reopened.listModelUsage("thread");
    assert.equal(page.calls.length, 2);
    assert.equal(page.calls[0]!.status, "unknown");
    assert.deepEqual(page.calls[1]!.usage, { inputTokens: 10, cacheReadTokens: 0 });
    assert.equal((await reopened.listModelUsage("foreign")).calls[0]!.status, "pending");
    assert.doesNotMatch(await readFile(join(f.directory, EXECUTION_RECORD_FILE), "utf8"), /prompt|secret/);
  } finally { await f.cleanup(); }
});

test("retention prunes terminal calls, protects pending calls and explicitly reports truncated coverage", async () => {
  const f = await fixture();
  try {
    const pending = call("pending");
    const calls = [pending, ...Array.from({ length: 127 }, (_, i) => ({ ...call(`old-${i}`), status: "returned" as const, finishedAt: at }))];
    await writeFile(join(f.directory, EXECUTION_RECORD_FILE), JSON.stringify({ version: 1, runs: [], modelUsage: { calls, droppedCount: 0 } }));
    await f.records.startModelCall(call("new"));
    const page = await f.records.listModelUsage("thread");
    assert.equal(page.calls.length, 128); assert.equal(page.droppedCount, 1);
    assert.ok(page.calls.find(c => c.id === "pending")); assert.equal(page.calls.find(c => c.id === "old-126"), undefined);
    await writeFile(join(f.directory, EXECUTION_RECORD_FILE), JSON.stringify({ version: 1, runs: [], modelUsage: { calls: Array.from({ length: 128 }, (_, i) => call(`p-${i}`)), droppedCount: 0 } }));
    await assert.rejects(f.records.startModelCall(call("over")), /Active model calls/);
  } finally { await f.cleanup(); }
});

test("SDK retry is two actual provider calls; query-rewrite local reuse is one, missing caches remain unknown", async () => {
  const f = await fixture();
  try {
    let dispatched = 0;
    const model = observeModelUsage(new MockLanguageModelV3({ doGenerate: async () => {
      if (++dispatched === 1) throw new APICallError({ message: "temporarily unavailable", url: "https://fixture.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true });
      return response('{"queries":["复盘结构"]}');
    } }), { records: f.records, threadId: "thread", enabled: () => true, scope: () => ({ purpose: "query_rewrite" }), prices: [price] });
    await generateText({ model, prompt: "retry", maxRetries: 1 });
    let page = await f.records.listModelUsage("thread");
    assert.equal(dispatched, 2); assert.equal(page.calls.length, 2);
    assert.deepEqual(page.calls.map(c => c.status), ["returned", "failed"]);
    assert.deepEqual(page.calls[0]!.usage, { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, cacheWriteTokens: 10 });
    const rewrite = createMemoryQueryRewriter(model);
    await rewrite("user", "怎样复盘", new AbortController().signal);
    await rewrite("user", "怎样复盘", new AbortController().signal);
    page = await f.records.listModelUsage("thread");
    assert.equal(page.calls.length, 3); assert.equal(dispatched, 3);
    const missing = observeModelUsage(new MockLanguageModelV3({ doGenerate: async () => ({ ...response("ok"), usage: { ...reported, inputTokens: { ...reported.inputTokens, cacheRead: undefined, cacheWrite: undefined } } }) }), {
      records: f.records, threadId: "thread", enabled: () => true, scope: () => ({ purpose: "chat" }),
    });
    await generateText({ model: missing, prompt: "no cache report", maxRetries: 0 });
    const usage = (await f.records.listModelUsage("thread")).calls[0]!.usage;
    assert.equal(Object.hasOwn(usage, "cacheReadTokens"), false); assert.equal(Object.hasOwn(usage, "cacheWriteTokens"), false);
  } finally { await f.cleanup(); }
});

test("cancellation of non-cooperative provider keeps one unknown-use attempt; late results cannot settle it again", async () => {
  const f = await fixture();
  try {
    let resolve!: (value: ReturnType<typeof response>) => void;
    let started!: () => void;
    const dispatched = new Promise<void>(r => { started = r; });
    const model = observeModelUsage(new MockLanguageModelV3({ doGenerate: () => { started(); return new Promise(r => { resolve = r; }); } }), {
      records: f.records, threadId: "thread", enabled: () => true, scope: () => ({ purpose: "query_rewrite" }),
    });
    const controller = new AbortController();
    const pending = createMemoryQueryRewriter(model)("user", "reports", controller.signal);
    await dispatched; controller.abort(new Error("stop"));
    await assert.rejects(pending, /stop/); resolve(response('{"queries":[]}'));
    const deadline = Date.now() + 2000;
    while ((await f.records.listModelUsage("thread")).calls[0]?.status === "pending" && Date.now() < deadline) await delay(10);
    const page = await f.records.listModelUsage("thread");
    assert.equal(page.calls.length, 1); assert.equal(page.calls[0]!.status, "cancelled");
    assert.deepEqual(page.calls[0]!.usage, {});
  } finally { await f.cleanup(); }
});

test("usage file sync failure prevents provider dispatch and does not retry to hide a missing journal", async t => {
  const f = await fixture();
  try {
    let dispatched = 0;
    const model = observeModelUsage(new MockLanguageModelV3({ doGenerate: async () => { dispatched++; return response("ok"); } }), {
      records: f.records, threadId: "thread", enabled: () => true, scope: () => ({ purpose: "chat" }),
    });
    const probe = await open(join(f.directory, "probe"), "w"); const prototype = Object.getPrototypeOf(probe); await probe.close();
    const injected = t.mock.method(prototype, "sync", async () => { throw new Error("usage sync failed"); });
    await assert.rejects(generateText({ model, prompt: "must not call", maxRetries: 0 }), /save failed/);
    injected.mock.restore();
    assert.equal(dispatched, 0);
    await assert.rejects(generateText({ model, prompt: "no retry", maxRetries: 0 }), /restart/);
    assert.equal(dispatched, 0);
  } finally { await f.cleanup(); }
});

test("abort during journal barrier is explicitly not_dispatched and never invokes the provider", async t => {
  const f = await fixture();
  try {
    let dispatched = 0;
    const controller = new AbortController();
    const start = f.records.startModelCall.bind(f.records);
    t.mock.method(f.records, "startModelCall", async (record: ModelCallRecord) => {
      await start(record); controller.abort(new Error("stop before dispatch"));
    });
    const model = observeModelUsage(new MockLanguageModelV3({ doGenerate: async () => { dispatched++; return response("ok"); } }), {
      records: f.records, threadId: "thread", enabled: () => true, scope: () => ({ purpose: "chat" }),
    });
    await assert.rejects(generateText({ model, prompt: "cancel at barrier", abortSignal: controller.signal, maxRetries: 0 }), /stop before dispatch/);
    assert.equal(dispatched, 0);
    assert.equal((await f.records.listModelUsage("thread")).calls[0]!.status, "not_dispatched");
  } finally { await f.cleanup(); }
});

test("actual AgentLoop streaming retry preserves two call attempts without changing loop or replaying tools", async () => {
  const f = await fixture(); let app: Awaited<ReturnType<typeof createRuntimeApp>> | undefined;
  try {
    let dispatched = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      if (++dispatched === 1) throw new APICallError({ message: "unavailable", url: "https://fixture.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true });
      return streamResponse("ok");
    } });
    const output = new PassThrough(); output.resume();
    app = await createRuntimeApp({ directory: join(f.directory, "transcripts"), assistant: { threadId: "thread" }, modelAlias: "fixture", model, output, env: {}, cwd: f.directory });
    app.enableExecutionRecords();
    const handle = await app.runtime.run({ agentId: app.agentId, threadId: "thread", messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "hello" }] }] });
    assert.equal((await handle.result).status, "completed");
    const page = await app.executionRecords.listModelUsage("thread");
    assert.equal(dispatched, 2); assert.equal(page.calls.length, 2);
    assert.deepEqual(page.calls.map(c => c.status), ["returned", "failed"]);
    assert.ok(page.calls.every(c => c.runId === handle.runId && c.purpose === "chat"));
    assert.deepEqual((await app.executionRecords.getRun("thread", handle.runId))?.tools, []);
  } finally { app?.dispose(); await f.cleanup(); }
});

test("Demo: real Controller wiring records chat/consolidation/rewrite/compaction and old summary reuse adds no call", async () => {
  const f = await fixture();
  const workspace = join(f.directory, "workspace"), directory = join(f.directory, "transcripts"), config = join(f.directory, "config.json");
  await mkdir(workspace);
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic", queryRewrite: { enabled: true } } },
    contextCompaction: { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: true, keepRecentTokens: 20 }, modelPricing: [price] }));
  let userId = "";
  const model = new MockLanguageModelV3({ doGenerate: async () => response('{"queries":["咖啡"]}'), doStream: async options => {
    const text = JSON.stringify(options.prompt);
    if (text.includes("You are a context compactor")) return streamResponse(JSON.stringify({ version: 2,
      goal: { text: "继续对话", evidenceMessageIds: [userId] }, constraints: [], decisions: [], actions: [], pending: [], files: [], nextStep: null }));
    if (text.includes("Extract only from this host-prepared material.")) {
      const source = options.prompt.find(message => message.role === "user");
      assert.ok(source && source.role === "user");
      const materialText = source.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      const material = JSON.parse(materialText.slice(materialText.indexOf("\n") + 1));
      const sourceUser = material.turns[0].user;
      return streamResponse(JSON.stringify({ batchId: material.batchId, proposals: [{ action: "add", kind: "preference", text: "我喝咖啡不加糖。",
        sourceMessageId: sourceUser.messageId, sourceQuote: sourceUser.text, reason: "明确偏好", eligibility: "durable_self_statement",
        factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }], outcomes: [{ messageId: sourceUser.messageId, status: "extracted" }] }));
    }
    return streamResponse("已收到。");
  } });
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory, assistant: { threadId: "thread", configPath: config }, modelAlias: "fixture", model, output, env: {}, cwd: f.directory });
  const controller = createAssistantController(app);
  try {
    const started = await controller.run("我喝咖啡不加糖。"); assert.ok(started.ok);
    const deadline = Date.now() + 5000;
    while (controller.getSnapshot().state.kind !== "idle" && Date.now() < deadline) await delay(10);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    assert.equal(controller.getSnapshot().lastConsolidationResult?.status, "completed");
    const memories = await controller.memory.list(); assert.ok(memories.ok);
    assert.equal(memories.value.entries.length, 1);
    userId = (await app.store.getMessages("thread")).find(message => message.role === "user")!.id;
    const compact = await controller.command("/compact"); assert.ok(compact.ok, JSON.stringify(compact));
    let page = await controller.runs.listModelUsage!();
    assert.deepEqual([...new Set(page.calls.map(c => c.purpose))].sort(), ["chat", "context_compaction", "memory_consolidation", "query_rewrite"]);
    assert.equal(page.calls.filter(c => c.purpose === "chat")[0]!.runId, started.runId);
    assert.equal(page.calls.filter(c => c.purpose === "query_rewrite")[0]!.runId, started.runId);
    assert.equal(page.calls.filter(c => c.purpose === "context_compaction")[0]!.runId, undefined, "manual compact is not a Run");
    assert.ok(page.calls.every(c => c.status === "returned"));
    const before = page.calls.length;
    const messages = await app.store.getMessages("thread");
    const reopened = new ContextCompactor({ store: app.store, threadId: "thread", modelId: "fixture",
      budget: app.moduleConfig!.contextCompaction, fixedContext: () => ({ instructions: "", tools: [] }),
      summarizer: createAiSdkSummarizer(observeModelUsage(model, { records: new ExecutionRecordStore(directory), threadId: "thread", enabled: () => true,
        scope: () => ({ purpose: "context_compaction" }) })) });
    await reopened.prepare(messages, new AbortController().signal);
    page = await controller.runs.listModelUsage!();
    assert.equal(page.calls.length, before, "reusing summary does not invoke another model");
    assert.deepEqual((await new ExecutionRecordStore(directory).listModelUsage("thread")).calls, page.calls, "reopen reads same ledger, never recomputes from trace totals");
    console.log("Usage Demo PASS: four purposes; formal memory saved; reuse +0 calls; reopen unchanged.");
  } finally { await controller.shutdown(); app.dispose(); await f.cleanup(); }
});
