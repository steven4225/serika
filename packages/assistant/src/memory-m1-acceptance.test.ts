import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { createMemoryStore } from "./memory-v7-store.js";
import { createMemoryExtraction } from "./memory-extraction.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG, defaultContextBudget } from "./context-budget.js";

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };
const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const wait = async (ready: () => boolean) => { for (let i = 0; i < 100 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(ready()); };

test("M1 uncertain extraction stores the exact user quote despite a rewritten model body in both windows", async t => {
  const quote = "我喜欢甜咖啡，但我又不喜欢甜咖啡";
  for (const [window, budget] of new Map([["32k", DEFAULT_CONTEXT_BUDGET_CONFIG], ["daily", defaultContextBudget()]])) await t.test(window, async () => {
    const root = await mkdtemp(join(tmpdir(), "cm6-uncertain-")), store = createMemoryStore(join(root, ".runloom/memory.json"), null);
    const messages: UIMessage[] = [{ id: "a", role: "assistant", parts: [{ type: "text", text: "你喜欢甜咖啡吗" }] }, user("u", quote)];
    let calls = 0, updated!: () => void;
    const completed = new Promise<void>(resolve => { updated = resolve; });
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      calls++;
      return { content: [{ type: "text", text: JSON.stringify({ proposals: [{ operation: "add", scope: "user", text: "用户喜欢甜咖啡", uncertain: true,
        category: "preference", sourceMessageId: "u", sourceQuote: quote, identity: { subject: "user", attribute: "coffee", value: "甜咖啡" },
        proposal: { messageId: "a", quote: "甜咖啡", valueQuote: "甜咖啡" } }], outcomes: [{ messageId: "u", status: "extracted" }] }) }],
        finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    } });
    const extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => messages, model, budget, updated });
    try {
      extraction.afterMask("u"); extraction.idle(); await completed;
      await new Promise<void>(resolve => setImmediate(resolve)); await extraction.pause();
      assert.equal(calls, 1); assert.equal(extraction.diagnostics().completed, 1); assert.equal(extraction.diagnostics().failed, 0);
      const saved = await store.readV7!(); assert.ok(saved.ok);
      const entries = saved.value.entries.filter(entry => entry.state === "active"); assert.equal(entries.length, 1);
      assert.equal(entries[0]!.text, quote); assert.equal(entries[0]!.uncertain, true);
      assert.equal(saved.value.progress[0]!.throughMessageId, "u");
    } finally { await extraction.close(); await rm(root, { recursive: true, force: true }); }
  });
});

test("M1 ordinary automatic chat uses one writer without approval: 3 foreground calls / 2 messages; autonomous has no writer", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cm4-primary-")));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json"), directory = join(root, "transcript");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { memory: { enabled: true, autoConsolidate: true } }, desktopAutonomy: { authorizedDirectory: workspace } }));
  let calls = 0;
  const requests: Array<Parameters<MockLanguageModelV3["doStream"]>[0]> = [];
  const model = new MockLanguageModelV3({ doGenerate: async () => assert.fail("No auxiliary call below threshold"), doStream: async request => {
    calls++; requests.push(request); const write = calls === 2;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, ...(write ? [{ type: "tool-call" as const, toolCallId: "remember", toolName: "memory_write", input: JSON.stringify({ operation: "add", scope: "user", text: "我喝咖啡不加糖", category: "preference", sourceQuote: "我喝咖啡不加糖", identity: { subject: "user", attribute: "coffee", value: "不加糖" } }) }] : [{ type: "text-start" as const, id: "a" }, { type: "text-delta" as const, id: "a", delta: "收到" }, { type: "text-end" as const, id: "a" }]),
      { type: "finish", finishReason: { unified: write ? "tool-calls" : "stop", raw: undefined }, usage },
    ] }) };
  } });
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory, assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "t", configPath }, modelAlias: "fixture", model, output, env: {}, cwd: root, desktopAutonomyHost: { home: join(root, "H") } });
  const controller = createAssistantController(app);
  try {
    for (const text of ["你好", "记住：我喝咖啡不加糖"]) {
      const settled = new Promise<void>(resolve => { const stop = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { stop(); resolve(); } }); });
      assert.equal((await controller.run(text)).ok, true); await settled;
    }
    assert.equal(calls, 3); assert.equal(calls / 2, 1.5); assert.equal(app.memoryExtraction!.diagnostics().calls, 0);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    const saved = await app.memoryStore!.readV7!(); assert.ok(saved.ok); assert.equal(saved.value.entries[0]!.text, "我喝咖啡不加糖");
    assert.ok(requests[1]!.tools?.some(tool => tool.name === "memory_write"));
    if (process.env.SERIKA_CM4_EVIDENCE_DIR) {
      const rows = (await Promise.all((await readdir(directory)).filter(name => name.startsWith("model-calls-")).map(name => readFile(join(directory, name), "utf8")))).flatMap(text => text.trim().split("\n").map(line => JSON.parse(line)));
      assert.equal(rows.filter(row => row.event === "started").length, 3);
      await mkdir(process.env.SERIKA_CM4_EVIDENCE_DIR, { recursive: true }); await writeFile(join(process.env.SERIKA_CM4_EVIDENCE_DIR, "foreground.json"), JSON.stringify({ fixture: true, messages: 2, calls: 3, average: 1.5, rows }, null, 2) + "\n");
    }
    const input = user("autonomous", "继续任务"); assert.equal(app.beginForegroundExecution!("desktop", input), true);
    try { const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [input] }); assert.equal((await handle.result).status, "completed"); }
    finally { await app.endForegroundExecution!(); }
    assert.equal(requests.at(-1)!.tools?.some(tool => tool.name === "memory_write"), false);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("M1 two extraction failures survive reopen; only idle retries the third, cancellation waits and commits no progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-retry-"));
  const store = createMemoryStore(join(root, ".runloom/memory.json"), null), messages = [user("u", "x".repeat(4000)), { id: "a", role: "assistant" as const, parts: [{ type: "text" as const, text: "y".repeat(4000) }] }];
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => { calls++; throw new Error("fixture failure"); } });
  const options = { store, threadId: "t", getMessages: async () => messages, model, budget: DEFAULT_CONTEXT_BUDGET_CONFIG, updated() {} };
  let extraction = createMemoryExtraction(options);
  try {
    extraction.idle(); await wait(() => extraction.diagnostics().failed === 1 && !extraction.diagnostics().running); await extraction.pause();
    extraction.idle(); await wait(() => extraction.diagnostics().failed === 2 && !extraction.diagnostics().running); await extraction.close();
    extraction = createMemoryExtraction(options); extraction.idle(); await extraction.pause(); assert.equal(calls, 2);
    const read = await store.readV7!(); assert.ok(read.ok); assert.equal(read.value.progress[0]!.retry?.failures, 2); assert.equal(read.value.progress[0]!.throughMessageId, null);
  } finally { await extraction.close(); await rm(root, { recursive: true, force: true }); }
});

test("M1 foreground cancellation waits for the background provider to settle and never advances progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm4-cancel-")), store = createMemoryStore(join(root, ".runloom/memory.json"), null);
  let started = false, settled = false;
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    started = true;
    await new Promise<void>(resolve => options.abortSignal!.addEventListener("abort", () => { setTimeout(() => { settled = true; resolve(); }, 20); }, { once: true }));
    throw new DOMException("cancelled", "AbortError");
  } });
  const extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => [user("u", "x".repeat(4000)), { id: "a", role: "assistant" as const, parts: [{ type: "text" as const, text: "y".repeat(4000) }] }], model, budget: DEFAULT_CONTEXT_BUDGET_CONFIG, updated() {} });
  try {
    extraction.idle(); await wait(() => started); await extraction.pause(); assert.equal(settled, true);
    const saved = await store.readV7!(); assert.ok(saved.ok); assert.equal(saved.value.progress.length, 0); assert.equal(extraction.diagnostics().cancelled, 1);
    await assert.rejects(readFile(join(root, ".runloom/memory.json")), { code: "ENOENT" });
  } finally { await extraction.close(); await rm(root, { recursive: true, force: true }); }
});

test("M1 idle trigger waits exactly 30 minutes; an idle retry stops after the third persisted failure", { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "cm4-idle-")), store = createMemoryStore(join(root, ".runloom/memory.json"), null);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0, expectsWrite = false;
  let finish!: () => void;
  let finished = new Promise<void>(resolve => { finish = resolve; });
  const model = new MockLanguageModelV3({ doGenerate: async () => { calls++; throw new Error("fixture failure"); } });
  const extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => { if (!expectsWrite) finish(); return [user("u", "short")]; }, model, budget: DEFAULT_CONTEXT_BUDGET_CONFIG, updated() { finish(); } });
  const settle = async () => {
    await finished;
    // The terminal extraction notification precedes the task's final promise cleanup.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(extraction.diagnostics().running, false);
    finished = new Promise<void>(resolve => { finish = resolve; });
  };
  try {
    extraction.idle(); await settle(); assert.equal(calls, 0);
    t.mock.timers.tick(29 * 60_000); assert.equal(calls, 0);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expectsWrite = true;
      t.mock.timers.tick(attempt === 1 ? 60_000 : 30 * 60_000); await settle(); assert.equal(calls, attempt);
      const saved = await store.readV7!(); assert.ok(saved.ok); assert.equal(saved.value.progress[0]!.retry!.failures, attempt);
    }
    expectsWrite = false;
    t.mock.timers.tick(30 * 60_000); await settle(); assert.equal(calls, 3);
    assert.equal(extraction.diagnostics().pendingSegments, 1);
  } finally { await extraction.close(); t.mock.timers.reset(); await rm(root, { recursive: true, force: true }); }
});

test("M1 saved older pending replay cannot supersede a newer-source value after restart", async t => {
  const root = await mkdtemp(join(tmpdir(), "cm6-old-replay-")), store = createMemoryStore(join(root, ".runloom/memory.json"), null);
  const old = "我住在北京", latest = "我现在住在上海";
  const messages = [user("old", old), user("new", latest)];
  const { hashCanonicalJson } = await import("@serika/core");
  const hash = (count: number) => hashCanonicalJson(JSON.parse(JSON.stringify(messages.slice(0, count))));
  const seed = await store.writeV7!([{ operation: "add", scope: { kind: "user" }, text: latest, category: "note", identity: { subject: "user", attribute: "residence", value: "上海" },
    source: { kind: "conversation", threadId: "t", messageId: "new", quote: latest, sentAt: null } }], new AbortController().signal,
    { expectedProgress: null, progress: { projectId: null, threadId: "t", throughMessageId: "new", prefixHash: hash(2), retry: null, pending: [{ messageId: "old", prefixHash: hash(1) }] } });
  assert.ok(seed.ok);
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    calls++;
    const read = await store.readV7!(); assert.ok(read.ok); const target = read.value.entries.find(entry => entry.state === "active")!;
    return { content: [{ type: "text", text: JSON.stringify({ proposals: [{ operation: "replace", scope: "user", id: target.id, expectedRevision: target.revision, category: "note",
      text: old, sourceMessageId: "old", sourceQuote: old, identity: { subject: "user", attribute: "residence", value: "北京" } }], outcomes: [{ messageId: "old", status: "extracted" }] }) }],
      finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  } });
  const extraction = createMemoryExtraction({ store: createMemoryStore(join(root, ".runloom/memory.json"), null), threadId: "t", getMessages: async () => messages, model, budget: DEFAULT_CONTEXT_BUDGET_CONFIG, updated() {} });
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] }); extraction.idle();
    for (let i = 0; i < 20000 && extraction.diagnostics().running; i++) await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(30 * 60_000); t.mock.timers.reset();
    for (let i = 0; i < 20000 && extraction.diagnostics().running; i++) await new Promise<void>(resolve => setImmediate(resolve));
    await extraction.pause(); assert.equal(calls, 1);
    const read = await store.readV7!(); assert.ok(read.ok);
    assert.equal(read.value.progress[0]!.pending.length, 0);
    assert.deepEqual(read.value.entries.filter(entry => entry.state === "active").map(entry => entry.text), [latest]);
    const historical = read.value.entries.find(entry => entry.text === old)!; assert.equal(historical.state, "superseded");
    assert.equal(historical.supersededBy, read.value.entries.find(entry => entry.text === latest)!.id);
    const { v7Conflicts } = await import("./memory-v7-store.js"); assert.equal(v7Conflicts(read.value.entries).length, 0);
  } finally { await extraction.close(); t.mock.timers.reset(); await rm(root, { recursive: true, force: true }); }
});
