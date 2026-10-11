import { tool, type UIMessage } from "ai";
import { z } from "zod";
import { AgentError } from "@aisdk-agent/core";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import type { MemoryConsolidation } from "../memory-consolidation.js";
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
  MemoryUpdateInput,
  MemoryWriteOptions,
  WorkspaceMemoryStore,
  TemporalWorkspaceMemoryStore,
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
const validTimeSchema = z.object({ from: z.string().nullable(), to: z.string().nullable(), basis: z.enum(["explicit", "reported", "unknown"]) }).strict();
const memoryKindSchema = z.enum(["preference", "fact", "event", "note"]);
const factIdentitySchema = z.object({ attribute: z.enum(["response_language", "review_format", "coffee", "residence"]), scenario: z.enum(["general", "work", "personal"]), value: z.string().min(1).refine(value => Buffer.byteLength(value) <= 96) }).strict();
const factFields = { kind: memoryKindSchema.optional(), recallTerms: z.array(z.string().min(1).refine(value => Buffer.byteLength(value) <= 96)).max(3).optional(), validTime: validTimeSchema.optional() };
const changeFactFields = { kind: factFields.kind, recallTerms: factFields.recallTerms };
const sourceIdentifierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }), z.object({ kind: z.literal("legacy") }),
  z.object({ kind: z.literal("conversation"), threadId: z.string(), messageId: z.string() }),
]);
const assertionSchema = z.object({ factIdentity: factIdentitySchema.optional(), assertionId: z.string(), text: z.string(), kind: memoryKindSchema, recallTerms: z.array(z.string()), validTime: validTimeSchema, systemTime: z.object({ from: z.string().nullable(), to: z.string().nullable() }), state: z.enum(["asserted", "retracted"]), sources: z.array(memorySourceSchema) });
const memoryEntrySchema = z.object({
  assertion: assertionSchema.omit({ text: true, sources: true }).extend({ sourceIds: z.array(sourceIdentifierSchema) }).optional(),
  id: z.string(),
  text: z.string(),
  enabled: z.boolean(),
  pinned: z.boolean().optional(),
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
    pinned: z.boolean().optional(),
  })).optional(),
});
const memoryFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
const memoryListOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true), entries: z.array(memoryEntrySchema),
    nextOffset: z.number().int().nonnegative().nullable(), truncated: z.boolean(),
  }),
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
    memories: z.array(memoryEntrySchema.extend({ relatedAssertions: z.array(assertionSchema).optional(), historyCoverage: z.enum(["complete", "legacy_partial"]).optional() })),
    batchId: z.string().optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    ok: z.literal(true),
    bootstrap: z.boolean(),
    turns: z.array(incrementalConsolidationTurnSchema),
    memories: z.array(memoryEntrySchema.extend({ relatedAssertions: z.array(assertionSchema).optional(), historyCoverage: z.enum(["complete", "legacy_partial"]).optional() })),
    batchId: z.string().optional(),
    truncated: z.boolean().optional(),
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

const memoryListInputSchema = z.object({
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const memoryGetInputSchema = z.object({ id: z.string().min(1) });
const memoryAddInputSchema = z.object({
  ...factFields,
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
    pinned: z.boolean().optional(),
    status: z.enum(["active", "disabled"]).optional(),
    scope: memoryScopeInputSchema.optional(),
    expiresAt: z.string().nullable().optional(),
    sourceMessageId: z.string().min(1).optional(),
    sourceQuote: z.string().min(1).optional(),
  })
  .refine(({ text, enabled, pinned, status, scope, expiresAt, sourceMessageId }) =>
    text !== undefined ||
    enabled !== undefined ||
    pinned !== undefined ||
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
const memoryPrepareConsolidationInputSchema = z.object({
  mode: z.literal("incremental").optional(),
  turns: z.number().int().min(1).max(MAX_CONSOLIDATION_TURNS).optional(),
}).strict().refine(({ mode, turns }) => mode === undefined || turns === undefined, {
  message: "mode and turns cannot be combined",
});

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

/** A lost post-commit acknowledgement must not look like a safe failed write. */
function confirmedMemoryWrite<T extends { ok: true } | { ok: false; error: { code: string; message: string } }>(result: T): T {
  if (!result.ok && result.error.code === "MEMORY_COMMIT_UNCERTAIN") {
    throw new AgentError({
      code: "TOOL_OUTCOME_UNKNOWN",
      message: "Memory commit may already have been applied. Read the saved memory or candidate receipt before attempting another write.",
      retryable: false,
      phase: "tool",
    });
  }
  return result;
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

const candidateStatusSchema = z.enum(["pending", "accepted", "rejected", "stale"]);
const candidateFactFields = { factIdentity: factIdentitySchema.optional(), reuseSources: z.literal(true).optional() };
const candidateChangeSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("add"), text: z.string(), scope: memoryScopeSchema, expiresAt: z.string().nullable(), ...factFields, factIdentity: factIdentitySchema.optional() }),
  ...(["update", "correct"] as const).map(operation => z.object({ operation: z.literal(operation), memoryId: z.string(), expectedRevision: z.number().int().positive(), text: z.string(), expiresAt: z.string().nullable(), ...factFields, ...candidateFactFields })),
  z.object({ operation: z.literal("change"), memoryId: z.string(), expectedRevision: z.number().int().positive(), text: z.string(), expiresAt: z.string().nullable(), ...changeFactFields, factIdentity: factIdentitySchema.optional(), effectiveAt: z.string().nullable() }),
  ...(["retract", "disable"] as const).map(operation => z.object({ operation: z.literal(operation), memoryId: z.string(), expectedRevision: z.number().int().positive(), text: z.string(), expiresAt: z.string().nullable() })),
]);
const candidateSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), batchId: z.string(),
  originThreadId: z.string(), fingerprint: z.string(), change: candidateChangeSchema,
  source: z.object({ kind: z.literal("conversation"), threadId: z.string(), messageId: z.string(), quote: z.string() }),
  sources: z.array(z.object({ kind: z.literal("conversation"), threadId: z.string(), messageId: z.string(), quote: z.string() })).max(4).optional(),
  reason: z.string(), createdAt: z.string(), resolvedAt: z.string().nullable(),
  status: candidateStatusSchema,
  staleReason: z.enum(["target_changed", "target_missing", "expired", "duplicate"]).nullable(),
  appliedResult: z.object({ memoryId: z.string(), revision: z.number().int().positive() }).nullable(),
});
const candidateListInputSchema = z.object({
  status: candidateStatusSchema.optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
const candidateListOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.object({ candidates: z.array(candidateSchema), nextOffset: z.number().int().nonnegative().nullable(), truncated: z.boolean() }) }),
  memoryFailureSchema,
]);
const candidateApplyInputSchema = z.object({
  candidateId: z.string().min(1), expectedCandidateRevision: z.number().int().positive(),
}).strict();
const candidateApplyOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.object({
    candidateId: z.string(), status: z.enum(["accepted", "rejected"]),
    memoryId: z.string().nullable(), memoryRevision: z.number().int().positive().nullable(), replayed: z.boolean(),
  }) }),
  memoryFailureSchema,
]);
const proposalCommon = {
  sourceMessageId: z.string().min(1).optional(), sourceQuote: z.string().min(1).optional(),
  sources: z.array(z.object({ sourceMessageId: z.string().min(1), sourceQuote: z.string().min(1) }).strict()).min(1).max(4).optional(),
  reason: z.string().min(1),
  eligibility: z.enum(["durable_self_statement", "explicit_request", "needs_review", "ignore"]).optional(),
};
const proposalFactFields = { ...factFields, factIdentity: factIdentitySchema.optional() };
const proposalChangeFactFields = { ...changeFactFields, factIdentity: factIdentitySchema.optional() };
const candidateStageInputSchema = z.object({
  batchId: z.string().min(1),
  outcomes: z.array(z.object({ messageId: z.string().min(1), status: z.enum(["extracted", "no_memory", "deferred"]) }).strict()).max(8).optional(),
  proposals: z.array(z.discriminatedUnion("action", [
    z.object({ action: z.literal("add"), text: z.string().min(1), ...proposalCommon, ...proposalFactFields, expiresAt: z.string().nullable().optional(), scope: memoryScopeInputSchema.optional() }).strict(),
    ...(["update", "correct"] as const).map(action => z.object({ action: z.literal(action), text: z.string().min(1), ...proposalCommon, ...proposalFactFields, expiresAt: z.string().nullable().optional(), memoryId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict()),
    z.object({ action: z.literal("change"), text: z.string().min(1), ...proposalCommon, ...proposalChangeFactFields, expiresAt: z.string().nullable().optional(), effectiveAt: z.string().optional(), memoryId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict(),
    ...(["retract", "disable"] as const).map(action => z.object({ action: z.literal(action), text: z.string().min(1).optional(), ...proposalCommon, memoryId: z.string().min(1), expectedRevision: z.number().int().positive() }).strict()),
  ])).max(5),
}).strict();
const candidateStageOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.object({ staged: z.literal(true), batchId: z.string(), count: z.number().int().nonnegative() }) }),
  memoryFailureSchema,
]);

export interface MemoryModuleOptions {
  /** Host-registered consolidation Skills, never model-provided IDs. */
  consolidationAgentIds?: readonly string[];
  /** Active thread. Thread scope is bound to this id and cannot target another thread. */
  threadId?: string;
  /** Injectable clock for expiry checks and memory timestamps. */
  now?: () => Date;
  /** Application-owned run-local proposals; absent for standalone read-only material preparation. */
  consolidation?: MemoryConsolidation;
}

function presentMemoryEntry(entry: MemoryEntry): MemoryEntry {
  const { history: _history, ...current } = entry;
  return current;
}

function visibleScope(scope: MemoryScope | undefined, threadId: string | undefined): boolean {
  return scope === undefined || scope.kind === "workspace" || scope.threadId === threadId;
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
    // Production mutations capture commit time under flock. A pre-lock wall-clock
    // snapshot can falsely look like rollback after another Thread writes first.
    ...(options.now === undefined ? {} : { now: options.now() }),
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
        execute: async (input, { abortSignal }) => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const listed = await store.list(signal, writeOptions());
          if (!listed.ok) return listed;
          const visible = listed.entries.filter((entry) => visibleScope(entry.scope, options.threadId));
          const offset = input.offset ?? 0;
          const limit = input.limit ?? 20;
          const entries: MemoryEntry[] = [];
          for (const entry of visible.slice(offset, offset + limit)) {
            const next = [...entries, presentMemoryEntry(entry)];
            if (Buffer.byteLength(JSON.stringify({ ok: true, entries: next, nextOffset: offset + next.length, truncated: true }), "utf8") > 16 * 1024) break;
            entries.push(presentMemoryEntry(entry));
          }
          if (entries.length === 0 && offset < visible.length) {
            return { ok: false as const, error: { code: "MEMORY_LIMIT_EXCEEDED", message: "Memory entry exceeds the list response budget; use memory_get" } };
          }
          const truncated = offset + entries.length < visible.length;
          return { ok: true as const, entries, nextOffset: truncated ? offset + entries.length : null, truncated };
        },
      });
      const memoryGetTool = tool({
        description: "Read one saved memory, including its source quote and revision history, when the user asks where it came from or what changed. A conversation quote is the excerpt verified at save time, not proof the original message is still in this thread JSONL or recoverable with /history. Do not infer new memories. History is prior revisions, not the current fact.",
        inputSchema: memoryGetInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ id }, { abortSignal }): Promise<MemoryEntryResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const found = await store.get(id, signal, writeOptions());
          if (!found.ok) return found;
          if (!visibleScope(found.entry.scope, options.threadId)) {
            return { ok: false, error: { code: "MEMORY_ENTRY_NOT_FOUND", message: "Memory entry not found" } };
          }
          const entry = { ...found.entry, ...(found.entry.history === undefined ? {} : { history: found.entry.history.filter((revision) => visibleScope(revision.scope, options.threadId)) }) };
          if (Buffer.byteLength(JSON.stringify({ ok: true, entry }), "utf8") > 64 * 1024) {
            return { ok: false, error: { code: "MEMORY_LIMIT_EXCEEDED", message: "Memory detail exceeds the response budget" } };
          }
          return { ok: true, entry };
        },
      });
      const memoryAddTool = tool({
        description: "Save a workspace memory only after the user explicitly confirms it. If it was proposed from conversation, supply the committed user sourceMessageId and a sourceQuote copied exactly from that message; the program verifies the quote. A memory is active by default. scope.kind thread means the active thread; do not supply a thread id. expiresAt is optional.",
        inputSchema: memoryAddInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ text, enabled, status, scope, expiresAt, sourceMessageId, sourceQuote, kind, recallTerms, validTime }, { abortSignal }): Promise<MemoryEntryResult> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const bound = bindScope(scope, options.threadId);
          if (!bound.ok) return bound;
          const provenance = sourceMessageId === undefined || sourceQuote === undefined
            ? undefined
            : await sourceFromCommittedUser(sourceMessageId, sourceQuote, signal);
          if (provenance !== undefined && !provenance.ok) return provenance;
          const saved = confirmedMemoryWrite(await store.add({
            text,
            ...(kind === undefined ? {} : { kind }), ...(recallTerms === undefined ? {} : { recallTerms }), ...(validTime === undefined ? {} : { validTime }),
            ...(provenance === undefined ? {} : { source: provenance.source }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(status === undefined ? {} : { status: status as MemoryStatus }),
            ...(bound.scope === undefined ? {} : { scope: bound.scope }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          }, signal, writeOptions()));
          if (!saved.ok) return saved;
          return { ok: true, entry: presentMemoryEntry(saved.entry) };
        },
      });
      const memoryUpdateTool = tool({
        description: "Update a workspace memory only after the user explicitly confirms the change. Include the current expectedRevision; stale revisions are rejected. If the change came from conversation, supply the committed user sourceMessageId and a sourceQuote copied exactly from that message. scope.kind thread means the active thread; do not supply a thread id.",
        inputSchema: memoryUpdateInputSchema,
        outputSchema: memoryEntryOutputSchema,
        execute: async ({ id, expectedRevision, text, enabled, pinned, status, scope, expiresAt, sourceMessageId, sourceQuote }, { abortSignal }): Promise<MemoryEntryResult> => {
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
            ...(pinned === undefined ? {} : { pinned }),
            ...(status === undefined ? {} : { status: status as MemoryStatus }),
            ...(bound.scope === undefined ? {} : { scope: bound.scope }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          };
          const saved = confirmedMemoryWrite(await store.update(id, input, signal, writeOptions()));
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
          return confirmedMemoryWrite(await store.delete(id, signal, writeOptions()));
        },
      });
      const memoryPrepareConsolidationTool = getMessages === undefined
        ? undefined
        : tool({
            description:
              options.consolidation
                ? "Prepare exactly one batch of committed non-excluded ordinary user text and bounded related Memory. Returns current projections plus relatedAssertions with applicability/knowledge time, including visible disabled/expired and historical versions only for conflict checking, never as current facts or permission to re-enable. Returns batchId for one subsequent memory_stage_candidates call, including an empty proposals array when no suggestions exist. Use {mode:incremental} with NO turns field only in the automatic consolidator: mode and turns are mutually exclusive. Its stored user-prefix cursor advances only after successful staging and completed Run finalization. Manual turns select recent users. Other Thread/private history is excluded. This is read-only; do not apply active Memory in this consolidation turn."
                : "Prepare committed ordinary user text and related current Memory for read-only review. Without a consolidation service this tool does not stage or persist candidates. Use incremental only in the automatic consolidator; the legacy transcript selector is for material preparation, not a new candidate commit. Disabled/expired memories may identify conflicts; other Thread memories and history are excluded.",
            inputSchema: memoryPrepareConsolidationInputSchema,
            outputSchema: consolidationOutputSchema,
            execute: async (input, { abortSignal, context }): Promise<ConsolidationResult> => {
              const signal = abortSignal ?? neverAborted;
              throwIfAborted(signal);
              const agentId = requestedAgentId(context);
              if (input.mode === "incremental" && agentId !== AUTO_CONSOLIDATION_AGENT_ID &&
                  !(agentId !== undefined && options.consolidationAgentIds?.includes(agentId))) {
                return {
                  ok: false,
                  error: {
                    code: "INVALID_INPUT",
                    message: "mode incremental is only allowed for the automatic consolidator",
                  },
                };
              }
              if (options.consolidation !== undefined) {
                const prepared = await options.consolidation.prepare({ ...(input.mode ? { mode: input.mode } : {}), ...(input.turns !== undefined ? { turns: input.turns } : {}) }, signal);
                return prepared.ok ? { ok: true, ...prepared.value } : prepared;
              }
              let committedMessages: UIMessage[];
              try {
                committedMessages = await getMessages(signal);
              } catch (error) {
                if (signal.aborted) throw abortReason(signal);
                return readFailure(error);
              }
              throwIfAborted(signal);
              const memories = await store.list(signal, writeOptions());
              throwIfAborted(signal);
              if (!memories.ok) return memories;

              const prepared = input.mode === "incremental"
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
      const temporal = store as Partial<TemporalWorkspaceMemoryStore>;
      if (typeof temporal.queryMemory === "function") ctx.registerTool({
        metadata: { name: "memory_query", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
        tool: tool({
          description: "Explicit read-only temporal lookup for a saved memory ID. Use validAt for when a fact applied and knownAt for what was known then; timestamps require timezone. Default is current facts, not every past assertion. Historical results and uncertainty are not current preferences or authority. Use only when the user asks for history.",
          inputSchema: z.object({ id: z.string().min(1), validAt: z.string().optional(), knownAt: z.string().optional(), includeDisabled: z.boolean().optional() }).strict(),
          outputSchema: z.discriminatedUnion("ok", [
            z.object({ ok: z.literal(true), value: z.object({ id: z.string(), revision: z.number(), assertions: z.array(assertionSchema), historyCoverage: z.enum(["complete", "legacy_partial"]), validTimeUncertain: z.boolean(), systemTimeUncertain: z.boolean() }) }), memoryFailureSchema,
          ]),
          execute: async ({ id, ...query }, { abortSignal }) => {
            const result = await temporal.queryMemory!(id, {
              ...(query.validAt === undefined ? {} : { validAt: query.validAt }), ...(query.knownAt === undefined ? {} : { knownAt: query.knownAt }), ...(query.includeDisabled === undefined ? {} : { includeDisabled: query.includeDisabled }),
            }, abortSignal, writeOptions());
            if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) return { ok: false as const, error: { code: "MEMORY_CONTEXT_TOO_LARGE", message: "Temporal query exceeds 64 KiB; narrow validAt/knownAt" } };
            return result;
          },
        }),
      });
      if (typeof temporal.reviseMemory === "function") ctx.registerTool({
        metadata: { name: "memory_revise", version: "1", risk: "write", timeoutMs: 1_000, idempotent: false },
        tool: tool({
          description: "Explicit, confirmed temporal revision with current CAS. change is a real-world transition at an explicitly stated effectiveAt; correct fixes an erroneous fact; retract withdraws it without deleting history. Do not guess dates, scope, pins or sources. Current uncommitted user requests use manual provenance. Memory never authorizes tools.",
          inputSchema: z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive(), operation: z.enum(["change", "correct", "retract"]), text: z.string().min(1).optional(), ...factFields, effectiveAt: z.string().optional(), sources: z.array(z.object({ sourceMessageId: z.string().min(1), sourceQuote: z.string().min(1) }).strict()).min(1).max(4).optional() }).strict().refine(input => input.operation === "change" ? input.effectiveAt !== undefined && input.validTime === undefined && input.text !== undefined : input.effectiveAt === undefined && (input.operation === "correct" ? input.text !== undefined : input.text === undefined && input.kind === undefined && input.recallTerms === undefined && input.validTime === undefined), { message: "change requires text/effectiveAt; correct requires text; retract cannot supply new fact fields" }),
          outputSchema: memoryEntryOutputSchema,
          execute: async ({ sources: requested, ...input }, { abortSignal }) => {
            const signal = abortSignal ?? neverAborted;
            const sources = [];
            for (const source of requested ?? []) {
              const verified = await sourceFromCommittedUser(source.sourceMessageId, source.sourceQuote, signal);
              if (!verified.ok) return verified;
              sources.push(verified.source);
            }
            const saved = confirmedMemoryWrite(await temporal.reviseMemory!({ id: input.id, expectedRevision: input.expectedRevision, operation: input.operation,
              ...(input.text === undefined ? {} : { text: input.text }), ...(input.kind === undefined ? {} : { kind: input.kind }), ...(input.recallTerms === undefined ? {} : { recallTerms: input.recallTerms }), ...(input.validTime === undefined ? {} : { validTime: input.validTime }), ...(input.effectiveAt === undefined ? {} : { effectiveAt: input.effectiveAt }),
              ...(requested === undefined ? {} : { sources }),
            }, signal, writeOptions()));
            return saved.ok ? { ok: true as const, entry: presentMemoryEntry(saved.entry) } : saved;
          },
        }),
      });
      ctx.registerTool({
        metadata: { name: "memory_candidates_list", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
        tool: tool({
          description: "List persisted memory candidates from this Thread with stable ids. Pending candidates are not saved active memories. Use their id and revision, never a prose candidate number, for an explicitly requested acceptance.",
          inputSchema: candidateListInputSchema, outputSchema: candidateListOutputSchema,
          execute: (input, { abortSignal }) => store.listCandidates(input, abortSignal, writeOptions()),
        }),
      });
      ctx.registerTool({
        metadata: { name: "memory_apply_candidate", version: "1", risk: "write", timeoutMs: 1_000, idempotent: true },
        tool: tool({
          description: "Accept a previously persisted candidate only when the user explicitly selects it. The normal tool confirmation is required. The store atomically rechecks its revision and the target memory; stale previews cannot overwrite newer memory. Success returns the actual memory id and revision.",
          inputSchema: candidateApplyInputSchema, outputSchema: candidateApplyOutputSchema,
          execute: (input, { abortSignal }) => store.resolveCandidate({ ...input, decision: "accept" }, abortSignal, writeOptions()),
        }),
      });
      if (options.consolidation !== undefined) {
        ctx.registerTool({
          metadata: { name: "memory_stage_candidates", version: "1", risk: "read", timeoutMs: 1_000, idempotent: false },
          tool: tool({
            description: "Stage at most five structured proposals after exactly one memory_prepare_consolidation. Use its batchId and one to four exact committed user quotes per proposal, never assistant/summary/tool evidence. add creates a fact; change is a real transition with explicit effectiveAt, or an undated pending proposal when effectiveAt is omitted (always requires explicit review, never an inferred date); correct fixes a wrong assertion; retract withdraws and disable stops use. Only add accepts scope. Target edits require memoryId/expectedRevision and must omit scope entirely (even the unchanged scope); never copy pinned/enabled fields from the target. recallTerms (at most three, each 96 UTF-8 bytes) are lookup aids, not facts. Set eligibility to durable_self_statement only for explicit ordinary lasting user facts/preferences, explicit_request for clear user requests to retain/change/withdraw supported memory, needs_review for ambiguity, or ignore for secrets, third-party, ephemeral, guessed, or opted-out material. Missing eligibility requires review; this enum is model judgment, not permission or proof. Ambiguous target/time needs review, not guessed dates. An empty proposals array means no suggestions. This only stages data; completed finalization applies the trusted host policy. Manual/history stay pending review; eligible new incremental proposals may be automatically saved only in automatic mode.",
            inputSchema: candidateStageInputSchema, outputSchema: candidateStageOutputSchema,
            execute: (input, { abortSignal }) => options.consolidation!.stage(input, abortSignal),
          }),
        });
      }
      if (memoryPrepareConsolidationTool !== undefined) {
        ctx.registerTool({
          metadata: memoryPrepareConsolidationMetadata,
          tool: memoryPrepareConsolidationTool,
        });
      }
    },
  };
}
