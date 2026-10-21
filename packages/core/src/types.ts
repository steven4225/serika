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
  /** Foreground opt-in only; does not change execution limits or permission. */
  enableSteering?: boolean;
}

export interface SteerRequest { id: string; text: string }
export interface SteerResponse {
  id: string;
  status: "accepted" | "not_applied";
  reason?: "closed" | "invalid" | "limit" | "conflict";
}
/** Runtime-owned safe-boundary mailbox. Never aborts an executing tool. */
export interface RunSteering {
  readonly signal: AbortSignal;
  hasPending(): boolean;
  drain(): Promise<SteerRequest[]>;
  applied(request: SteerRequest, messageId: string): Promise<void>;
  sealIfEmpty(): boolean;
  close(reason: string): Promise<void>;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Absent means the provider did not report it, never an inferred zero. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface RunResult {
  runId: string;
  threadId: string;
  status: TerminalRunStatus;
  text: string;
  steps: number;
  usage: TokenUsage;
  error?: import("./errors.js").AgentErrorData;
  /** Optional host-owned completion check; absent for ordinary chat. Not a human quality acceptance. */
  completion?: CompletionReport;
}

export type CompletionReason = "delivered" | "needs_confirmation" | "needs_information" | "budget_exhausted" | "needs_review";
export interface CompletionReport { reason: CompletionReason; corrections: number }
export interface BeforeRunFinishInput extends PrepareModelContextInput {
  runId: string;
  threadId: string;
  text: string;
  steps: number;
  remainingSteps: number;
  corrections: number;
}
export type RunFinishDecision = { kind: "continue"; feedback: string } | { kind: "stop"; reason: CompletionReason };
export type BeforeRunFinish = (input: BeforeRunFinishInput) => RunFinishDecision | undefined | Promise<RunFinishDecision | undefined>;

export interface RunHandle {
  runId: string;
  events: AsyncIterable<import("./events.js").AgentEvent>;
  result: Promise<RunResult>;
  cancel(reason?: string): Promise<void>;
  steer?: (request: SteerRequest) => Promise<SteerResponse>;
}

export interface PrepareModelContextInput {
  contextOverflow?: { inputTokens: number };
  messages: UIMessage[];
  definition: AgentDefinition;
  context?: unknown;
  signal: AbortSignal;
}

export type PrepareModelContext = (
  input: PrepareModelContextInput,
) => UIMessage[] | Promise<UIMessage[]>;

export interface BeforeToolExecuteInput {
  toolName: string;
  toolCallId: string;
  input: unknown;
  definition: AgentDefinition;
  context?: unknown;
  signal: AbortSignal;
  /** Revokes stale approval only; distinct from Run/tool cancellation. */
  steerSignal?: AbortSignal;
}

export type ToolExecutionDecision =
  | { allow: true }
  | { allow: false; reason: string };

export type BeforeToolExecute = (
  input: BeforeToolExecuteInput,
) => ToolExecutionDecision | Promise<ToolExecutionDecision>;

export interface AfterToolCallInput {
  toolName: string;
  toolCallId: string;
  input: unknown;
  output: unknown;
  /** A copy of the messages this Run produced so far (no earlier thread history), ending with this call's result. */
  runMessages: UIMessage[];
  definition: AgentDefinition;
  context?: unknown;
  signal: AbortSignal;
}

/**
 * Hooks return decisions instead of throwing. `feedback` is appended to the next
 * model request's instructions only (never the transcript or events); `stop`
 * ends the Run with RUN_LIMIT_EXCEEDED after this already completed call.
 */
export type AfterToolCallDecision = { kind: "feedback"; text: string } | { kind: "stop"; message: string };

/** Called once after each successfully completed tool call. */
export type AfterToolCall = (
  input: AfterToolCallInput,
) => AfterToolCallDecision | undefined | Promise<AfterToolCallDecision | undefined>;

export interface LoopOutcome {
  text: string;
  messages: UIMessage[];
  steps: number;
  usage: TokenUsage;
  stopReason: "completed" | "approval_required";
  completion?: CompletionReport;
}

export interface AgentLoopInput<TContext = unknown> {
  definition: AgentDefinition<TContext>;
  messages: UIMessage[];
  context?: TContext;
  signal: AbortSignal;
  steering?: RunSteering;
  prepareModelContext?: PrepareModelContext;
  beforeToolExecute?: BeforeToolExecute;
  afterToolCall?: AfterToolCall;
  beforeRunFinish?: (input: Omit<BeforeRunFinishInput, "runId" | "threadId">) => ReturnType<BeforeRunFinish>;
  generateId(): string;
  emit: import("./events.js").EmitAgentEvent;
}

export interface AgentLoop {
  execute<TContext>(input: AgentLoopInput<TContext>): Promise<LoopOutcome>;
}
