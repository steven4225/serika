import { tool, type UIMessage } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type { TranscriptAccess } from "./transcript-access.js";
import { blockLimits } from "./context-blocks.js";
import type { ContextBudgetConfig } from "./context-budget.js";

export function historyTools(access: TranscriptAccess, budget: ContextBudgetConfig): RegisteredTool[] {
  const maxChars = blockLimits(budget).section * 2;
  const searchable = (message: UIMessage) => JSON.stringify(message.parts);
  const excluded = (message: UIMessage) => !!(message.metadata as { transcriptExcluded?: boolean } | undefined)?.transcriptExcluded;
  return [
    { metadata: { name: "history_search", version: "1", risk: "read", timeoutMs: 5000, idempotent: true },
      tool: tool({ description: "Search this Thread's original journal using literal keywords. Excluded messages return a placeholder only. Read history_read for full numbered messages and tool output ranges.",
        inputSchema: z.object({ query: z.string().min(1), start: z.number().int().nonnegative().default(0) }).strict(),
        execute: async ({ query, start }) => {
          const messages = await access.read(), terms = query.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean);
          const hits = messages.map((message, index) => ({ message, index })).filter(({ message }) => excluded(message) || terms.some(term => searchable(message).normalize("NFKC").toLowerCase().includes(term)));
          const selected = []; let size = 0, next: number | null = null;
          for (let index = start; index < hits.length; index++) {
            const hit = hits[index]!, row = { number: hit.index + 1, id: hit.message.id, role: hit.message.role,
              text: excluded(hit.message) ? `[Message ${hit.message.id} excluded.]` : searchable(hit.message) };
            if (!selected.length && JSON.stringify(row).length > maxChars) row.text = Array.from(row.text).slice(0, Math.max(0, maxChars - JSON.stringify({ ...row, text: "" }).length)).join("");
            if (selected.length && size + JSON.stringify(row).length > maxChars) { next = index; break; }
            selected.push(row); size += JSON.stringify(row).length;
          }
          return { ok: true, hits: selected, next };
        } }) },
    { metadata: { name: "history_read", version: "1", risk: "read", timeoutMs: 5000, idempotent: true },
      tool: tool({ description: "Read one journal message by ID or one-based number, optionally one toolCallId. start/end are Unicode character offsets; full tool output and attachments stay in the original journal. Exclusions never expose content.",
        inputSchema: z.object({ id: z.string().min(1).optional(), number: z.number().int().positive().optional(), toolCallId: z.string().min(1).optional(),
          start: z.number().int().nonnegative().default(0), end: z.number().int().positive().optional() }).strict().refine(value => !!value.id !== !!value.number, "Supply id or number").refine(value => value.end === undefined || value.end > value.start, "end must follow start"),
        execute: async ({ id, number, toolCallId, start, end }) => {
          const messages = await access.read(), message = id ? messages.find(message => message.id === id) : messages[number! - 1];
          if (!message) return { ok: false, error: { code: "NOT_FOUND", message: "Message unavailable" } };
          if (excluded(message)) return { ok: true, id: message.id, excluded: true, text: `[Message ${message.id} excluded.]` };
          const part = toolCallId ? message.parts.find(part => "toolCallId" in part && part.toolCallId === toolCallId) : undefined;
          if (toolCallId && !part) return { ok: false, error: { code: "NOT_FOUND", message: "Tool unavailable in this message" } };
          const chars = Array.from(part ? JSON.stringify(part) : JSON.stringify(message.parts));
          const stop = Math.min(chars.length, end ?? chars.length, start + maxChars);
          return { ok: true, id: message.id, role: message.role, start, end: stop, total: chars.length, truncated: stop < chars.length,
            text: chars.slice(start, stop).join("") };
        } }) },
  ];
}
