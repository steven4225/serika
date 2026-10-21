import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import {
  AgentError,
  type ContextCompactionStore,
  type MessageStore,
  type ThreadContextCompactionRecord,
  type TokenUsage,
} from "@serika/core";
import {
  compactPrefixHash,
  contextSummaryPrompt,
  CONTEXT_SUMMARY_STRATEGY_VERSION,
  parseContextSummary,
  contextSummaryFailurePaths,
  type ContextCompactionRecord,
  type ContextSummaryFile,
  type ContextSummaryItem,
  type ContextSummaryV2,
  type Summarizer,
} from "./context-compaction.js";
import {
  estimateContextBudget,
  estimateMessageTokens,
  estimateSerializedTokens,
  contextBudgetThresholds,
  partitionMessagesForCompaction,
  type ContextBudgetConfig,
  type ContextInputParts,
} from "./context-budget.js";
import { collectTranscriptToolFacts } from "./work-summary.js";
import type { ContextDiagnostics, ContextResult } from "./context-diagnostics.js";
import { CONTEXT_ESTIMATOR_VERSION } from "./context-budget.js";
import { isAutoConsolidationRequest, withoutConsolidationTurns } from "./consolidation.js";
import { expandMessageReferences } from "./context-assembler.js";
import { placeForegroundTaskReference } from "./foreground-autonomy.js";
import { blockLimits, maskOldestBlock, fitMessage, layerMessage, appendSummaryLayer, validLayers, summaryText } from "./context-blocks.js";
import { compactSummaryActions, createCompactionChecklist, type CompactionChecklistSources } from "./compaction-records.js";

const SUMMARY_TIMEOUT_MS = 30_000;
const FILE_TOOLS = new Set(["write_file", "edit_file"]);

export interface ContextCompactorOptions {
  store: MessageStore & ContextCompactionStore;
  threadId: string;
  modelId: string;
  summarizer: Summarizer;
  budget: ContextBudgetConfig;
  /** Actual runtime capacity bound. */
  modelContextWindowTokens?: number;
  project?: string;
  fixedContext: (messages: readonly UIMessage[], signal: AbortSignal) =>
    | Omit<ContextInputParts, "messages">
    | Promise<Omit<ContextInputParts, "messages">>;
  promptPrefix?: (signal: AbortSignal, messages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>;
  refreshReference?: (messages: UIMessage[], signal: AbortSignal) => Promise<UIMessage[]>;
  checklist?: () => CompactionChecklistSources | Promise<CompactionChecklistSources>;
  onMask?: (throughMessageId: string) => void;
  backgroundReference?: (signal: AbortSignal) => Promise<UIMessage>;
  now?: () => Date;
  generateId?: () => string;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Context compaction cancelled", "AbortError");
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function contextError(message: string): AgentError {
  return new AgentError({
    code: "CONTEXT_PREPARE_FAILED",
    message,
    retryable: false,
    phase: "runtime",
  });
}

function asOpaqueRecord(record: ContextCompactionRecord): ThreadContextCompactionRecord {
  return record as unknown as ThreadContextCompactionRecord;
}

function asContextRecord(record: ThreadContextCompactionRecord): ContextCompactionRecord | undefined {
  if (record.v !== 2 || record.type !== "thread.context.compacted") return undefined;
  return record as unknown as ContextCompactionRecord;
}

function validRecord(record: ContextCompactionRecord, messages: readonly UIMessage[]): boolean {
  const exclusions = messages.filter(message => (message.metadata as { transcriptExcluded?: boolean } | undefined)?.transcriptExcluded).map(message => message.id);
  if (JSON.stringify(record.excludedMessageIds ?? []) !== JSON.stringify(exclusions)) return false;
  const index = record.firstKeptMessageIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index > messages.length) return false;
  if (record.firstKeptMessageId !== null && record.firstKeptMessageId !== messages[index]?.id) {
    return false;
  }
  if (record.sourcePrefixHash !== compactPrefixHash(messages, index)) return false;
  if (record.checklist !== undefined && (typeof record.checklist !== "object" || record.checklist === null ||
      record.checklist.id !== "runloom-compaction-checklist" || record.checklist.role !== "assistant" ||
      !Array.isArray(record.checklist.parts) || record.checklist.parts.length !== 1 || record.checklist.parts[0]?.type !== "text")) return false;
  // Legacy summaries may have learned raw extraction JSON. Keep them on disk,
  // but do not reinstall/merge one that covered auxiliary turns without exclusion.
  if (record.consolidationExcluded !== true && messages.slice(0, index).some(isAutoConsolidationRequest)) return false;
  return (record.layers === undefined || validLayers(record.layers)) && parseContextSummary(JSON.stringify(record.summary)) !== undefined;
}

/** Uses precisely the same transcript-prefix validation as preparation. */
export async function readContextDiagnostics(
  store: MessageStore & ContextCompactionStore,
  threadId: string,
  budget: ContextBudgetConfig,
  lastPreparation: ContextDiagnostics["lastPreparation"] = null,
): Promise<ContextResult<ContextDiagnostics>> {
  try {
    const messages = await store.getMessages(threadId);
    const records = await store.getContextCompactions(threadId);
    const record = [...records].reverse().map(asContextRecord).find((candidate) =>
      candidate !== undefined && validRecord(candidate, messages));
    return { ok: true, value: {
      threadId,
      enabled: budget.enabled,
      budget: { ...budget },
      estimatorVersion: CONTEXT_ESTIMATOR_VERSION,
      latestValidCompaction: record === undefined ? null : {
        id: record.id,
        createdAt: record.createdAt,
        modelId: record.modelId,
        firstKeptMessageIndex: record.firstKeptMessageIndex,
        firstKeptMessageId: record.firstKeptMessageId,
        metrics: structuredClone(record.metrics),
      },
      lastPreparation: structuredClone(lastPreparation),
    } };
  } catch (error) {
    return { ok: false, error: diagnosticError(error) };
  }
}

function diagnosticError(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof AgentError ? error.data.code : "CONTEXT_DIAGNOSTICS_FAILED",
    message: error instanceof Error ? error.message : String(error),
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim().length > 0))];
}

function previousEvidenceIds(summary: ContextSummaryV2 | undefined): string[] {
  if (summary === undefined) return [];
  const items: ContextSummaryItem[] = [
    summary.goal,
    ...summary.constraints,
    ...summary.decisions,
    ...summary.actions,
    ...summary.pending,
    ...summary.files,
    ...(summary.nextStep === null ? [] : [summary.nextStep]),
  ];
  return uniqueIds(items.flatMap((item) => item.evidenceMessageIds));
}

function constrainItem(
  item: ContextSummaryItem,
  allowed: ReadonlySet<string>,
  fallbackId: string,
): ContextSummaryItem {
  const evidenceMessageIds = uniqueIds(item.evidenceMessageIds.filter((id) => allowed.has(id)));
  return {
    text: item.text,
    evidenceMessageIds: evidenceMessageIds.length > 0 ? evidenceMessageIds : [fallbackId],
  };
}

export function reconcilePublishedSummary(
  summary: ContextSummaryV2,
  coveredMessages: readonly UIMessage[],
  previous: ContextSummaryV2 | undefined,
): ContextSummaryV2 {
  const facts = collectTranscriptToolFacts(coveredMessages);
  const fallbackId = coveredMessages.find((message) => message.id.trim().length > 0)?.id
    ?? previous?.goal.evidenceMessageIds[0]
    ?? "covered";
  const allowed = new Set([
    ...coveredMessages.map((message) => message.id),
    ...previousEvidenceIds(previous),
  ]);
  const constrain = (item: ContextSummaryItem): ContextSummaryItem =>
    constrainItem(item, allowed, fallbackId);

  const factsById = new Map(facts.map((fact) => [fact.toolCallId, fact]));
  const fromFacts = facts.map((fact) => {
    return {
      text: fact.text,
      evidenceMessageIds: fact.evidenceMessageIds,
      status: fact.status,
      toolCallIds: [fact.toolCallId],
    };
  });
  const keptPreviousActions = (previous?.actions ?? []).filter(
    (action) => action.status !== "completed" && !action.toolCallIds.some((id) => factsById.has(id)),
  );
  // Unfinished plans are not tool successes, but must survive compaction.
  // A modeled completed/failed action without a receipt is not evidence.
  const unfinishedActions = summary.actions.filter((action) =>
    (action.status === "unknown" || action.status === "not_executed") &&
    action.toolCallIds.length === 0 &&
    !keptPreviousActions.some((previousAction) =>
      previousAction.text === action.text && previousAction.status === action.status),
  ).map((action) => ({ ...action, ...constrain(action) }));

  const fileFacts = facts.filter(
    (fact) =>
      fact.status === "completed" &&
      fact.path !== undefined &&
      FILE_TOOLS.has(fact.toolName),
  );
  const latestFileFacts = [...new Map(fileFacts.map(fact => [fact.path!, fact])).values()];
  const newFiles: ContextSummaryFile[] = latestFileFacts.map((fact) => {
    const modeled = summary.files.find((file) => file.path === fact.path);
    return {
      text: `Historical successful write receipt, not current disk state: ${fact.text}`,
      evidenceMessageIds: fact.evidenceMessageIds,
      path: fact.path!,
      purpose: modeled?.purpose ?? fact.toolName,
    };
  });
  const newPaths = new Set(newFiles.map((file) => file.path));
  const keptPreviousFiles = (previous?.files ?? []).filter((file) => !newPaths.has(file.path));

  return {
    version: 2,
    goal: constrain(summary.goal),
    constraints: summary.constraints.map(constrain),
    decisions: summary.decisions.map((decision) => ({ ...decision, ...constrain(decision) })),
    actions: compactSummaryActions([...keptPreviousActions, ...fromFacts, ...unfinishedActions]),
    pending: summary.pending.map(constrain),
    files: [...new Map([...keptPreviousFiles, ...newFiles].map(file => [file.path, file])).values()],
    nextStep: summary.nextStep === null ? null : constrain(summary.nextStep),
  };
}

export class ContextCompactor {
  readonly #options: ContextCompactorOptions;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  #latest: ContextCompactionRecord | undefined;
  #effectiveReferencePrefix: readonly UIMessage[] = [];
  #lastPreparation: ContextDiagnostics["lastPreparation"] = null;

  async getDiagnostics(): Promise<ContextResult<ContextDiagnostics>> {
    const result = await readContextDiagnostics(this.#options.store, this.#options.threadId, this.#options.budget, this.#lastPreparation);
    if (result.ok) result.value.background = { queued: this.pending, running: !!this.#task, error: this.#backgroundError ?? null,
      ...(this.#backgroundFailure ? { failure: structuredClone(this.#backgroundFailure) } : {}) };
    return result;
  }

  /** Material selection can fail before prepare is entered. It is not a reuse. */
  recordPreparationFailure(error: unknown): void {
    this.#lastPreparation = {
      at: this.#now().toISOString(), outcome: "failed", compactionId: null,
      estimatedInputTokens: null, error: diagnosticError(error),
    };
  }

  /** The exact references counted by the latest preparation, for final injection. */
  get effectiveReferencePrefix(): readonly UIMessage[] {
    return this.#effectiveReferencePrefix;
  }
  async referenceSnapshot(messages: UIMessage[]): Promise<UIMessage[] | undefined> {
    return (await this.#findLatestValid(messages))?.referencePrefix;
  }
  constructor(options: ContextCompactorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
  }

  #maskedThrough = 0;
  #pending: { messages: UIMessage[]; end: number; prefix: readonly UIMessage[]; sources?: CompactionChecklistSources } | undefined;
  #task: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #backgroundError: string | undefined;
  #backgroundFailure: { name: string; code: string; finishReason?: string; schemaPaths: string[] } | undefined;
  #installedId: string | undefined;
  #reportedScale = 1;
  #extraBlock = false;

  /** Foreground projection never dispatches or waits for a model. */
  async prepare(messages: UIMessage[], signal: AbortSignal, _force = false, referencePrefix?: readonly UIMessage[]): Promise<UIMessage[]> {
    abortIfNeeded(signal);
    const visible = withoutConsolidationTurns(messages);
    let prefix = referencePrefix ?? await this.#options.promptPrefix?.(signal, messages) ?? [];
    this.#effectiveReferencePrefix = prefix;
    if (!this.#options.budget.enabled) return visible;
    const fixed = await this.#options.fixedContext(messages, signal), limits = blockLimits(this.#options.budget);
    const record = await this.#findLatestValid(messages);
    if (record && this.#installedId !== record.id && this.#options.refreshReference) {
      prefix = await this.#options.refreshReference(messages, signal);
      this.#effectiveReferencePrefix = prefix; this.#installedId = record.id;
    }
    let boundary = Math.max(record?.firstKeptMessageIndex ?? 0, this.#maskedThrough);
    const sources = await this.#options.checklist?.();
    const requestLimit = Math.max(1, limits.section);
    const fixedTokens = estimateContextBudget({ ...fixed, messages: prefix }, this.#options.budget).inputTokens;
    const recalibratedInput = Math.floor(contextBudgetThresholds(this.#options.budget).availableInputTokens / this.#reportedScale);
    if (fixedTokens >= recalibratedInput) throw contextError("Fixed context exceeds the available input budget; no model request dispatched");
    const singleLimit = Math.max(1, recalibratedInput - fixedTokens);
    const foreground = messages.flatMap(message => ((message.metadata ?? {}) as { contextReferences?: UIMessage[] }).contextReferences ?? []).filter(message => message.id === "runloom-foreground-task").at(-1);
    const boundedForeground = foreground ? fitMessage(foreground, singleLimit) : undefined;
    const bounded = visible.map(message => fitMessage(message, Math.min(this.#options.budget.contextWindowTokens,
      message.role === "user" ? singleLimit : 16_000)));
    const checklistMessages = () => messages.map(message => message.role === "user" ? fitMessage({ ...message, metadata: undefined }, requestLimit) : message);
    let checklistTokens = 0;
    const compose = () => {
      const keptIds = new Set(messages.slice(boundary).map(message => message.id));
      const required = boundary ? createCompactionChecklist({ ...sources, permissions: sources?.permissions, messages: checklistMessages(), maxTokens: limits.section, requestReferenceOnly: !!boundedForeground || boundary <= messages.reduce((last, message, index) => message.role === "user" ? index : last, -1) }) : undefined;
      checklistTokens = required ? estimateMessageTokens([required]) : 0;
      const missing = boundary > (record?.firstKeptMessageIndex ?? 0) ? [{ id: "runloom-masked-history", role: "assistant" as const,
        parts: [{ type: "text" as const, text: `Original messages ${messages[record?.firstKeptMessageIndex ?? 0]?.id ?? ""}–${messages[boundary - 1]?.id ?? ""} are masked pending background summary/extraction; use history_search/history_read.` }] }] : [];
      return placeForegroundTaskReference([...(record ? [layerMessage(record)] : []), ...(required ? [required] : []), ...missing, ...bounded.filter(message => keptIds.has(message.id)), ...(boundedForeground ? [boundedForeground] : [])]);
    };
    const estimate = (view: UIMessage[]) => {
      const measured = estimateContextBudget({ ...fixed, messages: [...prefix, ...expandMessageReferences(view)] }, this.#options.budget);
      measured.inputTokens = Math.ceil(measured.inputTokens * this.#reportedScale);
      measured.exceeds = measured.inputTokens > measured.availableInputTokens;
      return measured;
    };
    if (this.#extraBlock) {
      const next = maskOldestBlock(messages, boundary, limits.block);
      this.#extraBlock = false;
      if (next > boundary) boundary = next;
    }
    let view = compose(), measured = estimate(view);
    const recentTokens = () => estimateMessageTokens(bounded.filter(message => messages.slice(boundary).some(item => item.id === message.id)));
    // The host ledger borrows from recent originals before any foreground call.
    let checklistOverflow = checklistTokens > limits.section;
    while (measured.exceeds || recentTokens() > limits.recent + limits.block || checklistOverflow) {
      const next = maskOldestBlock(messages, boundary, limits.block);
      if (next <= boundary) break;
      boundary = next; view = compose(); measured = estimate(view); checklistOverflow = false;
    }
    if (measured.exceeds) {
      const current = bounded.reduce((last, message, index) => message.role === "user" ? index : last, -1);
      if (current >= 0) {
        const { contextReferences: _refs, contextSnapshot: _snapshot, ...metadata } = (bounded[current]!.metadata ?? {}) as Record<string, unknown>;
        const target = estimateMessageTokens([{ ...bounded[current]!, metadata }]) - Math.ceil((measured.inputTokens - measured.availableInputTokens) / this.#reportedScale);
        bounded[current] = fitMessage(bounded[current]!, target);
        view = compose(); measured = estimate(view);
      }
    }
    if (record && estimateMessageTokens([layerMessage(record)]) > limits.totalSummary) throw contextError("Historical summary exceeds proportional total budget; original journal retained");
    if (measured.exceeds) throw contextError(`Prepared context exceeds budget (${measured.inputTokens} > ${measured.availableInputTokens}); required metadata retained`);
    this.#maskedThrough = boundary;
    if (boundary > (record?.firstKeptMessageIndex ?? 0)) this.#options.onMask?.(messages[boundary - 1]!.id);
    const covered = record?.firstKeptMessageIndex ?? 0;
    const nextBlock = maskOldestBlock(messages, covered, limits.block);
    if (nextBlock > covered && (boundary > covered || recentTokens() >= limits.recent)) {
      this.#pending = { messages: structuredClone(messages), end: nextBlock, prefix: structuredClone(prefix), ...(sources ? { sources: structuredClone(sources) } : {}) };
    }
    this.#lastPreparation = { at: this.#now().toISOString(), outcome: record ? "reused" : "passthrough", compactionId: record?.id ?? null,
      estimatedInputTokens: measured.inputTokens, error: null,
      ...(checklistTokens > limits.section ? { degradation: { reason: "checklist_overflow" as const, checklistTokens, sectionBudget: limits.section,
        maskedThroughMessageId: messages[boundary - 1]?.id ?? null } } : {}) };
    return view;
  }

  reportedOverflow(inputTokens: number): void {
    const estimated = this.#lastPreparation?.estimatedInputTokens;
    if (estimated) this.#reportedScale *= Math.max(1, inputTokens / estimated);
    this.#extraBlock = true;
  }
  get pending(): boolean { return this.#pending !== undefined; }
  get backgroundError(): string | undefined { return this.#backgroundError; }
  get backgroundFailure() { return this.#backgroundFailure ? structuredClone(this.#backgroundFailure) : undefined; }
  async runPending(signal: AbortSignal): Promise<void> {
    const job = this.#pending;
    if (!job || this.#task) return;
    this.#pending = undefined;
    const abort = new AbortController(); this.#abort = abort;
    const linked = AbortSignal.any([signal, abort.signal]);
    this.#task = this.#summarize(job, linked).then(() => {
      this.#backgroundError = undefined;
      this.#backgroundFailure = undefined;
      const covered = this.#latest?.firstKeptMessageIndex ?? 0;
      if (covered < this.#maskedThrough) {
        const next = maskOldestBlock(job.messages, covered, blockLimits(this.#options.budget).block);
        if (next > covered) this.#pending = { ...job, end: next };
      }
    }, error => {
      if (!linked.aborted) {
        this.#backgroundError = error instanceof Error ? error.message : String(error);
        const detail = error instanceof Error ? error.cause as { finishReason?: string; schemaPaths?: string[] } | undefined : undefined;
        this.#backgroundFailure = { name: error instanceof Error ? error.name : "Error", code: error instanceof AgentError ? error.data.code : "CONTEXT_SUMMARY_FAILED",
          ...(detail?.finishReason ? { finishReason: detail.finishReason } : {}), schemaPaths: detail?.schemaPaths ?? [] };
      }
    }).finally(() => { this.#task = undefined; this.#abort = undefined; });
    await this.#task;
  }
  async pause(): Promise<void> { this.#abort?.abort(new DOMException("Foreground has priority", "AbortError")); await this.#task; }
  invalidate(): void { this.#latest = undefined; this.#maskedThrough = 0; this.#pending = undefined; this.#installedId = undefined; }
  async close(): Promise<void> { this.#pending = undefined; await this.pause(); }

  async #summarize(job: NonNullable<{ messages: UIMessage[]; end: number; prefix: readonly UIMessage[]; sources?: CompactionChecklistSources }>, signal: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    const { messages, end, prefix, sources } = job;
    const persisted = await this.#findLatestValid(messages);
    const start = persisted?.firstKeptMessageIndex ?? 0;
    if (end <= start) return;
    const limits = blockLimits(this.#options.budget);
    const original = withoutConsolidationTurns(messages.slice(start, end));
    if (!original.length) return;
    const archive = persisted?.layers?.recent.length === 4 ? { index: persisted.layers.index, oldest: persisted.layers.recent[0] } : undefined;
    const reference = await this.#options.backgroundReference?.(signal);
    const referenceText = reference?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
    const task = `\nCurrent fixed reference: ${referenceText}\nKeep continuation text (excluding JSON framing and evidence IDs) within ${limits.section} estimated tokens. Preserve explicit constraints, decisions and unfinished work; use short clauses. Host checklist separately retains all unknown/failed effects.` +
      (archive ? `\nAlso return a farIndex string in the SAME JSON object: consolidate this previous index and oldest summary into a short searchable topic index, preserving confirmed goals, constraints, decisions, unfinished work, dates and message ranges. Do not repeat background filler. Index budget ${limits.section} tokens. Index material: ${JSON.stringify(archive)}` : "");
    const promptFor = (block: UIMessage[]) => contextSummaryPrompt({ messages: block, location: { threadId: this.#options.threadId, project: this.#options.project ?? "current-workspace" } }) + task;
    const inputLimit = Math.min(contextBudgetThresholds(this.#options.budget).availableInputTokens,
      this.#options.budget.contextWindowTokens - this.#options.budget.summaryMaxOutputTokens - this.#options.budget.safetyMarginTokens);
    let block = original;
    if (estimateSerializedTokens(promptFor(block)) > inputLimit) {
      let low = 1, high = inputLimit, best: UIMessage[] | undefined;
      while (low <= high) {
        const allowance = Math.floor((low + high) / 2);
        let candidate: UIMessage[];
        try { candidate = original.map(message => fitMessage(message, allowance)); }
        catch { low = allowance + 1; continue; }
        if (estimateSerializedTokens(promptFor(candidate)) <= inputLimit) { best = candidate; low = allowance + 1; }
        else high = allowance - 1;
      }
      if (!best) throw contextError("Summary metadata exceeds its input budget; original block retained");
      block = best;
    }
    const prompt = promptFor(block);
    if (estimateSerializedTokens(prompt) > inputLimit) throw contextError("Summary request exceeds its input budget; original block retained");
    const started = Date.now();
    const result = await this.#completeOne(prompt, this.#options.budget.summaryMaxOutputTokens, signal);
    abortIfNeeded(signal);
    if (result.finishReason === "length") throw contextError("Summary output was truncated; original block retained");
    const parsed = parseContextSummary(result.text, original.map(message => message.id));
    if (!parsed) throw new AgentError({ code: "CONTEXT_PREPARE_FAILED", message: "Summary output is invalid; original block retained", retryable: false, phase: "runtime" },
      { cause: { finishReason: result.finishReason, schemaPaths: contextSummaryFailurePaths(result.text) } });
    const json = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(result.text)?.[1] ?? result.text;
    const raw = JSON.parse(json.slice(json.indexOf("{"), json.lastIndexOf("}") + 1)) as { farIndex?: unknown };
    const summary = reconcilePublishedSummary(parsed, original, persisted ? { ...persisted.summary, files: [] } : undefined);
    const layers = appendSummaryLayer({ ...(persisted ? { previous: persisted } : {}), messages, start, end, summary,
      ...(typeof raw.farIndex === "string" ? { farIndex: raw.farIndex } : {}) });
    if (estimateSerializedTokens(summaryText(summary)) > limits.section || estimateSerializedTokens(layers.index) > limits.section) {
      throw contextError("Summary segment or far index exceeds its proportional budget; original block retained");
    }
    const checklist = createCompactionChecklist({ ...sources, permissions: sources?.permissions, messages: withoutConsolidationTurns(messages.slice(0, end)), maxTokens: limits.section, requestReferenceOnly: true });
    const fresh = await this.#options.store.getMessages(this.#options.threadId);
    if (compactPrefixHash(fresh, end) !== compactPrefixHash(messages, end) ||
        JSON.stringify(this.#exclusions(fresh)) !== JSON.stringify(this.#exclusions(messages))) throw contextError("Summary sources changed; result discarded");
    abortIfNeeded(signal);
    const record: ContextCompactionRecord = {
      v: 2, type: "thread.context.compacted", threadId: this.#options.threadId, id: this.#generateId(),
      previousCompactionId: persisted?.id ?? null, firstKeptMessageIndex: end, firstKeptMessageId: messages[end]?.id ?? null,
      sourcePrefixHash: compactPrefixHash(messages, end), consolidationExcluded: true,
      excludedMessageIds: this.#exclusions(messages), referencePrefix: [...prefix], checklist, summary, layers,
      strategyVersion: CONTEXT_SUMMARY_STRATEGY_VERSION, modelId: this.#options.modelId, createdAt: this.#now().toISOString(),
      metrics: { estimatedInputBefore: estimateMessageTokens(messages), estimatedInputAfter: estimateMessageTokens([layerMessage({ layers, summary } as ContextCompactionRecord), checklist, ...messages.slice(end)]),
        durationMs: Date.now() - started, attempts: 1, ...(result.usage ? { usage: result.usage } : {}) },
    };
    await this.#options.store.appendContextCompaction(asOpaqueRecord(record));
    this.#latest = record;
  }

  #exclusions(messages: readonly UIMessage[]): string[] {
    return messages.filter(message => (message.metadata as { transcriptExcluded?: boolean } | undefined)?.transcriptExcluded).map(message => message.id);
  }

  async #findLatestValid(messages: readonly UIMessage[]): Promise<ContextCompactionRecord | undefined> {
    if (this.#latest !== undefined && validRecord(this.#latest, messages)) return this.#latest;
    const records = await this.#options.store.getContextCompactions(this.#options.threadId);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = asContextRecord(records[index]!);
      if (record !== undefined && validRecord(record, messages)) {
        this.#latest = record;
        return record;
      }
    }
    return undefined;
  }

  async #completeOne(
    prompt: string,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<{ text: string; usage?: TokenUsage; finishReason?: string }> {
    abortIfNeeded(signal);
    const window = this.#options.modelContextWindowTokens;
    if (window !== undefined && estimateSerializedTokens(prompt) + maxOutputTokens + this.#options.budget.safetyMarginTokens > window) {
      throw contextError("上下文摘要输入超过当前模型窗口，尚未发送摘要请求；请核对模型容量和摘要预算。");
    }
    const controller = new AbortController();
    let rejectCancelled!: (error: Error) => void;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    const onAbort = (): void => {
      const error = abortError(signal);
      controller.abort(error);
      rejectCancelled(error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      const timeoutMs = SUMMARY_TIMEOUT_MS;
      timer = setTimeout(() => {
        const error = new AgentError({
          code: "MODEL_TIMEOUT",
          message: `Context summary exceeded the ${timeoutMs / 1000} second budget`,
          retryable: true,
          phase: "model",
        });
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.#options.summarizer.complete({
          prompt,
          maxOutputTokens,
          signal: controller.signal,
        }),
        timeout,
        cancelled,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
