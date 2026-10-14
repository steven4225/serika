import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import { contextBudgetForMode, DEFAULT_CONTEXT_BUDGET_CONFIG } from "@aisdk-agent/example-cli/dist/context-budget.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { changeContextMode } from "./context-settings.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "serika-context-mode-"));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json"); await mkdir(workspace);
  const budget = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: true, contextWindowTokens: 1_000_000, safetyMarginTokens: 32_768 };
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: false } }, contextCompaction: budget,
    modelContextWindows: [{ provider: "test", modelId: "test", contextWindowTokens: 1_000_000 }] }));
  let calls = 0; const events: MainToRenderer[] = [];
  const options = { userData: join(root, "profile"), cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", send: (event: MainToRenderer) => { events.push(event); },
    model: new MockLanguageModelV3({ provider: "test", modelId: "test", doStream: async () => { calls++; return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "t" }, { type: "text-delta" as const, id: "t", delta: "收到" }, { type: "text-end" as const, id: "t" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
    ] }) }; } }),
  };
  return { root, configPath, budget, options, events, calls: () => calls, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function readBudget(host: DesktopRuntime) { const result = await host.current.getContextDiagnostics(); assert(result.ok); return result.value.budget; }
async function idle(host: DesktopRuntime) { const deadline = Date.now() + 5000; while (host.current.snapshot().state.kind !== "idle") { if (Date.now() > deadline) throw new Error("host remained busy"); await new Promise(resolve => setTimeout(resolve, 5)); } }

it("mode selection preserves conversation, rejects busy/stale changes and persists the complete preset after reopen", async () => {
  const f = await fixture(); let host = await DesktopRuntime.create(f.options);
  try {
    const identity = host.info();
    assert.equal((await readBudget(host)).mode, undefined, "legacy configuration is not upgraded on read");
    await host.current.run("保留原对话", { memoryConsolidation: "exclude" });
    const before = await readFile(f.configPath, "utf8");
    await assert.rejects(host.setContextMode({ mode: "long-task", expectedBudget: f.budget }), /等待/);
    assert.equal(await readFile(f.configPath, "utf8"), before); await idle(host);
    const history = await host.current.history(), calls = f.calls();
    await host.setContextMode({ mode: "long-task", expectedBudget: await readBudget(host) });
    assert.deepEqual(await readBudget(host), contextBudgetForMode("long-task"));
    assert(f.events.some(event => event.type === "identity-changed" && event.reason === "context"), "renderer must return to the context page, not modules");
    assert.equal(host.info().threadId, identity.threadId); assert.deepEqual(await host.current.history(), history);
    await assert.rejects(host.setContextMode({ mode: "daily", expectedBudget: f.budget }), /配置已变化/);
    assert.deepEqual(await readBudget(host), contextBudgetForMode("long-task"));
    await host.shutdown(); host = await DesktopRuntime.create(f.options);
    assert.deepEqual(await readBudget(host), contextBudgetForMode("long-task"));
    assert.deepEqual(await host.current.history(), history); assert.equal(f.calls(), calls, "mode change and restart never replay a Run");
  } finally { await host.shutdown(); await f.cleanup(); }
});

it("small actual model capacity keeps requested mode CAS separate and reapplies the cap after reopen", async () => {
  const f = await fixture();
  const raw = JSON.parse(await readFile(f.configPath, "utf8"));
  raw.modelContextWindows[0].contextWindowTokens = 128_000;
  await writeFile(f.configPath, JSON.stringify(raw));
  let host = await DesktopRuntime.create(f.options);
  try {
    const before = await host.current.getContextDiagnostics(); assert(before.ok);
    assert.equal(before.value.budget.contextWindowTokens, 128_000);
    await host.setContextMode({ mode: "long-task", expectedBudget: before.value.requestedBudget! });
    const after = await host.current.getContextDiagnostics(); assert(after.ok);
    assert.equal(after.value.budget.inputBudgetTokens, 91_136);
    assert.equal(after.value.requestedBudget?.inputBudgetTokens, 400_000);
    assert.equal(after.value.budget.keepRecentTokens, 64_000);
    await host.shutdown(); host = await DesktopRuntime.create(f.options);
    assert.equal((await readBudget(host)).inputBudgetTokens, 91_136);
    assert.equal(f.calls(), 0, "reading capacity and switching never invoke or replay a model");
  } finally { await host.shutdown(); await f.cleanup(); }
});

it("32K legacy desktop may select either mode while retaining requested intent and actual capacity", async () => {
  const f = await fixture();
  const raw = JSON.parse(await readFile(f.configPath, "utf8"));
  raw.contextCompaction = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: true };
  raw.modelContextWindows[0].contextWindowTokens = 32768;
  await writeFile(f.configPath, JSON.stringify(raw));
  const host = await DesktopRuntime.create(f.options);
  try {
    await host.current.run("短消息不会超过32K窗口", { memoryConsolidation: "exclude" }); await idle(host);
    const prepared = await host.current.getContextDiagnostics(); assert(prepared.ok); assert(prepared.value.lastPreparation);
    for (const mode of ["daily", "long-task"] as const) {
      const before = await host.current.getContextDiagnostics(); assert(before.ok);
      await host.setContextMode({ mode, expectedBudget: before.value.requestedBudget! });
      const after = await host.current.getContextDiagnostics(); assert(after.ok);
      assert.equal(after.value.budget.contextWindowTokens, 32768);
      assert(after.value.budget.inputBudgetTokens! <= 32768 - after.value.budget.maxOutputTokens - after.value.budget.safetyMarginTokens);
      assert.equal(after.value.requestedBudget?.inputBudgetTokens, mode === "daily" ? 256_000 : 400_000);
      assert.equal(after.value.lastPreparation, null);
    }
    assert.equal(f.calls(), 1, "mode changes cannot reuse old preparation metrics or dispatch a new model call");
  } finally { await host.shutdown(); await f.cleanup(); }
});

it("failed mode activation rolls back the old config and reconnects without replay", async t => {
  const f = await fixture(); const host = await DesktopRuntime.create(f.options);
  try {
    const before = await readFile(f.configPath, "utf8"), bridge = host.current, shutdown = bridge.shutdown.bind(bridge);
    const fault = t.mock.method(bridge, "shutdown", async () => { await shutdown(); throw new Error("mode activation fault"); });
    await assert.rejects(host.setContextMode({ mode: "daily", expectedBudget: await readBudget(host) }), /mode activation fault/);
    fault.mock.restore();
    assert.equal(await readFile(f.configPath, "utf8"), before); assert.deepEqual(await readBudget(host), f.budget);
    assert.equal(host.current.snapshot().state.kind, "idle"); assert.equal(f.calls(), 0);
    assert(f.events.some(event => event.type === "identity-changed" && event.reason === "context" && event.configurationError?.includes("mode activation fault")), "remounted context page must retain the apply failure");
  } finally { await host.shutdown(); await f.cleanup(); }
});

it("unconfirmed mode commit stops new execution until explicit reconnect rereads disk", async t => {
  const f = await fixture(); const host = await DesktopRuntime.create(f.options);
  try {
    const probe = await open(f.root, "r"), prototype = Object.getPrototypeOf(probe); await probe.close();
    const original = prototype.sync; let reached = false;
    const fault = t.mock.method(prototype, "sync", async function(this: { stat(): Promise<{ isDirectory(): boolean }> }) {
      if ((await this.stat()).isDirectory() && !reached) { reached = true; throw new Error("mode directory sync fault"); }
      return original.call(this);
    });
    await assert.rejects(host.setContextMode({ mode: "daily", expectedBudget: await readBudget(host) }), /配置保存结果未确认/);
    fault.mock.restore(); assert(reached); assert.throws(() => host.current, /暂停新执行/);
    assert.equal(host.info().runtimeRecovery?.state, "failed");
    await host.retryConnection(); assert.deepEqual(await readBudget(host), contextBudgetForMode("daily")); assert.equal(f.calls(), 0);
  } finally { await host.shutdown(); await f.cleanup(); }
});

it("explicit mode selection preserves disabled compaction and rejects renderer authority fields", async () => {
  const f = await fixture();
  try {
    const raw = JSON.parse(await readFile(f.configPath, "utf8")); raw.contextCompaction.enabled = false; await writeFile(f.configPath, JSON.stringify(raw));
    const expectedBudget = { ...f.budget, enabled: false }, before = await readFile(f.configPath, "utf8");
    await assert.rejects(changeContextMode(f.configPath, { mode: "daily", expectedBudget, configPath: "/other" } as never, f.root), /参数无效/);
    await assert.rejects(changeContextMode(f.configPath, { mode: "daily", expectedBudget: { ...expectedBudget, enabled: "yes" } } as never, f.root), /参数无效/);
    assert.equal(await readFile(f.configPath, "utf8"), before);
    const undo = await changeContextMode(f.configPath, { mode: "daily", expectedBudget }, f.root);
    assert.deepEqual(JSON.parse(await readFile(f.configPath, "utf8")).contextCompaction, { ...contextBudgetForMode("daily"), enabled: false });
    await undo(); assert.equal(await readFile(f.configPath, "utf8"), before);
  } finally { await f.cleanup(); }
});

it("mode selection keeps a smaller declared physical ceiling while storing the preset as intent", async () => {
  const f = await fixture();
  try {
    for (const mode of ["daily", "long-task"] as const) {
      const budget = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: true, contextWindowTokens: 128_000 };
      const raw = JSON.parse(await readFile(f.configPath, "utf8")); raw.contextCompaction = budget;
      await writeFile(f.configPath, JSON.stringify(raw));
      await changeContextMode(f.configPath, { mode, expectedBudget: budget }, f.root);
      const saved = JSON.parse(await readFile(f.configPath, "utf8")).contextCompaction;
      assert.equal(saved.contextWindowTokens, 128_000, "preset intent must not invent a 1M physical capacity");
      assert.equal(saved.inputBudgetTokens, mode === "daily" ? 256_000 : 400_000);
    }
    const budget = { ...f.budget, contextWindowTokens: 512_000, maxOutputTokens: 8192, safetyMarginTokens: 16_384 };
    const raw = JSON.parse(await readFile(f.configPath, "utf8")); raw.contextCompaction = budget;
    await writeFile(f.configPath, JSON.stringify(raw));
    await changeContextMode(f.configPath, { mode: "long-task", expectedBudget: budget }, f.root);
    const saved = JSON.parse(await readFile(f.configPath, "utf8")).contextCompaction;
    assert.equal(saved.contextWindowTokens, 512_000);
    assert.equal(saved.maxOutputTokens, 8192);
    assert.equal(saved.safetyMarginTokens, 16_384);
    assert.equal(saved.inputBudgetTokens, 400_000);
  } finally { await f.cleanup(); }
});
