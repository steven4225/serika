import type { AgentDefinition } from "./types.js";

export interface AgentCatalog {
  get(agentId: string): AgentDefinition | undefined;
}

export class InMemoryAgentCatalog implements AgentCatalog {
  readonly #definitions = new Map<string, AgentDefinition>();

  constructor(definitions: readonly AgentDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: AgentDefinition): void {
    if (this.#definitions.has(definition.id)) {
      throw new Error(`Agent already registered: ${definition.id}`);
    }
    this.#definitions.set(definition.id, definition);
  }

  get(agentId: string): AgentDefinition | undefined {
    return this.#definitions.get(agentId);
  }
}
