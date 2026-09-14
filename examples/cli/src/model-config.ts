import { defaultSettingsMiddleware, wrapLanguageModel, type LanguageModel } from "ai";
import { createConfiguredModel } from "@aisdk-agent/ai-sdk-adapter";

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
  if (mode !== "minimax-m3" && mode !== "deepseek") {
    throw new Error(`Unsupported RUNLOOM_MODEL: ${mode}. Use mock, minimax-m3 or deepseek`);
  }

  const prefix = mode === "deepseek" ? "DEEPSEEK" : "MINIMAX";
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  if (!apiKey) {
    throw new Error(`${prefix}_API_KEY is required when RUNLOOM_MODEL=${mode}`);
  }
  const model = createConfiguredModel({
    adapter: "openai-compatible",
    baseURL: env[`${prefix}_BASE_URL`] ?? (
      mode === "deepseek" ? "https://api.deepseek.com" : "https://api.minimax.io/v1"
    ),
    modelId: env[`${prefix}_MODEL_ID`] ?? (
      mode === "deepseek" ? "deepseek-flash" : "MiniMax-M3"
    ),
    apiKey,
  }, options);

  if (mode === "minimax-m3") return { modelAlias: "minimax/m3", model };

  // Thinking tool calls require replaying reasoning_content across requests.
  // The current transcript/loop does not preserve that provider-specific field.
  return {
    modelAlias: "deepseek/default",
    model: wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions: { openaiCompatible: { thinking: { type: "disabled" } } } },
      }),
    }),
  };
}
