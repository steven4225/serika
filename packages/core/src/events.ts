import type { AgentErrorData } from "./errors.js";
import type { RunStatus, TokenUsage, CompletionReason } from "./types.js";

export interface AgentEventDataMap {
  "run.steer.accepted": { id: string; text: string };
  "run.steer.applied": { id: string; messageId: string };
  "run.steer.not_applied": { id: string; reason: string };
  "tool.call.superseded": { toolCallId: string; toolName: string; reason: "steer" };
  "run.started": { agentId: string; agentVersion: string };
  "message.delta": { text: string };
  "step.started": { stepNumber: number };
  "step.completed": {
    stepNumber: number;
    finishReason: string;
    usage: TokenUsage;
  };
  "model.retry.scheduled": {
    stepNumber: number;
    nextAttempt: number;
    maxAttempts: number;
    delayMs: number;
    error: AgentErrorData;
  };
  "tool.call.requested": {
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
  "tool.call.approval_required": {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    input: unknown;
  };
  "tool.call.started": { toolCallId: string; toolName: string };
  "tool.call.completed": {
    toolCallId: string;
    toolName: string;
    output: unknown;
  };
  "tool.call.failed": {
    toolCallId: string;
    toolName: string;
    error: AgentErrorData;
  };
  "usage.updated": { usage: TokenUsage };
  "run.completion.checked": { decision: "continue" | "stop"; reason?: CompletionReason; corrections: number };
  "run.completed": { text: string; steps: number; usage: TokenUsage };
  "run.failed": { error: AgentErrorData };
  "run.cancelled": { reason?: string };
  "run.timed_out": { timeoutMs: number };
}

export type AgentEventType = keyof AgentEventDataMap;

export type AgentEvent = {
  [TType in AgentEventType]: {
    id: string;
    type: TType;
    occurredAt: string;
    runId: string;
    threadId: string;
    sequence: number;
    data: AgentEventDataMap[TType];
  };
}[AgentEventType];

export type EmitAgentEvent = <TType extends AgentEventType>(
  type: TType,
  data: AgentEventDataMap[TType],
) => Promise<void>;

export const terminalStatuses = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
