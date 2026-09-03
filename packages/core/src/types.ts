import type { UIMessage } from "ai";
import type { z } from "zod";

export type RunStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type TerminalRunStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled" | "timed_out"
>;

export interface AgentLimits {
  maxSteps: number;
  totalTimeoutMs: number;
  stepTimeoutMs: number;
  maxOutputTokens?: number;
}

export interface AgentDefinition<TContext = unknown> {
  id: string;
  version: string;
  instructions: string;
  model: string;
  tools: readonly string[];
  limits: AgentLimits;
  contextSchema?: z.ZodType<TContext>;
}

export interface RunRequest<TContext = unknown> {
  agentId: string;
  threadId: string;
  messages: UIMessage[];
  context?: TContext;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RunResult {
  runId: string;
  threadId: string;
  status: TerminalRunStatus;
  text: string;
  steps: number;
  usage: TokenUsage;
  error?: import("./errors.js").AgentErrorData;
}

export interface RunHandle {
  runId: string;
  events: AsyncIterable<import("./events.js").AgentEvent>;
  result: Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
}

export interface LoopOutcome {
  text: string;
  messages: UIMessage[];
  steps: number;
  usage: TokenUsage;
  stopReason: "completed" | "approval_required";
}

export interface AgentLoopInput<TContext = unknown> {
  definition: AgentDefinition<TContext>;
  messages: UIMessage[];
  context?: TContext;
  signal: AbortSignal;
  generateId(): string;
  emit: import("./events.js").EmitAgentEvent;
}

export interface AgentLoop {
  execute<TContext>(input: AgentLoopInput<TContext>): Promise<LoopOutcome>;
}
