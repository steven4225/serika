import assert from "node:assert/strict";
import { it } from "node:test";
import { asSchema, tool } from "ai";
import { z } from "zod";
import { ToolRegistry } from "@serika/ai-sdk-adapter";
import { estimateContextBudget, estimateSerializedTokens, DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";
import { modelToolContext } from "./model-tool-context.js";

it("budget counts the exact model-visible description/JSON Schema, only for selected tools", async () => {
  const selected = tool({ description: "detailed description ".repeat(200), inputSchema: z.object({ path: z.string().describe("absolute description"), content: z.string() }), execute: () => "unused" });
  const registry = new ToolRegistry(["selected", "hidden"].map(name => ({ metadata: { name, version: "1", risk: "read", timeoutMs: 1000, idempotent: true }, tool: selected })));
  const tools = await modelToolContext(registry.definitions(["selected"]));
  assert.deepEqual(tools, [{ name: "selected", description: selected.description, inputSchema: await asSchema(selected.inputSchema).jsonSchema }]);
  assert(!JSON.stringify(tools).includes("hidden")); assert(!JSON.stringify(tools).includes("execute"));
  const metadata = [registry.metadata("selected")!];
  assert(estimateSerializedTokens(tools) > estimateSerializedTokens(metadata) + 2000);
  const messages = [{ id: "u", role: "user" as const, parts: [{ type: "text" as const, text: "x".repeat(52_000) }] }];
  assert.equal(estimateContextBudget({ messages, tools: metadata }, DEFAULT_CONTEXT_BUDGET_CONFIG).exceeds, false);
  assert.equal(estimateContextBudget({ messages, tools }, DEFAULT_CONTEXT_BUDGET_CONFIG).exceeds, true);
});
