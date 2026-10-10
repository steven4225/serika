import { asSchema, type ToolSet } from "ai";

/** The same SDK definitions sent by AgentLoop, without execution functions. */
export async function modelToolContext(definitions: ToolSet) {
  return Promise.all(Object.entries(definitions).map(async ([name, definition]) => ({
    name, description: definition.description ?? "",
    inputSchema: await asSchema(definition.inputSchema).jsonSchema,
  })));
}
