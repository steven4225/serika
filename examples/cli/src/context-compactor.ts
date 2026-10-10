import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import {
  AgentError,
  type ContextCompactionStore,
  type MessageStore,
  type ThreadContextCompactionRecord,
  type TokenUsage,
} from "@aisdk-agent/core";
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
  keepRecentCompactionUnits,
  partitionMessagesForCompaction,
  type ContextBudgetConfig,
  type ContextInputParts,
  type MessageCompactionUnit,
} from "./context-budget.js";
import { collectTranscriptToolFacts } from "./work-summary.js";
import type { ContextDiagnostics, ContextResult } from "./context-diagnostics.js";
import { CONTEXT_ESTIMATOR_VERSION } from "./context-budget.js";

const SUMMARY_TIMEOUT_MS = 30_000;
const MANUAL_COMPACTION_TIMEOUT_MS = 120_000;
const MAX_SUMMARY_MERGES = 4;
const FILE_TOOLS = new Set(["write_file", "edit_file"]);
const FILE_RECEIPT_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

export interface ContextCompactorOptions {
  store: MessageStore & ContextCompactionStore;
  threadId: string;
  modelId: string;
  summarizer: Summarizer;
  budget: ContextBudgetConfig;
  fixedContext: (messages: readonly UIMessage[], signal: AbortSignal) =>
    | Omit<ContextInputParts, "messages">
    | Promise<Omit<ContextInputParts, "messages">>;
  promptPrefix?: (signal: AbortSignal, messages: readonly UIMessage[]) => UIMessage[] | Promise<UIMessage[]>;
  now?: () => Date;
  generateId?: () => string;
}

export interface CompactCommandResult {
  message: string;
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
): UIMessage[][] {
  const chunks: UIMessage[][] = [];
  let current: UIMessage[] = [];
  let currentTokens = 0;
  const append = (message: UIMessage) => {
    const tokens = estimateMessageTokens([message]);
    if (tokens > maxTokens) throw contextError("A compaction source fragment exceeds the source budget");
    if (current.length > 0 && currentTokens + tokens > maxTokens) {
      chunks.push(current); current = []; currentTokens = 0;
      if (chunks.length >= MAX_SUMMARY_MERGES) throw contextError("Context compaction source is too large for the bounded summary merge");
    }
    current.push(message); currentTokens += tokens;
  };
  for (const unit of units) {
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
    const modeled = summary.actions.find((action) => action.toolCallIds.includes(fact.toolCallId));
    return {
      text: modeled?.text ?? fact.text,
      evidenceMessageIds: fact.evidenceMessageIds,
      status: fact.status,
      toolCallIds: [fact.toolCallId],
    };
  });
  const keptPreviousActions = (previous?.actions ?? []).filter(
    (action) => !action.toolCallIds.some((id) => factsById.has(id)),
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
    actions: compactCompletedActions([...keptPreviousActions, ...fromFacts, ...unfinishedActions], facts),
    pending: summary.pending.map(constrain),
    files: [...new Map([...keptPreviousFiles, ...newFiles].map(file => [file.path, file])).values()],
    nextStep: summary.nextStep === null ? null : constrain(summary.nextStep),
  };
}

/** Full receipts stay in transcript; only repeated completed file effects share a reference. */
function compactCompletedActions(actions: ContextSummaryV2["actions"], facts: ReturnType<typeof collectTranscriptToolFacts>): ContextSummaryV2["actions"] {
  const byId = new Map(facts.map(fact => [fact.toolCallId, fact]));
  const groups = new Map<string, ContextSummaryV2["actions"][number]>();
  const result: ContextSummaryV2["actions"] = [];
  for (const action of actions) {
    const fact = byId.get(action.toolCallIds.at(-1) ?? "");
    if (action.status !== "completed" || !fact?.path || !FILE_RECEIPT_TOOLS.has(fact.toolName)) {
      // Never aggregate a later success across an unresolved/failed operation.
      if (action.status !== "completed") groups.clear();
      result.push(action); continue;
    }
    const key = `${fact.toolName}:${fact.path}`;
    const previousAction = groups.get(key);
    if (!previousAction) {
      const grouped = { ...action };
      groups.set(key, grouped); result.push(grouped);
    } else {
      previousAction.text = `Historical ${fact.toolName} receipts for ${fact.path}; inspect full transcript for the full sequence, then read current disk before continuing.`;
      previousAction.toolCallIds = uniqueIds([...previousAction.toolCallIds, ...action.toolCallIds]).slice(-8);
      previousAction.evidenceMessageIds = uniqueIds([...previousAction.evidenceMessageIds, ...action.evidenceMessageIds]).slice(-8);
    }
  }
  return result;
}

function formatUsage(usage: TokenUsage | undefined): string {
  if (
    usage === undefined ||
    (usage.inputTokens === undefined && usage.outputTokens === undefined)
  ) {
    return "usage unknown";
  }
  return `usage in=${usage.inputTokens ?? "unknown"} out=${usage.outputTokens ?? "unknown"}`;
}

function addObservedUsage(previous: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const sum = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  const inputTokens = sum(previous?.inputTokens, next.inputTokens);
  const outputTokens = sum(previous?.outputTokens, next.outputTokens);
  const totalTokens = sum(previous?.totalTokens, next.totalTokens);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
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
    try {
      const prepared = await this.#prepare(messages, signal, force, referencePrefix);
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
    }
  }

  async #prepare(
    messages: UIMessage[], signal: AbortSignal, force: boolean,
    referencePrefix?: readonly UIMessage[],
  ): Promise<UIMessage[]> {
    this.#lastPrepare = { kind: "passthrough" };
    this.#effectiveReferencePrefix = referencePrefix ?? [];
    if (!this.#options.budget.enabled) return messages;
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
          messages: [...prefixInject, ...conversation],
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
    const finish = (conversation: UIMessage[], compactionId: string | null = null): UIMessage[] => {
      // Reuse, noop and forced preparation must obey the same final budget.
      checkPreparedBudget(conversation);
      this.#preparedCompactionId = compactionId;
      return conversation;
    };

    // Resume is optional evidence, unlike Memory/checkpoint. Do not let it
    // force compaction or block an otherwise valid input; publish the same
    // effective snapshot that callers must use for final injection.
    if (estimatePrepared(messages).exceeds && prefixInject.some((message) => message.id === "runloom-resume-observation")) {
      prefixInject = prefixInject.filter((message) => message.id !== "runloom-resume-observation");
    }
    this.#effectiveReferencePrefix = prefixInject;

    const persisted = await this.#findLatestValid(messages);
    const compose = (summary: ContextSummaryV2, firstKept: number): UIMessage[] => [
      ...transcriptPrefix(messages),
      summaryMessage(summary, {
        index: firstKept,
        id: firstKept === messages.length ? null : messages[firstKept]?.id ?? null,
      }),
      ...messages.slice(firstKept),
    ];
    if (!force && persisted !== undefined) {
      const installed = compose(persisted.summary, persisted.firstKeptMessageIndex);
      if (!estimatePrepared(installed).exceeds) {
        this.#lastPrepare = { kind: "reused" };
        return finish(installed, persisted.id);
      }
    }
    const rawBudget = estimatePrepared(messages);
    this.#preparedEstimate = rawBudget.inputTokens;
    if (!force && !rawBudget.exceeds && persisted === undefined) {
      this.#lastPrepare = { kind: "passthrough" };
      return finish(messages);
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
    );
    const keptFits = (nextKept: readonly MessageCompactionUnit[]): boolean => {
      if (nextKept.length === 0) return false;
      const firstKept = nextKept[0]!.startIndex;
      const estimate = estimatePrepared([
        ...transcriptPrefix(messages),
        ...messages.slice(firstKept),
      ]);
      return estimate.inputTokens + summaryReserve <= estimate.availableInputTokens;
    };

    // The stored summary replaces a prefix. A completed tool result that sits
    // after the current user message cannot be removed by itself, so once the
    // suffix no longer fits, summarize that prefix through the result too.
    while (!keptFits(kept)) {
      const head = kept[0];
      if (head === undefined || !head.completeToolCalls) break;
      const laterCompleteTool = kept.slice(1).some((unit) => unit.completeToolCalls && unit.hasToolCall);
      if (!head.hasToolCall && !laterCompleteTool) break;
      omitted = [...omitted, head];
      kept = kept.slice(1);
    }

    if (omitted.length === 0) {
      this.#lastPrepare = { kind: "noop" };
      if (force) return persisted === undefined ? finish(messages) : finish(compose(persisted.summary, persisted.firstKeptMessageIndex), persisted.id);
      if (persisted !== undefined) return finish(compose(persisted.summary, persisted.firstKeptMessageIndex), persisted.id);
      throw contextError("Context exceeds the configured input budget and has no safe compaction boundary");
    }
    if (kept.length === 0 && omitted.length === 0) {
      throw contextError("Context exceeds the configured input budget and has no safe compaction boundary");
    }

    const firstKept = kept[0]?.startIndex ?? messages.length;
    if (persisted !== undefined && persisted.firstKeptMessageIndex >= firstKept) {
      const installed = compose(persisted.summary, persisted.firstKeptMessageIndex);
      if (force || !estimatePrepared(installed).exceeds) {
        this.#lastPrepare = { kind: "noop" };
        return finish(installed, persisted.id);
      }
    }

    const keptMessages = messages.slice(firstKept);
    const coveredMessages = messages.slice(0, firstKept);
    const prefix = transcriptPrefix(messages);
    const previous = persisted?.summary;
    const started = Date.now();
    const summaryInputBudget = Math.max(
      256,
      this.#options.budget.keepRecentTokens,
    );
    // A validated persisted summary already covers this exact prefix. Merge only
    // new material, even when the old boundary now falls inside a complete turn.
    // Re-reading the full prefix would eventually exhaust the fixed merge limit.
    const sourceStart = persisted?.firstKeptMessageIndex ?? 0;
    const incrementalUnits = omitted.filter(unit => unit.endIndex >= sourceStart).map(unit => ({
      messages: unit.messages.slice(Math.max(0, sourceStart - unit.startIndex)),
    }));
    const chunks = summarySourceChunks(incrementalUnits, summaryInputBudget);
    if (chunks.length === 0 || chunks.length > MAX_SUMMARY_MERGES) {
      throw contextError("Context compaction source is too large for the bounded summary merge");
    }
    let summary = previous;
    let attempts = 0;
    let usage: TokenUsage | undefined;
    for (const chunk of chunks) {
      const result = await this.#completeWithRetry(
        contextSummaryPrompt({
          ...(summary === undefined ? {} : { previousSummary: summary }),
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
    const compactedMessages = [
      ...prefix,
      summaryMessage(summary, { index: firstKept, id: keptMessages[0]?.id ?? null }),
      ...keptMessages,
    ];
    // Validate before persisting too: an unusable summary is not a new boundary.
    const afterBudget = checkPreparedBudget(compactedMessages);

    const record: ContextCompactionRecord = {
      v: 2,
      type: "thread.context.compacted",
      threadId: this.#options.threadId,
      id: this.#generateId(),
      previousCompactionId: persisted?.id ?? null,
      firstKeptMessageIndex: firstKept,
      firstKeptMessageId: keptMessages[0]?.id ?? null,
      sourcePrefixHash: compactPrefixHash(messages, firstKept),
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

  async compact(signal: AbortSignal): Promise<CompactCommandResult> {
    const messages = await this.#options.store.getMessages(this.#options.threadId);
    if (messages.length === 0) return { message: "没有可压缩的已提交历史。" };
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortError(signal));
    if (signal.aborted) controller.abort(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new AgentError({
      code: "MODEL_TIMEOUT",
      message: "Context compaction exceeded the 120 second manual budget",
      retryable: true,
      phase: "runtime",
    })), MANUAL_COMPACTION_TIMEOUT_MS);
    try {
      const prepared = await this.prepare(messages, controller.signal, true);
      if (this.#lastPrepare?.kind === "written") {
        const metrics = this.#lastPrepare.record.metrics;
        return {
          message:
            `上下文摘要已保存。估算 ${metrics.estimatedInputBefore} → ${metrics.estimatedInputAfter} tokens；` +
            `耗时 ${metrics.durationMs} ms；尝试 ${metrics.attempts} 次；${formatUsage(metrics.usage)}。原始历史仍可用 /history 回查。`,
        };
      }
      if (!prepared.some((message) =>
        typeof message.metadata === "object" &&
        message.metadata !== null &&
        (message.metadata as { source?: unknown }).source === "context-compaction"
      )) {
        return { message: "没有可压缩内容。" };
      }
      return { message: "没有可压缩内容。" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
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
          const timer = setTimeout(resolve, delays[attempt]!);
          const onAbort = (): void => {
            clearTimeout(timer);
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
      timer = setTimeout(() => {
        const error = new AgentError({
          code: "MODEL_TIMEOUT",
          message: "Context summary exceeded the 30 second budget",
          retryable: true,
          phase: "model",
        });
        controller.abort(error);
        reject(error);
      }, SUMMARY_TIMEOUT_MS);
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
