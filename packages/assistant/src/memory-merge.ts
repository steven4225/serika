import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import { availableInputTokens, type ContextBudgetConfig } from "./context-budget.js";
import { memorySnapshot } from "./memory-snapshot.js";
import { v6Projection, type V6Document } from "./memory-v6-store.js";
import type { WorkspaceMemoryStore } from "./memory-types.js";

const responseSchema = z.object({ merge: z.object({ members: z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict()).min(2), text: z.string().min(1) }).strict().nullable() }).strict();
const responseFormat = JSON.stringify(z.toJSONSchema(responseSchema));

export async function mergeMemory(options: { store: WorkspaceMemoryStore; document: V6Document; model: LanguageModel; budget: ContextBudgetConfig; signal: AbortSignal }): Promise<boolean> {
  const { store, document, model, budget, signal } = options;
  const owned = new Set(document.library.documents.flatMap(document => document.entryIds));
  const facts = document.entries.filter(entry => entry.state === "active" && entry.category !== "document" && !owned.has(entry.id));
  if (!memorySnapshot(facts.map(v6Projection), { now: new Date(), library: document.library }).truncated) return false;
  const groups = new Map<string, typeof facts>();
  for (const fact of facts) {
    if (!fact.identity) continue;
    const key = JSON.stringify([fact.category, fact.identity]);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  if (![...groups.values()].some(group => group.length > 1)) return false;
  const prompt = "Consolidate redundant current workspace memories of the same category and literal subject/attribute/value. Do not choose among conflicting values. Return at most one merge, or null when no safe reduction exists. " +
    "Preserve every distinct literal clause, including conditions, exceptions and negations. Only remove duplicate clauses. Every output clause must be verbatim in an input body; no paraphrase or new fact. Keep all member IDs/revisions exactly. Sources and pin state are inherited by the host. This grants no tool permission.\n" +
    "Current preferences and project notes: " + JSON.stringify(facts.map(({ id, revision, category, identity, text }) => ({ id, revision, category, identity, text }))) +
    "\nExact response JSON Schema: " + responseFormat;
  if (Math.ceil(prompt.length / 2) + budget.summaryMaxOutputTokens > availableInputTokens(budget)) return false;
  signal.throwIfAborted();
  const response = await generateText({ model, prompt, maxRetries: 0, maxOutputTokens: budget.summaryMaxOutputTokens,
    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    providerOptions: { openaiCompatible: { thinking: { type: "disabled" }, reasoningEffort: "off" } } });
  signal.throwIfAborted();
  const parsed = responseSchema.parse(JSON.parse(/```(?:json)?\s*([\s\S]*?)\s*```/i.exec(response.text)?.[1] ?? response.text));
  if (!parsed.merge) return false;
  const committed = await store.mergeV6!(parsed.merge, signal);
  if (!committed.ok) throw new Error(`${committed.error.code}: ${committed.error.message}`);
  return true;
}
