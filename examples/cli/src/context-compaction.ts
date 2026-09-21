import { streamText, type LanguageModel, type UIMessage } from "ai";
import { durable, type TokenUsage } from "@aisdk-agent/core";

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
  }): Promise<{ text: string; usage?: TokenUsage }>;
}

export function createAiSdkSummarizer(model: LanguageModel): Summarizer {
  return {
    async complete({ prompt, maxOutputTokens, signal }) {
      const result = streamText({
        model,
        system:
          "You are a context compactor. Return only valid JSON matching the requested schema. Do not invent tool results, file writes, permissions, or current disk state.",
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
        ...(usage === undefined
          ? {}
          : {
              usage: {
                ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
                ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
                ...(usage.inputTokens === undefined && usage.outputTokens === undefined
                  ? {}
                  : { totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) }),
              },
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

export function parseContextSummary(text: string): ContextSummaryV2 | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return validateContextSummary(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function contextSummaryPrompt(input: {
  previousSummary?: ContextSummaryV2;
  messages: readonly UIMessage[];
}): string {
  return [
    "Summarize the supplied transcript into this exact JSON shape:",
    JSON.stringify({
      version: 2,
      goal: { text: "", evidenceMessageIds: ["message-id"] },
      constraints: [{ text: "", evidenceMessageIds: ["message-id"] }],
      decisions: [{ text: "", evidenceMessageIds: ["message-id"], source: "user", status: "confirmed" }],
      actions: [{ text: "", evidenceMessageIds: ["message-id"], status: "completed", toolCallIds: ["tool-call-id"] }],
      pending: [{ text: "", evidenceMessageIds: ["message-id"] }],
      files: [{ text: "", evidenceMessageIds: ["message-id"], path: "workspace/path", purpose: "" }],
      nextStep: { text: "", evidenceMessageIds: ["message-id"] },
    }),
    "Preserve the newest user goal, constraints, withdrawals, and decisions. Distinguish confirmed user decisions from assistant proposals. Tool statuses must reflect evidence in the transcript; unknown side effects remain unknown. Do not claim current disk state without a tool result.",
    input.previousSummary === undefined ? "Previous summary: none" : `Previous summary:\n${JSON.stringify(input.previousSummary)}`,
    `Transcript to merge:\n${JSON.stringify(input.messages)}`,
  ].join("\n\n");
}
