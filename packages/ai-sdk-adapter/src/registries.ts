import type { LanguageModel, ToolSet } from "ai";
import { AgentError } from "@aisdk-agent/core";

export interface ModelRegistry {
  resolve(modelId: string): LanguageModel;
}

export class InMemoryModelRegistry implements ModelRegistry {
  readonly #models = new Map<string, LanguageModel>();

  constructor(models: Readonly<Record<string, LanguageModel>> = {}) {
    for (const [id, model] of Object.entries(models)) this.register(id, model);
  }

  register(id: string, model: LanguageModel): void {
    if (this.#models.has(id)) throw new Error(`Model already registered: ${id}`);
    this.#models.set(id, model);
  }

  resolve(modelId: string): LanguageModel {
    const model = this.#models.get(modelId);
    if (!model) {
      throw new AgentError({
        code: "MODEL_BAD_RESPONSE",
        message: `Model is not registered: ${modelId}`,
        retryable: false,
        phase: "model",
      });
    }
    return model;
  }
}

export type ToolRisk =
  | "read"
  | "write"
  | "external_side_effect"
  | "destructive";

export interface ToolMetadata {
  name: string;
  version: string;
  risk: ToolRisk;
  timeoutMs: number;
  idempotent: boolean;
  redact?: readonly string[];
}

export interface RegisteredTool {
  metadata: ToolMetadata;
  tool: ToolSet[string];
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(tools: readonly RegisteredTool[] = []) {
    for (const registered of tools) this.register(registered);
  }

  register(registered: RegisteredTool): void {
    const { name } = registered.metadata;
    if (this.#tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.#tools.set(name, registered);
  }

  resolve(names: readonly string[]): ToolSet {
    return Object.fromEntries(
      names.map((name) => {
        const registered = this.#tools.get(name);
        if (!registered) {
          throw new AgentError({
            code: "TOOL_NOT_FOUND",
            message: `Tool is not registered: ${name}`,
            retryable: false,
            phase: "tool",
          });
        }
        return [name, registered.tool];
      }),
    );
  }

  metadata(name: string): ToolMetadata | undefined {
    return this.#tools.get(name)?.metadata;
  }
}
