import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import {
  AUTO_CONSOLIDATION_AGENT_ID, MAX_CONSOLIDATION_TURNS,
  findCommittedUserMessage, hasMemoryTool, isAutoConsolidationRequest,
  isExactUserQuote, userStartedTurns,
  type ConsolidationTurn, type IncrementalConsolidationTurn,
} from "./consolidation.js";
import { candidateFingerprint, type CandidateDraft, type ConsolidationCursor, type MemoryResult } from "./memory-candidates.js";
import type { MemoryEntry, WorkspaceMemoryStore } from "./memory-store.js";

export const CONSOLIDATION_MATERIAL_MAX_BYTES = 64 * 1024;
export const CONSOLIDATION_MEMORIES_MAX_BYTES = 24 * 1024;
export const CONSOLIDATION_MEMORIES_MAX = 20;

export interface MemoryProposal {
  action: "add" | "update";
  text: string;
  sourceMessageId: string;
  sourceQuote: string;
  reason: string;
  scope?: { kind: "workspace" } | { kind: "thread" };
  expiresAt?: string | null;
  memoryId?: string;
  expectedRevision?: number;
}
export type PreparedBatch = {
  batchId: string; truncated: boolean; memories: MemoryEntry[];
} & (
  | { turns: ConsolidationTurn[] }
  | { bootstrap: boolean; turns: IncrementalConsolidationTurn[] }
);
export interface MemoryConsolidation {
  begin(agentId: string): void;
  canStart(signal?: AbortSignal): Promise<MemoryResult<{ canStart: boolean; pendingCount: number }>>;
  prepare(input: { mode?: "incremental"; turns?: number }, signal?: AbortSignal): Promise<MemoryResult<PreparedBatch>>;
  stage(input: { batchId: string; proposals: unknown[] }, signal?: AbortSignal): Promise<MemoryResult<{ staged: true; batchId: string; count: number }>>;
  finalize(result: { status: string; consolidationAttempts?: { prepare: number; stage: number } }, signal?: AbortSignal): Promise<MemoryResult<{ candidateIds: string[]; replayed: boolean }>>;
  discard(): void;
}
interface OrdinaryTurn { user: { id: string; text: string }; messages: UIMessage[] }
interface Batch {
  agentId: string;
  prepareCount: number;
  stageCount: number;
  invalid: boolean;
  prepared?: PreparedBatch;
  selected?: OrdinaryTurn[];
  drafts?: CandidateDraft[];
  expectedCursor?: ConsolidationCursor | null;
  nextCursor?: ConsolidationCursor | null;
  committed?: MemoryResult<{ candidateIds: string[]; replayed: boolean }>;
}
const fail = (code: string, message: string): { ok: false; error: { code: string; message: string } } => ({ ok: false, error: { code, message } });
function aborted(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function userText(message: UIMessage): string {
  return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}
function ordinaryTurns(messages: readonly UIMessage[]): OrdinaryTurn[] {
  return userStartedTurns(messages).flatMap((turn) => {
    const user = turn[0]!;
    return isAutoConsolidationRequest(user) ? [] : [{ user: { id: user.id, text: userText(user) }, messages: turn }];
  });
}
/** The encoding is versioned and binds ordered ordinary user ids and exact text. */
export function consolidationPrefixHash(messages: readonly UIMessage[], throughMessageId: string): string | undefined {
  const turns = ordinaryTurns(messages);
  const matches = turns.flatMap((turn, index) => turn.user.id === throughMessageId ? [index] : []);
  if (matches.length !== 1) return undefined;
  return createHash("sha256").update(JSON.stringify([
    "runloom-consolidation-prefix/v1", turns.slice(0, matches[0]! + 1).map((turn) => [turn.user.id, turn.user.text]),
  ])).digest("hex");
}
function visible(entry: MemoryEntry, threadId: string): boolean {
  return entry.scope?.kind !== "thread" || entry.scope.threadId === threadId;
}
function current(entry: MemoryEntry): MemoryEntry { const { history: _history, ...value } = entry; return value; }
function relatedMemories(entries: MemoryEntry[], turns: OrdinaryTurn[], threadId: string): { entries: MemoryEntry[]; truncated: boolean } {
  // This is bounded conflict material, not the primary Agent's retrieval algorithm.
  const query = turns.map((turn) => turn.user.text).join("\n");
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]{2,}/gu) ?? []).flatMap((term) => {
    if (!/\p{Script=Han}/u.test(term)) return [term];
    const chars = [...term];
    return chars.slice(0, -1).map((char, index) => char + chars[index + 1]!);
  }))];
  const ranked = entries.filter((entry) => visible(entry, threadId)).map(current)
    .map((entry) => ({ entry, score: terms.filter((term) => entry.text.toLowerCase().includes(term) || term.includes(entry.text.toLowerCase())).length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  const selected: MemoryEntry[] = [];
  for (const { entry } of ranked) {
    if (selected.length < CONSOLIDATION_MEMORIES_MAX && Buffer.byteLength(JSON.stringify([...selected, entry])) <= CONSOLIDATION_MEMORIES_MAX_BYTES) selected.push(entry);
  }
  return { entries: selected, truncated: selected.length < ranked.length };
}
function proposalDraft(proposal: unknown, prepared: PreparedBatch, selected: OrdinaryTurn[], messages: UIMessage[], threadId: string, now: Date): MemoryResult<CandidateDraft> {
  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) return fail("MEMORY_BATCH_INVALID", "Proposal must be an object");
  const p = proposal as Record<string, unknown>;
  const common = ["action", "text", "sourceMessageId", "sourceQuote", "reason", "expiresAt"];
  const allowed = p.action === "add" ? [...common, "scope"] : [...common, "memoryId", "expectedRevision"];
  if ((p.action !== "add" && p.action !== "update") || Object.keys(p).some((key) => !allowed.includes(key))) return fail("MEMORY_BATCH_INVALID", "Unknown proposal action or field");
  for (const [field, limit] of [["text", 2048], ["sourceQuote", 2048], ["reason", 512]] as const) {
    if (typeof p[field] !== "string" || p[field].trim().length === 0 || Buffer.byteLength(p[field]) > limit) return fail("MEMORY_BATCH_INVALID", `${field} is empty or exceeds its byte limit`);
  }
  if (typeof p.sourceMessageId !== "string" || !selected.some((turn) => turn.user.id === p.sourceMessageId)) return fail("MEMORY_SOURCE_INVALID", "Source must belong to the prepared user window");
  const source = findCommittedUserMessage(messages, p.sourceMessageId);
  if (source === undefined || !isExactUserQuote(source.text, p.sourceQuote as string)) return fail("MEMORY_SOURCE_INVALID", "Source quote must exactly match a unique committed user message");
  if (p.expiresAt !== undefined && p.expiresAt !== null && (typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= now.getTime())) return fail("MEMORY_BATCH_INVALID", "expiresAt must be a valid future timestamp or null");
  const draftSource = { kind: "conversation" as const, threadId, messageId: p.sourceMessageId, quote: p.sourceQuote as string };
  if (p.action === "add") {
    let scope: { kind: "workspace" } | { kind: "thread"; threadId: string } = { kind: "workspace" };
    if (p.scope !== undefined) {
      if (typeof p.scope !== "object" || p.scope === null || Array.isArray(p.scope)) return fail("MEMORY_BATCH_INVALID", "Invalid scope");
      const value = p.scope as Record<string, unknown>;
      if (Object.keys(value).length !== 1 || (value.kind !== "workspace" && value.kind !== "thread")) return fail("MEMORY_BATCH_INVALID", "Scope cannot name a Thread id");
      if (value.kind === "thread") scope = { kind: "thread", threadId };
    }
    return { ok: true, value: { change: { operation: "add", text: p.text as string, scope, expiresAt: p.expiresAt as string | null | undefined ?? null }, source: draftSource, reason: p.reason as string } };
  }
  const target = prepared.memories.find((entry) => entry.id === p.memoryId && entry.revision === p.expectedRevision);
  if (typeof p.memoryId !== "string" || !Number.isInteger(p.expectedRevision) || target === undefined || !target.enabled || target.status === "disabled" || (target.expiresAt != null && Date.parse(target.expiresAt) <= now.getTime())) return fail("MEMORY_BATCH_INVALID", "Update must target an active, unexpired revision provided by prepare");
  return { ok: true, value: { change: { operation: "update", memoryId: p.memoryId, expectedRevision: p.expectedRevision as number, text: p.text as string, expiresAt: p.expiresAt === undefined ? target.expiresAt ?? null : p.expiresAt as string | null }, source: draftSource, reason: p.reason as string } };
}

export function createMemoryConsolidation(options: {
  store: WorkspaceMemoryStore;
  getMessages: (signal?: AbortSignal) => Promise<UIMessage[]>;
  threadId: string;
  now?: () => Date;
  generateId?: () => string;
}): MemoryConsolidation {
  let batch: Batch | undefined;
  const now = options.now ?? (() => new Date());
  const readMessages = async (signal?: AbortSignal): Promise<MemoryResult<UIMessage[]>> => {
    try { const messages = await options.getMessages(signal); aborted(signal); return { ok: true, value: messages }; }
    catch (error) { aborted(signal); return fail("READ_FAILED", error instanceof Error ? error.message : "Unable to read transcript"); }
  };
  const canStart: MemoryConsolidation["canStart"] = async (signal) => options.store.checkCandidateCapacity(signal);
  return {
    begin(agentId) { batch = { agentId, prepareCount: 0, stageCount: 0, invalid: false }; },
    canStart,
    discard() { batch = undefined; },
    async prepare(input, signal) {
      aborted(signal);
      const run = batch;
      if (run === undefined) return fail("MEMORY_BATCH_INVALID", "No active consolidation lifecycle");
      run.prepareCount += 1;
      if (run.prepareCount !== 1) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Prepare must be called exactly once"); }
      const automatic = run.agentId === AUTO_CONSOLIDATION_AGENT_ID;
      if ((automatic && input.mode !== "incremental") || (!automatic && input.mode !== undefined) || (input.mode !== undefined && input.turns !== undefined) || (input.turns !== undefined && (!Number.isInteger(input.turns) || input.turns < 1 || input.turns > MAX_CONSOLIDATION_TURNS))) { run.invalid = true; return fail("INVALID_INPUT", "Invalid preparation mode or turns"); }
      const capacity = await canStart(signal);
      if (!capacity.ok) return capacity;
      if (!capacity.value.canStart) return fail("MEMORY_LIMIT_EXCEEDED", "Pending candidate queue is full; review candidates first");
      const loaded = await readMessages(signal);
      if (!loaded.ok) return loaded;
      const listed = await options.store.list(signal);
      if (!listed.ok) return listed;
      const all = ordinaryTurns(loaded.value);
      const cursor = automatic ? await options.store.getConsolidationCursor(options.threadId, signal) : { ok: true as const, value: null };
      if (!cursor.ok) return cursor;
      let after = -1;
      if (cursor.value !== null) {
        const hash = consolidationPrefixHash(loaded.value, cursor.value.throughMessageId);
        if (hash !== cursor.value.prefixHash) return fail("MEMORY_CURSOR_MISMATCH", "Transcript does not match the stored user-message boundary");
        after = all.findIndex((turn) => turn.user.id === cursor.value!.throughMessageId);
      }
      const eligible = all.slice(after + 1).filter((turn) => turn.user.text.trim().length > 0 && (!automatic || !hasMemoryTool(turn.messages)));
      let selected = automatic && cursor.value !== null ? eligible.slice(0, MAX_CONSOLIDATION_TURNS) : eligible.slice(-(input.turns ?? MAX_CONSOLIDATION_TURNS));
      const bootstrap = automatic && cursor.value === null;
      const batchId = (options.generateId ?? randomUUID)();
      const related = relatedMemories(listed.entries, selected, options.threadId);
      let memories = related.entries;
      let truncated = related.truncated || eligible.length > selected.length;
      const material = (): PreparedBatch => automatic
        ? { batchId, truncated, memories, bootstrap, turns: selected.map((turn) => ({ user: { messageId: turn.user.id, text: turn.user.text }, assistant: [], tools: [] })) }
        : { batchId, truncated, memories, turns: selected.map((turn) => ({ messages: [{ id: turn.user.id, role: "user", text: turn.user.text }] })) };
      while (Buffer.byteLength(JSON.stringify(material())) > CONSOLIDATION_MATERIAL_MAX_BYTES && memories.length > 0) { memories = memories.slice(0, -1); truncated = true; }
      while (Buffer.byteLength(JSON.stringify(material())) > CONSOLIDATION_MATERIAL_MAX_BYTES && selected.length > 1) { selected = selected.slice(0, -1); truncated = true; }
      if (Buffer.byteLength(JSON.stringify(material())) > CONSOLIDATION_MATERIAL_MAX_BYTES) return fail("MEMORY_BATCH_INVALID", "One user message exceeds the consolidation material budget; no text or cursor was truncated");
      if (batch !== run) return fail("MEMORY_BATCH_INVALID", "Consolidation lifecycle changed during preparation");
      aborted(signal);
      run.prepared = material(); run.selected = selected; run.expectedCursor = cursor.value;
      const last = selected.at(-1)?.user.id ?? all.at(-1)?.user.id;
      run.nextCursor = automatic && last !== undefined ? {
        threadId: options.threadId, throughMessageId: last,
        prefixHash: consolidationPrefixHash(loaded.value, last)!, lastBatchId: batchId, updatedAt: now().toISOString(),
      } : null;
      return { ok: true, value: structuredClone(run.prepared) };
    },
    async stage(input, signal) {
      aborted(signal);
      const run = batch;
      if (run === undefined) return fail("MEMORY_BATCH_INVALID", "No active consolidation lifecycle");
      run.stageCount += 1;
      if (run.stageCount !== 1 || run.invalid || run.prepared === undefined || run.selected === undefined || input.batchId !== run.prepared.batchId || !Array.isArray(input.proposals) || input.proposals.length > 5) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Stage must match one prepared batch and contain at most five proposals"); }
      const loaded = await readMessages(signal);
      if (!loaded.ok) { run.invalid = true; return loaded; }
      const drafts: CandidateDraft[] = [];
      for (const proposal of input.proposals) {
        const parsed = proposalDraft(proposal, run.prepared, run.selected, loaded.value, options.threadId, now());
        if (!parsed.ok) { run.invalid = true; return parsed; }
        if (drafts.some((draft) => candidateFingerprint(options.threadId, draft) === candidateFingerprint(options.threadId, parsed.value))) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Duplicate proposal in one batch"); }
        drafts.push(parsed.value);
      }
      if (batch !== run) return fail("MEMORY_BATCH_INVALID", "Consolidation lifecycle changed during staging");
      run.drafts = drafts;
      return { ok: true, value: { staged: true, batchId: input.batchId, count: drafts.length } };
    },
    async finalize(result, signal) {
      const run = batch;
      const empty = { ok: true as const, value: { candidateIds: [], replayed: false } };
      if (run === undefined) return empty;
      if (result.status !== "completed") { batch = undefined; return empty; }
      if (run.committed !== undefined) return run.committed.ok ? { ok: true, value: { ...run.committed.value, replayed: true } } : run.committed;
      const attempts = result.consolidationAttempts;
      if (run.prepareCount === 0 && run.stageCount === 0 && run.agentId !== AUTO_CONSOLIDATION_AGENT_ID && (attempts === undefined || (attempts.prepare === 0 && attempts.stage === 0))) return empty;
      aborted(signal);
      if (attempts !== undefined && (attempts.prepare !== 1 || attempts.stage !== 1)) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Exactly one prepare and stage attempt is required, including rejected tool inputs"); }
      if (run.invalid || run.prepareCount !== 1 || run.stageCount !== 1 || run.prepared === undefined || run.selected === undefined || run.drafts === undefined) return fail("MEMORY_BATCH_INVALID", "Completed consolidation requires exactly one successful prepare and stage");
      const loaded = await readMessages(signal);
      if (!loaded.ok) return loaded;
      for (const selected of run.selected) {
        const source = findCommittedUserMessage(loaded.value, selected.user.id);
        if (source === undefined || source.text !== selected.user.text) return fail("MEMORY_SOURCE_INVALID", "Prepared source changed before candidate commit");
      }
      if (run.nextCursor != null && consolidationPrefixHash(loaded.value, run.nextCursor.throughMessageId) !== run.nextCursor.prefixHash) return fail("MEMORY_CURSOR_MISMATCH", "Transcript prefix changed before candidate commit");
      const listed = await options.store.list(signal);
      if (!listed.ok) return listed;
      for (const draft of run.drafts) {
        if (draft.change.operation !== "update") continue;
        const change = draft.change;
        const target = listed.entries.find((entry) => entry.id === change.memoryId && visible(entry, options.threadId));
        if (target === undefined || target.revision !== change.expectedRevision || !target.enabled || target.status === "disabled" || (target.expiresAt != null && Date.parse(target.expiresAt) <= now().getTime())) return fail("MEMORY_REVISION_CONFLICT", "Prepared update target changed before commit");
      }
      if (batch !== run) return fail("MEMORY_BATCH_INVALID", "Consolidation lifecycle changed before commit");
      aborted(signal);
      const committed = await options.store.commitCandidateBatch({
        batchId: run.prepared.batchId, originThreadId: options.threadId, candidates: run.drafts,
        expectedCursor: run.expectedCursor ?? null, nextCursor: run.nextCursor ?? null,
      }, signal, { boundThreadId: options.threadId, now: now() });
      run.committed = committed;
      return committed;
    },
  };
}
