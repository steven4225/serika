import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createDemoModel } from "./demo-model.js";
import { contextBudgetForMode, effectiveContextBudget, validateContextBudgetConfig } from "./context-budget.js";
import { resolveModelContextWindow } from "./model-config.js";

async function diagnostics(env: NodeJS.ProcessEnv, window = 1_000_000, windows: unknown[] = [], modelId?: string) {
  const root = await mkdtemp(join(tmpdir(), "serika-model-budget-"));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, modules: {}, modelContextWindows: windows,
    contextCompaction: { ...contextBudgetForMode("daily"), contextWindowTokens: window } }));
  const model = modelId ? new MockLanguageModelV3({ provider: "test", modelId }) : createDemoModel();
  // Only a local model stub is used; capacity is tied to the actual model id.
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "capacity", "--config", configPath],
    modelAlias: "mock/default", model, env: { RUNLOOM_MODEL: "command-code", COMMAND_CODE_MODEL_ID: model.modelId, ...env }, cwd: root,
    output: new Writable({ write(_chunk, _encoding, callback) { callback(); } }) });
  try {
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

it("unknown model capacity does not inherit a template 1M window", async () => {
  const value = await diagnostics({});
  assert.equal(value.budget.contextWindowTokens, 128_000);
  assert.equal(value.budget.inputBudgetTokens, 91_136);
  assert.equal(value.modelCapacity?.source, "unverified_fallback");
});

it("capacity configuration matches exact provider and model, not aliases or other models", async () => {
  const model = createDemoModel();
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

it("explicit smaller physical limits remain authoritative and tiny windows fail before a model request", async () => {
  const requested = { ...contextBudgetForMode("daily"), contextWindowTokens: 96_000, inputBudgetTokens: 50_000, safetyMarginTokens: 1024 };
  const large = { provider: "test", modelId: "test", contextWindowTokens: 512_000, source: "configuration" as const };
  const effective = effectiveContextBudget(requested, large);
  assert.equal(effective.contextWindowTokens, 96_000);
  assert.equal(effective.inputBudgetTokens, 50_000);
  assert.equal(effective.keepRecentTokens, 39_904);
  assert.equal(validateContextBudgetConfig(effective).ok, true);
  assert.throws(() => effectiveContextBudget(requested, { ...large, contextWindowTokens: 4096 }), /回复与安全余量/);
  const small = effectiveContextBudget({ ...requested, summaryMaxOutputTokens: 1024 }, { ...large, contextWindowTokens: 24_000 });
  assert.equal(small.summaryInputChunkTokens, 16_832);
  assert.equal(validateContextBudgetConfig(small).ok, true);
  assert.throws(() => resolveModelContextWindow({ provider: "test", modelId: "current" }, {
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
