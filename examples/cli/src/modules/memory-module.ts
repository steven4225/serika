import { tool, type UIMessage } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import { MAX_CONTEXT_BYTES } from "../context-window.js";
import {
  consolidateMessages,
  MAX_CONSOLIDATION_TURNS,
  type ConsolidationTurn,
} from "../consolidation.js";
import type {
  MemoryEntry,
  MemoryEntryResult,
  MemoryDeleteResult,
  MemoryListResult,
  MemoryUpdateInput,
  WorkspaceMemoryStore,
} from "../memory-store.js";

export type { MemoryEntry, WorkspaceMemoryStore } from "../memory-store.js";

const memoryEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  enabled: z.boolean(),
});
const memoryFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
const memoryListOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), entries: z.array(memoryEntrySchema) }),
  memoryFailureSchema,
]);
const memoryEntryOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), entry: memoryEntrySchema }),
  memoryFailureSchema,
]);
const memoryDeleteOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.string() }),
  memoryFailureSchema,
]);
const consolidationMessageSchema = z.object({
  id: z.string(),
  role: z.union([z.literal("user"), z.literal("assistant")]),
  text: z.string(),
});
const consolidationOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    turns: z.array(z.object({ messages: z.array(consolidationMessageSchema) })),
    memories: z.array(memoryEntrySchema),
  }),
  memoryFailureSchema,
]);

const memoryListMetadata: RegisteredTool["metadata"] = {
  name: "memory_list",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};
const memoryAddMetadata: RegisteredTool["metadata"] = {
  name: "memory_add",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};
const memoryUpdateMetadata: RegisteredTool["metadata"] = {
  name: "memory_update",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};
const memoryDeleteMetadata: RegisteredTool["metadata"] = {
  name: "memory_delete",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};
const memoryPrepareConsolidationMetadata: RegisteredTool["metadata"] = {
  name: "memory_prepare_consolidation",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};

const memoryListInputSchema = z.object({});
const memoryAddInputSchema = z.object({
  text: z.string().refine((value) => value.trim().length > 0, {
    message: "text must be non-empty",
  }),
  enabled: z.boolean().optional(),
});
const memoryUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().refine((value) => value.trim().length > 0, {
      message: "text must be non-empty",
    }).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(({ text, enabled }) => text !== undefined || enabled !== undefined, {
    message: "at least one field must be provided",
  });
const memoryDeleteInputSchema = z.object({ id: z.string().min(1) });
const memoryPrepareConsolidationInputSchema = z.object({
  turns: z.number().int().min(1).max(MAX_CONSOLIDATION_TURNS).optional(),
}).strict();

/** Consolidation uses the same serialized context budget as model preparation. */
export const CONSOLIDATION_RESULT_MAX_BYTES = MAX_CONTEXT_BYTES;
export type ConsolidationGetMessages = (signal?: AbortSignal) => Promise<UIMessage[]>;

export type ConsolidationResult =
  | {
      ok: true;
      turns: ConsolidationTurn[];
      memories: MemoryEntry[];
    }
  | { ok: false; error: { code: string; message: string } };

function readFailure(error: unknown): ConsolidationResult {
  return {
    ok: false,
    error: {
      code: "READ_FAILED",
      message: error instanceof Error ? error.message : "Unable to read committed transcript",
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

const neverAborted = new AbortController().signal;

export function createMemoryModule(
  store: WorkspaceMemoryStore,
  getMessages?: ConsolidationGetMessages,
): AgentModule {
  return {
    id: "memory",
    setup(ctx) {
      const memoryListTool = tool({
        description: "List explicitly saved workspace memories. Do not infer or extract memories automatically.",
        inputSchema: memoryListInputSchema,
        outputSchema: memoryListOutputSchema,
        execute: async (_input, { abortSignal }): Promise<MemoryListResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.list(signal);
        },
      });
      const memoryAddTool = tool({
        description: "Save a workspace memory only when the user explicitly asks you to remember it.",
        inputSchema: memoryAddInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ text, enabled }, { abortSignal }): Promise<MemoryEntryResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.add({ text, ...(enabled === undefined ? {} : { enabled }) }, signal);
        },
      });
      const memoryUpdateTool = tool({
        description: "Update a workspace memory only when the user explicitly asks to change it.",
        inputSchema: memoryUpdateInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ id, text, enabled }, { abortSignal }): Promise<MemoryEntryResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const input: MemoryUpdateInput = {
            ...(text === undefined ? {} : { text }),
            ...(enabled === undefined ? {} : { enabled }),
          };
          return store.update(id, input, signal);
        },
      });
      const memoryDeleteTool = tool({
        description: "Delete a workspace memory only when the user explicitly asks to remove it.",
        inputSchema: memoryDeleteInputSchema,
        outputSchema: memoryDeleteOutputSchema,
        execute: async ({ id }, { abortSignal }): Promise<MemoryDeleteResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.delete(id, signal);
        },
      });
      const memoryPrepareConsolidationTool = getMessages === undefined
        ? undefined
        : tool({
            description:
              "Prepare recent committed conversation turns and all workspace memories for a manual memory consolidation review. This is read-only; do not write memories in the same turn.",
            inputSchema: memoryPrepareConsolidationInputSchema,
            outputSchema: consolidationOutputSchema,
            execute: async ({ turns: requestedTurns }, { abortSignal }): Promise<ConsolidationResult> => {
              const signal = abortSignal ?? neverAborted;
              throwIfAborted(signal);
              const turns = requestedTurns ?? MAX_CONSOLIDATION_TURNS;
              let committedMessages: UIMessage[];
              try {
                committedMessages = await getMessages(signal);
              } catch (error) {
                if (signal.aborted) throw abortReason(signal);
                return readFailure(error);
              }
              throwIfAborted(signal);
              const memories = await store.list(signal);
              throwIfAborted(signal);
              if (!memories.ok) return memories;

              const prepared = consolidateMessages(committedMessages, turns);
              if (!prepared.ok) return prepared;

              const result: ConsolidationResult = {
                ok: true,
                turns: prepared.turns,
                memories: memories.entries.map((entry) => ({ ...entry })),
              };
              if (Buffer.byteLength(JSON.stringify(result), "utf8") > CONSOLIDATION_RESULT_MAX_BYTES) {
                return {
                  ok: false,
                  error: {
                    code: "CONSOLIDATION_INPUT_TOO_LARGE",
                    message:
                      "Selected conversation and workspace memories exceed the consolidation input limit; reduce the number of turns or shorten existing memories",
                  },
                };
              }
              return result;
            },
          });

      ctx.registerTool({ metadata: memoryListMetadata, tool: memoryListTool });
      ctx.registerTool({ metadata: memoryAddMetadata, tool: memoryAddTool });
      ctx.registerTool({ metadata: memoryUpdateMetadata, tool: memoryUpdateTool });
      ctx.registerTool({ metadata: memoryDeleteMetadata, tool: memoryDeleteTool });
      if (memoryPrepareConsolidationTool !== undefined) {
        ctx.registerTool({
          metadata: memoryPrepareConsolidationMetadata,
          tool: memoryPrepareConsolidationTool,
        });
      }
    },
  };
}
