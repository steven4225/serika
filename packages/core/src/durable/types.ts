export type IsoTimestamp = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type RunStatus =
  | "ready"
  | "executing"
  | "waiting_approval"
  | "waiting_retry"
  | "requires_reconciliation"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type TerminalRunStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled" | "timed_out"
>;

export type ActionStatus =
  | "ready"
  | "executing"
  | "waiting_approval"
  | "waiting_retry"
  | "requires_reconciliation"
  | "resolved";

export type ActionKind = "invoke_model" | "execute_tool";

export type ToolReplaySafety =
  | "read_only"
  | "naturally_idempotent"
  | "idempotency_keyed"
  | "non_idempotent";

export interface RetryPolicySnapshot {
  /** Includes the first execution. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterRatio: number;
}

export interface RunLimitsSnapshot {
  deadlineAt: IsoTimestamp | null;
  maxTurns: number;
  maxActions: number;
}

export interface AgentExecutionSnapshot {
  agentId: string;
  agentVersion: string;
  modelId: string;
  instructionVersion: string;
  toolsetVersion: string;
}

export interface StopRequest {
  reason: "cancel" | "deadline";
  requestedAt: IsoTimestamp;
  requestedBy: string;
  detail: string | null;
}

export interface ThreadState {
  id: string;
  activeRunId: string | null;
  headMessageId: string | null;
  version: number;
}

export interface RunState {
  id: string;
  threadId: string;
  status: RunStatus;
  version: number;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  baseHeadMessageId: string | null;
  triggerMessageId: string;
  execution: AgentExecutionSnapshot;
  limits: RunLimitsSnapshot;
  stopRequest: StopRequest | null;
  laterStopRequests: readonly StopRequest[];
  terminalError: RuntimeFailure | null;
}

export interface TurnState {
  id: string;
  runId: string;
  sequence: number;
  version: number;
}

export interface ModelActionInput {
  kind: "invoke_model";
  modelId: string;
  messageSnapshotId: string;
}

export interface ToolActionInput {
  kind: "execute_tool";
  toolName: string;
  toolCallId: string;
  input: JsonValue;
  inputHash: string;
  replaySafety: ToolReplaySafety;
  businessIdempotencyKey: string | null;
}

export type ActionInput = ModelActionInput | ToolActionInput;

export type NotExecutedReason =
  | "approval_rejected"
  | "approval_expired"
  | "run_cancelled"
  | "run_timed_out"
  | "effect_not_applied";

export type ActionResolution =
  | {
      kind: "model_result";
      outcome: "final_answer" | "tool_calls";
      output: JsonValue;
    }
  | {
      kind: "tool_result";
      isError: boolean;
      output: JsonValue;
      source: "attempt" | "reconciliation";
    }
  | {
      kind: "not_executed";
      reason: NotExecutedReason;
    }
  | {
      kind: "runtime_failure";
      failure: RuntimeFailure;
    };

export interface ActionState {
  id: string;
  runId: string;
  turnId: string;
  sequence: number;
  status: ActionStatus;
  version: number;
  input: ActionInput;
  retryPolicy: RetryPolicySnapshot;
  attemptTimeoutMs: number;
  attemptCount: number;
  retryAt: IsoTimestamp | null;
  resolution: ActionResolution | null;
}

export type AttemptDispatchState =
  | "not_dispatched"
  | "dispatched"
  | "response_received"
  | "unknown";

export interface RuntimeFailure {
  code: string;
  message: string;
  retryable: boolean;
}

export type AttemptResolution =
  | {
      kind: "completed";
      output:
        | {
            kind: "model";
            outcome: "final_answer" | "tool_calls";
            value: JsonValue;
          }
        | {
            kind: "tool";
            isError: boolean;
            value: JsonValue;
          };
    }
  | {
      /** The adapter can prove that the external Effect was not applied. */
      kind: "not_applied";
      failure: RuntimeFailure;
    }
  | {
      kind: "safely_aborted";
      reason: "cancel" | "deadline";
    }
  | {
      kind: "interrupted";
      failure: RuntimeFailure;
    }
  | {
      kind: "outcome_unknown";
      failure: RuntimeFailure;
    };

export interface AttemptState {
  id: string;
  actionId: string;
  sequence: number;
  status: "started" | "resolved";
  dispatchState: AttemptDispatchState;
  startedAt: IsoTimestamp;
  resolvedAt: IsoTimestamp | null;
  resolution: AttemptResolution | null;
  version: number;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

export interface ApprovalState {
  id: string;
  runId: string;
  actionId: string;
  status: ApprovalStatus;
  requestedAt: IsoTimestamp;
  expiresAt: IsoTimestamp | null;
  resolvedAt: IsoTimestamp | null;
  resolvedBy: string | null;
  reason: string | null;
  actionInputHash: string;
  version: number;
}

export type ReconciliationObservedOutcome =
  | "effect_succeeded"
  | "effect_failed"
  | "effect_not_applied";

export interface ReconciliationResolution {
  outcome: ReconciliationObservedOutcome;
  disposition: "retry" | "return_error" | null;
  output: JsonValue;
  evidence: JsonValue;
  resolvedAt: IsoTimestamp;
  resolvedBy: string;
}

export interface ReconciliationCaseState {
  id: string;
  runId: string;
  actionId: string;
  attemptId: string;
  status: "open" | "resolved";
  dispatchState: Extract<AttemptDispatchState, "dispatched" | "unknown">;
  actionInputHash: string;
  businessIdempotencyKey: string | null;
  openedAt: IsoTimestamp;
  resolution: ReconciliationResolution | null;
  version: number;
}

/**
 * A transaction-sized projection loaded by the Runtime for one active Action.
 * Historical Turns, Actions, Attempts and messages remain in their own stores.
 */
export interface RuntimeSnapshot {
  thread: ThreadState;
  run: RunState;
  turn: TurnState;
  action: ActionState;
  attempt: AttemptState | null;
  approval: ApprovalState | null;
  reconciliation: ReconciliationCaseState | null;
}

export type ExternalEffect =
  | {
      kind: "invoke_model";
      runId: string;
      turnId: string;
      actionId: string;
      attemptId: string;
      modelId: string;
      messageSnapshotId: string;
      timeoutMs: number;
    }
  | {
      kind: "execute_tool";
      runId: string;
      turnId: string;
      actionId: string;
      attemptId: string;
      toolsetVersion: string;
      toolName: string;
      toolCallId: string;
      input: JsonValue;
      businessIdempotencyKey: string | null;
      timeoutMs: number;
    };

export type DurableCommand =
  | {
      type: "start_action";
      now: IsoTimestamp;
      attemptId: string;
    }
  | {
      type: "record_dispatch";
      now: IsoTimestamp;
      attemptId: string;
      dispatchState: Exclude<AttemptDispatchState, "not_dispatched">;
    }
  | {
      /** Rechecks stop/deadline and atomically crosses the dispatch boundary. */
      type: "prepare_dispatch";
      now: IsoTimestamp;
      attemptId: string;
    }
  | {
      type: "resume_undispatched_attempt";
      now: IsoTimestamp;
      attemptId: string;
    }
  | {
      type: "resolve_attempt";
      now: IsoTimestamp;
      attemptId: string;
      resolution: AttemptResolution;
      /** Precomputed durable schedule; required only when a retry is selected. */
      retryAt?: IsoTimestamp;
      /** Runtime-provided identity; required when reconciliation is selected. */
      reconciliationId?: string;
    }
  | {
      type: "resolve_approval";
      now: IsoTimestamp;
      approvalId: string;
      decision: "approved" | "rejected";
      resolvedBy: string;
      reason?: string;
    }
  | {
      type: "expire_approval";
      now: IsoTimestamp;
      approvalId: string;
      resolvedBy: string;
    }
  | {
      type: "wake_retry";
      now: IsoTimestamp;
      actionId: string;
    }
  | {
      type: "request_stop";
      request: StopRequest;
    }
  | {
      type: "resolve_reconciliation";
      now: IsoTimestamp;
      reconciliationId: string;
      resolvedBy: string;
      evidence: JsonValue;
      outcome:
        | { kind: "effect_succeeded"; output: JsonValue }
        | { kind: "effect_failed"; error: JsonValue }
        | {
            kind: "effect_not_applied";
            disposition: "retry" | "return_error";
            error?: JsonValue;
          };
    };

export interface DurableDecision {
  events: readonly DurableEvent[];
  effects: readonly ExternalEffect[];
}

export type DurableEvent =
  | {
      type: "action_started";
      at: IsoTimestamp;
      attempt: AttemptState;
    }
  | {
      type: "attempt_dispatch_recorded";
      at: IsoTimestamp;
      attemptId: string;
      dispatchState: Exclude<AttemptDispatchState, "not_dispatched">;
    }
  | {
      type: "attempt_resolved";
      at: IsoTimestamp;
      attemptId: string;
      resolution: AttemptResolution;
      actionResolution: ActionResolution | null;
      nextRunStatus:
        | "ready"
        | "completed"
        | "failed"
        | "cancelled"
        | "timed_out";
      failure: RuntimeFailure | null;
    }
  | {
      type: "retry_scheduled";
      at: IsoTimestamp;
      attemptId: string;
      resolution: AttemptResolution;
      retryAt: IsoTimestamp;
    }
  | {
      type: "reconciliation_opened";
      at: IsoTimestamp;
      attemptId: string;
      resolution: AttemptResolution;
      reconciliation: ReconciliationCaseState;
    }
  | {
      type: "approval_resolved";
      at: IsoTimestamp;
      approvalId: string;
      status: Exclude<ApprovalStatus, "pending" | "cancelled">;
      resolvedBy: string;
      reason: string | null;
      actionResolution: ActionResolution | null;
    }
  | {
      type: "approval_cancelled_by_stop";
      at: IsoTimestamp;
      approvalId: string;
      resolvedBy: string;
      reason: string;
      terminalStatus: Extract<TerminalRunStatus, "cancelled" | "timed_out">;
    }
  | {
      type: "retry_woken";
      at: IsoTimestamp;
      actionId: string;
    }
  | {
      type: "stop_requested";
      at: IsoTimestamp;
      request: StopRequest;
      isPrimary: boolean;
    }
  | {
      type: "run_stopped_without_execution";
      at: IsoTimestamp;
      terminalStatus: Extract<TerminalRunStatus, "cancelled" | "timed_out">;
      actionResolution: ActionResolution;
    }
  | {
      type: "run_limit_exceeded";
      at: IsoTimestamp;
      limit: "max_turns" | "max_actions";
      failure: RuntimeFailure;
    }
  | {
      type: "reconciliation_resolved";
      at: IsoTimestamp;
      reconciliationId: string;
      resolution: ReconciliationResolution;
      actionResolution: ActionResolution | null;
      nextRunStatus: "ready" | "cancelled" | "timed_out";
    };
