import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import {
  AUTO_CONSOLIDATION_AGENT_ID, MAX_CONSOLIDATION_TURNS,
  findCommittedUserMessage, hasMemoryTool, isAutoConsolidationRequest,
  isExactUserQuote, isMemoryConsolidationExcluded, userStartedTurns,
  type ConsolidationTurn, type IncrementalConsolidationTurn,
} from "./consolidation.js";
import { candidateFingerprint, type CandidateBatchResult, type CandidateDraft, type ConsolidationCursor, type ConsolidationOutcome, type MemoryResult } from "./memory-candidates.js";
import type { MemoryConsolidationEntry, MemoryEntry, WorkspaceMemoryStore } from "./memory-store.js";
import { rankMemoryEntriesForQuery } from "./memory-retrieval.js";
import { overlaps, validateRecallTerms, validateTemporalTimestamp, validateValidTime, type MemoryKind, type MemoryValidTime } from "./memory-temporal.js";
import { sameFact, sameFactSlot, validateFactIdentity, type MemoryFactIdentity } from "./memory-fact-identity.js";
import { hasOpposingSelfStatements, hasRelativeTime, isReminderInstruction, messageClock, statedScenario } from "./memory-observation-policy.js";

export const CONSOLIDATION_MATERIAL_MAX_BYTES = 64 * 1024;
export const CONSOLIDATION_MEMORIES_MAX_BYTES = 24 * 1024;
export const CONSOLIDATION_MEMORIES_MAX = 20;
export const CONSOLIDATION_EXTRACTION_MAX_BYTES = 32 * 1024;

/** Explicit history selection is bound by the controller, never chosen by the model. */
export type MemoryConsolidationRequest =
  | { mode: "incremental" }
  | { mode: "history"; messageIds: string[] };
export interface MemoryConsolidationSource {
  messageId: string;
  preview: string;
  truncated: boolean;
  excluded: boolean;
}
export interface MemoryConsolidationSourcePage {
  sources: MemoryConsolidationSource[];
  nextOffset: number | null;
}

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
  factIdentity?: MemoryFactIdentity;
  recallTerms?: string[];
  validTime?: MemoryValidTime;
  effectiveAt?: string;
  /** Model judgment, never a source of authorization or a semantic guarantee. */
  eligibility?: "durable_self_statement" | "explicit_request" | "needs_review" | "ignore";
}
type ConsolidationMemory = MemoryEntry & Partial<Pick<MemoryConsolidationEntry, "relatedAssertions" | "historyCoverage">>;
export type PreparedBatch = {
  batchId: string; truncated: boolean; memories: ConsolidationMemory[];
  selection?: { mode: "history"; messageIds: string[] };
} & (
  | { turns: ConsolidationTurn[] }
  | { bootstrap: boolean; turns: IncrementalConsolidationTurn[] }
);
export interface MemoryConsolidation {
  begin(agentId: string, request?: MemoryConsolidationRequest): void;
  canStart(signal?: AbortSignal): Promise<MemoryResult<{ canStart: boolean; pendingCount: number }>>;
  prepare(input: { mode?: "incremental"; turns?: number }, signal?: AbortSignal): Promise<MemoryResult<PreparedBatch>>;
  stage(input: { batchId: string; proposals: unknown[]; outcomes?: unknown }, signal?: AbortSignal): Promise<MemoryResult<{ staged: true; batchId: string; count: number }>>;
  finalize(result: { status: string; consolidationAttempts?: { prepare: number; stage: number } }, signal?: AbortSignal): Promise<MemoryResult<CandidateBatchResult & { processedCount?: number }>>;
  discard(): void;
}
interface OrdinaryTurn { user: { id: string; text: string }; messages: UIMessage[] }
interface Batch {
  agentId: string;
  request?: MemoryConsolidationRequest;
  prepareCount: number;
  stageCount: number;
  invalid: boolean;
  prepared?: PreparedBatch;
  selected?: OrdinaryTurn[];
  drafts?: CandidateDraft[];
  autoAcceptIndexes?: number[];
  outcomes?: ConsolidationOutcome[];
  processedCount?: number;
  sourcePrefix?: { throughMessageId: string; prefixHash: string } | null;
  expectedCursor?: ConsolidationCursor | null;
  nextCursor?: ConsolidationCursor | null;
  committed?: MemoryResult<CandidateBatchResult>;
}
/** Built-in workflow: one tool-free Run; the host prepares and stages, never the model. */
export async function prepareConsolidationExtraction(service: MemoryConsolidation, message: UIMessage, signal?: AbortSignal): Promise<UIMessage> {
  const prepared = await service.prepare({ mode: "incremental" }, signal);
  if (!prepared.ok) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
  return { ...message, parts: [{ type: "text", text: "Extract only from this host-prepared material. Return one JSON object with batchId, proposals (at most five), and outcomes (one per source, in order).\n" + JSON.stringify(prepared.value) }] };
}
export async function stageConsolidationExtraction(service: MemoryConsolidation, text: string, signal?: AbortSignal): Promise<MemoryResult<{ staged: true; batchId: string; count: number }>> {
  if (Buffer.byteLength(text) > CONSOLIDATION_EXTRACTION_MAX_BYTES) return fail("MEMORY_BATCH_INVALID", "Extraction exceeds the output budget");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail("MEMORY_BATCH_INVALID", "Extraction must be a complete JSON object, not prose or a code fence"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("MEMORY_BATCH_INVALID", "Invalid extraction object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["batchId", "proposals", "outcomes"].includes(key)) || typeof input.batchId !== "string" || !Array.isArray(input.proposals) || !Array.isArray(input.outcomes)) return fail("MEMORY_BATCH_INVALID", "Extraction requires batchId, proposals and explicit outcomes");
  return service.stage({ batchId: input.batchId, proposals: input.proposals, outcomes: input.outcomes }, signal);
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

export function validateConsolidationRequest(value: unknown): MemoryResult<MemoryConsolidationRequest> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("INVALID_INPUT", "Choose incremental or selected history consolidation");
  const input = value as Record<string, unknown>;
  if (input.mode === "incremental" && Object.keys(input).length === 1) return { ok: true, value: { mode: "incremental" } };
  if (input.mode !== "history" || Object.keys(input).some(key => !["mode", "messageIds"].includes(key)) || !Array.isArray(input.messageIds) ||
      input.messageIds.length < 1 || input.messageIds.length > MAX_CONSOLIDATION_TURNS ||
      input.messageIds.some(id => typeof id !== "string" || !id || id.length > 256) || new Set(input.messageIds).size !== input.messageIds.length) {
    return fail("INVALID_INPUT", "Select one to eight unique committed user messages from this Thread");
  }
  return { ok: true, value: { mode: "history", messageIds: [...input.messageIds] as string[] } };
}

/** Display material only. The exact original is reread and verified during preparation. */
export function consolidationSourcePage(messages: readonly UIMessage[], offset = 0): MemoryResult<MemoryConsolidationSourcePage> {
  if (!Number.isSafeInteger(offset) || offset < 0) return fail("INVALID_INPUT", "Invalid source offset");
  const turns = ordinaryTurns(messages).reverse();
  const selected = turns.slice(offset, offset + 20);
  return { ok: true, value: { sources: selected.map(turn => ({ messageId: turn.user.id,
    preview: Array.from(turn.user.text).slice(0, 400).join(""), truncated: Array.from(turn.user.text).length > 400,
    excluded: isMemoryConsolidationExcluded(turn.messages[0]!) || hasMemoryTool(turn.messages),
  })), nextOffset: offset + selected.length < turns.length ? offset + selected.length : null } };
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

/** Read-only queue observation using the same eligibility and cursor contract as automatic prepare. */
export function memoryConsolidationBacklog(messages: readonly UIMessage[], cursor: ConsolidationCursor | null): MemoryResult<number> {
  const all = ordinaryTurns(messages);
  let after = -1;
  if (cursor !== null) {
    if (consolidationPrefixHash(messages, cursor.throughMessageId) !== cursor.prefixHash) return fail("MEMORY_CURSOR_MISMATCH", "Transcript does not match the stored user-message boundary");
    after = all.findIndex(turn => turn.user.id === cursor.throughMessageId);
  }
  const eligible = all.slice(after + 1).filter(turn => turn.user.text.trim().length > 0 && !isMemoryConsolidationExcluded(turn.messages[0]!) && !hasMemoryTool(turn.messages));
  return { ok: true, value: cursor === null ? Math.min(eligible.length, MAX_CONSOLIDATION_TURNS) : eligible.length };
}
function visible(entry: MemoryEntry, threadId: string): boolean {
  return entry.scope?.kind !== "thread" || entry.scope.threadId === threadId;
}
function current(entry: ConsolidationMemory): ConsolidationMemory { const { history: _history, ...value } = entry; return value; }
function rankForTurns(entries: MemoryEntry[], turns: OrdinaryTurn[]): MemoryEntry[] {
  const selected = new Map<string, MemoryEntry>();
  // Each message gets its own bounded query. Joining the window first lets one
  // long earlier message consume the query budget and hide a later correction.
  // Recent material wins when the shared conflict-reference budget fills up.
  for (const turn of [...turns].reverse()) {
    for (const entry of rankMemoryEntriesForQuery(entries, turn.user.text)) {
      if (!selected.has(entry.id)) selected.set(entry.id, entry);
    }
  }
  return [...selected.values()];
}
function relatedMemories(entries: ConsolidationMemory[], turns: OrdinaryTurn[], threadId: string): { entries: ConsolidationMemory[]; truncated: boolean } {
  // Old assertions are conflict material only, never asserted as current primary context.
  const material = entries.filter((entry) => visible(entry, threadId)).map((entry) => {
    const value = current(entry);
    if (value.relatedAssertions === undefined) return value;
    const byAssertion = new Map(value.relatedAssertions.map((assertion) => [assertion.assertionId, assertion]));
    const relatedAssertions = rankForTurns(value.relatedAssertions.map((assertion) => ({ id: assertion.assertionId,
      text: [assertion.text, ...assertion.recallTerms].join("\n"), enabled: false,
    })), turns).map((assertion) => byAssertion.get(assertion.id)!);
    return { ...value, relatedAssertions };
  });
  const byId = new Map(material.map((entry) => [entry.id, entry]));
  const lexical = rankForTurns(material.map((entry) => ({ ...entry,
    text: [entry.text, ...(entry.assertion?.recallTerms ?? []), ...(entry.relatedAssertions ?? []).flatMap((assertion) => [assertion.text, ...assertion.recallTerms])].join("\n"),
  })), turns).map((entry) => byId.get(entry.id)!);
  // Small identity-bearing facts must be discoverable even when paraphrases share no lexical tokens.
  const ranked = [...new Map([...lexical, ...material.filter(entry => entry.assertion?.factIdentity)].map(entry => [entry.id, entry])).values()];
  const selected: ConsolidationMemory[] = [];
  let trimmed = false;
  for (const entry of ranked) {
    if (selected.length >= CONSOLIDATION_MEMORIES_MAX) break;
    let candidate = entry;
    while (Buffer.byteLength(JSON.stringify([...selected, candidate])) > CONSOLIDATION_MEMORIES_MAX_BYTES && (candidate.relatedAssertions?.length ?? 0) > 0) {
      candidate = { ...candidate, relatedAssertions: candidate.relatedAssertions!.slice(0, -1) };
      trimmed = true;
    }
    if (candidate.relatedAssertions?.length === 0 && !candidate.assertion?.factIdentity && rankForTurns([candidate], turns).length === 0) continue;
    if (Buffer.byteLength(JSON.stringify([...selected, candidate])) <= CONSOLIDATION_MEMORIES_MAX_BYTES) selected.push(candidate);
  }
  return { entries: selected, truncated: trimmed || selected.length < ranked.length };
}
function activeTarget(entry: MemoryEntry, now: Date): boolean {
  return (entry.status === "active" || entry.status === undefined && entry.enabled) &&
    (entry.expiresAt == null || Date.parse(entry.expiresAt) > now.getTime());
}
function containsKnownCredentials(text: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]\s*\S+)|(?:密码|密钥|令牌)\s*(?:[:：=]|是)\s*\S+/i.test(text);
}
function containsKnownOptOut(text: string): boolean {
  return /(?:不要|别|禁止)(?:记录|记住|记忆|保存到记忆|整理进记忆)|\b(?:do not|don't|never) (?:remember|memorize|store this in memory)\b/i.test(text);
}
/** Conservative recognized consent restrictions; not a general intent recognizer. */
function requiresKnownReview(text: string): boolean {
  return /(?:不要|不得|别)(?:保存|写入)|(?:未经|没有).{0,12}(?:确认|同意).{0,12}(?:不得|不要|不准)|(?:先|等).{0,10}(?:审核|确认).{0,10}(?:再|才).{0,8}(?:保存|写入)|\b(?:do not|don't) (?:save|write)|\bproposals? only\b/i.test(text);
}
function proposalDraft(proposal: unknown, prepared: PreparedBatch, selected: OrdinaryTurn[], messages: UIMessage[], threadId: string, now: Date): MemoryResult<CandidateDraft> {
  if (typeof proposal !== "object" || proposal === null || Array.isArray(proposal)) return fail("MEMORY_BATCH_INVALID", "Proposal must be an object");
  const p = proposal as Record<string, unknown>;
  const withdrawal = p.action === "retract" || p.action === "disable";
  const common = ["action", "text", "sourceMessageId", "sourceQuote", "sources", "reason", "eligibility"];
  const fact = ["kind", "recallTerms", "expiresAt", "factIdentity"];
  const allowed = p.action === "add" ? [...common, ...fact, "validTime", "scope"] :
    withdrawal ? [...common, "memoryId", "expectedRevision"] :
    [...common, ...fact, "memoryId", "expectedRevision", p.action === "change" ? "effectiveAt" : "validTime"];
  if (typeof p.action !== "string" || !["add", "update", "change", "correct", "retract", "disable"].includes(p.action) || Object.keys(p).some((key) => !allowed.includes(key))) return fail("MEMORY_BATCH_INVALID", "Unknown proposal action or field");
  if (p.eligibility !== undefined && (typeof p.eligibility !== "string" || !["durable_self_statement", "explicit_request", "needs_review", "ignore"].includes(p.eligibility))) return fail("MEMORY_BATCH_INVALID", "Invalid proposal eligibility");
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
  let facts: { kind?: MemoryKind; recallTerms?: string[]; validTime?: MemoryValidTime; effectiveAt?: string; factIdentity?: MemoryFactIdentity } = {};
  let expiry = p.expiresAt as string | null | undefined;
  try {
    if (p.factIdentity !== undefined) facts.factIdentity = validateFactIdentity(p.factIdentity);
    if (p.kind !== undefined) {
      if (typeof p.kind !== "string" || !["preference", "fact", "event", "note"].includes(p.kind)) return fail("MEMORY_BATCH_INVALID", "Invalid memory kind");
      facts.kind = p.kind as MemoryKind;
    }
    if (facts.factIdentity !== undefined && p.action === "add" && facts.kind !== "fact" && facts.kind !== "preference") return fail("MEMORY_BATCH_INVALID", "An identified add must be a fact or preference");
    if (p.recallTerms !== undefined) facts.recallTerms = validateRecallTerms(p.recallTerms);
    if (p.validTime !== undefined) {
      if (typeof p.validTime !== "object" || p.validTime === null || Array.isArray(p.validTime) || Object.keys(p.validTime).some((key) => !["from", "to", "basis"].includes(key))) return fail("MEMORY_BATCH_INVALID", "Invalid validTime fields");
      facts.validTime = validateValidTime(p.validTime);
      if (facts.validTime.basis === "unknown" && (facts.validTime.from !== null || facts.validTime.to !== null)) return fail("MEMORY_BATCH_INVALID", "Unknown proposal time cannot invent an interval");
    }
    if (p.action === "change") {
      if (p.effectiveAt !== undefined) facts.effectiveAt = validateTemporalTimestamp(p.effectiveAt, "Candidate change effectiveAt");
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
  if (p.action === "change") return { ok: true, value: { change: { operation: "change", ...targetFields, ...facts, effectiveAt: facts.effectiveAt ?? null }, ...provenance } };
  return { ok: true, value: { change: { operation: p.action as "update" | "correct", ...targetFields, ...facts }, ...provenance } };
}

export function createMemoryConsolidation(options: {
  store: WorkspaceMemoryStore;
  getMessages: (signal?: AbortSignal) => Promise<UIMessage[]>;
  threadId: string;
  now?: () => Date;
  generateId?: () => string;
  /** Trusted host configuration; never supplied by the model or transcript. */
  writePolicy?: "review" | "automatic";
  /** Registered host Skills only; text, transcript and model input cannot add IDs. */
  consolidationAgentIds?: readonly string[];
}): MemoryConsolidation {
  let batch: Batch | undefined;
  const now = options.now ?? (() => new Date());
  const consolidationAgents = new Set([AUTO_CONSOLIDATION_AGENT_ID, ...(options.consolidationAgentIds ?? [])]);
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
    begin(agentId, request) { batch = { agentId, ...(request === undefined ? {} : { request: structuredClone(request) }), prepareCount: 0, stageCount: 0, invalid: false }; },
    canStart,
    discard() { batch = undefined; },
    async prepare(input, signal) {
      aborted(signal);
      const run = batch;
      if (run === undefined) return fail("MEMORY_BATCH_INVALID", "No active consolidation lifecycle");
      run.prepareCount += 1;
      if (run.prepareCount !== 1) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Prepare must be called exactly once"); }
      const automatic = consolidationAgents.has(run.agentId);
      const history = run.request?.mode === "history" ? run.request : undefined;
      if (!history && ((automatic && input.mode !== "incremental") || (!automatic && input.mode !== undefined) || (input.mode !== undefined && input.turns !== undefined) || (input.turns !== undefined && (!Number.isInteger(input.turns) || input.turns < 1 || input.turns > MAX_CONSOLIDATION_TURNS)))) { run.invalid = true; return fail("INVALID_INPUT", "Invalid preparation mode or turns"); }
      const capacity = await canStart(signal);
      if (!capacity.ok) return capacity;
      if (!capacity.value.canStart) return fail("MEMORY_LIMIT_EXCEEDED", "Pending candidate queue is full; review candidates first");
      const loaded = await readMessages(signal);
      if (!loaded.ok) return loaded;
      const observedAt = now();
      const listed = await readMaterial(observedAt, signal);
      if (!listed.ok) return listed;
      const all = ordinaryTurns(loaded.value);
      const cursor = automatic && !history ? await options.store.getConsolidationCursor(options.threadId, signal) : { ok: true as const, value: null };
      if (!cursor.ok) return cursor;
      let after = -1;
      if (cursor.value !== null) {
        const hash = consolidationPrefixHash(loaded.value, cursor.value.throughMessageId);
        if (hash !== cursor.value.prefixHash) return fail("MEMORY_CURSOR_MISMATCH", "Transcript does not match the stored user-message boundary");
        after = all.findIndex((turn) => turn.user.id === cursor.value!.throughMessageId);
      }
      const eligible = all.slice(after + 1).filter((turn) => turn.user.text.trim().length > 0 && !isMemoryConsolidationExcluded(turn.messages[0]!) && (!automatic || !hasMemoryTool(turn.messages)));
      let selected = automatic && cursor.value !== null ? eligible.slice(0, MAX_CONSOLIDATION_TURNS) : eligible.slice(-(input.turns ?? MAX_CONSOLIDATION_TURNS));
      if (automatic && !history && options.store.getConsolidationReceipt) {
        const receipt = await options.store.getConsolidationReceipt(options.threadId, signal);
        if (!receipt.ok) return receipt;
        const deferred = receipt.value?.outcomes.find(outcome => outcome.status === "deferred")?.messageId;
        if (deferred) {
          const prefix = receipt.value!.sourcePrefix;
          if (!prefix || consolidationPrefixHash(loaded.value, prefix.throughMessageId) !== prefix.prefixHash) return fail("MEMORY_CURSOR_MISMATCH", "Transcript changed since the deferred coverage receipt");
          const index = eligible.findIndex(turn => turn.user.id === deferred);
          if (index < 0) return fail("MEMORY_SOURCE_INVALID", "Deferred source is no longer eligible; no cursor was advanced");
          if (cursor.value === null) selected = eligible.slice(index, index + MAX_CONSOLIDATION_TURNS);
        }
      }
      if (history) {
        const valid = validateConsolidationRequest(history);
        if (!valid.ok) return valid;
        selected = eligible.filter(turn => history.messageIds.includes(turn.user.id));
        if (selected.length !== history.messageIds.length) return fail("MEMORY_SOURCE_INVALID", "Selected history is missing, excluded, or belongs to a different Thread");
      }
      const bootstrap = automatic && cursor.value === null;
      const batchId = (options.generateId ?? randomUUID)();
      const related = relatedMemories(listed.value, selected, options.threadId);
      let memories = related.entries;
      let truncated = related.truncated || !history && eligible.length > selected.length;
      const material = (): PreparedBatch => automatic
        ? { batchId, truncated, memories, bootstrap, ...(history ? { selection: { mode: "history" as const, messageIds: [...history.messageIds] } } : {}), turns: selected.map((turn) => ({ user: { messageId: turn.user.id, text: turn.user.text, ...messageClock(turn.messages[0]!) }, assistant: [], tools: [] })) }
        : { batchId, truncated, memories, turns: selected.map((turn) => ({ messages: [{ id: turn.user.id, role: "user", text: turn.user.text, ...messageClock(turn.messages[0]!) }] })) };
      while (Buffer.byteLength(JSON.stringify(material())) > CONSOLIDATION_MATERIAL_MAX_BYTES && memories.length > 0) { memories = memories.slice(0, -1); truncated = true; }
      while (!history && Buffer.byteLength(JSON.stringify(material())) > CONSOLIDATION_MATERIAL_MAX_BYTES && selected.length > 1) { selected = selected.slice(0, -1); truncated = true; }
      if (Buffer.byteLength(JSON.stringify(material())) > CONSOLIDATION_MATERIAL_MAX_BYTES) return fail("MEMORY_BATCH_INVALID", "One user message exceeds the consolidation material budget; no text or cursor was truncated");
      if (batch !== run) return fail("MEMORY_BATCH_INVALID", "Consolidation lifecycle changed during preparation");
      aborted(signal);
      run.prepared = material(); run.selected = selected; run.expectedCursor = cursor.value;
      const throughMessageId = selected.at(-1)?.user.id;
      run.sourcePrefix = throughMessageId ? { throughMessageId, prefixHash: consolidationPrefixHash(loaded.value, throughMessageId)! } : null;
      run.nextCursor = null; // Reading material is not evidence that it was processed.
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
      const automatic = options.writePolicy === "automatic" && consolidationAgents.has(run.agentId) && run.request?.mode !== "history";
      const autoAcceptIndexes: number[] = [];
      const covered = new Set<string>();
      const contradictions = run.selected.filter(turn => hasOpposingSelfStatements(turn.user.text) &&
        !containsKnownCredentials(turn.user.text) && !containsKnownOptOut(turn.user.text));
      const reviewSources = new Set(contradictions.map(turn => turn.user.id));
      for (const proposal of input.proposals) {
        const parsed = proposalDraft(proposal, run.prepared, run.selected, loaded.value, options.threadId, now());
        if (!parsed.ok) { run.invalid = true; return parsed; }
        for (const source of parsed.value.sources ?? [parsed.value.source]) covered.add(source.messageId);
        // Preserve the whole contradictory group below, even if extraction omitted a side.
        if ((parsed.value.sources ?? [parsed.value.source]).some(source => reviewSources.has(source.messageId))) continue;
        let eligibility = (proposal as MemoryProposal).eligibility;
        // Missing time is reviewable uncertainty, not a guessed transition or a
        // reason to poison otherwise valid source-bound proposals in this batch.
        if (eligibility !== "ignore" && parsed.value.change.operation === "change" && parsed.value.change.effectiveAt === null) eligibility = "needs_review";
        // Conservative deny probes for recognizable credentials/explicit opt-out phrases.
        // This is not a universal natural-language privacy classifier. Metadata exclusion
        // remains the deterministic opt-out, enforced independently by source validation.
        const sourceText = (parsed.value.sources ?? [parsed.value.source]).map(source => run.selected!.find(turn => turn.user.id === source.messageId)!.user.text).join("\n");
        let change = parsed.value.change;
        const control = change.operation === "retract" || change.operation === "disable";
        if (eligibility === "ignore" || containsKnownCredentials(`${sourceText}\n${JSON.stringify(change)}`) || containsKnownOptOut(sourceText) && !(control && eligibility === "explicit_request")) continue;
        const quotes = (parsed.value.sources ?? [parsed.value.source]).map(source => source.quote).join("\n");
        const targetId = change.operation === "add" ? undefined : change.memoryId;
        const proposedKind = "kind" in change && change.kind !== undefined ? change.kind : run.prepared.memories.find(entry => entry.id === targetId)?.assertion?.kind;
        if ((proposedKind === "event" || proposedKind === "note") && isReminderInstruction(quotes)) continue;
        if (change.operation !== "retract" && change.operation !== "disable") {
          const scenario = statedScenario(sourceText);
          const bodyScenario = statedScenario(change.text);
          const identity = "factIdentity" in change ? change.factIdentity : undefined;
          const uncertainScene = scenario.limited && (!scenario.scenario || !bodyScenario.limited || bodyScenario.scenario !== scenario.scenario || !identity || identity.scenario !== scenario.scenario) ||
            bodyScenario.limited && (!bodyScenario.scenario || bodyScenario.scenario !== scenario.scenario) ||
            identity !== undefined && identity.scenario !== "general" && identity.scenario !== bodyScenario.scenario;
          if (uncertainScene) {
            eligibility = "needs_review";
            if ("factIdentity" in change && identity && scenario.scenario) change.factIdentity = { ...identity, scenario: scenario.scenario };
            else if ("factIdentity" in change) { const { factIdentity: _identity, ...rest } = change; change = rest; }
            parsed.value.reason = "这条偏好有使用场景限制，请确认适用范围后再保存。";
          }
          if (change.operation !== "add") {
            const targetId = change.memoryId;
            const target = run.prepared.memories.find(entry => entry.id === targetId)!;
            const oldQualifier = statedScenario(target.text);
            const oldScene = target.assertion?.factIdentity?.scenario ?? oldQualifier.scenario ?? (oldQualifier.limited ? undefined : "general");
            const newScene = ("factIdentity" in change ? change.factIdentity?.scenario : undefined) ?? scenario.scenario ?? (scenario.limited ? undefined : "general");
            if (oldScene !== newScene && (oldScene !== undefined || newScene !== undefined) || uncertainScene) {
              // A different/unknown scene is not a correction of the old scene.
              const { memoryId: _id, expectedRevision: _revision, operation: _operation, ...fact } = change;
              const { effectiveAt: _time, reuseSources: _reuse, ...fields } = fact as typeof fact & { effectiveAt?: unknown; reuseSources?: unknown };
              change = { ...fields, operation: "add", scope: target.scope ?? { kind: "workspace" } };
              eligibility = "needs_review";
            }
          }
          if (hasRelativeTime(quotes) && (parsed.value.sources ?? [parsed.value.source]).some(source =>
            messageClock(run.selected!.find(turn => turn.user.id === source.messageId)!.messages[0]!).sentAt === null)) {
            if ("validTime" in change && change.validTime?.basis === "explicit") {
              change = { ...change, validTime: { from: null, to: null, basis: "unknown" } }; eligibility = "needs_review";
            }
            if (change.operation === "change") { change = { ...change, effectiveAt: null }; eligibility = "needs_review"; }
          }
          parsed.value.change = change;
        }
        if (change.operation === "add" && change.factIdentity) {
          const proposed = change;
          const matches = run.prepared.memories.filter(entry => activeTarget(entry, now()) && entry.enabled &&
            JSON.stringify(entry.scope ?? { kind: "workspace" }) === JSON.stringify(proposed.scope) &&
            sameFactSlot(entry.assertion?.factIdentity, proposed.factIdentity) &&
            overlaps(entry.assertion!.validTime, proposed.validTime ?? { from: null, to: null }));
          if (matches.length === 1) {
            const target = matches[0]!;
            const identical = sameFact(target.assertion?.factIdentity, proposed.factIdentity) &&
              (proposed.validTime === undefined || JSON.stringify(proposed.validTime) === JSON.stringify(target.assertion!.validTime)) &&
              ((proposal as MemoryProposal).expiresAt === undefined || proposed.expiresAt === (target.expiresAt ?? null)) &&
              (proposed.kind === undefined || proposed.kind === target.assertion!.kind);
            // A synonymous observation retains the old wording/time and adds evidence.
            // A differing add has no proved correction/change intent: require review.
            change = { operation: "correct", memoryId: target.id, expectedRevision: target.revision!,
              text: identical ? target.text : proposed.text,
              expiresAt: (proposal as MemoryProposal).expiresAt === undefined ? target.expiresAt ?? null : proposed.expiresAt,
              factIdentity: proposed.factIdentity!, kind: proposed.kind ?? target.assertion!.kind,
              ...(identical ? { reuseSources: true, validTime: target.assertion!.validTime } : proposed.validTime === undefined ? {} : { validTime: proposed.validTime }) };
            parsed.value.change = change;
            if (!identical) eligibility = "needs_review";
          } else if (matches.length > 1) eligibility = "needs_review";
        }
        const repeated = drafts.find(draft => {
          const other = draft.change;
          return "factIdentity" in other && "factIdentity" in change && sameFact(other.factIdentity, change.factIdentity) &&
            (other.operation === "add" && change.operation === "add" && JSON.stringify([other.scope, other.expiresAt, other.kind, other.validTime]) === JSON.stringify([change.scope, change.expiresAt, change.kind, change.validTime]) ||
              "reuseSources" in other && other.reuseSources && "reuseSources" in change && change.reuseSources && other.operation !== "add" && change.operation !== "add" && other.memoryId === change.memoryId);
        });
        if (repeated) {
          // Consolidate evidence, never fact text. Keep the existing four-source bound.
          const sources = [...(repeated.sources ?? [repeated.source]), ...(parsed.value.sources ?? [parsed.value.source])]
            .filter((source, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(source)) === index);
          if (sources.length > 4) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Repeated fact exceeds four sources; defer remaining observations to a later batch"); }
          repeated.sources = sources; repeated.source = sources[0]!;
          // One ambiguous observation must not become automatic through an earlier observation.
          if (eligibility !== "durable_self_statement" && eligibility !== "explicit_request" || requiresKnownReview(sourceText)) {
            const index = drafts.indexOf(repeated); const automaticIndex = autoAcceptIndexes.indexOf(index);
            if (automaticIndex >= 0) autoAcceptIndexes.splice(automaticIndex, 1);
          }
          continue;
        }
        if (drafts.some((draft) => candidateFingerprint(options.threadId, draft) === candidateFingerprint(options.threadId, parsed.value))) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Duplicate proposal in one batch"); }
        const kind = "kind" in change && change.kind !== undefined ? change.kind : change.operation === "add" ? undefined : run.prepared.memories.find(entry => entry.id === change.memoryId)?.assertion?.kind;
        const supportedKind = control ? eligibility === "explicit_request" : kind === "preference" || kind === "fact" || eligibility === "explicit_request";
        if (automatic && supportedKind && !requiresKnownReview(sourceText) && (eligibility === "durable_self_statement" || eligibility === "explicit_request")) autoAcceptIndexes.push(drafts.length);
        drafts.push(parsed.value);
      }
      for (const turn of contradictions) {
        // Over-size or over-capacity groups stay deferred, never clipped or silently dropped.
        if (drafts.length >= 5 || Buffer.byteLength(turn.user.text) > 2048) continue;
        drafts.push({ change: { operation: "add", text: turn.user.text, kind: "note", scope: { kind: "workspace" }, expiresAt: null },
          source: { kind: "conversation", threadId: options.threadId, messageId: turn.user.id, quote: turn.user.text },
          reason: "这段原话包含相互矛盾的偏好，整组保留待你确认；尚未写入有效记忆。" });
        covered.add(turn.user.id);
      }
      // Compare the entire batch, including review-only observations. Neither
      // conflicting new value gets to win merely by ordering or eligibility.
      for (let index = autoAcceptIndexes.length - 1; index >= 0; index--) {
        const position = autoAcceptIndexes[index]!;
        const change = drafts[position]!.change;
        if (change.operation === "add" && drafts.some((draft, otherIndex) => {
          const other = draft.change;
          return otherIndex !== position && other.operation === "add" &&
            JSON.stringify(other.scope) === JSON.stringify(change.scope) && sameFactSlot(other.factIdentity, change.factIdentity) &&
            overlaps(other.validTime ?? { from: null, to: null }, change.validTime ?? { from: null, to: null });
        })) autoAcceptIndexes.splice(index, 1);
      }
      const outcomes: ConsolidationOutcome[] = [];
      if (input.outcomes !== undefined && (!Array.isArray(input.outcomes) || input.outcomes.length !== run.selected.length)) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Every prepared source requires exactly one ordered outcome"); }
      for (const [index, selected] of run.selected.entries()) {
        // Legacy stages may save proposals but cannot attest full source coverage.
        const raw = input.outcomes === undefined ? { messageId: selected.user.id, status: "deferred" } : (input.outcomes as unknown[])[index];
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Invalid source outcome"); }
        let outcome = raw as Record<string, unknown>;
        if (reviewSources.has(selected.user.id) && outcome.messageId === selected.user.id && ["extracted", "no_memory", "deferred"].includes(String(outcome.status))) {
          outcome = { ...outcome, status: drafts.some(draft => draft.source.messageId === selected.user.id) ? "extracted" : "deferred" };
        }
        if (Object.keys(outcome).some(key => !["messageId", "status"].includes(key)) || outcome.messageId !== selected.user.id || !["extracted", "no_memory", "deferred"].includes(String(outcome.status)) || outcome.status === "extracted" && !covered.has(selected.user.id) || outcome.status === "no_memory" && covered.has(selected.user.id)) { run.invalid = true; return fail("MEMORY_BATCH_INVALID", "Outcome must match the source and proposal coverage; deferred includes partially extracted sources"); }
        outcomes.push(outcome as unknown as ConsolidationOutcome);
      }
      const firstDeferred = outcomes.findIndex(outcome => outcome.status === "deferred");
      run.processedCount = firstDeferred < 0 ? outcomes.length : firstDeferred;
      run.outcomes = outcomes;
      const last = run.selected[run.processedCount - 1]?.user.id;
      if (consolidationAgents.has(run.agentId) && run.request?.mode !== "history" && last !== undefined) run.nextCursor = {
        threadId: options.threadId, throughMessageId: last, prefixHash: consolidationPrefixHash(loaded.value, last)!,
        lastBatchId: run.prepared.batchId, updatedAt: now().toISOString(),
      };
      if (batch !== run) return fail("MEMORY_BATCH_INVALID", "Consolidation lifecycle changed during staging");
      run.drafts = drafts;
      if (automatic) run.autoAcceptIndexes = autoAcceptIndexes;
      return { ok: true, value: { staged: true, batchId: input.batchId, count: drafts.length } };
    },
    async finalize(result, signal) {
      const run = batch;
      const empty = { ok: true as const, value: { candidateIds: [], replayed: false } };
      if (run === undefined) return empty;
      if (result.status !== "completed") { batch = undefined; return empty; }
      if (run.committed !== undefined) return run.committed.ok ? { ok: true, value: { ...run.committed.value, replayed: true } } : run.committed;
      const attempts = result.consolidationAttempts;
      if (run.prepareCount === 0 && run.stageCount === 0 && !consolidationAgents.has(run.agentId) && (attempts === undefined || (attempts.prepare === 0 && attempts.stage === 0))) return empty;
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
      if (run.sourcePrefix && consolidationPrefixHash(loaded.value, run.sourcePrefix.throughMessageId) !== run.sourcePrefix.prefixHash) return fail("MEMORY_CURSOR_MISMATCH", "Prepared transcript prefix changed before candidate commit");
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
        ...(run.autoAcceptIndexes === undefined ? {} : { autoAcceptIndexes: run.autoAcceptIndexes }),
        ...(run.outcomes === undefined ? {} : { outcomes: run.outcomes }),
        ...(consolidationAgents.has(run.agentId) && run.request?.mode !== "history" ? { incremental: true as const } : {}),
        sourcePrefix: run.sourcePrefix ?? null,
      }, signal, { boundThreadId: options.threadId, ...(options.now === undefined ? {} : { commitClock: options.now }) });
      run.committed = committed;
      return committed.ok ? { ok: true, value: { ...committed.value, processedCount: run.processedCount ?? 0 } } : committed;
    },
  };
}
