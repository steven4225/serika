import type { AgentErrorData } from "./errors.js";
import type { RunStatus, TokenUsage } from "./types.js";

export interface AgentEventDataMap {
  "run.started": { agentId: string; agentVersion: string };
  "message.delta": { text: string };
  "step.started": { stepNumber: number };
  "step.completed": {
    stepNumber: number;
    finishReason: string;
    usage: TokenUsage;
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
