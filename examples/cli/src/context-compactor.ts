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
  fixedContext: (messages: readonly UIMessage[], signal: AbortSignal) =>
    | Omit<ContextInputParts, "messages">
    | Promise<Omit<ContextInputParts, "messages">>;
  promptPrefix?: (signal: AbortSignal) => UIMessage[] | Promise<UIMessage[]>;
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
        error.data.code === "MODEL_RATE_LIMIT")
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

function summarySourceChunks(
  units: readonly { messages: readonly UIMessage[] }[],
  maxTokens: number,
): UIMessage[][] {
  const chunks: UIMessage[][] = [];
  let current: UIMessage[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    const perMessage = Math.max(32, Math.floor(maxTokens / Math.max(1, unit.messages.length)));
    let bounded = unit.messages.map((message) => summarySourceMessage(message, perMessage));
    let unitTokens = estimateMessageTokens(bounded);
    if (unitTokens > maxTokens) {
      bounded = [{
        id: unit.messages[0]?.id ?? `compaction-unit-${chunks.length}-${current.length}`,
        role: "assistant",
        parts: [{
          type: "text",
          text: truncateSummaryText(
            unit.messages.map((message) => `${message.id}: ${JSON.stringify(message.parts)}`).join("\n"),
            Math.max(128, maxTokens * 2),
          ),
        }],
      }];
      unitTokens = estimateMessageTokens(bounded);
    }
    if (current.length > 0 && currentTokens + unitTokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(...bounded);
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

function reconcilePublishedSummary(
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

  const fileFacts = facts.filter(
    (fact) =>
      fact.status === "completed" &&
      fact.path !== undefined &&
      FILE_TOOLS.has(fact.toolName),
  );
  const newFiles: ContextSummaryFile[] = fileFacts.map((fact) => {
    const modeled = summary.files.find((file) => file.path === fact.path);
    return {
      text: modeled?.text ?? fact.text,
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
    actions: [...keptPreviousActions, ...fromFacts],
    pending: summary.pending.map(constrain),
    files: [...keptPreviousFiles, ...newFiles],
    nextStep: summary.nextStep === null ? null : constrain(summary.nextStep),
  };
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

export class ContextCompactor {
  readonly #options: ContextCompactorOptions;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  #latest: ContextCompactionRecord | undefined;
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

  async prepare(messages: UIMessage[], signal: AbortSignal, force = false): Promise<UIMessage[]> {
    this.#lastPrepare = { kind: "passthrough" };
    if (!this.#options.budget.enabled) return messages;
    abortIfNeeded(signal);

    const fixed = await this.#options.fixedContext(messages, signal);
    const prefixInject = this.#options.promptPrefix === undefined
      ? []
      : await this.#options.promptPrefix(signal);
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
        return installed;
      }
    }
    const rawBudget = estimatePrepared(messages);
    if (!force && !rawBudget.exceeds && persisted === undefined) {
      this.#lastPrepare = { kind: "passthrough" };
      return messages;
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

    while (kept.length > 1 && !keptFits(kept)) {
      const head = kept[0]!;
      if (!head.completeToolCalls) break;
      if (currentUserUnit !== undefined && head.startIndex === currentUserUnit.startIndex) break;
      omitted = [...omitted, head];
      kept = kept.slice(1);
    }

    if (omitted.length === 0) {
      this.#lastPrepare = { kind: "noop" };
      if (force) return persisted === undefined ? messages : compose(persisted.summary, persisted.firstKeptMessageIndex);
      if (persisted !== undefined) return compose(persisted.summary, persisted.firstKeptMessageIndex);
      throw contextError("Context exceeds the configured input budget and has no safe compaction boundary");
    }
    if (kept.length === 0) {
      throw contextError("Context exceeds the configured input budget and has no safe compaction boundary");
    }

    const firstKept = kept[0]!.startIndex;
    if (persisted !== undefined && persisted.firstKeptMessageIndex >= firstKept) {
      const installed = compose(persisted.summary, persisted.firstKeptMessageIndex);
      if (force || !estimatePrepared(installed).exceeds) {
        this.#lastPrepare = { kind: "noop" };
        return force ? messages : installed;
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
    const chunks = summarySourceChunks(omitted, summaryInputBudget);
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
      );
      abortIfNeeded(signal);
      const parsedSummary = parseContextSummary(result.text);
      if (parsedSummary === undefined) {
        throw contextError("Context compaction returned invalid summary JSON");
      }
      summary = parsedSummary;
      attempts += result.attempts;
      if (result.usage !== undefined) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + (result.usage.inputTokens ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (result.usage.outputTokens ?? 0),
          totalTokens: (usage?.totalTokens ?? 0) + (result.usage.totalTokens ?? 0),
        };
      }
    }
    if (summary === undefined) throw contextError("Context compaction returned no summary");
    summary = reconcilePublishedSummary(summary, coveredMessages, previous);
    const compactedMessages = [
      ...prefix,
      summaryMessage(summary, { index: firstKept, id: keptMessages[0]?.id ?? null }),
      ...keptMessages,
    ];
    const afterBudget = estimatePrepared(compactedMessages);
    if (afterBudget.exceeds) {
      throw contextError("Context remains over the configured input budget after compaction");
    }

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
    return compactedMessages;
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
            `耗时 ${metrics.durationMs} ms；${formatUsage(metrics.usage)}。原始历史仍可用 /history 回查。`,
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
  ): Promise<{ text: string; usage?: TokenUsage; attempts: number }> {
    const delays = [0, 250, 1_000];
    let last: unknown;
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
      try {
        const result = await this.#completeOne(prompt, maxOutputTokens, signal);
        if (result.text.trim() === "") {
          throw new AgentError({
            code: "MODEL_TIMEOUT",
            message: "Context compaction returned empty output",
            retryable: true,
            phase: "model",
          });
        }
        return { ...result, attempts: attempt + 1 };
      } catch (error) {
        last = error;
        if (signal.aborted) throw abortError(signal);
        if (!isRetryableCompactionError(error)) throw error;
      }
    }
    throw contextError(`Context compaction failed after ${delays.length} attempts: ${String(last)}`);
  }

  async #completeOne(
    prompt: string,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<{ text: string; usage?: TokenUsage }> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(abortError(signal));
    if (signal.aborted) controller.abort(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
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
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
