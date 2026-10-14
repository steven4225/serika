import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import { createConfiguredModel } from "@aisdk-agent/ai-sdk-adapter";
import { UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS, type ModelCapacityEvidence, type ModelContextWindow } from "./context-budget.js";

/** Capacity is operator-declared and exact-model-bound; aliases never imply a window. */
export function resolveModelContextWindow(model: { provider: string; modelId: string }, env: NodeJS.ProcessEnv,
  configured: readonly ModelContextWindow[] = []): ModelCapacityEvidence {
  const identity = { provider: model.provider, modelId: model.modelId };
  const mode = env.RUNLOOM_MODEL;
  const prefix = mode === "command-code" ? "COMMAND_CODE" : mode === "deepseek" ? "DEEPSEEK" : mode === "minimax-m3" ? "MINIMAX" : undefined;
  const configuredId = prefix ? env[`${prefix}_MODEL_ID`] ?? (mode === "command-code" ? "deepseek/deepseek-v4.1-flash" : mode === "deepseek" ? "deepseek-flash" : "MiniMax-M3") : undefined;
  const raw = prefix && configuredId === model.modelId ? env[`${prefix}_CONTEXT_WINDOW_TOKENS`] : undefined;
  if (raw !== undefined) {
    const tokens = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(tokens) || tokens <= 0) throw new Error("模型窗口配置必须是正整数，请核对 CONTEXT_WINDOW_TOKENS；尚未发送请求。");
    return { ...identity, contextWindowTokens: tokens, source: "environment" };
  }
  const found = configured.find(item => item.provider === model.provider && item.modelId === model.modelId);
  return { ...identity, contextWindowTokens: found?.contextWindowTokens ?? UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
    source: found ? "configuration" : "unverified_fallback" };
}

export function inspectCliModelConfig(env: NodeJS.ProcessEnv = process.env): {
  alias: string;
  modelId: string;
  credential: "present" | "missing" | "not_required";
  error?: string;
} {
  const mode = env.RUNLOOM_MODEL ?? "mock";
  if (mode === "mock") return { alias: "mock/default", modelId: "mock", credential: "not_required" };
  if (mode !== "minimax-m3" && mode !== "deepseek" && mode !== "command-code") {
    return { alias: mode, modelId: "unknown", credential: "not_required", error: `Unsupported RUNLOOM_MODEL: ${mode}. Use mock, minimax-m3, deepseek or command-code` };
  }
  const prefix = mode === "command-code" ? "COMMAND_CODE" : mode === "deepseek" ? "DEEPSEEK" : "MINIMAX";
  const credential = env[`${prefix}_API_KEY`]?.trim() ? "present" : "missing";
  return {
    alias: mode === "command-code" ? "command-code/default" : mode === "deepseek" ? "deepseek/default" : "minimax/m3",
    modelId: env[`${prefix}_MODEL_ID`] ?? (mode === "command-code" ? "deepseek/deepseek-v4.1-flash" : mode === "deepseek" ? "deepseek-flash" : "MiniMax-M3"),
    credential,
    ...(credential === "missing" ? { error: `${prefix}_API_KEY is required when RUNLOOM_MODEL=${mode}` } : {}),
  };
}

/** Shared CLI/TUI and worker selection; each entry retains its own mock behavior. */
export function configureCliModel(
  createMockModel: () => LanguageModel,
  env: NodeJS.ProcessEnv = process.env,
  options?: { fetch?: typeof fetch },
): { modelAlias: string; model: LanguageModel } {
  const mode = env.RUNLOOM_MODEL ?? "mock";
  if (mode === "mock") {
    return { modelAlias: "mock/default", model: createMockModel() };
  }
  if (mode !== "minimax-m3" && mode !== "deepseek" && mode !== "command-code") {
    throw new Error(`Unsupported RUNLOOM_MODEL: ${mode}. Use mock, minimax-m3, deepseek or command-code`);
  }

  const prefix = mode === "command-code" ? "COMMAND_CODE" : mode === "deepseek" ? "DEEPSEEK" : "MINIMAX";
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  if (!apiKey) {
    throw new Error(`${prefix}_API_KEY is required when RUNLOOM_MODEL=${mode}`);
  }
  const modelId = env[`${prefix}_MODEL_ID`] ?? (
    mode === "command-code" ? "deepseek/deepseek-v4.1-flash" : mode === "deepseek" ? "deepseek-flash" : "MiniMax-M3"
  );
  const model = createConfiguredModel({
    adapter: "openai-compatible",
    baseURL: env[`${prefix}_BASE_URL`] ?? (
      mode === "command-code" ? "https://api.commandcode.ai/provider/v1" : mode === "deepseek" ? "https://api.deepseek.com" : "https://api.minimax.io/v1"
    ),
    modelId,
    apiKey,
  }, options);

  if (mode === "minimax-m3") return { modelAlias: "minimax/m3", model };

  // Thinking tool calls require replaying reasoning_content across requests.
  // The current transcript/loop does not preserve that provider-specific field.
  return {
    modelAlias: mode === "command-code" ? "command-code/default" : "deepseek/default",
    model: wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { openaiCompatible: {
          thinking: { type: "disabled" },
          // Command Code's DeepSeek route ignores thinking alone and uses "off", not "none".
          ...(mode === "command-code" && modelId.startsWith("deepseek/") ? { reasoningEffort: "off" } : {}),
        } } },
      }),
    }),
  };
}
