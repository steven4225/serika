import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createMemoryExtraction } from "./memory-extraction.js";
import { readMemoryExtractionFailures } from "./memory-extraction-log.js";
import { createMemoryStore } from "./memory-v7-store.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG, defaultContextBudget } from "./context-budget.js";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const secret = "PRIVATE_CONVERSATION_AND_PROMPT";
const messages: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text: secret }] }];
const settle = async (extraction: ReturnType<typeof createMemoryExtraction>) => {
  for (let i = 0; i < 20000 && extraction.diagnostics().running; i++) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(extraction.diagnostics().running, false);
};

it("persists extraction, validation and actual store-save failures without source/model text in both windows", async t => {
  for (const [window, budget] of [["32k", DEFAULT_CONTEXT_BUDGET_CONFIG], ["daily", defaultContextBudget()]] as const) for (const stage of ["extract", "validate", "save"] as const) await t.test(`${window}:${stage}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-extraction-log-")), memory = join(root, "data/memory.json"), failureLog = join(root, "data/memory-extraction-failures.jsonl");
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      calls++;
      if (stage === "extract") throw new Error(secret);
      if (stage === "save") await writeFile(memory, "corrupt");
      return { content: [{ type: "text", text: stage === "validate" ? secret : JSON.stringify({ proposals: [], outcomes: [{ messageId: "u", status: "no_memory" }] }) }],
        finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    } });
    const extraction = createMemoryExtraction({ store: createMemoryStore(memory, "personal"), threadId: "thread-a", projectId: "personal", failureLog,
      model, budget, getMessages: async () => messages, updated() {} });
    try {
      await mkdir(join(root, "data")); extraction.afterMask("u"); extraction.idle(); await settle(extraction); await extraction.close();
      const rows = await readMemoryExtractionFailures(failureLog, { threadId: "thread-a", projectId: "personal" });
      assert.equal(calls, 1); assert.equal(rows[0]?.stage, stage); assert.ok(rows[0]?.code); assert.ok(rows[0]?.message); assert.ok(Number.isFinite(Date.parse(rows[0]!.at)));
      assert.equal(extraction.diagnostics().failed, 1); assert.equal(extraction.diagnostics().completed, 0);
      assert.doesNotMatch(await readFile(failureLog, "utf8"), new RegExp(secret));
      assert.deepEqual(await readMemoryExtractionFailures(failureLog, { threadId: "other", projectId: "personal" }), []);
      assert.deepEqual(await readMemoryExtractionFailures(failureLog, { threadId: "thread-a", projectId: null }), []);
    } finally { await extraction.close(); await rm(root, { recursive: true, force: true }); }
  });
});

it("reopened controller exposes the retained reason even with automatic extraction disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-extraction-maintenance-")), data = join(root, "data"), workspace = join(root, "workspace"), config = join(root, "config.json");
  await mkdir(data); await mkdir(workspace);
  const failureLog = join(data, "memory-extraction-failures.jsonl");
  const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error(secret); } });
  const extraction = createMemoryExtraction({ store: createMemoryStore(join(data, "memory.json"), "personal"), threadId: "thread-a", projectId: "personal", failureLog,
    model, budget: defaultContextBudget(), getMessages: async () => messages, updated() {} });
  extraction.afterMask("u"); extraction.idle(); await settle(extraction); await extraction.close();
  await writeFile(config, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { memory: { enabled: true, autoConsolidate: false } } }));
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: data, configPath: config, threadId: "thread-a" },
    project: { id: "personal", directory: workspace, name: "personal", kind: "folder" }, modelAlias: "fixture", model, output, env: {}, cwd: root });
  const controller = createAssistantController(app);
  try {
    const maintenance = await controller.memory.getMaintenance(); assert.ok(maintenance.ok);
    assert.equal(maintenance.value.consolidation.enabled, false); assert.equal(maintenance.value.failures?.length, 1);
    assert.equal(maintenance.value.failures?.[0]?.code, "MEMORY_EXTRACTION_FAILED");
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it("failed journal writes remain visible without converting extraction failure to success", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-extraction-journal-error-"));
  await writeFile(join(root, "not-a-directory"), "x");
  const extraction = createMemoryExtraction({ store: createMemoryStore(join(root, "memory.json"), null), threadId: "t", failureLog: join(root, "not-a-directory/log.jsonl"),
    model: new MockLanguageModelV3({ doGenerate: async () => { throw new Error(secret); } }), budget: defaultContextBudget(), getMessages: async () => messages, updated() {} });
  try {
    extraction.afterMask("u"); extraction.idle(); await settle(extraction);
    assert.match(extraction.diagnostics().logError ?? "", /MEMORY_FAILURE_LOG_WRITE_FAILED/);
    assert.equal(extraction.diagnostics().failed, 1); assert.equal(extraction.diagnostics().completed, 0);
  } finally { await extraction.close(); await rm(root, { recursive: true, force: true }); }
});

it("controller can still read a recorded save failure when the actual memory file becomes corrupt", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-extraction-corrupt-maintenance-")), data = join(root, "data"), workspace = join(root, "workspace"), config = join(root, "config.json");
  await mkdir(data); await mkdir(workspace);
  await writeFile(config, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { memory: { enabled: true, autoConsolidate: false } } }));
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    await writeFile(join(data, "memory.json"), "corrupt");
    return { content: [{ type: "text", text: JSON.stringify({ proposals: [], outcomes: [{ messageId: "u", status: "no_memory" }] }) }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
  } });
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: data, configPath: config, threadId: "t" }, modelAlias: "fixture", model, output, env: {}, cwd: root });
  const controller = createAssistantController(app), extraction = createMemoryExtraction({ store: app.memoryStore!, threadId: "t", projectId: null,
    failureLog: app.dataPaths!.memoryFailures, model, budget: defaultContextBudget(), getMessages: async () => messages, updated() {} });
  try {
    extraction.afterMask("u"); extraction.idle(); await settle(extraction);
    assert.equal((await controller.memory.list()).ok, false);
    const maintenance = await controller.memory.getMaintenance(); assert.ok(maintenance.ok);
    assert.equal(maintenance.value.storageError?.code, "MEMORY_FILE_INVALID");
    assert.equal(maintenance.value.stored, null); assert.equal(maintenance.value.disabled, null);
    assert.ok(maintenance.value.failures?.some(row => row.stage === "save" && row.code === "MEMORY_FILE_INVALID"));
  } finally { await extraction.close(); await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});
