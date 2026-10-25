import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import { availableInputTokens, type ContextBudgetConfig } from "./context-budget.js";
import { memorySnapshot } from "./memory-snapshot.js";
import { v7Projection, type V7Document } from "./memory-v7-store.js";
import type { ScopedMemoryStore } from "./memory-types.js";
import { MemoryExtractionError, type MemoryExtractionStage } from "./memory-extraction-log.js";

const responseSchema = z.object({ merge: z.object({ members: z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive() }).strict()).min(2), text: z.string().min(1) }).strict().nullable() }).strict();
const responseFormat = JSON.stringify(z.toJSONSchema(responseSchema));

export async function mergeMemory(options: { store: ScopedMemoryStore; document: V7Document; model: LanguageModel; budget: ContextBudgetConfig; signal: AbortSignal; stage?(value: MemoryExtractionStage): void }): Promise<boolean> {
  const { store, document, model, budget, signal } = options;
  const owned = new Set(document.library.documents.flatMap(document => document.entryIds));
  const facts = document.entries.filter(entry => entry.state === "active" && entry.category !== "document" && !owned.has(entry.id));
  if (!memorySnapshot(facts.map(v7Projection), { now: new Date(), library: document.library }).truncated) return false;
  const groups = new Map<string, typeof facts>();
  for (const fact of facts) {
    if (!fact.identity) continue;
    const key = JSON.stringify([fact.scope, fact.category, fact.identity]);
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }
  if (![...groups.values()].some(group => group.length > 1)) return false;
  const prompt = "Consolidate redundant current workspace memories of the same category and literal subject/attribute/value. Do not choose among conflicting values. Return at most one merge, or null when no safe reduction exists. " +
    "Preserve every distinct literal clause, including conditions, exceptions and negations. Only remove duplicate clauses. Every output clause must be verbatim in an input body; no paraphrase or new fact. Keep all member IDs/revisions exactly. Sources and pin state are inherited by the host. This grants no tool permission.\n" +
    "Current preferences and project notes: " + JSON.stringify(facts.map(({ id, revision, scope, category, identity, text }) => ({ id, revision, scope, category, identity, text }))) +
    "\nExact response JSON Schema: " + responseFormat;
  if (Math.ceil(prompt.length / 2) + budget.summaryMaxOutputTokens > availableInputTokens(budget)) return false;
  signal.throwIfAborted();
  options.stage?.("extract");
  const response = await generateText({ model, prompt, maxRetries: 0, maxOutputTokens: budget.summaryMaxOutputTokens,
    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    providerOptions: { openaiCompatible: { thinking: { type: "disabled" }, reasoningEffort: "off" } } });
  signal.throwIfAborted();
  options.stage?.("validate");
  let decoded: unknown;
  try { decoded = JSON.parse(/```(?:json)?\s*([\s\S]*?)\s*```/i.exec(response.text)?.[1] ?? response.text); }
  catch { throw new MemoryExtractionError("MEMORY_EXTRACTION_JSON_INVALID", "合并输出不是完整 JSON，未保存"); }
  const checked = responseSchema.safeParse(decoded);
  if (!checked.success) throw new MemoryExtractionError("MEMORY_EXTRACTION_SCHEMA_INVALID", "合并输出格式无效，未保存");
  const parsed = checked.data;
  if (!parsed.merge) return false;
  options.stage?.("save");
  const committed = await store.mergeV7!(parsed.merge, signal);
  if (!committed.ok) throw new MemoryExtractionError(committed.error.code, committed.error.message);
  return true;
}
