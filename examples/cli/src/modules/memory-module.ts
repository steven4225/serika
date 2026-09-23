import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { AgentError } from "@aisdk-agent/core";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import { MAX_CONTEXT_BYTES } from "../context-window.js";
import {
  AUTO_CONSOLIDATION_AGENT_ID,
  consolidateMessages,
  findCommittedUserMessage,
  isExactUserQuote,
  MAX_CONSOLIDATION_TURNS,
  selectIncrementalConsolidationTurns,
  type ConsolidationTurn,
  type IncrementalConsolidationTurn,
} from "../consolidation.js";
import type {
  MemoryEntry,
  MemoryEntryResult,
  MemoryFailure,
  MemoryDeleteResult,
  MemoryScope,
  MemoryStatus,
  MemoryListResult,
  MemoryUpdateInput,
  MemoryWriteOptions,
  WorkspaceMemoryStore,
} from "../memory-store.js";

export type { MemoryEntry, WorkspaceMemoryStore } from "../memory-store.js";

const memoryScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }),
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }),
]);
/** Model input may choose the current thread, but cannot name a thread id. */
const memoryScopeInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("thread") }).strict(),
]);
const memorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("legacy") }),
  z.object({
    kind: z.literal("conversation"),
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    quote: z.string().min(1),
  }),
]);
const memoryEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  enabled: z.boolean(),
  status: z.enum(["active", "disabled"]).optional(),
  scope: memoryScopeSchema.optional(),
  source: memorySourceSchema.optional(),
  createdAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  revision: z.number().int().positive().optional(),
  history: z.array(z.object({
    revision: z.number().int().positive(),
    text: z.string(),
    status: z.enum(["active", "disabled"]),
    scope: memoryScopeSchema,
    expiresAt: z.string().nullable(),
    source: memorySourceSchema,
    changedAt: z.string(),
  })).optional(),
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
const incrementalConsolidationTurnSchema = z.object({
  user: z.object({ messageId: z.string(), text: z.string() }),
  assistant: z.array(z.object({ messageId: z.string(), text: z.string() })),
  tools: z.array(z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    outcome: z.enum(["success", "failed", "denied"]),
    content: z.string(),
    truncated: z.boolean(),
  })),
});
const consolidationOutputSchema = z.union([
  z.object({
    ok: z.literal(true),
    turns: z.array(z.object({ messages: z.array(consolidationMessageSchema) })),
    memories: z.array(memoryEntrySchema),
  }),
  z.object({
    ok: z.literal(true),
    bootstrap: z.boolean(),
    turns: z.array(incrementalConsolidationTurnSchema),
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
const memoryGetMetadata: RegisteredTool["metadata"] = {
  name: "memory_get",
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
const memoryGetInputSchema = z.object({ id: z.string().min(1) });
const memoryAddInputSchema = z.object({
  text: z.string().refine((value) => value.trim().length > 0, {
    message: "text must be non-empty",
  }),
  enabled: z.boolean().optional(),
  status: z.enum(["active", "disabled"]).optional(),
  scope: memoryScopeInputSchema.optional(),
  expiresAt: z.string().nullable().optional(),
  sourceMessageId: z.string().min(1).optional(),
  sourceQuote: z.string().min(1).optional(),
}).refine(({ sourceMessageId, sourceQuote }) => (sourceMessageId === undefined) === (sourceQuote === undefined), {
  message: "sourceMessageId and sourceQuote must be provided together",
});
const memoryUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    text: z.string().refine((value) => value.trim().length > 0, {
      message: "text must be non-empty",
    }).optional(),
    enabled: z.boolean().optional(),
    status: z.enum(["active", "disabled"]).optional(),
    scope: memoryScopeInputSchema.optional(),
    expiresAt: z.string().nullable().optional(),
    sourceMessageId: z.string().min(1).optional(),
    sourceQuote: z.string().min(1).optional(),
  })
  .refine(({ text, enabled, status, scope, expiresAt, sourceMessageId }) =>
    text !== undefined ||
    enabled !== undefined ||
    status !== undefined ||
    scope !== undefined ||
    expiresAt !== undefined ||
    sourceMessageId !== undefined, {
    message: "at least one field must be provided",
  })
  .refine(({ sourceMessageId, sourceQuote }) => (sourceMessageId === undefined) === (sourceQuote === undefined), {
    message: "sourceMessageId and sourceQuote must be provided together",
  });
const memoryDeleteInputSchema = z.object({ id: z.string().min(1) });
const memoryPrepareConsolidationInputSchema = z.union([
  z.object({ mode: z.literal("incremental") }).strict(),
  z.object({
    turns: z.number().int().min(1).max(MAX_CONSOLIDATION_TURNS).optional(),
  }).strict(),
]);

/** Consolidation uses the same serialized context budget as model preparation. */
export const CONSOLIDATION_RESULT_MAX_BYTES = MAX_CONTEXT_BYTES;
export type ConsolidationGetMessages = (signal?: AbortSignal) => Promise<UIMessage[]>;

export type ConsolidationResult =
  | {
      ok: true;
      turns: ConsolidationTurn[];
      memories: MemoryEntry[];
    }
  | {
      ok: true;
      bootstrap: boolean;
      turns: IncrementalConsolidationTurn[];
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

function requestedAgentId(context: unknown): string | undefined {
  if (typeof context !== "object" || context === null) return undefined;
  if (!("agentId" in context) || typeof context.agentId !== "string") return undefined;
  return context.agentId;
}

function consolidationInputTooLarge(): AgentError {
  return new AgentError({
    code: "CONTEXT_PREPARE_FAILED",
    message:
      "Selected conversation and workspace memories exceed the consolidation input limit; reduce the number of turns or shorten existing memories",
    retryable: false,
    phase: "runtime",
  });
}

const neverAborted = new AbortController().signal;

export interface MemoryModuleOptions {
  /** Active thread. Thread scope is bound to this id and cannot target another thread. */
  threadId?: string;
  /** Injectable clock for expiry checks and memory timestamps. */
  now?: () => Date;
}

function presentMemoryEntry(entry: MemoryEntry): MemoryEntry {
  const { history: _history, ...current } = entry;
  return current;
}

/**
 * Consolidation needs disabled and expired current versions for conflict and
 * duplicate detection, but it must not expose another thread's private memory.
 */
function selectConsolidationMemories(
  entries: readonly MemoryEntry[],
  threadId: string | undefined,
): MemoryEntry[] {
  return entries.flatMap((entry) => {
    const scope = entry.scope;
    if (scope?.kind === "thread" && scope.threadId !== threadId) return [];
    return [presentMemoryEntry(entry)];
  });
}

function bindScope(
  scope: { kind: "workspace" } | { kind: "thread" } | undefined,
  threadId: string | undefined,
): { ok: true; scope?: MemoryScope } | { ok: false; error: { code: "INVALID_INPUT"; message: string } } {
  if (scope === undefined) return { ok: true };
  if (scope.kind === "workspace") return { ok: true, scope: { kind: "workspace" } };
  if (threadId === undefined || threadId.length === 0) {
    return { ok: false, error: { code: "INVALID_INPUT", message: "Thread scope requires the active thread" } };
  }
  return { ok: true, scope: { kind: "thread", threadId } };
}

export function createMemoryModule(
  store: WorkspaceMemoryStore,
  getMessages?: ConsolidationGetMessages,
  options: MemoryModuleOptions = {},
): AgentModule {
  const writeOptions = (): MemoryWriteOptions => ({
    ...(options.threadId === undefined ? {} : { boundThreadId: options.threadId }),
    now: options.now?.() ?? new Date(),
  });
  const sourceFromCommittedUser = async (
    messageId: string,
    quote: string,
    signal: AbortSignal,
  ): Promise<{ ok: true; source: { kind: "conversation"; threadId: string; messageId: string; quote: string } } | MemoryFailure> => {
    if (options.threadId === undefined || getMessages === undefined) {
      return { ok: false as const, error: { code: "INVALID_INPUT", message: "Conversation source requires the active thread and committed transcript" } };
    }
    let messages: UIMessage[];
    try {
      messages = await getMessages(signal);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      return {
        ok: false,
        error: { code: "READ_FAILED", message: error instanceof Error ? error.message : "Unable to read committed transcript" },
      };
    }
    throwIfAborted(signal);
    const committed = findCommittedUserMessage(messages, messageId);
    if (committed === undefined) {
      return { ok: false as const, error: { code: "INVALID_INPUT", message: "sourceMessageId must identify a committed user message in the active thread" } };
    }
    if (!isExactUserQuote(committed.text, quote)) {
      return { ok: false as const, error: { code: "INVALID_INPUT", message: "sourceQuote must be an exact substring of that committed user message" } };
    }
    return { ok: true as const, source: { kind: "conversation" as const, threadId: options.threadId, messageId, quote } };
  };

  return {
    id: "memory",
    setup(ctx) {
      const memoryListTool = tool({
        description: "List the current version of explicitly saved workspace memories. Revision history is not included. Do not infer or extract memories automatically.",
        inputSchema: memoryListInputSchema,
        outputSchema: memoryListOutputSchema,
        execute: async (_input, { abortSignal }): Promise<MemoryListResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const listed = await store.list(signal);
          if (!listed.ok) return listed;
          return { ok: true, entries: listed.entries.map(presentMemoryEntry) };
        },
      });
      const memoryGetTool = tool({
        description: "Read one saved memory, including its source quote and revision history, when the user asks where it came from or what changed. A conversation quote is the excerpt verified at save time, not proof the original message is still in this thread JSONL or recoverable with /history. Do not infer new memories. History is prior revisions, not the current fact.",
        inputSchema: memoryGetInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ id }, { abortSignal }): Promise<MemoryEntryResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.get(id, signal);
        },
      });
      const memoryAddTool = tool({
        description: "Save a workspace memory only after the user explicitly confirms it. If it was proposed from conversation, supply the committed user sourceMessageId and a sourceQuote copied exactly from that message; the program verifies the quote. A memory is active by default. scope.kind thread means the active thread; do not supply a thread id. expiresAt is optional.",
        inputSchema: memoryAddInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ text, enabled, status, scope, expiresAt, sourceMessageId, sourceQuote }, { abortSignal }): Promise<MemoryEntryResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const bound = bindScope(scope, options.threadId);
          if (!bound.ok) return bound;
          const provenance = sourceMessageId === undefined || sourceQuote === undefined
            ? undefined
            : await sourceFromCommittedUser(sourceMessageId, sourceQuote, signal);
          if (provenance !== undefined && !provenance.ok) return provenance;
          const saved = await store.add({
            text,
            ...(provenance === undefined ? {} : { source: provenance.source }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(status === undefined ? {} : { status: status as MemoryStatus }),
            ...(bound.scope === undefined ? {} : { scope: bound.scope }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }, signal, writeOptions());
          if (!saved.ok) return saved;
          return { ok: true, entry: presentMemoryEntry(saved.entry) };
        },
      });
      const memoryUpdateTool = tool({
        description: "Update a workspace memory only after the user explicitly confirms the change. Include the current expectedRevision; stale revisions are rejected. If the change came from conversation, supply the committed user sourceMessageId and a sourceQuote copied exactly from that message. scope.kind thread means the active thread; do not supply a thread id.",
        inputSchema: memoryUpdateInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ id, expectedRevision, text, enabled, status, scope, expiresAt, sourceMessageId, sourceQuote }, { abortSignal }): Promise<MemoryEntryResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const bound = bindScope(scope, options.threadId);
          if (!bound.ok) return bound;
          const provenance = sourceMessageId === undefined || sourceQuote === undefined
            ? undefined
            : await sourceFromCommittedUser(sourceMessageId, sourceQuote, signal);
          if (provenance !== undefined && !provenance.ok) return provenance;
          const input: MemoryUpdateInput = {
            expectedRevision,
            ...(provenance === undefined ? {} : { source: provenance.source }),
            ...(text === undefined ? {} : { text }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(status === undefined ? {} : { status: status as MemoryStatus }),
            ...(bound.scope === undefined ? {} : { scope: bound.scope }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          };
          const saved = await store.update(id, input, signal, writeOptions());
          if (!saved.ok) return saved;
          return { ok: true, entry: presentMemoryEntry(saved.entry) };
        },
      });
      const memoryDeleteTool = tool({
        description: "Delete a workspace memory only when the user explicitly asks to remove it.",
        inputSchema: memoryDeleteInputSchema,
        outputSchema: memoryDeleteOutputSchema,
        execute: async ({ id }, { abortSignal }): Promise<MemoryDeleteResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.delete(id, signal, writeOptions());
        },
      });
      const memoryPrepareConsolidationTool = getMessages === undefined
        ? undefined
        : tool({
            description:
              "Prepare committed conversation evidence and related current memories for review. Use mode incremental only in the automatic consolidator to read ordinary turns after the last successful marker, with an eight-turn bootstrap when no marker exists; assistant and tool evidence is context only and cannot be a user-fact source. Without mode, manually review recent user messages selected by turns. Disabled and expired current memories remain visible for duplicate/conflict detection, but another thread's memories are excluded. This is read-only; do not write memories in the same turn.",
            inputSchema: memoryPrepareConsolidationInputSchema,
            outputSchema: consolidationOutputSchema,
            execute: async (input, { abortSignal, context }): Promise<ConsolidationResult> => {
              const signal = abortSignal ?? neverAborted;
              throwIfAborted(signal);
              if ("mode" in input && requestedAgentId(context) !== AUTO_CONSOLIDATION_AGENT_ID) {
                return {
                  ok: false,
                  error: {
                    code: "INVALID_INPUT",
                    message: "mode incremental is only allowed for the automatic consolidator",
                  },
                };
              }
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

              const prepared = "mode" in input
                ? selectIncrementalConsolidationTurns(committedMessages)
                : consolidateMessages(committedMessages, input.turns ?? MAX_CONSOLIDATION_TURNS);
              if (!prepared.ok) return prepared;

              const selectedMemories = selectConsolidationMemories(memories.entries, options.threadId);
              const result: ConsolidationResult = "bootstrap" in prepared
                ? {
                    ok: true,
                    bootstrap: prepared.bootstrap,
                    turns: prepared.turns,
                    memories: selectedMemories,
                  }
                : { ok: true, turns: prepared.turns, memories: selectedMemories };
              if (Buffer.byteLength(JSON.stringify(result), "utf8") > CONSOLIDATION_RESULT_MAX_BYTES) {
                throw consolidationInputTooLarge();
              }
              return result;
            },
          });

      ctx.registerTool({ metadata: memoryListMetadata, tool: memoryListTool });
      ctx.registerTool({ metadata: memoryGetMetadata, tool: memoryGetTool });
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
