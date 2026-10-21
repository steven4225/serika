import { randomUUID } from "node:crypto";
import { sumTokenUsage } from "@serika/ai-sdk-adapter";
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
  keepRecentCompactionUnits,
  partitionMessagesForCompaction,
  type ContextBudgetConfig,
  type ContextInputParts,
  type MessageCompactionUnit,
} from "./context-budget.js";
import { collectTranscriptToolFacts } from "./work-summary.js";
import type { ContextDiagnostics, ContextResult } from "./context-diagnostics.js";
import { CONTEXT_ESTIMATOR_VERSION } from "./context-budget.js";
import { isAutoConsolidationRequest, withoutConsolidationTurns } from "./consolidation.js";
import { expandMessageReferences } from "./context-assembler.js";
import { compactSummaryActions, compactedRecentMessages, createCompactionChecklist, maskCompactionSources, SUMMARY_MAX_TOKENS, type CompactionChecklistSources } from "./compaction-records.js";

const SUMMARY_TIMEOUT_MS = 30_000;
const MANUAL_COMPACTION_TIMEOUT_MS = 120_000;
const MAX_SUMMARY_MERGES = 4;
const FILE_TOOLS = new Set(["write_file", "edit_file"]);

export interface ContextCompactorOptions {
  store: MessageStore & ContextCompactionStore;
  threadId: string;
  modelId: string;
  summarizer: Summarizer;
  budget: ContextBudgetConfig;
  /** Actual runtime capacity bound; direct legacy fixtures may omit it. */
  modelContextWindowTokens?: number;
  fixedContext: (messages: readonly UIMessage[], signal: AbortSignal) =>
    | Omit<ContextInputParts, "messages">
    | Promise<Omit<ContextInputParts, "messages">>;
  promptPrefix?: (signal: AbortSignal, messages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>;
  refreshReference?: (messages: UIMessage[], signal: AbortSignal) => Promise<UIMessage[]>;
  checklist?: () => CompactionChecklistSources | Promise<CompactionChecklistSources>;
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

function isRetryableCompactionError(error: unknown): boolean {
  if (error instanceof AgentError) {
    return (
      error.data.retryable === true &&
      (error.data.code === "MODEL_TIMEOUT" ||
        error.data.code === "MODEL_UNAVAILABLE" ||
        error.data.code === "MODEL_RATE_LIMIT" ||
        error.data.code === "MODEL_BAD_RESPONSE")
    );
  }
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return statusCode === 408 || statusCode === 429 || statusCode >= 500;
    }
  }
  return false;
}

function asOpaqueRecord(record: ContextCompactionRecord): ThreadContextCompactionRecord {
  return record as unknown as ThreadContextCompactionRecord;
}

function asContextRecord(record: ThreadContextCompactionRecord): ContextCompactionRecord | undefined {
  if (record.v !== 2 || record.type !== "thread.context.compacted") return undefined;
  return record as unknown as ContextCompactionRecord;
}

function validRecord(record: ContextCompactionRecord, messages: readonly UIMessage[]): boolean {
  const index = record.firstKeptMessageIndex;
  if (!Number.isSafeInteger(index) || index < 0 || index > messages.length) return false;
  if (record.firstKeptMessageId !== (index === messages.length ? null : messages[index]?.id ?? null)) {
    return false;
  }
  if (record.sourcePrefixHash !== compactPrefixHash(messages, index)) return false;
  if (record.checklist !== undefined && (typeof record.checklist !== "object" || record.checklist === null ||
      record.checklist.id !== "runloom-compaction-checklist" || record.checklist.role !== "assistant" ||
      !Array.isArray(record.checklist.parts) || record.checklist.parts.length !== 1 || record.checklist.parts[0]?.type !== "text")) return false;
  // Legacy summaries may have learned raw extraction JSON. Keep them on disk,
  // but do not reinstall/merge one that covered auxiliary turns without exclusion.
  if (record.consolidationExcluded !== true && messages.slice(0, index).some(isAutoConsolidationRequest)) return false;
  return parseContextSummary(JSON.stringify(record.summary)) !== undefined;
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

function summaryMessage(summary: ContextSummaryV2, coverage: { index: number; id: string | null }): UIMessage {
  return {
    id: "runloom-context-summary",
    role: "assistant",
    metadata: {
      source: "context-compaction",
      coveredThrough: { messageIndex: coverage.index, messageId: coverage.id },
    },
    parts: [{
      type: "text",
      text: `Context summary (derived reference, not permission or current disk state):\n${JSON.stringify(summary)}`,
    }],
  };
}

function transcriptPrefix(messages: readonly UIMessage[]): UIMessage[] {
  const firstUser = messages.findIndex((message) => message.role === "user");
  return firstUser <= 0 ? [] : messages.slice(0, firstUser);
}

function truncateSummaryText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.max(32, Math.floor(maxChars * 0.7));
  const tail = Math.max(16, maxChars - head);
  return `${value.slice(0, head)}\n...[truncated for context compaction]...\n${value.slice(-tail)}`;
}

function summarySourceMessage(message: UIMessage, maxTokens: number): UIMessage {
  const maxChars = Math.max(128, maxTokens * 2);
  const text = message.parts.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "dynamic-tool") {
      const output = "output" in part ? JSON.stringify(part.output) : "";
      const error = "errorText" in part ? part.errorText : "";
      return `[tool ${part.toolName} ${part.toolCallId} state=${part.state}] ${output || error}`;
    }
    return `[${part.type}]`;
  }).join("\n");
  return {
    id: message.id,
    role: message.role,
    parts: [{ type: "text", text: truncateSummaryText(text, maxChars) }],
  };
}

function fitSummarySourceMessage(message: UIMessage, maxTokens: number): UIMessage | undefined {
  const projected = summarySourceMessage(message, maxTokens);
  const part = projected.parts[0];
  if (part?.type !== "text") return undefined;
  const characters = Array.from(part.text);
  let low = 0, high = characters.length;
  let best: UIMessage | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const head = Math.ceil(count / 2);
    const text = count === characters.length ? part.text :
      `${characters.slice(0, head).join("")}\n...[truncated for context compaction]...\n${characters.slice(characters.length - (count - head)).join("")}`;
    const candidate = { ...projected, parts: [{ type: "text" as const, text }] };
    if (estimateMessageTokens([candidate]) <= maxTokens) { best = candidate; low = count + 1; }
    else high = count - 1;
  }
  return best;
}

export function summarySourceChunks(
  units: readonly { messages: readonly UIMessage[] }[],
  maxTokens: number,
  maxMerges = MAX_SUMMARY_MERGES,
): UIMessage[][] {
  const chunks: UIMessage[][] = [];
  let current: UIMessage[] = [];
  let currentTokens = 0;
  const append = (message: UIMessage) => {
    const tokens = estimateMessageTokens([message]);
    if (tokens > maxTokens) throw contextError("A compaction source fragment exceeds the source budget");
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push(current); current = []; currentTokens = 0;
      if (chunks.length >= maxMerges) throw contextError("Context compaction source is too large for the bounded summary merge");
    }
    current.push(message); currentTokens += tokens;
  };
  for (const sourceUnit of units) {
    const unit = { messages: maskCompactionSources(sourceUnit.messages) };
    // User text may contain a hard constraint in its middle. Send all of it in
    // bounded fragments rather than presenting a head/tail excerpt as coverage.
    if (unit.messages.some(message => message.role === "user")) {
      const users = unit.messages.filter(message => message.role === "user");
      const userTokens = estimateMessageTokens(users);
      const otherCount = unit.messages.length - users.length;
      const otherBudget = Math.floor((maxTokens - userTokens) / Math.max(1, otherCount));
      const bounded = unit.messages.map(message => message.role === "user" ? message :
        fitSummarySourceMessage(message, otherBudget));
      if (bounded.every((message): message is UIMessage => message !== undefined) && estimateMessageTokens(bounded) <= maxTokens) {
        if (current.length && currentTokens + estimateMessageTokens(bounded) > maxTokens) {
          chunks.push(current); current = []; currentTokens = 0;
        }
        for (const message of bounded) append(message);
        continue;
      }
      for (const message of unit.messages) {
        if (message.role !== "user") {
          const projected = fitSummarySourceMessage(message, maxTokens);
          if (!projected) throw contextError("Compaction source metadata exceeds the source budget");
          append(projected); continue;
        }
        const text = message.parts.map(part => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
        let remaining = Array.from(text);
        while (remaining.length > 0) {
          let low = 1, high = remaining.length, fits = 0;
          while (low <= high) {
            const count = Math.floor((low + high) / 2);
            const fragment = { id: message.id, role: message.role, parts: [{ type: "text" as const, text: remaining.slice(0, count).join("") }] };
            if (estimateMessageTokens([fragment]) <= maxTokens) { fits = count; low = count + 1; } else high = count - 1;
          }
          if (!fits) throw contextError("User source cannot fit a bounded compaction fragment");
          append({ id: message.id, role: message.role, parts: [{ type: "text", text: remaining.slice(0, fits).join("") }] });
          remaining = remaining.slice(fits);
        }
      }
      continue;
    }
    const perMessage = Math.floor(maxTokens / Math.max(1, unit.messages.length));
    let bounded = unit.messages.map((message) => fitSummarySourceMessage(message, perMessage));
    if (bounded.some(message => message === undefined)) {
      const projected = fitSummarySourceMessage({
        id: unit.messages[0]?.id ?? "compaction-unit",
        role: "assistant",
        parts: [{ type: "text", text: unit.messages.map(message => `${message.id}: ${JSON.stringify(message.parts)}`).join("\n") }],
      }, maxTokens);
      if (!projected) throw contextError("Compaction source metadata exceeds the source budget");
      bounded = [projected];
    }
    const messages = bounded.filter((message): message is UIMessage => message !== undefined);
    const unitTokens = estimateMessageTokens(messages);
    if (current.length > 0 && currentTokens + unitTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(...messages);
    currentTokens += unitTokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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

function addObservedUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return sumTokenUsage(previous, next);
}

export class ContextCompactor {
  readonly #options: ContextCompactorOptions;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  #latest: ContextCompactionRecord | undefined;
  #effectiveReferencePrefix: readonly UIMessage[] = [];
  #lastPreparation: ContextDiagnostics["lastPreparation"] = null;
  #preparedEstimate: number | null = null;
  #preparedCompactionId: string | null = null;

  getDiagnostics(): Promise<ContextResult<ContextDiagnostics>> {
    return readContextDiagnostics(this.#options.store, this.#options.threadId, this.#options.budget, this.#lastPreparation);
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
  #lastPrepare:
    | { kind: "written"; record: ContextCompactionRecord }
    | { kind: "reused" }
    | { kind: "noop" }
    | { kind: "passthrough" }
    | undefined;

  constructor(options: ContextCompactorOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
  }

  async prepare(
    messages: UIMessage[],
    signal: AbortSignal,
    force = false,
    referencePrefix?: readonly UIMessage[],
  ): Promise<UIMessage[]> {
    this.#preparedEstimate = null;
    this.#preparedCompactionId = null;
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const jobTimeoutMs = this.#options.budget.inputBudgetTokens === undefined ? MANUAL_COMPACTION_TIMEOUT_MS : 600_000;
    const timer = setTimeout(() => controller.abort(contextError(`Context preparation exceeded its ${jobTimeoutMs / 1000} second total budget`)), jobTimeoutMs);
    try {
      const prepared = await this.#prepare(messages, controller.signal, force, referencePrefix);
      this.#lastPreparation = {
        at: this.#now().toISOString(),
        outcome: this.#lastPrepare?.kind ?? "passthrough",
        compactionId: this.#preparedCompactionId,
        estimatedInputTokens: this.#preparedEstimate,
        error: null,
      };
      return prepared;
    } catch (error) {
      this.#lastPreparation = {
        at: this.#now().toISOString(), outcome: "failed", compactionId: null,
        estimatedInputTokens: this.#preparedEstimate, error: diagnosticError(error),
      };
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #prepare(
    messages: UIMessage[], signal: AbortSignal, force: boolean,
    referencePrefix?: readonly UIMessage[],
  ): Promise<UIMessage[]> {
    this.#lastPrepare = { kind: "passthrough" };
    this.#effectiveReferencePrefix = referencePrefix ?? [];
    const visibleIds = new Set(withoutConsolidationTurns(messages).map(message => message.id));
    const journalIds = new Set(messages.map(message => message.id));
    const visible = (conversation: readonly UIMessage[]) => conversation.filter(message =>
      // Injected summary messages are not journal entries.
      !journalIds.has(message.id) || visibleIds.has(message.id));
    if (!this.#options.budget.enabled) return visible(messages);
    abortIfNeeded(signal);

    const fixed = await this.#options.fixedContext(messages, signal);
    // The caller may capture retrieval once and use the same prefix for both
    // this budget and final injection. Even [] overrides the fallback reader.
    let prefixInject = referencePrefix ?? (this.#options.promptPrefix === undefined
      ? []
      : await this.#options.promptPrefix(signal, messages));
    const estimatePrepared = (conversation: readonly UIMessage[]) =>
      estimateContextBudget(
        {
          instructions: fixed.instructions ?? "",
          tools: fixed.tools ?? [],
          memories: [],
          dynamicContext: fixed.dynamicContext ?? "",
          messages: [...prefixInject, ...expandMessageReferences(visible(conversation))],
        },
        this.#options.budget,
      );
    const checkPreparedBudget = (conversation: readonly UIMessage[]) => {
      const estimate = estimatePrepared(conversation);
      this.#preparedEstimate = estimate.inputTokens;
      if (estimate.exceeds) {
        throw contextError(`Prepared context exceeds the configured input budget (${estimate.inputTokens} > ${estimate.availableInputTokens} tokens)`);
      }
      return estimate;
    };
    const limits = contextBudgetThresholds(this.#options.budget);
    const protectedMessages: UIMessage[] = [];
    const summaryLimit = SUMMARY_MAX_TOKENS;
    const summaryTokens = (conversation: readonly UIMessage[]) => estimateMessageTokens(conversation.filter(message =>
      message.id === "runloom-context-summary" || message.id === "runloom-compaction-checklist"));
    const checkSummary = (conversation: readonly UIMessage[]) => {
      const tokens = summaryTokens(conversation);
      if (tokens > summaryLimit) throw contextError(`Context summary and host checklist exceed the ${summaryLimit} token summary budget (${tokens}); original records are retained`);
    };
    const finish = (conversation: UIMessage[], compactionId: string | null = null): UIMessage[] => {
      abortIfNeeded(signal);
      checkSummary(conversation);
      // Reuse, noop and forced preparation must obey the same final budget.
      checkPreparedBudget(conversation);
      this.#preparedCompactionId = compactionId;
      return visible(conversation);
    };

    // Resume is optional evidence, unlike Memory/checkpoint. Do not let it
    // force compaction or block an otherwise valid input; publish the same
    // effective snapshot that callers must use for final injection.
    if (estimatePrepared(messages).exceeds && prefixInject.some((message) => message.id === "runloom-resume-observation")) {
      prefixInject = prefixInject.filter((message) => message.id !== "runloom-resume-observation");
    }
    this.#effectiveReferencePrefix = prefixInject;

    const persisted = await this.#findLatestValid(messages);
    abortIfNeeded(signal);
    const compose = (summary: ContextSummaryV2, firstKept: number, checklist?: UIMessage): UIMessage[] => [
      ...transcriptPrefix(messages),
      summaryMessage(summary, {
        index: firstKept,
        id: firstKept === messages.length ? null : messages[firstKept]?.id ?? null,
      }),
      ...(checklist ? [checklist] : this.#options.checklist ? [createCompactionChecklist({
        messages: visible(messages.slice(0, firstKept)), permissions: undefined,
      })] : []),
      ...compactedRecentMessages(messages, firstKept),
    ];
    const shouldCompact = (inputTokens: number): boolean => this.#options.budget.inputBudgetTokens === undefined
      ? inputTokens > limits.availableInputTokens
      : inputTokens + limits.predictedGrowthTokens >= limits.triggerTokens;
    if (!force && persisted !== undefined) {
      const installed = compose(persisted.summary, persisted.firstKeptMessageIndex, persisted.checklist);
      if (!shouldCompact(estimatePrepared(installed).inputTokens) &&
          summaryTokens(installed) <= summaryLimit) {
        this.#lastPrepare = { kind: "reused" };
        return finish(installed, persisted.id);
      }
    }
    const rawBudget = estimatePrepared(persisted === undefined ? messages : compose(persisted.summary, persisted.firstKeptMessageIndex, persisted.checklist));
    this.#preparedEstimate = rawBudget.inputTokens;
    if (!force && !shouldCompact(rawBudget.inputTokens) && persisted === undefined) {
      this.#lastPrepare = { kind: "passthrough" };
      return finish(messages);
    }
    const checklistSources = await this.#options.checklist?.();
    if (checklistSources) protectedMessages.push(createCompactionChecklist({ ...checklistSources, messages: visible(messages) }));

    if (this.#options.refreshReference) {
      prefixInject = await this.#options.refreshReference(messages, signal);
      this.#effectiveReferencePrefix = prefixInject;
    }
    const partition = partitionMessagesForCompaction(messages);
    const units = [...partition.history, ...partition.current];
    let { kept, omitted } = keepRecentCompactionUnits(
      units,
      Math.max(1, this.#options.budget.keepRecentTokens),
    );
    const firstIncomplete = units.find((unit) => !unit.completeToolCalls);
    if (firstIncomplete !== undefined) {
      kept = units.filter((unit) => unit.startIndex >= firstIncomplete.startIndex);
      omitted = units.filter(
        (unit) => unit.endIndex < firstIncomplete.startIndex && unit.completeToolCalls,
      );
    }
    const currentUserIndex = partition.currentUserIndex;
    const currentUserUnit = currentUserIndex === null
      ? undefined
      : units.find((unit) => unit.startIndex <= currentUserIndex && unit.endIndex >= currentUserIndex);
    if (currentUserUnit !== undefined && !kept.some((unit) => unit.startIndex === currentUserUnit.startIndex)) {
      kept = [currentUserUnit, ...kept].sort((left, right) => left.startIndex - right.startIndex);
      const retained = new Set(kept.map((unit) => unit.startIndex));
      omitted = units.filter((unit) => !retained.has(unit.startIndex));
    }

    const summaryReserve = Math.max(
      persisted === undefined ? 0 : estimateSerializedTokens(persisted.summary),
      this.#options.budget.summaryMaxOutputTokens,
    ) + estimateMessageTokens(protectedMessages);
    const keptFits = (nextKept: readonly MessageCompactionUnit[]): boolean => {
      if (nextKept.length === 0) return false;
      const firstKept = nextKept[0]!.startIndex;
      const estimate = estimatePrepared([
        ...transcriptPrefix(messages),
        ...messages.slice(firstKept),
      ]);
      const target = this.#options.budget.inputBudgetTokens === undefined ? estimate.availableInputTokens : limits.triggerTokens - limits.predictedGrowthTokens;
      return estimate.inputTokens + summaryReserve <= target;
    };

    // The stored summary replaces a prefix. A completed tool result that sits
    // after the current user message cannot be removed by itself, so once the
    // suffix no longer fits, summarize that prefix through the result too.
    while (!keptFits(kept)) {
      const head = kept[0];
      if (head === undefined || !head.completeToolCalls) break;
      const laterCompleteTool = kept.slice(1).some((unit) => unit.completeToolCalls && unit.hasToolCall);
      // Keep the live request for proactive compression. Preserve the existing
      // hard-overflow escape: request + completed tool result may be summarized
      // together, but never remove the request alone or an incomplete call.
      if (this.#options.budget.inputBudgetTokens !== undefined && head === currentUserUnit &&
          (!laterCompleteTool || estimatePrepared([
            ...transcriptPrefix(messages), ...messages.slice(head.startIndex),
          ]).inputTokens + summaryReserve <= limits.availableInputTokens)) break;
      if (this.#options.budget.inputBudgetTokens === undefined && !head.hasToolCall && !laterCompleteTool) break;
      omitted = [...omitted, head];
      kept = kept.slice(1);
    }

    if (omitted.length === 0) {
      this.#lastPrepare = { kind: "noop" };
      if (force) return persisted === undefined ? finish(messages) : finish(compose(persisted.summary, persisted.firstKeptMessageIndex, persisted.checklist), persisted.id);
      if (persisted !== undefined) return finish(compose(persisted.summary, persisted.firstKeptMessageIndex, persisted.checklist), persisted.id);
      if (!rawBudget.exceeds) return finish(messages);
      throw contextError("Context exceeds the configured input budget and has no safe compaction boundary");
    }
    if (kept.length === 0 && omitted.length === 0) {
      throw contextError("Context exceeds the configured input budget and has no safe compaction boundary");
    }

    const firstKept = kept[0]?.startIndex ?? messages.length;
    if (persisted !== undefined && persisted.firstKeptMessageIndex >= firstKept) {
      const installed = compose(persisted.summary, persisted.firstKeptMessageIndex, persisted.checklist);
      if (force || !estimatePrepared(installed).exceeds) {
        this.#lastPrepare = { kind: "noop" };
        return finish(installed, persisted.id);
      }
    }

    const keptMessages = messages.slice(firstKept);
    const coveredMessages = visible(messages.slice(0, firstKept));
    const previous = persisted?.summary;
    const started = Date.now();
    const summaryInputBudget = Math.max(
      256,
      this.#options.budget.summaryInputChunkTokens ?? this.#options.budget.keepRecentTokens,
    );
    // A validated persisted summary already covers this exact prefix. Merge only
    // new material, even when the old boundary now falls inside a complete turn.
    // Re-reading the full prefix would eventually exhaust the fixed merge limit.
    const sourceStart = persisted?.firstKeptMessageIndex ?? 0;
    const incrementalUnits = omitted.filter(unit => unit.endIndex >= sourceStart).map(unit => ({
      messages: visible(unit.messages.slice(Math.max(0, sourceStart - unit.startIndex))),
    })).filter(unit => unit.messages.length > 0);
    const maxMerges = this.#options.budget.inputBudgetTokens === undefined ? MAX_SUMMARY_MERGES :
      Math.min(16, Math.ceil(limits.availableInputTokens / summaryInputBudget) + 2);
    const chunks = summarySourceChunks(incrementalUnits, summaryInputBudget, maxMerges);
    if (chunks.length === 0) {
      this.#lastPrepare = { kind: "noop" };
      return persisted ? finish(compose(persisted.summary, persisted.firstKeptMessageIndex, persisted.checklist), persisted.id) : finish(messages);
    }
    if (chunks.length > maxMerges) {
      throw contextError("Context compaction source is too large for the bounded summary merge");
    }
    let summary = previous;
    let attempts = 0;
    let usage: TokenUsage | undefined;
    for (const chunk of chunks) {
      const result = await this.#completeWithRetry(
        contextSummaryPrompt({
          ...(summary === undefined ? {} : { previousSummary: { ...summary, actions: [] } }),
          messages: chunk,
        }),
        this.#options.budget.summaryMaxOutputTokens,
        signal,
        uniqueIds([...chunk.map((message) => message.id), ...previousEvidenceIds(summary)]),
      );
      abortIfNeeded(signal);
      summary = result.summary;
      attempts += result.attempts;
      if (result.usage !== undefined) {
        usage = addObservedUsage(usage, result.usage);
      }
    }
    if (summary === undefined) throw contextError("Context compaction returned no summary");
    summary = reconcilePublishedSummary(summary, coveredMessages, previous);
    const checklist = checklistSources ? createCompactionChecklist({ ...checklistSources, messages: coveredMessages }) : undefined;
    const compactedMessages = compose(summary, firstKept, checklist);
    checkSummary(compactedMessages);
    // Validate before persisting too: an unusable summary is not a new boundary.
    const afterBudget = checkPreparedBudget(compactedMessages);
    abortIfNeeded(signal);

    const record: ContextCompactionRecord = {
      v: 2,
      type: "thread.context.compacted",
      threadId: this.#options.threadId,
      id: this.#generateId(),
      previousCompactionId: persisted?.id ?? null,
      firstKeptMessageIndex: firstKept,
      firstKeptMessageId: keptMessages[0]?.id ?? null,
      sourcePrefixHash: compactPrefixHash(messages, firstKept),
      consolidationExcluded: true,
      referencePrefix: [...prefixInject],
      ...(checklist ? { checklist } : {}),
      summary,
      strategyVersion: CONTEXT_SUMMARY_STRATEGY_VERSION,
      modelId: this.#options.modelId,
      createdAt: this.#now().toISOString(),
      metrics: {
        estimatedInputBefore: rawBudget.inputTokens,
        estimatedInputAfter: afterBudget.inputTokens,
        durationMs: Date.now() - started,
        attempts,
        ...(usage === undefined ? {} : { usage }),
      },
    };
    await this.#options.store.appendContextCompaction(asOpaqueRecord(record));
    this.#latest = record;
    this.#lastPrepare = { kind: "written", record };
    return finish(compactedMessages, record.id);
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

  async #completeWithRetry(
    prompt: string,
    maxOutputTokens: number,
    signal: AbortSignal,
    fallbackEvidenceIds: readonly string[],
  ): Promise<{ summary: ContextSummaryV2; usage?: TokenUsage; attempts: number }> {
    const delays = [0, 250, 1_000];
    let last: unknown;
    let lastText = "";
    let usage: TokenUsage | undefined;
    for (let attempt = 0; attempt < delays.length; attempt += 1) {
      abortIfNeeded(signal);
      if (delays[attempt]! > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delays[attempt]!);
          const onAbort = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(abortError(signal));
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      const requestPrompt = lastText.trim() === ""
        ? prompt
        : `${prompt}\n\nThe previous response was not valid complete ContextSummaryV2 JSON. Reply with a shorter complete JSON object; do not repeat file contents or enumerate every intermediate action. Preserve constraints and uncertain effects.\nPrevious response excerpt (not a template to copy):\n${truncateSummaryText(lastText, 2_000)}`;
      try {
        const result = await this.#completeOne(requestPrompt, maxOutputTokens, signal);
        if (result.usage !== undefined) {
          usage = addObservedUsage(usage, result.usage);
        }
        lastText = result.text;
        if (result.finishReason === "length") {
          throw new AgentError({
            code: "MODEL_BAD_RESPONSE",
            message: `Context compaction output was truncated at the ${maxOutputTokens} token limit`,
            retryable: true,
            phase: "model",
          });
        }
        if (result.text.trim() === "") {
          throw new AgentError({
            code: "MODEL_TIMEOUT",
            message: "Context compaction returned empty output",
            retryable: true,
            phase: "model",
          });
        }
        const summary = parseContextSummary(result.text, fallbackEvidenceIds);
        if (summary === undefined) {
          throw new AgentError({
            code: "MODEL_BAD_RESPONSE",
            message: "Context compaction returned invalid summary JSON",
            retryable: true,
            phase: "model",
          });
        }
        return {
          summary,
          attempts: attempt + 1,
          ...(usage === undefined ? {} : { usage }),
        };
      } catch (error) {
        last = error;
        if (signal.aborted) throw abortError(signal);
        if (!isRetryableCompactionError(error)) throw error;
      }
    }
    const observedUsage = usage === undefined
      ? "usage unavailable (a failed call may still incur cost)"
      : `returned-response usage ${JSON.stringify(usage)} (failed calls without usage may still incur cost)`;
    throw contextError(`Context compaction failed after ${delays.length} attempts; ${observedUsage}: ${String(last)}`);
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
      const timeoutMs = this.#options.budget.inputBudgetTokens === undefined ? SUMMARY_TIMEOUT_MS : 90_000;
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
