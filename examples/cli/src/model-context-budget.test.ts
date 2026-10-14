import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createRuntimeApp } from "./app.js";
import { contextBudgetForMode, effectiveContextBudget, validateContextBudgetConfig } from "./context-budget.js";
import { configureCliModel, resolveModelContextWindow } from "./model-config.js";

async function diagnostics(env: NodeJS.ProcessEnv, window = 1_000_000, windows: unknown[] = [], modelId?: string,
  run?: { text: string; status: "completed" | "failed" }) {
  const root = await mkdtemp(join(tmpdir(), "serika-model-budget-"));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, modules: {}, modelContextWindows: windows,
    contextCompaction: { ...contextBudgetForMode("daily"), contextWindowTokens: window } }));
  let calls = 0;
  const model = new MockLanguageModelV3({ provider: "openai-compatible.chat", modelId: modelId ?? "fixture-model", doStream: async () => {
    calls++;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "t" },
      { type: "text-delta" as const, id: "t", delta: "收到" }, { type: "text-end" as const, id: "t" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
    ] }) };
  } });
  // Only a local model stub is used; capacity is tied to the actual model id.
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "capacity", "--config", configPath],
    modelAlias: "mock/default", model, env: { RUNLOOM_MODEL: "command-code", COMMAND_CODE_MODEL_ID: model.modelId, ...env }, cwd: root,
    output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }) });
  try {
    if (run) {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
        messages: [{ id: "capacity-user", role: "user", parts: [{ type: "text", text: run.text }] }] });
      assert.equal((await handle.result).status, run.status);
      assert.equal(calls, run.status === "completed" ? 1 : 0);
    }
    const result = await app.getContextDiagnostics();
    assert(result.ok);
    return result.value;
  } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
}

it("runtime clamps a daily preset to the configured actual model capacity without calling it", async () => {
  const value = await diagnostics({ COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "128000" });
  assert.equal(value.budget.contextWindowTokens, 128_000);
  assert.equal(value.budget.inputBudgetTokens, 91_136);
  assert.equal(value.requestedBudget?.inputBudgetTokens, 256_000);
  assert.equal(value.modelCapacity?.source, "environment");
});

it("32K preset sends a fitting user turn but rejects a truly oversized current request before dispatch", async () => {
  const env = { COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "32768" };
  const fitting = await diagnostics(env, 1_000_000, [], undefined, { text: "简短说声收到", status: "completed" });
  assert(fitting.lastPreparation?.estimatedInputTokens! <= fitting.budget.inputBudgetTokens!);
  const oversized = await diagnostics(env, 1_000_000, [], undefined, { text: "字".repeat(70_000), status: "failed" });
  assert.equal(oversized.lastPreparation?.outcome, "failed");
});

it("32K model starts with a daily preset and proportionally bounded reserves instead of inheriting a 32K margin", async () => {
  const value = await diagnostics({ COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "32768" });
  assert.equal(value.budget.contextWindowTokens, 32_768);
  assert(value.budget.inputBudgetTokens! > 16_000);
  assert(value.budget.safetyMarginTokens <= 2048);
  assert(value.budget.summaryMaxOutputTokens <= 2048);
  assert(value.budget.summaryInputChunkTokens! < 24_000);
  assert(validateContextBudgetConfig(value.budget).ok);
});

it("unknown model capacity does not inherit a template 1M window", async () => {
  const value = await diagnostics({});
  assert.equal(value.budget.contextWindowTokens, 128_000);
  assert.equal(value.budget.inputBudgetTokens, 91_136);
  assert.equal(value.modelCapacity?.source, "unverified_fallback");
});

it("capacity configuration matches exact provider and model, not aliases or other models", async () => {
  const model = new MockLanguageModelV3({ provider: "openai-compatible.chat", modelId: "fixture-model" });
  const value = await diagnostics({}, 1_000_000, [
    { provider: model.provider, modelId: model.modelId, contextWindowTokens: 512_000 },
    { provider: "another", modelId: model.modelId, contextWindowTokens: 1_000_000 },
  ]);
  assert.equal(value.budget.inputBudgetTokens, 256_000);
  assert.equal(value.modelCapacity?.source, "configuration");
  assert.equal(resolveModelContextWindow({ provider: "test", modelId: "different" }, {
    RUNLOOM_MODEL: "command-code", COMMAND_CODE_MODEL_ID: "old-model", COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "1000000",
  }).source, "unverified_fallback");
});

it("same model ID on another provider never inherits this route's environment capacity", () => {
  const env = { RUNLOOM_MODEL: "command-code", COMMAND_CODE_MODEL_ID: "same-id", COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "1000000" };
  assert.equal(resolveModelContextWindow({ provider: "other-provider.chat", modelId: "same-id" }, env).source, "unverified_fallback");
  assert.equal(resolveModelContextWindow({ provider: "other-provider.chat", modelId: "same-id" }, env,
    [{ provider: "other-provider.chat", modelId: "same-id", contextWindowTokens: 64_000 }]).contextWindowTokens, 64_000);
  // Construct the real adapter without calling it, so its provider identity is
  // verified rather than assumed by the local model fixtures.
  const { model } = configureCliModel(() => new MockLanguageModelV3(), { ...env, COMMAND_CODE_API_KEY: "fixture-key" });
  assert.notEqual(typeof model, "string");
  if (typeof model !== "string") assert.equal(resolveModelContextWindow(model, env).source, "environment");
});

it("explicit smaller physical limits remain authoritative and tiny windows fail before a model request", async () => {
  const requested = { ...contextBudgetForMode("daily"), contextWindowTokens: 96_000, inputBudgetTokens: 50_000, safetyMarginTokens: 1024 };
  const large = { provider: "test", modelId: "test", contextWindowTokens: 512_000, source: "configuration" as const };
  const effective = effectiveContextBudget(requested, large);
  assert.equal(effective.contextWindowTokens, 96_000);
  assert.equal(effective.inputBudgetTokens, 50_000);
  assert.equal(effective.keepRecentTokens, 39_904);
  assert.equal(validateContextBudgetConfig(effective).ok, true);
  assert.throws(() => effectiveContextBudget(requested, { ...large, contextWindowTokens: 4096 }), /窗口不足/);
  assert.throws(() => effectiveContextBudget({ ...requested, mode: undefined }, { ...large, contextWindowTokens: 4096 }), /回复与安全余量/);
  const small = effectiveContextBudget({ ...requested, summaryMaxOutputTokens: 1024 }, { ...large, contextWindowTokens: 24_000 });
  assert.equal(small.summaryInputChunkTokens, 16_832);
  assert.equal(validateContextBudgetConfig(small).ok, true);
  assert.throws(() => resolveModelContextWindow({ provider: "openai-compatible.chat", modelId: "current" }, {
    RUNLOOM_MODEL: "command-code", COMMAND_CODE_MODEL_ID: "current", COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "NaN",
  }), /正整数/);
});

it("reassembling with another model capacity recalculates the effective ceiling", async () => {
  const small = await diagnostics({ COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "128000" }, 1_000_000, [], "small-model");
  const large = await diagnostics({ COMMAND_CODE_CONTEXT_WINDOW_TOKENS: "512000" }, 1_000_000, [], "large-model");
  assert.equal(small.budget.inputBudgetTokens, 91_136);
  assert.equal(large.budget.inputBudgetTokens, 256_000);
  assert.equal(small.modelCapacity?.modelId, "small-model");
  assert.equal(large.modelCapacity?.modelId, "large-model");
});
