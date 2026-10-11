import type { AgentEvent, TokenUsage } from "@aisdk-agent/core";

export const TRACE_MAX_EVENTS = 128;
export const TRACE_MAX_BYTES = 24 * 1024;
export type TraceEventType = "step.started" | "step.completed" | "model.retry.scheduled"
  | "tool.call.approval_required" | "run.completion.checked";
/** Metadata only. Never persist deltas, prompts, reasoning or duplicate tool payloads. */
export interface ExecutionTraceEvent {
  type: TraceEventType;
  sequence: number;
  occurredAt: string;
  stepNumber?: number;
  finishReason?: string;
  usage?: TokenUsage;
  toolCallId?: string;
  nextAttempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorCode?: string;
  decision?: "continue" | "stop";
  reason?: string;
  corrections?: number;
}
export interface ExecutionTrace {
  version: 1;
  events: ExecutionTraceEvent[];
  truncated: boolean;
  /** An optional metadata write failed; later persisted receipts remain authoritative. */
  incomplete: boolean;
  usage?: TokenUsage;
  steps?: number;
}

export function compactTraceEvent(event: AgentEvent): ExecutionTraceEvent | null {
  const base = { sequence: event.sequence, occurredAt: event.occurredAt };
  switch (event.type) {
    case "step.started": return { ...base, type: event.type, stepNumber: event.data.stepNumber };
    case "step.completed": return { ...base, type: event.type, stepNumber: event.data.stepNumber,
      finishReason: event.data.finishReason.slice(0, 80), usage: event.data.usage };
    case "model.retry.scheduled": return { ...base, type: event.type, stepNumber: event.data.stepNumber,
      nextAttempt: event.data.nextAttempt, maxAttempts: event.data.maxAttempts, delayMs: event.data.delayMs,
      errorCode: event.data.error.code.slice(0, 80) };
    case "tool.call.approval_required": return { ...base, type: event.type, toolCallId: event.data.toolCallId };
    case "run.completion.checked": return { ...base, type: event.type, decision: event.data.decision,
      corrections: event.data.corrections, ...(event.data.reason ? { reason: event.data.reason } : {}) };
    default: return null;
  }
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const positive = (v: unknown) => natural(v) && v > 0;
const short = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 80;
export function validTraceUsage(v: unknown): v is TokenUsage {
  return object(v) && Object.keys(v).every(k => ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens"].includes(k) && natural(v[k]));
}
export function validTrace(v: unknown): v is ExecutionTrace {
  if (!object(v) || v.version !== 1 || typeof v.truncated !== "boolean" || typeof v.incomplete !== "boolean" ||
      !Array.isArray(v.events) || v.events.length > TRACE_MAX_EVENTS ||
      Buffer.byteLength(JSON.stringify(v.events)) > TRACE_MAX_BYTES ||
      Object.keys(v).some(k => !["version", "events", "truncated", "incomplete", "usage", "steps"].includes(k)) ||
      (v.usage !== undefined && !validTraceUsage(v.usage)) || (v.steps !== undefined && !natural(v.steps))) return false;
  const sequences = new Set<number>();
  return v.events.every(e => {
    if (!object(e) || !positive(e.sequence) || sequences.has(e.sequence as number) ||
        typeof e.occurredAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.occurredAt) ||
        Number.isNaN(Date.parse(e.occurredAt)) || new Date(e.occurredAt).toISOString() !== e.occurredAt) return false;
    sequences.add(e.sequence as number);
    let fields: string[];
    let valid: boolean;
    switch (e.type) {
      case "step.started": fields = ["stepNumber"]; valid = positive(e.stepNumber); break;
      case "step.completed": fields = ["stepNumber", "finishReason", "usage"];
        valid = positive(e.stepNumber) && short(e.finishReason) && validTraceUsage(e.usage); break;
      case "model.retry.scheduled": fields = ["stepNumber", "nextAttempt", "maxAttempts", "delayMs", "errorCode"];
        valid = positive(e.stepNumber) && positive(e.nextAttempt) && positive(e.maxAttempts) &&
          (e.nextAttempt as number) <= (e.maxAttempts as number) && natural(e.delayMs) && short(e.errorCode); break;
      case "tool.call.approval_required": fields = ["toolCallId"];
        valid = typeof e.toolCallId === "string" && e.toolCallId.length > 0 && e.toolCallId.length <= 256; break;
      case "run.completion.checked": fields = ["decision", "reason", "corrections"];
        valid = ["continue", "stop"].includes(String(e.decision)) && natural(e.corrections) &&
          (e.reason === undefined || ["delivered", "needs_confirmation", "needs_information", "budget_exhausted", "needs_review"].includes(String(e.reason))); break;
      default: return false;
    }
    return valid && Object.keys(e).every(k => ["type", "sequence", "occurredAt", ...fields].includes(k));
  });
}
