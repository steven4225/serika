import type { UIMessage } from "ai";

/**
 * The first budget estimator is deliberately explicit and replaceable. It is
 * an estimate of the serialized request, not a provider tokenizer result.
 */
export const CONTEXT_ESTIMATOR_VERSION = "char-half/v1" as const;
export const CONTEXT_ESTIMATOR_METHOD = "estimated" as const;
export const MESSAGE_OVERHEAD_TOKENS = 4;

export interface ContextBudgetConfig {
  enabled: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  safetyMarginTokens: number;
  keepRecentTokens: number;
  summaryMaxOutputTokens: number;
}

/** Values are intentionally conservative defaults for tests and local config. */
export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = {
  enabled: false,
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  safetyMarginTokens: 1_024,
  keepRecentTokens: 8_192,
  summaryMaxOutputTokens: 1_024,
};

export interface ContextBudgetValidation {
  ok: boolean;
  errors: string[];
  availableInputTokens: number;
}

export interface ContextInputParts {
  instructions?: string;
  tools?: unknown;
  memories?: unknown;
  dynamicContext?: unknown;
  messages: readonly UIMessage[];
}

export interface ContextEstimateBreakdown {
  instructions: number;
  tools: number;
  memories: number;
  dynamicContext: number;
  messages: number;
}

export interface ContextEstimate {
  inputTokens: number;
  method: typeof CONTEXT_ESTIMATOR_METHOD;
  estimatorVersion: typeof CONTEXT_ESTIMATOR_VERSION;
  messageCount: number;
  breakdown: ContextEstimateBreakdown;
}

export interface ContextBudgetEstimate extends ContextEstimate {
  availableInputTokens: number;
  exceeds: boolean;
}

function serializedText(value: unknown): string {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "" : encoded;
}

/**
 * Estimate serialized input tokens using UTF-16 code units / 2, rounded up.
 * JSON framing is counted by the serialized value; each UI message also gets
 * a fixed protocol overhead so message-heavy prompts are not undercounted.
 */
export function estimateSerializedTokens(value: unknown): number {
  return Math.ceil(serializedText(value).length / 2);
}

export function estimateMessageTokens(messages: readonly UIMessage[]): number {
  return (
    estimateSerializedTokens(messages) +
    messages.length * MESSAGE_OVERHEAD_TOKENS
  );
}

export function availableInputTokens(config: Pick<
  ContextBudgetConfig,
  "contextWindowTokens" | "maxOutputTokens" | "safetyMarginTokens"
>): number {
  return (
    config.contextWindowTokens -
    config.maxOutputTokens -
    config.safetyMarginTokens
  );
}

export function validateContextBudgetConfig(
  config: ContextBudgetConfig,
  fixedInputTokens = 0,
): ContextBudgetValidation {
  const errors: string[] = [];
  if (typeof config.enabled !== "boolean") {
    errors.push("enabled must be a boolean");
  }
  const integerFields: Array<keyof ContextBudgetConfig> = [
    "contextWindowTokens",
    "maxOutputTokens",
    "safetyMarginTokens",
    "keepRecentTokens",
    "summaryMaxOutputTokens",
  ];
  for (const field of integerFields) {
    const value = config[field] as number;
    if (!Number.isSafeInteger(value) || value < 0) {
      errors.push(`${field} must be a non-negative safe integer`);
    }
  }

  const available = availableInputTokens(config);
  if (available <= 0) {
    errors.push("contextWindowTokens must leave a positive input budget");
  }
  if (config.keepRecentTokens <= 0 || config.keepRecentTokens >= available) {
    errors.push("keepRecentTokens must be greater than 0 and below available input budget");
  }
  if (config.summaryMaxOutputTokens <= 0) {
    errors.push("summaryMaxOutputTokens must be greater than 0");
  }
  if (!Number.isFinite(fixedInputTokens) || fixedInputTokens < 0) {
    errors.push("fixedInputTokens must be a non-negative finite number");
  } else if (fixedInputTokens >= available) {
    errors.push("fixed input estimate leaves no room for conversation context");
  }

  return { ok: errors.length === 0, errors, availableInputTokens: available };
}

export function estimateContextInput(input: ContextInputParts): ContextEstimate {
  const breakdown: ContextEstimateBreakdown = {
    instructions: estimateSerializedTokens(input.instructions ?? ""),
    tools: estimateSerializedTokens(input.tools ?? []),
    memories: estimateSerializedTokens(input.memories ?? []),
    dynamicContext: estimateSerializedTokens(input.dynamicContext ?? ""),
    messages: estimateMessageTokens(input.messages),
  };
  return {
    inputTokens:
      breakdown.instructions +
      breakdown.tools +
      breakdown.memories +
      breakdown.dynamicContext +
      breakdown.messages,
    method: CONTEXT_ESTIMATOR_METHOD,
    estimatorVersion: CONTEXT_ESTIMATOR_VERSION,
    messageCount: input.messages.length,
    breakdown,
  };
}

export function estimateContextBudget(
  input: ContextInputParts,
  config: Pick<
    ContextBudgetConfig,
    "contextWindowTokens" | "maxOutputTokens" | "safetyMarginTokens"
  >,
): ContextBudgetEstimate {
  const estimate = estimateContextInput(input);
  const available = availableInputTokens(config);
  return {
    ...estimate,
    availableInputTokens: available,
    exceeds: estimate.inputTokens > available,
  };
}

export interface MessageCompactionUnit {
  messages: UIMessage[];
  startIndex: number;
  endIndex: number;
  hasToolCall: boolean;
  completeToolCalls: boolean;
  estimatedTokens: number;
}

export interface CompactionMessagePartition {
  prefix: UIMessage[];
  history: MessageCompactionUnit[];
  current: MessageCompactionUnit[];
  currentUserIndex: number | null;
}

type ToolPart = {
  toolCallId: string;
  state?: string;
};

function toolParts(message: UIMessage): ToolPart[] {
  const parts: ToolPart[] = [];
  for (const part of message.parts) {
    if (
      typeof part === "object" &&
      part !== null &&
      "toolCallId" in part &&
      typeof part.toolCallId === "string"
    ) {
      parts.push({
        toolCallId: part.toolCallId,
        ...(typeof part.state === "string" ? { state: part.state } : {}),
      });
    }
  }
  return parts;
}

function unitHasOnlyCompleteTools(messages: readonly UIMessage[]): boolean {
  const parts = messages.flatMap(toolParts);
  const pending = new Set<string>();
  const completed = new Set<string>();
  for (const part of parts) {
    if (part.state === undefined || part.state === "output-available" || part.state === "output-error" || part.state === "output-denied") {
      completed.add(part.toolCallId);
      continue;
    }
    if (part.state === "input-available") {
      pending.add(part.toolCallId);
      continue;
    }
    return false;
  }
  return [...pending].every((toolCallId) => completed.has(toolCallId));
}

/**
 * Split messages at safe compaction boundaries. A tool call and every message
 * carrying the same toolCallId are kept in one unit. A pending tool part makes
 * the unit non-complete, so callers must keep it out of a summary cut.
 */
export function splitMessageCompactionUnits(
  messages: readonly UIMessage[],
): MessageCompactionUnit[] {
  if (messages.length === 0) return [];

  const spans = new Map<string, { start: number; end: number }>();
  for (let index = 0; index < messages.length; index += 1) {
    for (const part of toolParts(messages[index]!)) {
      const existing = spans.get(part.toolCallId);
      if (existing === undefined) {
        spans.set(part.toolCallId, { start: index, end: index });
      } else {
        existing.end = index;
      }
    }
  }

  const units: MessageCompactionUnit[] = [];
  let index = 0;
  while (index < messages.length) {
    let end = index;
    for (const span of spans.values()) {
      if (span.start <= end && span.end > end) end = span.end;
    }
    // Merge transitively overlapping spans. This also handles a provider that
    // emits several calls before their results.
    let changed = true;
    while (changed) {
      changed = false;
      for (const span of spans.values()) {
        if (span.start <= end && span.end > end) {
          end = span.end;
          changed = true;
        }
      }
    }
    const selected = messages.slice(index, end + 1);
    const hasToolCall = selected.some((message) => toolParts(message).length > 0);
    units.push({
      messages: selected,
      startIndex: index,
      endIndex: end,
      hasToolCall,
      completeToolCalls: unitHasOnlyCompleteTools(selected),
      estimatedTokens: estimateMessageTokens(selected),
    });
    index = end + 1;
  }
  return units;
}

/**
 * Partition a transcript while preserving the last user's complete request.
 * The current turn is still split into safe units so a caller can summarize
 * early completed tool interactions when the current turn is long.
 */
export function partitionMessagesForCompaction(
  messages: readonly UIMessage[],
): CompactionMessagePartition {
  const userIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") userIndexes.push(index);
  }
  if (userIndexes.length === 0) {
    const prefix = [...messages];
    return { prefix, history: [], current: [], currentUserIndex: null };
  }

  const firstUser = userIndexes[0]!;
  const currentUserIndex = userIndexes[userIndexes.length - 1]!;
  const prefix = messages.slice(0, firstUser);
  const historyStart = firstUser;
  const historyEnd = currentUserIndex;
  const history: MessageCompactionUnit[] = [];
  for (let turn = 0; turn < userIndexes.length - 1; turn += 1) {
    const start = userIndexes[turn]!;
    const end = userIndexes[turn + 1]! - 1;
    const turnMessages = messages.slice(start, end + 1);
    const hasToolCall = turnMessages.some((message) => toolParts(message).length > 0);
    history.push({
      messages: turnMessages,
      startIndex: start,
      endIndex: end,
      hasToolCall,
      completeToolCalls: unitHasOnlyCompleteTools(turnMessages),
      estimatedTokens: estimateMessageTokens(turnMessages),
    });
  }
  const current = splitMessageCompactionUnits(messages.slice(currentUserIndex))
    .map((unit) => ({
      ...unit,
      startIndex: unit.startIndex + currentUserIndex,
      endIndex: unit.endIndex + currentUserIndex,
    }));
  return { prefix, history, current, currentUserIndex };
}

/** Return a stable contiguous suffix of units that fits a token target. */
export function keepRecentCompactionUnits(
  units: readonly MessageCompactionUnit[],
  targetTokens: number,
): { kept: MessageCompactionUnit[]; omitted: MessageCompactionUnit[] } {
  if (!Number.isSafeInteger(targetTokens) || targetTokens <= 0) {
    throw new RangeError("targetTokens must be a positive safe integer");
  }
  const kept: MessageCompactionUnit[] = [];
  let total = 0;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]!;
    if (kept.length > 0 && total + unit.estimatedTokens > targetTokens) break;
    kept.unshift(unit);
    total += unit.estimatedTokens;
  }
  const keptIndexes = new Set(kept.map((unit) => unit.startIndex));
  return {
    kept,
    omitted: units.filter((unit) => !keptIndexes.has(unit.startIndex)),
  };
}
