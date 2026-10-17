import { streamText, type LanguageModel, type UIMessage } from "ai";
import { durable, type TokenUsage } from "@serika/core";
import { normalizeTokenUsage } from "@serika/ai-sdk-adapter";

export const CONTEXT_SUMMARY_VERSION = 2 as const;
export const CONTEXT_SUMMARY_STRATEGY_VERSION = "summary-json/v2" as const;
export const COMPACT_PREFIX_HASH_VERSION = "compact-prefix/jcs-sha256:v1" as const;

export type SummarySource = "user" | "assistant";
export type SummaryDecisionStatus =
  | "confirmed"
  | "proposed"
  | "superseded"
  | "withdrawn";
export type SummaryActionStatus =
  | "completed"
  | "failed"
  | "not_executed"
  | "unknown";

export interface ContextSummaryItem {
  text: string;
  evidenceMessageIds: string[];
}

export interface ContextSummaryAction extends ContextSummaryItem {
  status: SummaryActionStatus;
  toolCallIds: string[];
}

export interface ContextSummaryDecision extends ContextSummaryItem {
  source: SummarySource;
  status: SummaryDecisionStatus;
}

export interface ContextSummaryFile extends ContextSummaryItem {
  path: string;
  purpose: string;
}

export interface ContextSummaryV2 {
  version: typeof CONTEXT_SUMMARY_VERSION;
  goal: ContextSummaryItem;
  constraints: ContextSummaryItem[];
  decisions: ContextSummaryDecision[];
  actions: ContextSummaryAction[];
  pending: ContextSummaryItem[];
  files: ContextSummaryFile[];
  nextStep: ContextSummaryItem | null;
}

export interface CompactionMetrics {
  estimatedInputBefore: number;
  estimatedInputAfter: number;
  durationMs: number;
  attempts: number;
  usage?: TokenUsage;
}

export interface ContextCompactionRecord {
  v: 2;
  type: "thread.context.compacted";
  threadId: string;
  id: string;
  previousCompactionId: string | null;
  firstKeptMessageIndex: number;
  firstKeptMessageId: string | null;
  sourcePrefixHash: string;
  /** New summaries exclude auxiliary extraction turns while hashing the unchanged journal. */
  consolidationExcluded?: true;
  summary: ContextSummaryV2;
  strategyVersion: typeof CONTEXT_SUMMARY_STRATEGY_VERSION;
  modelId: string;
  createdAt: string;
  metrics: CompactionMetrics;
}

export interface Summarizer {
  complete(input: {
    prompt: string;
    maxOutputTokens: number;
    signal: AbortSignal;
  }): Promise<{ text: string; usage?: TokenUsage; finishReason?: string }>;
}

export function createAiSdkSummarizer(model: LanguageModel): Summarizer {
  return {
    async complete({ prompt, maxOutputTokens, signal }) {
      const result = streamText({
        model,
        system: [
          "You are a context compactor. Return only valid JSON matching the requested schema. Do not invent tool results, file writes, permissions, or current disk state.",
          `The hard output limit is ${maxOutputTokens} tokens INCLUDING JSON syntax and IDs. Aim below ${Math.floor(maxOutputTokens / 2)} tokens so the complete object fits.`,
          "Write a compact continuation note, not a transcript replay. Merge repeated constraints and repeated successful work on the same artifact. Do not reproduce file bodies, long tool arguments, or every intermediate read. Keep only the evidence IDs needed to support each item.",
          "Preserve the latest goal, unique constraints, changed decisions, unfinished work and uncertain effects. Do not merge conflicting action statuses or discard an unknown effect. Include every required top-level section; use empty arrays only when there is no evidence.",
        ].join("\n"),
        prompt,
        maxOutputTokens,
        abortSignal: signal,
        maxRetries: 0,
        telemetry: { isEnabled: false },
      });
      const text = await result.text;
      const usage = await result.usage;
      return {
        text,
        finishReason: await result.finishReason,
        ...(usage === undefined
          ? {}
          : {
              usage: normalizeTokenUsage(usage),
            }),
      };
    },
  };
}

/** Hashes only persisted transcript messages, never injected memory or summaries. */
export function compactPrefixHash(messages: readonly UIMessage[], endExclusive: number): string {
  const prefix = messages.slice(0, endExclusive).map(({ id, role, parts }) => ({ id, role, parts }));
  const canonicalHash = durable.hashCanonicalJson(
    JSON.parse(JSON.stringify(prefix)) as Parameters<typeof durable.hashCanonicalJson>[0],
  );
  return `${COMPACT_PREFIX_HASH_VERSION}:${canonicalHash.slice("jcs-sha256:v1:".length)}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function evidence(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function item(value: unknown): value is ContextSummaryItem {
  return typeof value === "object" && value !== null &&
    nonEmpty((value as ContextSummaryItem).text) &&
    evidence((value as ContextSummaryItem).evidenceMessageIds);
}

function uniqueEvidence(value: unknown, fallback: readonly string[]): string[] {
  const listed = Array.isArray(value) ? value.filter(nonEmpty) : [];
  const unique = [...new Set(listed)];
  return unique.length > 0 ? unique : [...new Set(fallback.filter(nonEmpty))];
}

function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

function coerceItem(
  value: unknown,
  fallbackEvidenceIds: readonly string[],
  textFallback?: string,
): ContextSummaryItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = nonEmpty(record.text)
    ? record.text.trim()
    : (textFallback !== undefined && nonEmpty(textFallback) ? textFallback.trim() : "");
  if (!nonEmpty(text)) return undefined;
  const evidenceMessageIds = uniqueEvidence(record.evidenceMessageIds, fallbackEvidenceIds);
  if (evidenceMessageIds.length === 0) return undefined;
  return { text, evidenceMessageIds };
}

/**
 * Fills omitted item fields that models routinely drop. The strict validator
 * still runs on the result; this does not invent tool outcomes or disk state.
 */
export function coerceContextSummary(
  value: unknown,
  fallbackEvidenceIds: readonly string[] = [],
): ContextSummaryV2 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const version = raw.version === 2 || raw.version === "2" ? 2 : raw.version;
  if (version !== 2) return undefined;
  const goal = coerceItem(raw.goal, fallbackEvidenceIds);
  if (goal === undefined) return undefined;
  // An omitted section cannot be distinguished from a forgotten constraint or
  // unfinished action. Require the explicit empty arrays requested by the prompt.
  if (!Array.isArray(raw.constraints) || !Array.isArray(raw.pending) ||
      !Array.isArray(raw.decisions) || !Array.isArray(raw.actions) ||
      !Array.isArray(raw.files) || !("nextStep" in raw)) return undefined;

  const constraints = (Array.isArray(raw.constraints) ? raw.constraints : []).map((entry) =>
    coerceItem(entry, fallbackEvidenceIds));
  const pending = (Array.isArray(raw.pending) ? raw.pending : []).map((entry) =>
    coerceItem(entry, fallbackEvidenceIds));
  if (constraints.includes(undefined) || pending.includes(undefined)) return undefined;
  const nextStep = raw.nextStep === null || raw.nextStep === undefined
    ? null
    : coerceItem(raw.nextStep, fallbackEvidenceIds);
  if (raw.nextStep !== null && raw.nextStep !== undefined && nextStep === undefined) return undefined;

  const decisions = (Array.isArray(raw.decisions) ? raw.decisions : []).map((entry) => {
    const base = coerceItem(entry, fallbackEvidenceIds);
    if (base === undefined || typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (record.source !== "user" && record.source !== "assistant") return undefined;
    if (typeof record.status !== "string" || !decisionStatuses.has(record.status as SummaryDecisionStatus)) {
      return undefined;
    }
    return { ...base, source: record.source, status: record.status as SummaryDecisionStatus };
  });
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).map((entry) => {
    const base = coerceItem(entry, fallbackEvidenceIds);
    if (base === undefined || typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (typeof record.status !== "string" || !actionStatuses.has(record.status as SummaryActionStatus)) {
      return undefined;
    }
    const toolCallIds = Array.isArray(record.toolCallIds) ? record.toolCallIds.filter(nonEmpty) : [];
    return { ...base, status: record.status as SummaryActionStatus, toolCallIds };
  });
  const files = (Array.isArray(raw.files) ? raw.files : []).map((entry) => {
    if (typeof entry !== "object" || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    if (!nonEmpty(record.path) || !nonEmpty(record.purpose)) return undefined;
    const base = coerceItem(entry, fallbackEvidenceIds, `${record.purpose.trim()} (${record.path.trim()})`);
    if (base === undefined) return undefined;
    return { ...base, path: record.path.trim(), purpose: record.purpose.trim() };
  });
  if (decisions.includes(undefined) || actions.includes(undefined) || files.includes(undefined)) return undefined;

  return {
    version: 2,
    goal,
    constraints: constraints as ContextSummaryItem[],
    decisions: decisions as ContextSummaryDecision[],
    actions: actions as ContextSummaryAction[],
    pending: pending as ContextSummaryItem[],
    files: files as ContextSummaryFile[],
    nextStep: nextStep ?? null,
  };
}

const actionStatuses = new Set<SummaryActionStatus>(["completed", "failed", "not_executed", "unknown"]);
const decisionStatuses = new Set<SummaryDecisionStatus>(["confirmed", "proposed", "superseded", "withdrawn"]);

/** Validates model output before it can become an installed summary. */
export function validateContextSummary(value: unknown): value is ContextSummaryV2 {
  if (typeof value !== "object" || value === null || (value as { version?: unknown }).version !== 2) return false;
  const summary = value as ContextSummaryV2;
  if (!item(summary.goal)) return false;
  if (!Array.isArray(summary.constraints) || !summary.constraints.every(item)) return false;
  if (!Array.isArray(summary.pending) || !summary.pending.every(item)) return false;
  if (summary.nextStep !== null && !item(summary.nextStep)) return false;
  if (!Array.isArray(summary.actions) || !summary.actions.every((action) =>
    item(action) && actionStatuses.has(action.status) && Array.isArray(action.toolCallIds) && action.toolCallIds.every(nonEmpty),
  )) return false;
  if (!Array.isArray(summary.decisions) || !summary.decisions.every((decision) =>
    item(decision) && (decision.source === "user" || decision.source === "assistant") && decisionStatuses.has(decision.status),
  )) return false;
  if (!Array.isArray(summary.files) || !summary.files.every((file) =>
    item(file) && nonEmpty(file.path) && nonEmpty(file.purpose),
  )) return false;
  return true;
}

export function parseContextSummary(
  text: string,
  fallbackEvidenceIds: readonly string[] = [],
): ContextSummaryV2 | undefined {
  const extracted = extractJsonObject(text);
  if (extracted === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(extracted);
    const coerced = coerceContextSummary(parsed, fallbackEvidenceIds);
    return coerced !== undefined && validateContextSummary(coerced) ? coerced : undefined;
  } catch {
    return undefined;
  }
}

export function contextSummaryPrompt(input: {
  previousSummary?: ContextSummaryV2;
  messages: readonly UIMessage[];
}): string {
  return [
    "Return one JSON object with version: 2 and keys goal, constraints, decisions, actions, pending, files, nextStep. Do not return a schema or placeholder values.",
    'Start the object with "version": 2. This mandatory top-level field must not be omitted or placed inside goal; an object without it is invalid even when all other fields are correct.',
    "goal is an item {text, evidenceMessageIds}. Each item needs non-empty text and at least one actual message id from the supplied transcript or previous summary. constraints and pending are arrays of items; use [] when there is no evidence. nextStep is an item or null.",
    "decisions, actions, and files use the same item fields (non-empty text and evidenceMessageIds). decisions also need source (user or assistant) and status (confirmed, proposed, superseded, or withdrawn). actions also need status (completed, failed, not_executed, or unknown) and toolCallIds (actual ids, or [] when none). files also need non-empty path and purpose. Use [] for decisions, actions, or files when there is no evidence.",
    "Preserve the newest user goal, constraints, withdrawals, and decisions. Distinguish confirmed user decisions from assistant proposals. Tool statuses must reflect evidence in the transcript; unknown side effects remain unknown. Do not claim current disk state without a tool result.",
    input.previousSummary === undefined ? "Previous summary: none" : `Previous summary:\n${JSON.stringify(input.previousSummary)}`,
    `Transcript to merge:\n${JSON.stringify(input.messages.map(message => ({ ...message, parts: message.parts.map(part => part.type === "file" ? { type: "text", text: `[Attached file: ${part.filename ?? "unnamed"} (${part.mediaType}); bytes omitted. Do not infer its contents.]` } : part) })))}`,
  ].join("\n\n");
}
