import {
  assertJsonValue,
  DurableRepositoryError,
  type ActionResolution,
  type ActionState,
  type ApprovalState,
  type AttemptResolution,
  type AttemptState,
  type ExternalEffect,
  type JsonValue,
  type ReconciliationCaseState,
  type ReconciliationResolution,
  type RunState,
  type RuntimeFailure,
  type StopRequest,
  type ThreadState,
  type TriggerMessage,
  type TurnState,
} from "@aisdk-agent/core/durable";
import type { Selectable } from "kysely";
import type {
  ActionTable,
  ApprovalTable,
  AttemptTable,
  EffectOutboxTable,
  MessageTable,
  ReconciliationCaseTable,
  RunStopRequestTable,
  RunTable,
  ThreadTable,
  TurnTable,
} from "./database.js";

export const JSON_SCHEMA_VERSION = 1;

export function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) invalidRow("Invalid database timestamp");
  return date.toISOString();
}

export function jsonValue(value: unknown, field: string): JsonValue {
  try {
    assertJsonValue(value, field);
  } catch (cause) {
    throw new DurableRepositoryError(
      "DATABASE_ERROR",
      `Invalid JSONB in ${field}`,
      { cause },
    );
  }
  return value;
}

function jsonRecord(value: unknown, field: string): Record<string, JsonValue> {
  const json = jsonValue(value, field);
  if (json === null || Array.isArray(json) || typeof json !== "object") {
    invalidRow(`${field} must be a JSON object`);
  }
  return json as Record<string, JsonValue>;
}

function wrapPayload(value: JsonValue): JsonValue {
  return { value };
}

function unwrapPayload(value: unknown, field: string): JsonValue {
  const record = jsonRecord(value, field);
  if (!("value" in record)) invalidRow(`${field}.value is required`);
  return record.value!;
}

function discriminated<T>(
  value: unknown,
  field: string,
  expectedKind: string,
): T {
  const record = jsonRecord(value, field);
  if (record.kind !== expectedKind) {
    invalidRow(`${field}.kind does not match ${expectedKind}`);
  }
  return record as T;
}

export function mapThread(row: Selectable<ThreadTable>): ThreadState {
  return {
    id: row.id,
    activeRunId: row.active_run_id,
    headMessageId: row.head_message_id,
    version: row.version,
  };
}

export function threadValues(state: ThreadState): Selectable<ThreadTable> {
  return {
    id: state.id,
    active_run_id: state.activeRunId,
    head_message_id: state.headMessageId,
    version: state.version,
  };
}

export function mapRun(
  row: Selectable<RunTable>,
  stopRequests: readonly StopRequest[],
): RunState {
  const terminalError = row.terminal_error === null
    ? null
    : jsonRecord(row.terminal_error, "runs.terminal_error") as unknown as RuntimeFailure;
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status as RunState["status"],
    version: row.version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    baseHeadMessageId: row.base_head_message_id,
    triggerMessageId: row.trigger_message_id,
    execution: {
      agentId: row.agent_id,
      agentVersion: row.agent_version,
      modelId: row.model_id,
      instructionVersion: row.instruction_version,
      toolsetVersion: row.toolset_version,
    },
    limits: {
      deadlineAt: row.deadline_at === null ? null : toIso(row.deadline_at),
      maxTurns: row.max_turns,
      maxActions: row.max_actions,
    },
    stopRequest: stopRequests[0] ?? null,
    laterStopRequests: stopRequests.slice(1),
    terminalError,
  };
}

export function runValues(
  state: RunState,
  idempotency: { clientIdempotencyKey: string | null; requestHash: string },
): Selectable<RunTable> {
  return {
    id: state.id,
    thread_id: state.threadId,
    status: state.status,
    version: state.version,
    created_at: new Date(state.createdAt),
    updated_at: new Date(state.updatedAt),
    base_head_message_id: state.baseHeadMessageId,
    trigger_message_id: state.triggerMessageId,
    agent_id: state.execution.agentId,
    agent_version: state.execution.agentVersion,
    model_id: state.execution.modelId,
    instruction_version: state.execution.instructionVersion,
    toolset_version: state.execution.toolsetVersion,
    deadline_at: state.limits.deadlineAt === null
      ? null
      : new Date(state.limits.deadlineAt),
    max_turns: state.limits.maxTurns,
    max_actions: state.limits.maxActions,
    terminal_error: state.terminalError,
    terminal_error_schema_version: state.terminalError === null
      ? null
      : JSON_SCHEMA_VERSION,
    client_idempotency_key: idempotency.clientIdempotencyKey,
    request_hash: idempotency.requestHash,
  };
}

export function mapStopRequest(
  row: Selectable<RunStopRequestTable>,
): StopRequest {
  return {
    reason: row.reason as StopRequest["reason"],
    requestedAt: toIso(row.requested_at),
    requestedBy: row.requested_by,
    detail: row.detail,
  };
}

export function mapTurn(row: Selectable<TurnTable>): TurnState {
  return {
    id: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    version: row.version,
  };
}

export function turnValues(state: TurnState): Selectable<TurnTable> {
  return {
    id: state.id,
    run_id: state.runId,
    sequence: state.sequence,
    version: state.version,
  };
}

export function mapAction(row: Selectable<ActionTable>): ActionState {
  const input: ActionState["input"] = row.kind === "invoke_model"
    ? {
        kind: "invoke_model",
        modelId: required(row.model_id, "actions.model_id"),
        messageSnapshotId: required(
          row.message_snapshot_id,
          "actions.message_snapshot_id",
        ),
      }
    : {
        kind: "execute_tool",
        toolName: required(row.tool_name, "actions.tool_name"),
        toolCallId: required(row.tool_call_id, "actions.tool_call_id"),
        input: unwrapPayload(row.tool_input, "actions.tool_input"),
        inputHash: required(row.input_hash, "actions.input_hash"),
        replaySafety: required(
          row.replay_safety,
          "actions.replay_safety",
        ) as Extract<ActionState["input"], { kind: "execute_tool" }>["replaySafety"],
        businessIdempotencyKey: row.business_idempotency_key,
      };
  const policy = jsonRecord(row.retry_policy, "actions.retry_policy");
  if (policy.version !== JSON_SCHEMA_VERSION) {
    invalidRow("Unsupported actions.retry_policy version");
  }
  const resolution = row.resolution_kind === null
    ? null
    : discriminated<ActionResolution>(
        row.resolution,
        "actions.resolution",
        row.resolution_kind,
      );
  return {
    id: row.id,
    runId: row.run_id,
    turnId: row.turn_id,
    sequence: row.sequence,
    status: row.status as ActionState["status"],
    version: row.version,
    input,
    retryPolicy: {
      maxAttempts: row.max_attempts,
      baseDelayMs: numberField(policy, "baseDelayMs"),
      maxDelayMs: numberField(policy, "maxDelayMs"),
      backoffFactor: numberField(policy, "backoffFactor"),
      jitterRatio: numberField(policy, "jitterRatio"),
    },
    attemptTimeoutMs: row.attempt_timeout_ms,
    attemptCount: row.attempt_count,
    retryAt: row.retry_at === null ? null : toIso(row.retry_at),
    resolution,
  };
}

export function actionValues(state: ActionState): Selectable<ActionTable> {
  const model = state.input.kind === "invoke_model" ? state.input : null;
  const tool = state.input.kind === "execute_tool" ? state.input : null;
  return {
    id: state.id,
    run_id: state.runId,
    turn_id: state.turnId,
    sequence: state.sequence,
    kind: state.input.kind,
    status: state.status,
    version: state.version,
    model_id: model?.modelId ?? null,
    message_snapshot_id: model?.messageSnapshotId ?? null,
    tool_name: tool?.toolName ?? null,
    tool_call_id: tool?.toolCallId ?? null,
    tool_input: tool === null ? null : wrapPayload(tool.input),
    tool_input_schema_version: tool === null ? null : JSON_SCHEMA_VERSION,
    input_hash: tool?.inputHash ?? null,
    replay_safety: tool?.replaySafety ?? null,
    business_idempotency_key: tool?.businessIdempotencyKey ?? null,
    max_attempts: state.retryPolicy.maxAttempts,
    attempt_count: state.attemptCount,
    attempt_timeout_ms: state.attemptTimeoutMs,
    retry_at: state.retryAt === null ? null : new Date(state.retryAt),
    retry_policy: {
      version: JSON_SCHEMA_VERSION,
      baseDelayMs: state.retryPolicy.baseDelayMs,
      maxDelayMs: state.retryPolicy.maxDelayMs,
      backoffFactor: state.retryPolicy.backoffFactor,
      jitterRatio: state.retryPolicy.jitterRatio,
    },
    resolution_kind: state.resolution?.kind ?? null,
    resolution: state.resolution,
    resolution_schema_version: state.resolution === null
      ? null
      : JSON_SCHEMA_VERSION,
  };
}

export function mapAttempt(row: Selectable<AttemptTable>): AttemptState {
  return {
    id: row.id,
    actionId: row.action_id,
    sequence: row.sequence,
    status: row.status as AttemptState["status"],
    dispatchState: row.dispatch_state as AttemptState["dispatchState"],
    startedAt: toIso(row.started_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    resolution: row.resolution_kind === null
      ? null
      : discriminated<AttemptResolution>(
          row.resolution,
          "attempts.resolution",
          row.resolution_kind,
        ),
    version: row.version,
  };
}

export function attemptValues(state: AttemptState): Selectable<AttemptTable> {
  return {
    id: state.id,
    action_id: state.actionId,
    sequence: state.sequence,
    status: state.status,
    dispatch_state: state.dispatchState,
    started_at: new Date(state.startedAt),
    resolved_at: state.resolvedAt === null ? null : new Date(state.resolvedAt),
    resolution_kind: state.resolution?.kind ?? null,
    resolution: state.resolution,
    resolution_schema_version: state.resolution === null
      ? null
      : JSON_SCHEMA_VERSION,
    version: state.version,
  };
}

export function mapApproval(row: Selectable<ApprovalTable>): ApprovalState {
  return {
    id: row.id,
    runId: row.run_id,
    actionId: row.action_id,
    status: row.status as ApprovalState["status"],
    requestedAt: toIso(row.requested_at),
    expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    resolvedBy: row.resolved_by,
    reason: row.reason,
    actionInputHash: row.action_input_hash,
    version: row.version,
  };
}

export function approvalValues(
  state: ApprovalState,
): Selectable<ApprovalTable> {
  return {
    id: state.id,
    run_id: state.runId,
    action_id: state.actionId,
    status: state.status,
    requested_at: new Date(state.requestedAt),
    expires_at: state.expiresAt === null ? null : new Date(state.expiresAt),
    resolved_at: state.resolvedAt === null ? null : new Date(state.resolvedAt),
    resolved_by: state.resolvedBy,
    reason: state.reason,
    action_input_hash: state.actionInputHash,
    version: state.version,
  };
}

export function mapReconciliation(
  row: Selectable<ReconciliationCaseTable>,
): ReconciliationCaseState {
  const resolution: ReconciliationResolution | null = row.resolution_kind === null
    ? null
    : {
        outcome: row.resolution_kind as ReconciliationResolution["outcome"],
        disposition: row.resolution_disposition as ReconciliationResolution["disposition"],
        output: unwrapPayload(row.resolution_output, "reconciliation_cases.resolution_output"),
        evidence: unwrapPayload(
          row.resolution_evidence,
          "reconciliation_cases.resolution_evidence",
        ),
        resolvedAt: toIso(required(row.resolved_at, "reconciliation_cases.resolved_at")),
        resolvedBy: required(row.resolved_by, "reconciliation_cases.resolved_by"),
      };
  return {
    id: row.id,
    runId: row.run_id,
    actionId: row.action_id,
    attemptId: row.attempt_id,
    status: row.status as ReconciliationCaseState["status"],
    dispatchState: row.dispatch_state as ReconciliationCaseState["dispatchState"],
    actionInputHash: row.action_input_hash,
    businessIdempotencyKey: row.business_idempotency_key,
    openedAt: toIso(row.opened_at),
    resolution,
    version: row.version,
  };
}

export function reconciliationValues(
  state: ReconciliationCaseState,
): Selectable<ReconciliationCaseTable> {
  return {
    id: state.id,
    run_id: state.runId,
    action_id: state.actionId,
    attempt_id: state.attemptId,
    status: state.status,
    dispatch_state: state.dispatchState,
    action_input_hash: state.actionInputHash,
    business_idempotency_key: state.businessIdempotencyKey,
    opened_at: new Date(state.openedAt),
    resolution_kind: state.resolution?.outcome ?? null,
    resolution_disposition: state.resolution?.disposition ?? null,
    resolution_output: state.resolution === null
      ? null
      : wrapPayload(state.resolution.output),
    resolution_evidence: state.resolution === null
      ? null
      : wrapPayload(state.resolution.evidence),
    resolved_at: state.resolution === null
      ? null
      : new Date(state.resolution.resolvedAt),
    resolved_by: state.resolution?.resolvedBy ?? null,
    resolution_schema_version: state.resolution === null
      ? null
      : JSON_SCHEMA_VERSION,
    version: state.version,
  };
}

export function mapMessage(
  row: Selectable<MessageTable>,
): TriggerMessage<JsonValue> {
  if (row.role !== "user") invalidRow("Trigger message role must be user");
  return {
    id: row.id,
    threadId: row.thread_id,
    parentMessageId: row.parent_message_id,
    createdByRunId: row.created_by_run_id,
    role: "user",
    content: unwrapPayload(row.content, "messages.content"),
    createdAt: toIso(row.created_at),
  };
}

export function messageValues(
  message: TriggerMessage<JsonValue>,
): Selectable<MessageTable> {
  return {
    id: message.id,
    thread_id: message.threadId,
    parent_message_id: message.parentMessageId,
    created_by_run_id: message.createdByRunId,
    role: message.role,
    content: wrapPayload(message.content),
    content_schema_version: JSON_SCHEMA_VERSION,
    created_at: new Date(message.createdAt),
  };
}

export function effectValues(
  effect: ExternalEffect,
  createdAt: string,
): Selectable<EffectOutboxTable> {
  return {
    attempt_id: effect.attemptId,
    run_id: effect.runId,
    action_id: effect.actionId,
    effect_kind: effect.kind,
    payload: effect,
    payload_schema_version: JSON_SCHEMA_VERSION,
    created_at: new Date(createdAt),
  };
}

export function mapEffect(row: Selectable<EffectOutboxTable>): ExternalEffect {
  return discriminated<ExternalEffect>(
    row.payload,
    "effect_outbox.payload",
    row.effect_kind,
  );
}

function required<T>(value: T | null, field: string): T {
  if (value === null) invalidRow(`${field} is required`);
  return value;
}

function numberField(record: Record<string, JsonValue>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRow(`actions.retry_policy.${field} must be a number`);
  }
  return value;
}

function invalidRow(message: string): never {
  throw new DurableRepositoryError("DATABASE_ERROR", message);
}
