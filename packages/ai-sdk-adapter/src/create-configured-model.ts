import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type LanguageModel } from "ai";
import { AgentError } from "@aisdk-agent/core";

export interface ModelConnectionConfig {
  adapter: "openai-compatible";
  baseURL: string;
  modelId: string;
  apiKey?: string;
}

function invalidConfig(message: string): AgentError {
  return new AgentError({
    code: "INVALID_REQUEST",
    message,
    retryable: false,
    phase: "runtime",
  });
}

/**
 * Create a model for an OpenAI Chat Completions-compatible endpoint.
 *
 * This is deliberately a pure configuration boundary: it does not read
 * environment variables, register the model, or probe the remote service.
 */
export function createConfiguredModel(
  config: ModelConnectionConfig,
  options?: { fetch?: typeof fetch },
): LanguageModel {
  if (typeof config !== "object" || config === null) {
    throw invalidConfig("Model connection config must be an object");
  }

  if (config.adapter !== "openai-compatible") {
    throw invalidConfig("Model connection adapter must be openai-compatible");
  }

  if (typeof config.baseURL !== "string") {
    throw invalidConfig("Model connection baseURL must be a string");
  }
  const baseURL = config.baseURL.trim();
  if (baseURL.length === 0) {
    throw invalidConfig("Model connection baseURL must not be empty");
  }
  let parsedURL: URL;
  try {
    parsedURL = new URL(baseURL);
  } catch (error) {
    throw new AgentError(
      {
        code: "INVALID_REQUEST",
        message: "Model connection baseURL must be a valid URL",
        retryable: false,
        phase: "runtime",
      },
      { cause: error },
    );
  }
  if (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") {
    throw invalidConfig("Model connection baseURL must use http or https");
  }

  if (typeof config.modelId !== "string") {
    throw invalidConfig("Model connection modelId must be a string");
  }
  const modelId = config.modelId.trim();
  if (modelId.length === 0) {
    throw invalidConfig("Model connection modelId must not be empty");
  }

  if (config.apiKey !== undefined && typeof config.apiKey !== "string") {
    throw invalidConfig("Model connection apiKey must be a string");
  }
  const apiKey = config.apiKey?.trim();

  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL,
    includeUsage: true,
    ...(apiKey ? { apiKey } : {}),
    ...(options?.fetch ? { fetch: options.fetch } : {}),
  });

  return provider.chatModel(modelId);
}
