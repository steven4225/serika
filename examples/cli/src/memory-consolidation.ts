import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import {
  AUTO_CONSOLIDATION_AGENT_ID, MAX_CONSOLIDATION_TURNS,
  findCommittedUserMessage, hasMemoryTool, isAutoConsolidationRequest,
  isExactUserQuote, isMemoryConsolidationExcluded, userStartedTurns,
  type ConsolidationTurn, type IncrementalConsolidationTurn,
} from "./consolidation.js";
import { candidateFingerprint, type CandidateDraft, type ConsolidationCursor, type MemoryResult } from "./memory-candidates.js";
import type { MemoryConsolidationEntry, MemoryEntry, WorkspaceMemoryStore } from "./memory-store.js";
import { rankMemoryEntriesForQuery } from "./memory-retrieval.js";
import { validateRecallTerms, validateTemporalTimestamp, validateValidTime, type MemoryKind, type MemoryValidTime } from "./memory-temporal.js";

export const CONSOLIDATION_MATERIAL_MAX_BYTES = 64 * 1024;
export const CONSOLIDATION_MEMORIES_MAX_BYTES = 24 * 1024;
export const CONSOLIDATION_MEMORIES_MAX = 20;

export interface MemoryProposal {
  action: "add" | "update" | "change" | "correct" | "retract" | "disable";
  text?: string;
  sourceMessageId?: string;
  sourceQuote?: string;
  sources?: Array<{ sourceMessageId: string; sourceQuote: string }>;
  reason: string;
  scope?: { kind: "workspace" } | { kind: "thread" };
  expiresAt?: string | null;
  memoryId?: string;
  expectedRevision?: number;
  kind?: MemoryKind;
  recallTerms?: string[];
  validTime?: MemoryValidTime;
  effectiveAt?: string;
}
type ConsolidationMemory = MemoryEntry & Partial<Pick<MemoryConsolidationEntry, "relatedAssertions" | "historyCoverage">>;
export type PreparedBatch = {
  batchId: string; truncated: boolean; memories: ConsolidationMemory[];
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
function current(entry: ConsolidationMemory): ConsolidationMemory { const { history: _history, ...value } = entry; return value; }
function relatedMemories(entries: ConsolidationMemory[], turns: OrdinaryTurn[], threadId: string): { entries: ConsolidationMemory[]; truncated: boolean } {
  // Old assertions are conflict material only, never asserted as current primary context.
  const query = turns.map((turn) => turn.user.text).join("\n");
  const material = entries.filter((entry) => visible(entry, threadId)).map((entry) => {
    const value = current(entry);
    if (value.relatedAssertions === undefined) return value;
    const byAssertion = new Map(value.relatedAssertions.map((assertion) => [assertion.assertionId, assertion]));
    const relatedAssertions = rankMemoryEntriesForQuery(value.relatedAssertions.map((assertion) => ({ id: assertion.assertionId,
      text: [assertion.text, ...assertion.recallTerms].join("\n"), enabled: false,
    })), query).map((assertion) => byAssertion.get(assertion.id)!);
    return { ...value, relatedAssertions };
  });
  const byId = new Map(material.map((entry) => [entry.id, entry]));
  const ranked = rankMemoryEntriesForQuery(material.map((entry) => ({ ...entry,
    text: [entry.text, ...(entry.relatedAssertions ?? []).flatMap((assertion) => [assertion.text, ...assertion.recallTerms])].join("\n"),
  })), query).map((entry) => byId.get(entry.id)!);
  const selected: ConsolidationMemory[] = [];
  let trimmed = false;
  for (const entry of ranked) {
    if (selected.length >= CONSOLIDATION_MEMORIES_MAX) break;
    let candidate = entry;
    while (Buffer.byteLength(JSON.stringify([...selected, candidate])) > CONSOLIDATION_MEMORIES_MAX_BYTES && (candidate.relatedAssertions?.length ?? 0) > 0) {
      candidate = { ...candidate, relatedAssertions: candidate.relatedAssertions!.slice(0, -1) };
      trimmed = true;
    }
    if (candidate.relatedAssertions?.length === 0 && rankMemoryEntriesForQuery([candidate], query).length === 0) continue;
    if (Buffer.byteLength(JSON.stringify([...selected, candidate])) <= CONSOLIDATION_MEMORIES_MAX_BYTES) selected.push(candidate);
  }
  return { entries: selected, truncated: trimmed || selected.length < ranked.length };
}
function activeTarget(entry: MemoryEntry, now: Date): boolean {
  return (entry.status === "active" || entry.status === undefined && entry.enabled) &&
    (entry.expiresAt == null || Date.parse(entry.expiresAt) > now.getTime());
}
function proposalDraft(proposal: unknown, prepared: PreparedBatch, selected: OrdinaryTurn[], messages: UIMessage[], threadId: string, now: Date): MemoryResult<CandidateDraft> {
  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) return fail("MEMORY_BATCH_INVALID", "Proposal must be an object");
  const p = proposal as Record<string, unknown>;
  const withdrawal = p.action === "retract" || p.action === "disable";
  const common = ["action", "text", "sourceMessageId", "sourceQuote", "sources", "reason"];
  const fact = ["kind", "recallTerms", "expiresAt"];
  const allowed = p.action === "add" ? [...common, ...fact, "validTime", "scope"] :
    withdrawal ? [...common, "memoryId", "expectedRevision"] :
    [...common, ...fact, "memoryId", "expectedRevision", p.action === "change" ? "effectiveAt" : "validTime"];
  if (typeof p.action !== "string" || !["add", "update", "change", "correct", "retract", "disable"].includes(p.action) || Object.keys(p).some((key) => !allowed.includes(key))) return fail("MEMORY_BATCH_INVALID", "Unknown proposal action or field");
  for (const [field, limit] of [["text", 2048], ["reason", 512]] as const) {
    if (withdrawal && field === "text" && p.text === undefined) continue;
    if (typeof p[field] !== "string" || p[field].trim().length === 0 || Buffer.byteLength(p[field]) > limit) return fail("MEMORY_BATCH_INVALID", `${field} is empty or exceeds its byte limit`);
  }
  const rawSources = p.sources === undefined ? [{ sourceMessageId: p.sourceMessageId, sourceQuote: p.sourceQuote }] : p.sources;
  if (!Array.isArray(rawSources) || rawSources.length < 1 || rawSources.length > 4) return fail("MEMORY_SOURCE_INVALID", "A proposal requires one to four exact user sources");
  const sources: NonNullable<CandidateDraft["sources"]> = [];
  for (const raw of rawSources) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("MEMORY_SOURCE_INVALID", "Source must be an object");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["sourceMessageId", "sourceQuote"].includes(key)) || typeof item.sourceMessageId !== "string" || !selected.some((turn) => turn.user.id === item.sourceMessageId)) return fail("MEMORY_SOURCE_INVALID", "Source must belong to the prepared user window");
    if (typeof item.sourceQuote !== "string" || item.sourceQuote.trim().length === 0 || Buffer.byteLength(item.sourceQuote) > 2048) return fail("MEMORY_SOURCE_INVALID", "Source quote is empty or exceeds 2048 bytes");
    const source = findCommittedUserMessage(messages, item.sourceMessageId);
    if (source === undefined || !isExactUserQuote(source.text, item.sourceQuote)) return fail("MEMORY_SOURCE_INVALID", "Source quote must exactly match a unique committed non-excluded user message");
    if (sources.some((existing) => existing.messageId === item.sourceMessageId && existing.quote === item.sourceQuote)) return fail("MEMORY_SOURCE_INVALID", "Duplicate source quote");
    sources.push({ kind: "conversation", threadId, messageId: item.sourceMessageId, quote: item.sourceQuote });
  }
  const draftSource = sources[0]!;
  if (p.sources !== undefined && (p.sourceMessageId !== undefined || p.sourceQuote !== undefined) && (p.sourceMessageId !== draftSource.messageId || p.sourceQuote !== draftSource.quote)) return fail("MEMORY_SOURCE_INVALID", "Legacy source fields must agree with the first source");
  const provenance = { source: draftSource, ...(p.sources === undefined ? {} : { sources }), reason: p.reason as string };
  let facts: { kind?: MemoryKind; recallTerms?: string[]; validTime?: MemoryValidTime; effectiveAt?: string } = {};
  let expiry = p.expiresAt as string | null | undefined;
  try {
    if (p.kind !== undefined) {
      if (typeof p.kind !== "string" || !["preference", "fact", "event", "note"].includes(p.kind)) return fail("MEMORY_BATCH_INVALID", "Invalid memory kind");
      facts.kind = p.kind as MemoryKind;
    }
    if (p.recallTerms !== undefined) facts.recallTerms = validateRecallTerms(p.recallTerms);
    if (p.validTime !== undefined) {
      if (typeof p.validTime !== "object" || p.validTime === null || Array.isArray(p.validTime) || Object.keys(p.validTime).some((key) => !["from", "to", "basis"].includes(key))) return fail("MEMORY_BATCH_INVALID", "Invalid validTime fields");
      facts.validTime = validateValidTime(p.validTime);
      if (facts.validTime.basis === "unknown" && (facts.validTime.from !== null || facts.validTime.to !== null)) return fail("MEMORY_BATCH_INVALID", "Unknown proposal time cannot invent an interval");
    }
    if (p.action === "change") {
      facts.effectiveAt = validateTemporalTimestamp(p.effectiveAt, "Candidate change effectiveAt");
      if (facts.kind !== undefined && facts.kind !== "fact" && facts.kind !== "preference") return fail("MEMORY_BATCH_INVALID", "A change must remain a fact or preference");
    }
    if (expiry !== undefined && expiry !== null) {
      expiry = validateTemporalTimestamp(expiry, "Candidate expiresAt");
      if (Date.parse(expiry) <= now.getTime()) return fail("MEMORY_BATCH_INVALID", "expiresAt must be in the future");
    }
  } catch (error) { return fail("MEMORY_BATCH_INVALID", error instanceof Error ? error.message : "Invalid fact fields"); }
  if (p.action === "add") {
    let scope: { kind: "workspace" } | { kind: "thread"; threadId: string } = { kind: "workspace" };
    if (p.scope !== undefined) {
      if (typeof p.scope !== "object" || p.scope === null || Array.isArray(p.scope)) return fail("MEMORY_BATCH_INVALID", "Invalid scope");
      const value = p.scope as Record<string, unknown>;
      if (Object.keys(value).length !== 1 || (value.kind !== "workspace" && value.kind !== "thread")) return fail("MEMORY_BATCH_INVALID", "Scope cannot name a Thread id");
      if (value.kind === "thread") scope = { kind: "thread", threadId };
    }
    return { ok: true, value: { change: { operation: "add", text: p.text as string, scope, expiresAt: expiry ?? null, ...facts }, ...provenance } };
  }
  const target = prepared.memories.find((entry) => entry.id === p.memoryId && entry.revision === p.expectedRevision);
  if (typeof p.memoryId !== "string" || !Number.isInteger(p.expectedRevision) || (p.expectedRevision as number) < 1 || target === undefined || !withdrawal && !activeTarget(target, now)) return fail("MEMORY_BATCH_INVALID", "Target must be the provided revision; fact edits require an active, unexpired record");
  if (withdrawal) {
    const text = target.text || target.relatedAssertions?.at(-1)?.text;
    if (text === undefined || text.trim().length === 0) return fail("MEMORY_BATCH_INVALID", "Target has no display fact to withdraw");
    if (p.text !== undefined && p.text !== text) return fail("MEMORY_BATCH_INVALID", "Withdrawal may not replace target text");
    return { ok: true, value: { change: { operation: p.action as "retract" | "disable", memoryId: p.memoryId, expectedRevision: p.expectedRevision as number, text, expiresAt: target.expiresAt ?? null }, ...provenance } };
  }
  const targetFields = { memoryId: p.memoryId, expectedRevision: p.expectedRevision as number, text: p.text as string, expiresAt: expiry === undefined ? target.expiresAt ?? null : expiry };
  if (p.action === "change") return { ok: true, value: { change: { operation: "change", ...targetFields, ...facts, effectiveAt: facts.effectiveAt! }, ...provenance } };
  return { ok: true, value: { change: { operation: p.action as "update" | "correct", ...targetFields, ...facts }, ...provenance } };
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
  const readMaterial = async (observedAt: Date, signal?: AbortSignal): Promise<MemoryResult<ConsolidationMemory[]>> => {
    const readOptions = { boundThreadId: options.threadId, now: observedAt };
    if (options.store.listConsolidationMaterial !== undefined) return options.store.listConsolidationMaterial(signal, readOptions);
    const listed = await options.store.list(signal, readOptions);
    return listed.ok ? { ok: true, value: listed.entries } : listed;
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
      const observedAt = now();
      const listed = await readMaterial(observedAt, signal);
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
      const eligible = all.slice(after + 1).filter((turn) => turn.user.text.trim().length > 0 && !isMemoryConsolidationExcluded(turn.messages[0]!) && (!automatic || !hasMemoryTool(turn.messages)));
      let selected = automatic && cursor.value !== null ? eligible.slice(0, MAX_CONSOLIDATION_TURNS) : eligible.slice(-(input.turns ?? MAX_CONSOLIDATION_TURNS));
      const bootstrap = automatic && cursor.value === null;
      const batchId = (options.generateId ?? randomUUID)();
      const related = relatedMemories(listed.value, selected, options.threadId);
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
        prefixHash: consolidationPrefixHash(loaded.value, last)!, lastBatchId: batchId, updatedAt: observedAt.toISOString(),
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
      const observedAt = now();
      const listed = await readMaterial(observedAt, signal);
      if (!listed.ok) return listed;
      for (const draft of run.drafts) {
        if (draft.change.operation === "add") continue;
        const change = draft.change;
        const target = listed.value.find((entry) => entry.id === change.memoryId && visible(entry, options.threadId));
        const withdrawal = change.operation === "retract" || change.operation === "disable";
        if (target === undefined || target.revision !== change.expectedRevision || !withdrawal && !activeTarget(target, observedAt)) return fail("MEMORY_REVISION_CONFLICT", "Prepared target changed before commit");
      }
      if (batch !== run) return fail("MEMORY_BATCH_INVALID", "Consolidation lifecycle changed before commit");
      aborted(signal);
      const committed = await options.store.commitCandidateBatch({
        batchId: run.prepared.batchId, originThreadId: options.threadId, candidates: run.drafts,
        expectedCursor: run.expectedCursor ?? null, nextCursor: run.nextCursor ?? null,
      }, signal, { boundThreadId: options.threadId, now: observedAt });
      run.committed = committed;
      return committed;
    },
  };
}
