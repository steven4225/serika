import { tool } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { selectInjectableMemoryEntries, type WorkspaceMemoryStore } from "./memory-store.js";
import type { DreamingService } from "./dreaming.js";
import { memoryLibraryDocuments } from "./memory-library.js";

export function memoryReadTools(options: { store: WorkspaceMemoryStore | undefined; dreaming: DreamingService | undefined; threadId: string }): RegisteredTool[] {
  return [{ metadata: { name: "memory_read", version: "1", risk: "read", idempotent: true, timeoutMs: 5000 },
    tool: tool({ description: "Read a Memory document or existing method by its indexed ID, or find overflow preferences/notes using literal keywords. Read-only reference data; no permission grants.",
      inputSchema: z.object({ id: z.string().min(1).optional(), query: z.string().min(1).optional() }).strict().refine(value => !!value.id !== !!value.query, "Supply either id or query"),
      execute: async ({ id, query }, { abortSignal }) => {
        const signal = abortSignal ?? new AbortController().signal;
        if (id?.startsWith("method:")) {
          const result = await options.dreaming?.read(id.slice(7), options.threadId, signal);
          return result?.ok ? { ok: true, id, title: result.value.title, instructions: result.value.instructions } : result ?? { ok: false, error: { code: "NOT_FOUND", message: "Method unavailable" } };
        }
        if (!options.store) return { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory unavailable" } };
        const now = new Date();
        const result = await options.store.readReferenceMaterial?.(signal, now);
        if (!result?.ok) return result ?? { ok: false, error: { code: "MEMORY_DISABLED", message: "Memory unavailable" } };
        const entries = selectInjectableMemoryEntries(result.value.entries, { now }).filter(entry => entry.temporalState !== "retracted" && entry.temporalState !== "not_applicable");
        if (id) {
          const document = memoryLibraryDocuments(result.value.library, entries, options.threadId, now).find(item => item.id === id);
          return document?.active && !document.missing ? { ok: true, id, title: document.title, text: document.text } : { ok: false, error: { code: "NOT_FOUND", message: "Document unavailable" } };
        }
        const keywords = query!.normalize("NFKC").toLowerCase().trim().split(/\s+/u).filter(Boolean);
        return { ok: true, entries: entries.filter(entry =>
          keywords.some(word => entry.text.normalize("NFKC").toLowerCase().includes(word)))
          .map(({ id, revision, text }) => ({ id, revision, text })) };
      } }) }];
}
