import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { acquireFlock } from "./flock.js";
import { creationReceipt, readCreationReceipt, type CreationReceipt } from "./creation-idempotency.js";
import { latestOccurrence, nextOccurrence, type Recurrence } from "./recurrence.js";
import { arrangementNeedsAttention, arrangementSettlement, arrangementWaiting, taskLifecycleStatuses, type TaskLifecycleStatus } from "./task-lifecycle.js";
import { readStoredWorkTask, WORK_TASK_MAX_ENTRIES, WorkTaskStoreError, type WorkTask } from "./work-task-store.js";
import { abortReason, throwIfAborted } from "./workspace-path.js";

export const TASK_WORKER_LOCK_FILE_NAME = "task-worker.lock";
export const TASK_PROMPT_MAX_BYTES = 16 * 1024;
export const TASK_LIST_DEFAULT_LIMIT = 20;
export const TASK_LIST_MAX_LIMIT = 50;
export const TASK_PREVIEW_MAX_CHARACTERS = 120;
export const RSS_DIGEST_TASK_PROMPT = "[runloom:rss-digest:v1] 定期 RSS 资讯简报：仅整理程序提供的订阅快照，不猜测当前新闻。";

export const taskStatuses = taskLifecycleStatuses;
export type TaskStatus = TaskLifecycleStatus;
export const TASK_FILE_MAX_BYTES = 16 * 1024 * 1024;
const legacyTaskStatuses = ["scheduled", "running", "completed", "failed", "cancelled", "interrupted"] as const;
export type LegacyTaskStatus = (typeof legacyTaskStatuses)[number];

export interface TaskError {
  code: string;
  message: string;
}

export type TaskArrangement =
  | { kind: "reminder"; source: "none"; notification: "always"; declarationVersion: 1 }
  | { kind: "todoist-brief"; source: "todoist-planning"; notification: "always"; declarationVersion: 1 }
  | { kind: "rss-digest"; source: "existing-rss-binding"; notification: "new-items"; declarationVersion: 1 }
  | { kind: "skill"; source: "none"; notification: "always"; declarationVersion: 1; skillId: string; skillHash: string };

export interface TaskRecord {
  kind: "arrangement";
  id: string;
  prompt: string;
  runAt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  threadId: string | null;
  runId: string | null;
  resultText: string | null;
  error: TaskError | null;
  /** Null for one-time tasks; present on v2 records. */
  recurringTaskId?: string | null;
  /** Host-confirmed arrangement. Absence retains the legacy scheduled responder. */
  arrangement?: TaskArrangement;
  /** No model Run exists for a deterministic reminder or empty RSS outcome. */
  execution?: "deterministic";
}

export interface TaskRecordV2 extends TaskRecord {
  recurringTaskId: string | null;
}

export interface TaskRecordV3 extends TaskRecordV2 {
  /** Null for legacy and newly-created tasks; set when an inbox item is acknowledged. */
  acknowledgedAt: string | null;
}

export const TASK_MAX_ATTEMPTS = 3;
export const TASK_MAX_NOTIFICATION_ATTEMPTS = 3;
export interface TaskAttempt {
  number: number;
  runId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
  error: TaskError | null;
}
export interface TaskNotification {
  status: "pending" | "submitted" | "failed" | "omitted";
  attempts: number;
  nextAttemptAt: string | null;
  error: TaskError | null;
}
/** `omitted` means the desktop was frontmost, so no system notification was submitted. */
export type TaskNotificationRecord =
  | { ok: true; delivery?: "omitted" }
  | { ok: false; error: TaskError; nextAttemptAt: string | null };
export interface TaskRecordV4 extends TaskRecordV3 {
  creation?: CreationReceipt;
  attempts: TaskAttempt[];
  retryAt: string | null;
  notification: TaskNotification | null;
  pendingOutcome: TaskFinish | null;
}
export interface TaskDocumentV4 {
  version: 4;
  tasks: LegacyTaskRecord[];
  recurringTasks: RecurringTaskRecord[];
}

export type LegacyTaskRecord = Omit<TaskRecordV4, "kind" | "status"> & { status: LegacyTaskStatus };

export interface TaskDocumentV5 {
  version: 5;
  tasks: Array<TaskRecordV4 | WorkTask>;
  recurringTasks: RecurringTaskRecord[];
}

export interface TaskDocumentV1 {
  version: 1;
  tasks: TaskRecord[];
}

export interface TaskDocumentV2 {
  version: 2;
  tasks: TaskRecordV2[];
  recurringTasks: RecurringTaskRecord[];
}

export interface TaskDocumentV3 {
  version: 3;
  tasks: TaskRecordV3[];
  recurringTasks: RecurringTaskRecord[];
}

// Runtime reads and writes only v5. Older task files are an offline upgrade input.
export type TaskDocument = TaskDocumentV5;

export type RecurringTaskStatus = "active" | "paused" | "cancelled";

export interface RecurringTaskRecord {
  creation?: CreationReceipt;
  id: string;
  prompt: string;
  recurrence: Recurrence;
  status: RecurringTaskStatus;
  createdAt: string;
  nextRunAt: string | null;
  arrangement?: TaskArrangement;
}

export interface CreateRecurringTaskInput {
  operationId?: string;
  prompt: string;
  recurrence: Recurrence;
  arrangement?: TaskArrangement;
}

export interface RecurringTaskListInput {
  status?: RecurringTaskStatus;
  limit?: number;
}

export interface RecurringTaskSummary {
  id: string;
  promptPreview: string;
  recurrence: Recurrence;
  status: RecurringTaskStatus;
  nextRunAt: string | null;
  arrangement?: TaskArrangement;
}

export interface RecurringTaskList {
  recurringTasks: RecurringTaskSummary[];
  truncated: boolean;
}

export interface RecurringTaskDetail {
  recurringTask: RecurringTaskRecord;
  latestTask: TaskRecordV4 | null;
}

export interface CreateTaskInput {
  operationId?: string;
  prompt: string;
  runAt: string;
  arrangement?: TaskArrangement;
}

export interface TaskSummary {
  id: string;
  promptPreview: string;
  runAt: string;
  status: TaskStatus;
  finishedAt: string | null;
  resultPreview: string | null;
  error: {
    code: string;
    messagePreview: string;
  } | null;
  recurringTaskId?: string | null;
  arrangement?: TaskArrangement;
  /** Preserved attempt fact when lifecycle is pending after failure or interruption. */
  settlement?: "failed" | "interrupted";
}

export interface TaskSummaryV3 extends TaskSummary {
  acknowledgedAt: string | null;
}

export type TaskListStatusFilter = TaskStatus | "attention";

export interface TaskListInput {
  status?: TaskListStatusFilter;
  limit?: number;
  recurringTaskId?: string;
  inbox?: boolean;
  /** Read-only keyset pagination for trusted delivery scans; tools need not expose it. */
  before?: { createdAt: string; id: string };
}

export interface TaskList {
  tasks: TaskSummary[];
  truncated: boolean;
}

export interface TaskListV3 {
  tasks: TaskSummaryV3[];
  truncated: boolean;
  nextCursor?: { createdAt: string; id: string };
}

export type TaskFinish =
  | {
      status: "completed";
      runId: string;
      resultText: string;
      notification?: boolean;
    }
  | {
      status: "completed";
      runId: null;
      execution: "deterministic";
      resultText: string;
      notification?: boolean;
    }
  | {
      status: "failed" | "interrupted";
      runId: string | null;
      error: TaskError;
      notification?: boolean;
    };

export const taskStoreErrorCodes = [
  "INVALID_INPUT",
  "TASK_NOT_FOUND",
  "TASK_NOT_CANCELLABLE",
  "TASK_NOT_RESCHEDULABLE",
  "TASK_NOT_ACKNOWLEDGEABLE",
  "TASK_FILE_INVALID",
  "TASK_VERSION_UNSUPPORTED",
  "TASK_MIGRATION_REQUIRED",
  "RECURRING_TASK_NOT_FOUND",
  "RECURRING_TASK_CANCELLED",
  "READ_FAILED",
  "WRITE_FAILED",
  "COMMIT_UNCERTAIN",
] as const;

export type TaskStoreErrorCode = (typeof taskStoreErrorCodes)[number];

export interface TaskFailure {
  ok: false;
  error: { code: TaskStoreErrorCode; message: string };
}

export type TaskStoreResult<T> = { ok: true; value: T } | TaskFailure;

export interface TaskStore {
  getHealthCounts(): Promise<TaskStoreResult<{ unacknowledgedCount: number; notificationFailureCount: number }>>;
  recordOutcome(id: string, outcome: TaskFinish): Promise<TaskStoreResult<TaskRecordV4>>;
  listRunning(): Promise<TaskStoreResult<TaskRecordV4[]>>;
  recordRunId(id: string, runId: string): Promise<TaskStoreResult<TaskRecordV4>>;
  retry(id: string, input: { error: TaskError; runId: string | null; nextRunAt: string }): Promise<TaskStoreResult<TaskRecordV4>>;
  listNotifications(now?: number): Promise<TaskStoreResult<TaskRecordV4[]>>;
  recordNotification(id: string, outcome: TaskNotificationRecord): Promise<TaskStoreResult<TaskRecordV4>>;
  create(input: CreateTaskInput, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecordV4>>;
  list(input?: TaskListInput): Promise<TaskStoreResult<TaskListV3>>;
  get(id: string): Promise<TaskStoreResult<TaskRecordV4>>;
  cancel(id: string, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecordV4>>;
  reschedule(id: string, runAt: string, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecordV4>>;
  acknowledge(id: string, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecordV4>>;
  claimNextDue(signal?: AbortSignal): Promise<TaskStoreResult<TaskRecordV4 | null>>;
  finish(id: string, outcome: TaskFinish, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecordV4>>;
  interruptRunning(signal?: AbortSignal): Promise<TaskStoreResult<number>>;
  listRecurring: (input?: RecurringTaskListInput) => Promise<TaskStoreResult<RecurringTaskList>>;
  createRecurring: (
    input: CreateRecurringTaskInput,
    signal?: AbortSignal,
  ) => Promise<TaskStoreResult<RecurringTaskRecord>>;
  getRecurring: (id: string) => Promise<TaskStoreResult<RecurringTaskDetail>>;
  pauseRecurring: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<TaskStoreResult<RecurringTaskRecord>>;
  resumeRecurring: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<TaskStoreResult<RecurringTaskRecord>>;
  cancelRecurring: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<TaskStoreResult<RecurringTaskRecord>>;
}

export interface TaskStoreOptions {
  now?: () => number;
  generateId?: () => string;
}

export class TaskStoreError extends Error {
  readonly code: TaskStoreErrorCode;

  constructor(code: TaskStoreErrorCode, message: string) {
    super(message);
    this.name = "TaskStoreError";
    this.code = code;
  }
}

const neverAborted = new AbortController().signal;
const storedTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const inputDatePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
const taskStatusSet = new Set<TaskStatus>(taskStatuses);
const legacyTaskStatusSet = new Set<LegacyTaskStatus>(legacyTaskStatuses);

function fail(code: TaskStoreErrorCode, message: string): TaskFailure {
  return { ok: false, error: { code, message } };
}

function raise(code: TaskStoreErrorCode, message: string): never {
  throw new TaskStoreError(code, message);
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && taskStatusSet.has(value as TaskStatus);
}

function isLegacyTaskStatus(value: unknown): value is LegacyTaskStatus {
  return typeof value === "string" && legacyTaskStatusSet.has(value as LegacyTaskStatus);
}

function cloneError(error: TaskError | null): TaskError | null {
  return error === null ? null : { ...error };
}

function cloneRecord(record: TaskRecordV4): TaskRecordV4 {
  return { ...record, error: cloneError(record.error),
    ...(record.creation ? { creation: { ...record.creation } } : {}),
    ...(record.arrangement ? { arrangement: { ...record.arrangement } } : {}),
    attempts: record.attempts.map((attempt) => ({ ...attempt, error: cloneError(attempt.error) })),
    notification: record.notification === null ? null : { ...record.notification, error: cloneError(record.notification.error) },
    pendingOutcome: record.pendingOutcome === null ? null : structuredClone(record.pendingOutcome) };
}

function cloneRecurrence(recurrence: Recurrence): Recurrence {
  return { ...recurrence };
}

function cloneRecurringTask(record: RecurringTaskRecord): RecurringTaskRecord {
  return { ...record, recurrence: cloneRecurrence(record.recurrence),
    ...(record.creation ? { creation: { ...record.creation } } : {}),
    ...(record.arrangement ? { arrangement: { ...record.arrangement } } : {}) };
}

export function validateTaskArrangement(value: unknown): TaskArrangement {
  if (!isObject(value) || Object.keys(value).some(key => !["kind", "source", "notification", "declarationVersion", ...(value.kind === "skill" ? ["skillId", "skillHash"] : [])].includes(key)) || value.declarationVersion !== 1) {
    raise("INVALID_INPUT", "Invalid task arrangement declaration");
  }
  if (value.kind === "reminder" && value.source === "none" && value.notification === "always") return { kind: value.kind, source: value.source, notification: value.notification, declarationVersion: 1 };
  if (value.kind === "todoist-brief" && value.source === "todoist-planning" && value.notification === "always") return { kind: value.kind, source: value.source, notification: value.notification, declarationVersion: 1 };
  if (value.kind === "rss-digest" && value.source === "existing-rss-binding" && value.notification === "new-items") return { kind: value.kind, source: value.source, notification: value.notification, declarationVersion: 1 };
  if (value.kind === "skill" && value.source === "none" && value.notification === "always" &&
      typeof value.skillId === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value.skillId) &&
      typeof value.skillHash === "string" && /^[a-f0-9]{64}$/.test(value.skillHash)) {
    return { kind: value.kind, source: value.source, notification: value.notification, declarationVersion: 1, skillId: value.skillId, skillHash: value.skillHash };
  }
  raise("INVALID_INPUT", "Task source and notification must match the declared arrangement");
}

function storedArrangement(value: unknown): TaskArrangement | undefined {
  if (value === undefined) return undefined;
  try { return validateTaskArrangement(value); }
  catch { raise("TASK_FILE_INVALID", "Invalid stored task arrangement"); }
}

function allowsDeterministic(task: { prompt?: unknown; arrangement?: unknown; recurringTaskId?: unknown }): boolean {
  return (isObject(task.arrangement) && task.arrangement.kind === "reminder") ||
    (task.prompt === RSS_DIGEST_TASK_PROMPT && typeof task.recurringTaskId === "string" && task.recurringTaskId.length > 0);
}

function preview(value: string): string {
  return Array.from(value).slice(0, TASK_PREVIEW_MAX_CHARACTERS).join("");
}

function validatePrompt(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    raise("INVALID_INPUT", "Task prompt must not be blank");
  }
  if (Buffer.byteLength(value, "utf8") > TASK_PROMPT_MAX_BYTES) {
    raise(
      "INVALID_INPUT",
      `Task prompt exceeds the ${TASK_PROMPT_MAX_BYTES}-byte limit`,
    );
  }
}

function validateStoredPrompt(value: unknown): asserts value is string {
  try {
    validatePrompt(value);
  } catch (error) {
    if (error instanceof TaskStoreError && error.code === "INVALID_INPUT") {
      raise("TASK_FILE_INVALID", error.message);
    }
    throw error;
  }
}

function validateSkillPrompt(prompt: string, arrangement: unknown): void {
  if (isObject(arrangement) && arrangement.kind === "skill" && Buffer.byteLength(prompt, "utf8") > 4096) {
    raise("INVALID_INPUT", "Scheduled Skill input exceeds 4 KiB");
  }
}

function checkDateParts(match: RegExpExecArray): void {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    raise("INVALID_INPUT", "Task runAt must be a valid ISO date-time");
  }
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > daysInMonth || monthStart.getUTCMonth() !== month - 1) {
    raise("INVALID_INPUT", "Task runAt must be a valid ISO date-time");
  }
  const milliseconds = match[7] === undefined ? 0 : Number(`0.${match[7]}`) * 1_000;
  if (milliseconds > 999) {
    raise("INVALID_INPUT", "Task runAt must be a valid ISO date-time");
  }
}

function normalizeRunAt(value: unknown): string {
  if (typeof value !== "string") {
    raise("INVALID_INPUT", "Task runAt must be an ISO date-time with a timezone");
  }
  const match = inputDatePattern.exec(value);
  if (!match) {
    raise(
      "INVALID_INPUT",
      "Task runAt must include a date, time, and explicit timezone",
    );
  }
  checkDateParts(match);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    raise("INVALID_INPUT", "Task runAt must be a valid ISO date-time");
  }
  return new Date(time).toISOString();
}

function validateStoredTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    raise("TASK_FILE_INVALID", `${field} must be a UTC ISO timestamp`);
  }
  const match = storedTimestampPattern.exec(value);
  if (!match) {
    raise("TASK_FILE_INVALID", `${field} must be a UTC ISO timestamp`);
  }
  // Reuse date-part validation, but map malformed persisted data to file errors.
  try {
    checkDateParts(match);
  } catch {
    raise("TASK_FILE_INVALID", `${field} must be a valid UTC ISO timestamp`);
  }
  if (!Number.isFinite(Date.parse(value))) {
    raise("TASK_FILE_INVALID", `${field} must be a valid UTC ISO timestamp`);
  }
}

function validateTaskError(value: unknown): TaskError {
  if (!isObject(value) || typeof value.code !== "string" || value.code.length === 0 ||
      typeof value.message !== "string" || value.message.length === 0) {
    raise("TASK_FILE_INVALID", "Task error must contain non-empty code and message");
  }
  return { code: value.code, message: value.message };
}

function validateDeliveryFields(value: Record<string, unknown>, version: number): Pick<TaskRecordV4, "attempts" | "retryAt" | "notification" | "pendingOutcome"> {
  if (version < 4) return {
    attempts: value.startedAt === null ? [] : [{ number: 1, runId: value.runId as string | null, startedAt: value.startedAt as string, finishedAt: value.finishedAt as string | null, status: value.status as TaskAttempt["status"], error: value.error as TaskError | null }],
    retryAt: null, notification: null, pendingOutcome: null,
  };
  if (!Array.isArray(value.attempts) || value.attempts.length > TASK_MAX_ATTEMPTS) raise("TASK_FILE_INVALID", "Invalid task attempts");
  const attemptCount = value.attempts.length;
  const attempts = value.attempts.map((raw, index): TaskAttempt => {
    if (!isObject(raw) || raw.number !== index + 1 || !["running", "completed", "failed", "interrupted"].includes(raw.status as string)) raise("TASK_FILE_INVALID", "Invalid task attempt");
    validateStoredTimestamp(raw.startedAt, "Attempt startedAt");
    if (raw.finishedAt !== null) validateStoredTimestamp(raw.finishedAt, "Attempt finishedAt");
    if (raw.runId !== null && (typeof raw.runId !== "string" || raw.runId.length === 0)) raise("TASK_FILE_INVALID", "Invalid attempt Run id");
    const error = raw.error === null ? null : validateTaskError(raw.error);
    if ((raw.status === "running") !== (raw.finishedAt === null) || ((raw.status === "failed" || raw.status === "interrupted") !== (error !== null)) || (raw.status === "completed" && raw.runId === null && value.execution !== "deterministic") || (raw.status === "running" && index !== attemptCount - 1)) raise("TASK_FILE_INVALID", "Inconsistent attempt state");
    return { number: index + 1, startedAt: raw.startedAt, finishedAt: raw.finishedAt as string | null, runId: raw.runId as string | null, status: raw.status as TaskAttempt["status"], error };
  });
  if (value.retryAt !== null) {
    validateStoredTimestamp(value.retryAt, "Task retryAt");
    if (value.status !== "scheduled" || attempts.length === 0 || attempts.length >= TASK_MAX_ATTEMPTS) raise("TASK_FILE_INVALID", "Invalid retry state");
  }
  const last = attempts.at(-1);
  if (value.status === "running" && (last?.status !== "running" || last.runId !== value.runId || last.startedAt !== value.startedAt)) raise("TASK_FILE_INVALID", "Running attempt does not match task");
  if (value.status !== "running" && last?.status === "running") raise("TASK_FILE_INVALID", "Unexpected running attempt");
  if (["completed", "failed", "interrupted"].includes(value.status as string) && (!last || last.status !== value.status || last.runId !== value.runId || last.finishedAt !== value.finishedAt || last.startedAt !== value.startedAt)) raise("TASK_FILE_INVALID", "Terminal attempt does not match task");
  if (value.status === "scheduled" && attempts.length > 0 && (value.retryAt === null || last?.status !== "failed")) raise("TASK_FILE_INVALID", "Scheduled attempt requires a failed retry");
  let notification: TaskNotification | null = null;
  if (value.notification !== null) {
    const raw = value.notification;
    if (!isObject(raw) || !["pending", "submitted", "failed", "omitted"].includes(raw.status as string) || !Number.isInteger(raw.attempts) || (raw.attempts as number) < 0 || (raw.attempts as number) > TASK_MAX_NOTIFICATION_ATTEMPTS || !["completed", "failed", "interrupted"].includes(value.status as string)) raise("TASK_FILE_INVALID", "Invalid notification state");
    if (raw.nextAttemptAt !== null) validateStoredTimestamp(raw.nextAttemptAt, "Notification nextAttemptAt");
    const error = raw.error === null ? null : validateTaskError(raw.error);
    const settled = raw.status === "submitted" || raw.status === "omitted";
    if ((raw.status === "failed") !== (error !== null) || (raw.status === "failed" && raw.attempts === 0) || (settled && (raw.nextAttemptAt !== null || raw.attempts === 0)) || (raw.status === "pending" && (raw.attempts !== 0 || raw.nextAttemptAt === null)) || (raw.attempts === TASK_MAX_NOTIFICATION_ATTEMPTS && raw.nextAttemptAt !== null)) raise("TASK_FILE_INVALID", "Inconsistent notification state");
    notification = { status: raw.status as TaskNotification["status"], attempts: raw.attempts as number, nextAttemptAt: raw.nextAttemptAt as string | null, error };
  }
  let pendingOutcome: TaskFinish | null = null;
  if (value.pendingOutcome !== null) {
    try { validateFinish(value.pendingOutcome); } catch { raise("TASK_FILE_INVALID", "Invalid pending outcome"); }
    pendingOutcome = value.pendingOutcome;
    if (value.status !== "running" || pendingOutcome.runId !== value.runId) raise("TASK_FILE_INVALID", "Pending outcome does not match running task");
    if (pendingOutcome.status === "completed" && pendingOutcome.runId === null && !allowsDeterministic(value)) raise("TASK_FILE_INVALID", "Deterministic outcome is not permitted for this task");
  }
  return { attempts, retryAt: value.retryAt as string | null, notification, pendingOutcome };
}

function finishAttempt(task: TaskRecordV4, outcome: TaskFinish, at: string): void {
  const attempt = task.attempts.at(-1);
  if (!attempt || attempt.status !== "running") raise("TASK_FILE_INVALID", "No running attempt");
  if (attempt.runId !== null && attempt.runId !== outcome.runId) raise("INVALID_INPUT", "Run id does not match running attempt");
  attempt.runId = outcome.runId;
  attempt.status = outcome.status;
  attempt.finishedAt = at;
  attempt.error = outcome.status === "completed" ? null : { ...outcome.error };
}

function validateRecord(value: unknown, version: 1 | 2 | 3 | 4): LegacyTaskRecord {
  if (!isObject(value)) raise("TASK_FILE_INVALID", "Task records must be objects");
  const arrangement = storedArrangement(value.arrangement);
  if (value.execution !== undefined && (value.execution !== "deterministic" || value.status !== "completed" || value.runId !== null || !allowsDeterministic(value))) {
    raise("TASK_FILE_INVALID", "Invalid deterministic execution receipt");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    raise("TASK_FILE_INVALID", "Task id must be non-empty");
  }
  validateStoredPrompt(value.prompt);
  try { validateSkillPrompt(value.prompt, arrangement); } catch { raise("TASK_FILE_INVALID", "Scheduled Skill input exceeds 4 KiB"); }
  if (typeof value.runAt !== "string" || !storedTimestampPattern.test(value.runAt)) {
    raise("TASK_FILE_INVALID", "Task runAt must be a UTC ISO timestamp");
  }
  try {
    validateStoredTimestamp(value.runAt, "Task runAt");
  } catch (error) {
    if (error instanceof TaskStoreError && error.code === "INVALID_INPUT") {
      raise("TASK_FILE_INVALID", error.message);
    }
    throw error;
  }
  if (!isLegacyTaskStatus(value.status)) raise("TASK_FILE_INVALID", "Task status is invalid");
  validateStoredTimestamp(value.createdAt, "Task createdAt");
  for (const field of ["startedAt", "finishedAt"] as const) {
    const timestamp = value[field];
    if (timestamp !== null) validateStoredTimestamp(timestamp, `Task ${field}`);
  }
  for (const field of ["threadId", "runId"] as const) {
    if (value[field] !== null && (typeof value[field] !== "string" || value[field].length === 0)) {
      raise("TASK_FILE_INVALID", `Task ${field} must be a non-empty string or null`);
    }
  }
  if (value.resultText !== null && typeof value.resultText !== "string") {
    raise("TASK_FILE_INVALID", "Task resultText must be a string or null");
  }
  const error = value.error === null ? null : validateTaskError(value.error);
  let acknowledgedAt: string | null = null;
  if (version >= 3) {
    if (value.acknowledgedAt === null) {
      acknowledgedAt = null;
    } else {
      validateStoredTimestamp(value.acknowledgedAt, "Task acknowledgedAt");
      acknowledgedAt = value.acknowledgedAt;
    }
  }
  if (
    version !== 1 &&
    value.recurringTaskId !== null &&
    (typeof value.recurringTaskId !== "string" || value.recurringTaskId.length === 0)
  ) {
    raise("TASK_FILE_INVALID", "Task recurringTaskId must be a non-empty string or null");
  }

  if (value.status === "scheduled" || value.status === "cancelled") {
    if (value.startedAt !== null || value.threadId !== null || value.runId !== null ||
        value.resultText !== null || error !== null ||
        (value.status === "scheduled" && value.finishedAt !== null) ||
        acknowledgedAt !== null) {
      raise("TASK_FILE_INVALID", `Task ${value.status} state has inconsistent execution fields`);
    }
  }
  if (value.status === "running") {
    if (value.startedAt === null || value.finishedAt !== null || value.threadId === null ||
        (version < 4 && value.runId !== null) || value.resultText !== null || error !== null ||
        acknowledgedAt !== null) {
      raise("TASK_FILE_INVALID", "Task running state has inconsistent execution fields");
    }
  }
  if (value.status === "completed") {
    if (value.startedAt === null || value.finishedAt === null || value.threadId === null ||
        (value.runId === null && value.execution !== "deterministic") || value.resultText === null || error !== null) {
      raise("TASK_FILE_INVALID", "Task completed state has inconsistent execution fields");
    }
  }
  if (value.status === "failed" || value.status === "interrupted") {
    if (value.startedAt === null || value.finishedAt === null || value.threadId === null ||
        value.resultText !== null || error === null) {
      raise("TASK_FILE_INVALID", `Task ${value.status} state has inconsistent execution fields`);
    }
  }

  return {
    id: value.id,
    prompt: value.prompt,
    runAt: value.runAt,
    status: value.status,
    createdAt: value.createdAt as string,
    startedAt: value.startedAt as string | null,
    finishedAt: value.finishedAt as string | null,
    threadId: value.threadId as string | null,
    runId: value.runId as string | null,
    resultText: value.resultText as string | null,
    error,
    acknowledgedAt,
    recurringTaskId: version !== 1
      ? (value.recurringTaskId as string | null)
      : null,
    ...(arrangement ? { arrangement } : {}),
    ...(value.execution === "deterministic" ? { execution: "deterministic" as const } : {}),
    ...validateDeliveryFields(value, version),
    ...(value.creation === undefined ? {} : { creation: readCreationReceipt(value.creation)! }),
  };
}

const recurringTaskStatuses = ["active", "paused", "cancelled"] as const;
const recurringTaskStatusSet = new Set<RecurringTaskStatus>(recurringTaskStatuses);

function isRecurringTaskStatus(value: unknown): value is RecurringTaskStatus {
  return typeof value === "string" && recurringTaskStatusSet.has(value as RecurringTaskStatus);
}

function validateStoredRecurrence(value: unknown): Recurrence {
  if (!isObject(value)) raise("TASK_FILE_INVALID", "Recurring task recurrence must be an object");
  try {
    // nextOccurrence performs the complete shape and range validation.
    nextOccurrence(value as Recurrence, "2026-01-01T00:00:00.000Z");
  } catch {
    raise("TASK_FILE_INVALID", "Recurring task recurrence is invalid");
  }
  const recurrence = value as Record<string, unknown>;
  return recurrence.kind === "daily"
    ? {
        kind: "daily",
        time: recurrence.time as string,
        utcOffset: recurrence.utcOffset as string,
      }
    : {
        kind: "weekly",
        weekday: recurrence.weekday as number,
        time: recurrence.time as string,
        utcOffset: recurrence.utcOffset as string,
      };
}

function validateRecurringTask(value: unknown): RecurringTaskRecord {
  if (!isObject(value)) {
    raise("TASK_FILE_INVALID", "Recurring task records must be objects");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    raise("TASK_FILE_INVALID", "Recurring task id must be non-empty");
  }
  validateStoredPrompt(value.prompt);
  try { validateSkillPrompt(value.prompt, value.arrangement); } catch { raise("TASK_FILE_INVALID", "Scheduled Skill input exceeds 4 KiB"); }
  const recurrence = validateStoredRecurrence(value.recurrence);
  if (!isRecurringTaskStatus(value.status)) {
    raise("TASK_FILE_INVALID", "Recurring task status is invalid");
  }
  validateStoredTimestamp(value.createdAt, "Recurring task createdAt");
  if (value.nextRunAt !== null) {
    validateStoredTimestamp(value.nextRunAt, "Recurring task nextRunAt");
  }
  if (value.status === "active" && value.nextRunAt === null) {
    raise("TASK_FILE_INVALID", "Active recurring task must have nextRunAt");
  }
  if (value.status !== "active" && value.nextRunAt !== null) {
    raise("TASK_FILE_INVALID", `Recurring task ${value.status} state must not have nextRunAt`);
  }
  return {
    id: value.id,
    prompt: value.prompt,
    recurrence,
    status: value.status,
    createdAt: value.createdAt as string,
    nextRunAt: value.nextRunAt as string | null,
    ...(value.creation === undefined ? {} : { creation: readCreationReceipt(value.creation)! }),
    ...(value.arrangement === undefined ? {} : { arrangement: storedArrangement(value.arrangement)! }),
  };
}

export function readLegacyTaskDocument(value: unknown): TaskDocumentV4 {
  if (!isObject(value)) raise("TASK_FILE_INVALID", "Task file must contain a JSON object");
  if (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) {
    raise("TASK_VERSION_UNSUPPORTED", "Unsupported task file version");
  }
  if (!Array.isArray(value.tasks)) {
    raise("TASK_FILE_INVALID", "Task file tasks must be an array");
  }
  const ids = new Set<string>();
  const tasks: LegacyTaskRecord[] = [];
  for (const taskValue of value.tasks) {
    const task = validateRecord(taskValue, value.version);
    if (ids.has(task.id)) raise("TASK_FILE_INVALID", `Duplicate task id: ${task.id}`);
    ids.add(task.id);
    tasks.push(task);
  }
  if (value.version === 1) {
    return { version: 4, tasks, recurringTasks: [] };
  }
  if (!Array.isArray(value.recurringTasks)) {
    raise("TASK_FILE_INVALID", "Task file recurringTasks must be an array");
  }
  const recurringIds = new Set<string>();
  const recurringTasks: RecurringTaskRecord[] = [];
  for (const recurringTaskValue of value.recurringTasks) {
    const recurringTask = validateRecurringTask(recurringTaskValue);
    if (recurringIds.has(recurringTask.id)) {
      raise("TASK_FILE_INVALID", `Duplicate recurring task id: ${recurringTask.id}`);
    }
    recurringIds.add(recurringTask.id);
    recurringTasks.push(recurringTask);
  }
  for (const task of tasks) {
    if (task.recurringTaskId !== null && !recurringIds.has(task.recurringTaskId)) {
      raise("TASK_FILE_INVALID", `Task references missing recurring task: ${task.recurringTaskId}`);
    }
  }
  const operations = [...tasks, ...recurringTasks].flatMap(task => task.creation ? [task.creation.operationId] : []);
  if (new Set(operations).size !== operations.length) raise("TASK_FILE_INVALID", "Duplicate creation operation ID");
  return { version: 4, tasks, recurringTasks };
}

function migrationRequired(file: string): never {
  const quote = (entry: string) => `'${entry.replaceAll("'", "'\\''")}'`;
  const script = fileURLToPath(new URL("../scripts/task-store-upgrade.mjs", import.meta.url));
  const command = [process.execPath, script, "--data", dirname(file)].map(quote).join(" ");
  raise("TASK_MIGRATION_REQUIRED", `任务记录需要离线升级到 tasks.json v5。先预览：${command} --dry-run；确认后：${command} --upgrade。启动时不会自动迁移。`);
}

function validateArrangementRecord(value: unknown): TaskRecordV4 {
  const legacy = validateRecord({ ...value as Record<string, unknown>, status: legacyStatusForV5(value) }, 4);
  const record = value as Record<string, unknown>;
  if (record.kind !== "arrangement") raise("TASK_FILE_INVALID", "Arrangement task kind is invalid");
  if (!isTaskStatus(record.status)) raise("TASK_FILE_INVALID", "Task status is invalid");
  const task: TaskRecordV4 = { ...legacy, kind: "arrangement", status: record.status };
  if (task.status === "pending" && task.error !== null) {
    const settlement = arrangementSettlement(task);
    if (settlement === null || legacy.status !== settlement) raise("TASK_FILE_INVALID", "Pending attention does not match its attempt");
  } else if (legacy.status === "scheduled" && task.status !== "pending") {
    raise("TASK_FILE_INVALID", "Waiting arrangement must stay pending");
  } else if (task.status !== "pending" && task.status !== legacy.status) {
    raise("TASK_FILE_INVALID", "Task status does not match its execution fields");
  }
  if (arrangementWaiting(task) && task.finishedAt !== null) raise("TASK_FILE_INVALID", "Waiting arrangement has finishedAt");
  return task;
}

function legacyStatusForV5(value: unknown): LegacyTaskStatus {
  if (!isObject(value) || !isTaskStatus(value.status)) raise("TASK_FILE_INVALID", "Task status is invalid");
  if (value.status === "running" || value.status === "completed" || value.status === "cancelled") return value.status;
  if (value.status !== "pending") raise("TASK_FILE_INVALID", "Task status is invalid");
  if (value.error === null) return "scheduled";
  const attempts = Array.isArray(value.attempts) ? value.attempts : [];
  const last = attempts.at(-1);
  if (isObject(last) && last.status === "interrupted") return "interrupted";
  return "failed";
}

function validateDocument(value: unknown): TaskDocumentV5 {
  if (!isObject(value)) raise("TASK_FILE_INVALID", "Task file must contain a JSON object");
  if (value.version === 1 || value.version === 2 || value.version === 3 || value.version === 4) {
    raise("TASK_MIGRATION_REQUIRED", "Task file requires the offline v5 upgrade");
  }
  if (value.version !== 5) raise("TASK_VERSION_UNSUPPORTED", "Unsupported task file version");
  if (!Array.isArray(value.tasks)) raise("TASK_FILE_INVALID", "Task file tasks must be an array");
  const ids = new Set<string>();
  const tasks: Array<TaskRecordV4 | WorkTask> = [];
  let workTasks = 0;
  for (const taskValue of value.tasks) {
    if (!isObject(taskValue)) raise("TASK_FILE_INVALID", "Task records must be objects");
    const task = taskValue.kind === "work" ? readWorkTask(taskValue) : validateArrangementRecord(taskValue);
    if (task.kind === "work") workTasks += 1;
    if (ids.has(task.id)) raise("TASK_FILE_INVALID", `Duplicate task id: ${task.id}`);
    ids.add(task.id);
    tasks.push(task);
  }
  if (workTasks > WORK_TASK_MAX_ENTRIES) raise("TASK_FILE_INVALID", "Work task limit reached");
  if (!Array.isArray(value.recurringTasks)) raise("TASK_FILE_INVALID", "Task file recurringTasks must be an array");
  const recurringIds = new Set<string>();
  const recurringTasks: RecurringTaskRecord[] = [];
  for (const recurringTaskValue of value.recurringTasks) {
    const recurringTask = validateRecurringTask(recurringTaskValue);
    if (recurringIds.has(recurringTask.id)) raise("TASK_FILE_INVALID", `Duplicate recurring task id: ${recurringTask.id}`);
    recurringIds.add(recurringTask.id);
    recurringTasks.push(recurringTask);
  }
  for (const task of tasks) {
    if (task.kind === "arrangement" && task.recurringTaskId !== null && task.recurringTaskId !== undefined && !recurringIds.has(task.recurringTaskId)) {
      raise("TASK_FILE_INVALID", `Task references missing recurring task: ${task.recurringTaskId}`);
    }
  }
  const operations = [...tasks, ...recurringTasks].flatMap(task => task.creation ? [task.creation.operationId] : []);
  if (new Set(operations).size !== operations.length) raise("TASK_FILE_INVALID", "Duplicate creation operation ID");
  return { version: 5, tasks, recurringTasks };
}

function readWorkTask(value: unknown): WorkTask {
  try { return readStoredWorkTask(value); }
  catch (error) {
    if (error instanceof WorkTaskStoreError) raise("TASK_FILE_INVALID", error.message);
    throw error;
  }
}

function validateCreateInput(input: unknown): CreateTaskInput & { runAt: string } {
  if (!isObject(input)) raise("INVALID_INPUT", "Task input must be an object");
  validatePrompt(input.prompt);
  validateSkillPrompt(input.prompt, input.arrangement);
  if (isObject(input.arrangement) && input.arrangement.kind === "skill" && Object.keys(input).some(key => !["prompt", "runAt", "arrangement", "operationId"].includes(key))) raise("INVALID_INPUT", "Unexpected scheduled Skill field");
  const runAt = normalizeRunAt(input.runAt);
  return { prompt: input.prompt, runAt, ...(input.arrangement === undefined ? {} : { arrangement: validateTaskArrangement(input.arrangement) }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId as string }) };
}

function validateCreateRecurringInput(
  input: unknown,
  now: number,
): CreateRecurringTaskInput {
  if (!isObject(input)) raise("INVALID_INPUT", "Recurring task input must be an object");
  validatePrompt(input.prompt);
  validateSkillPrompt(input.prompt, input.arrangement);
  if (isObject(input.arrangement) && input.arrangement.kind === "skill" && Object.keys(input).some(key => !["prompt", "recurrence", "arrangement", "operationId"].includes(key))) raise("INVALID_INPUT", "Unexpected scheduled Skill field");
  if (!isObject(input.recurrence)) {
    raise("INVALID_INPUT", "Recurring task recurrence must be an object");
  }
  try {
    nextOccurrence(input.recurrence as Recurrence, new Date(now).toISOString());
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      raise("INVALID_INPUT", error.message);
    }
    throw error;
  }
  const recurrence = input.recurrence as Record<string, unknown>;
  const normalized: Recurrence = recurrence.kind === "daily"
    ? {
        kind: "daily",
        time: recurrence.time as string,
        utcOffset: recurrence.utcOffset as string,
      }
    : {
        kind: "weekly",
        weekday: recurrence.weekday as number,
        time: recurrence.time as string,
        utcOffset: recurrence.utcOffset as string,
      };
  return { prompt: input.prompt, recurrence: normalized, ...(input.arrangement === undefined ? {} : { arrangement: validateTaskArrangement(input.arrangement) }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId as string }) };
}

function isTaskListStatusFilter(value: unknown): value is TaskListStatusFilter {
  return isTaskStatus(value) || value === "pending" || value === "attention";
}

function validateTaskListInput(input: unknown): Required<Pick<TaskListInput, "limit">> & TaskListInput {
  if (input === undefined) return { limit: TASK_LIST_DEFAULT_LIMIT };
  if (!isObject(input)) raise("INVALID_INPUT", "Task list input must be an object");
  if (input.status !== undefined && !isTaskListStatusFilter(input.status)) {
    raise("INVALID_INPUT", "Task list status is invalid");
  }
  if (
    input.recurringTaskId !== undefined &&
    (typeof input.recurringTaskId !== "string" || input.recurringTaskId.length === 0)
  ) {
    raise("INVALID_INPUT", "Task recurringTaskId must be a non-empty string");
  }
  if (input.inbox !== undefined && typeof input.inbox !== "boolean") {
    raise("INVALID_INPUT", "Task inbox filter must be a boolean");
  }
  if (input.before !== undefined && (!isObject(input.before) || typeof input.before.createdAt !== "string" || !Number.isFinite(Date.parse(input.before.createdAt)) || typeof input.before.id !== "string" || !input.before.id)) {
    raise("INVALID_INPUT", "Task list cursor is invalid");
  }
  if (input.limit !== undefined &&
      (typeof input.limit !== "number" || !Number.isInteger(input.limit) ||
       input.limit < 1 || input.limit > TASK_LIST_MAX_LIMIT)) {
    raise("INVALID_INPUT", `Task list limit must be an integer from 1 to ${TASK_LIST_MAX_LIMIT}`);
  }
  return {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.recurringTaskId === undefined
      ? {}
      : { recurringTaskId: input.recurringTaskId }),
    ...(input.inbox === undefined ? {} : { inbox: input.inbox }),
    ...(input.before === undefined ? {} : { before: input.before as { createdAt: string; id: string } }),
    limit: input.limit === undefined ? TASK_LIST_DEFAULT_LIMIT : input.limit,
  };
}

function validateRecurringTaskListInput(
  input: unknown,
): Required<Pick<RecurringTaskListInput, "limit">> & RecurringTaskListInput {
  if (input === undefined) return { limit: TASK_LIST_DEFAULT_LIMIT };
  if (!isObject(input)) {
    raise("INVALID_INPUT", "Recurring task list input must be an object");
  }
  if (input.status !== undefined && !isRecurringTaskStatus(input.status)) {
    raise("INVALID_INPUT", "Recurring task list status is invalid");
  }
  if (
    input.limit !== undefined &&
    (typeof input.limit !== "number" ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > TASK_LIST_MAX_LIMIT)
  ) {
    raise(
      "INVALID_INPUT",
      `Recurring task list limit must be an integer from 1 to ${TASK_LIST_MAX_LIMIT}`,
    );
  }
  return {
    ...(input.status === undefined ? {} : { status: input.status }),
    limit: input.limit === undefined ? TASK_LIST_DEFAULT_LIMIT : input.limit,
  };
}

function advanceRecurringTask(
  recurringTask: RecurringTaskRecord,
  now: number,
): void {
  if (recurringTask.status !== "active" || recurringTask.nextRunAt === null) return;
  if (Date.parse(recurringTask.nextRunAt) <= now) {
    recurringTask.nextRunAt = nextOccurrence(
      recurringTask.recurrence,
      new Date(now).toISOString(),
    );
  }
}

function validateFinish(outcome: unknown): asserts outcome is TaskFinish {
  if (!isObject(outcome) ||
      (outcome.status !== "completed" && outcome.status !== "failed" && outcome.status !== "interrupted")) {
    raise("INVALID_INPUT", "Task finish status is invalid");
  }
  if (outcome.notification !== undefined && typeof outcome.notification !== "boolean") raise("INVALID_INPUT", "Notification must be boolean");
  if (outcome.status === "completed") {
    const deterministic = outcome.runId === null && outcome.execution === "deterministic";
    if ((!deterministic && (typeof outcome.runId !== "string" || outcome.runId.length === 0)) ||
        (outcome.execution !== undefined && !deterministic) ||
        typeof outcome.resultText !== "string") {
      raise("INVALID_INPUT", "Completed task outcome must contain runId and resultText");
    }
    return;
  }
  if (outcome.runId !== null &&
      (typeof outcome.runId !== "string" || outcome.runId.length === 0)) {
    raise("INVALID_INPUT", "Failed task runId must be a non-empty string or null");
  }
  if (!isObject(outcome.error) || typeof outcome.error.code !== "string" ||
      outcome.error.code.length === 0 || typeof outcome.error.message !== "string" ||
      outcome.error.message.length === 0) {
    raise("INVALID_INPUT", "Failed task outcome must contain an error");
  }
}

function errorResult(error: unknown, signal: AbortSignal, write: boolean): TaskFailure {
  // Cancellation after replacement cannot turn an uncertain commit into a
  // proven cancelled write; callers must reconcile the saved state first.
  if (error instanceof TaskStoreError && error.code === "COMMIT_UNCERTAIN") return fail(error.code, error.message);
  if (signal.aborted) throw abortReason(signal);
  if (error instanceof TaskStoreError) return fail(error.code, error.message);
  return fail(
    write ? "WRITE_FAILED" : "READ_FAILED",
    write ? "Unable to write tasks" : "Unable to read tasks",
  );
}

function arrangementById(document: TaskDocument, id: string): TaskRecordV4 {
  const task = document.tasks.find((candidate) => candidate.id === id);
  if (task === undefined || task.kind !== "arrangement") raise("TASK_NOT_FOUND", `Task not found: ${id}`);
  return task;
}

export interface TaskFilePort {
  readonly filePath: string;
  read(): Promise<TaskDocumentV5>;
  edit<T>(operation: (document: TaskDocumentV5) => T): Promise<T>;
}

export class WorkspaceTaskStore implements TaskStore, TaskFilePort {
  readonly #root: string;
  readonly #file: string;
  readonly #directory: string;
  readonly #lockFile: string;
  readonly #now: () => number;
  readonly #generateId: () => string;
  #commitUncertain = false;
  #writeFailed = false;

  constructor(filePath: string, options: TaskStoreOptions = {}) {
    this.#file = resolve(filePath);
    this.#root = dirname(dirname(this.#file));
    this.#directory = dirname(this.#file);
    this.#lockFile = `${this.#file}.lock`;
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? randomUUID;
  }

  get filePath(): string { return this.#file; }

  read(): Promise<TaskDocumentV5> { return this.#read(); }

  edit<T>(operation: (document: TaskDocumentV5) => T): Promise<T> {
    return this.#update(neverAborted, operation);
  }

  async create(
    input: CreateTaskInput,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecordV4>> {
    try {
      throwIfAborted(signal);
      const normalized = validateCreateInput(input);
      const { operationId, ...payload } = normalized;
      const receipt = creationReceipt(operationId, { kind: "once", ...payload });
      if (!receipt && Date.parse(normalized.runAt) <= this.#now()) raise("INVALID_INPUT", "Task runAt must be later than the current time");
      const task: TaskRecordV4 = {
        ...(receipt ? { creation: receipt } : {}),
        kind: "arrangement",
        id: this.#generateId(),
        prompt: normalized.prompt,
        runAt: normalized.runAt,
        status: "pending",
        createdAt: new Date(this.#now()).toISOString(),
        startedAt: null,
        finishedAt: null,
        threadId: null,
        runId: null,
        resultText: null,
        error: null,
        acknowledgedAt: null,
        recurringTaskId: null,
        attempts: [], retryAt: null, notification: null, pendingOutcome: null,
        ...(normalized.arrangement ? { arrangement: normalized.arrangement } : {}),
      };
      if (task.id.length === 0) raise("WRITE_FAILED", "Task id generator returned an empty id");
      const value = await this.#update(signal, (document) => {
        const existing = receipt && [...document.tasks, ...document.recurringTasks].find(item => item.creation?.operationId === receipt.operationId);
        if (existing) {
          if (existing.creation!.requestHash !== receipt.requestHash || !("runAt" in existing)) raise("INVALID_INPUT", "同一创建操作的内容已变化，请先核对原安排。");
          return existing as TaskRecordV4;
        }
        if (Date.parse(normalized.runAt) <= this.#now()) raise("INVALID_INPUT", "Task runAt must be later than the current time");
        document.tasks.push(task);
        return task;
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async createRecurring(
    input: CreateRecurringTaskInput,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<RecurringTaskRecord>> {
    try {
      throwIfAborted(signal);
      const now = this.#now();
      const normalized = validateCreateRecurringInput(input, now);
      const { operationId, ...payload } = normalized;
      const receipt = creationReceipt(operationId, { kind: "recurring", ...payload });
      const recurringTask: RecurringTaskRecord = {
        ...(receipt ? { creation: receipt } : {}),
        id: this.#generateId(),
        prompt: normalized.prompt,
        recurrence: cloneRecurrence(normalized.recurrence),
        status: "active",
        createdAt: new Date(now).toISOString(),
        nextRunAt: nextOccurrence(
          normalized.recurrence,
          new Date(now).toISOString(),
        ),
        ...(normalized.arrangement ? { arrangement: normalized.arrangement } : {}),
      };
      if (recurringTask.id.length === 0) {
        raise("WRITE_FAILED", "Recurring task id generator returned an empty id");
      }
      const value = await this.#update(signal, (document) => {
        const existing = receipt && [...document.tasks, ...document.recurringTasks].find(item => item.creation?.operationId === receipt.operationId);
        if (existing) {
          if (existing.creation!.requestHash !== receipt.requestHash || !("recurrence" in existing)) raise("INVALID_INPUT", "同一创建操作的内容已变化，请先核对原安排。");
          return existing as RecurringTaskRecord;
        }
        document.recurringTasks.push(recurringTask);
        return recurringTask;
      });
      return { ok: true, value: cloneRecurringTask(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async list(input?: TaskListInput): Promise<TaskStoreResult<TaskListV3>> {
    try {
      const validated = validateTaskListInput(input);
      const document = await this.#read();
      const filtered = document.tasks.filter((task): task is TaskRecordV4 => {
        if (task.kind !== "arrangement") return false;
        if (validated.before) {
          const difference = Date.parse(task.createdAt) - Date.parse(validated.before.createdAt);
          if (difference > 0 || (difference === 0 && task.id.localeCompare(validated.before.id) >= 0)) return false;
        }
        if (
          validated.recurringTaskId !== undefined &&
          task.recurringTaskId !== validated.recurringTaskId
        ) {
          return false;
        }
        if (validated.inbox === true &&
            (task.acknowledgedAt !== null ||
             (task.status !== "completed" && !arrangementNeedsAttention(task)))) {
          return false;
        }
        if (validated.status === undefined) return true;
        if (validated.status === "attention") return arrangementNeedsAttention(task);
        if (validated.status === "pending") return arrangementWaiting(task);
        return task.status === validated.status;
      });
      const sorted = [...filtered].sort((a, b) => {
        const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        return created !== 0 ? created : b.id.localeCompare(a.id);
      });
      const visible = sorted.slice(0, validated.limit);
      return {
        ok: true,
        value: {
          tasks: visible.map((task) => ({
            id: task.id,
            promptPreview: preview(task.prompt),
            runAt: task.runAt,
            status: task.status,
            finishedAt: task.finishedAt,
            resultPreview: task.status === "completed" && task.resultText !== null
              ? preview(task.resultText)
              : null,
            error: arrangementNeedsAttention(task) && task.error !== null
              ? {
                  code: task.error.code,
                  messagePreview: preview(task.error.message),
                }
              : null,
            ...(arrangementSettlement(task) === null ? {} : { settlement: arrangementSettlement(task)! }),
            acknowledgedAt: task.acknowledgedAt ?? null,
            recurringTaskId: task.recurringTaskId ?? null,
            ...(task.arrangement === undefined ? {} : { arrangement: { ...task.arrangement } }),
          })),
          truncated: sorted.length > validated.limit,
          ...(sorted.length > validated.limit && visible.length ? { nextCursor: { createdAt: visible.at(-1)!.createdAt, id: visible.at(-1)!.id } } : {}),
        },
      };
    } catch (error) {
      return errorResult(error, neverAborted, false);
    }
  }

  async listRecurring(
    input?: RecurringTaskListInput,
  ): Promise<TaskStoreResult<RecurringTaskList>> {
    try {
      const validated = validateRecurringTaskListInput(input);
      const document = await this.#read();
      const filtered = validated.status === undefined
        ? document.recurringTasks
        : document.recurringTasks.filter((task) => task.status === validated.status);
      const sorted = [...filtered].sort((a, b) => {
        const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
        return created !== 0 ? created : b.id.localeCompare(a.id);
      });
      const visible = sorted.slice(0, validated.limit);
      return {
        ok: true,
        value: {
          recurringTasks: visible.map((task) => ({
            id: task.id,
            promptPreview: preview(task.prompt),
            recurrence: cloneRecurrence(task.recurrence),
            status: task.status,
            nextRunAt: task.nextRunAt,
            ...(task.arrangement === undefined ? {} : { arrangement: { ...task.arrangement } }),
          })),
          truncated: sorted.length > validated.limit,
        },
      };
    } catch (error) {
      return errorResult(error, neverAborted, false);
    }
  }

  async getRecurring(
    id: string,
  ): Promise<TaskStoreResult<RecurringTaskDetail>> {
    if (typeof id !== "string" || id.length === 0) {
      return fail("INVALID_INPUT", "Recurring task id must be non-empty");
    }
    try {
      const document = await this.#read();
      const recurringTask = document.recurringTasks.find((candidate) => candidate.id === id);
      if (recurringTask === undefined) {
        return fail("RECURRING_TASK_NOT_FOUND", `Recurring task not found: ${id}`);
      }
      const latestTask = [...document.tasks]
        .filter((task): task is TaskRecordV4 => task.kind === "arrangement" && task.recurringTaskId === id)
        .sort((a, b) => {
          const created = Date.parse(b.createdAt) - Date.parse(a.createdAt);
          return created !== 0 ? created : b.id.localeCompare(a.id);
        })[0];
      return {
        ok: true,
        value: {
          recurringTask: cloneRecurringTask(recurringTask),
          latestTask: latestTask === undefined ? null : cloneRecord(latestTask),
        },
      };
    } catch (error) {
      return errorResult(error, neverAborted, false);
    }
  }

  async pauseRecurring(
    id: string,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<RecurringTaskRecord>> {
    return this.#updateRecurring(id, signal, (task) => {
      if (task.status === "cancelled") {
        raise("RECURRING_TASK_CANCELLED", `Recurring task is cancelled: ${id}`);
      }
      if (task.status === "active") {
        task.status = "paused";
        task.nextRunAt = null;
      }
      return task;
    });
  }

  async resumeRecurring(
    id: string,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<RecurringTaskRecord>> {
    return this.#updateRecurring(id, signal, (task) => {
      if (task.status === "cancelled") {
        raise("RECURRING_TASK_CANCELLED", `Recurring task is cancelled: ${id}`);
      }
      if (task.status === "paused") {
        const now = this.#now();
        task.status = "active";
        task.nextRunAt = nextOccurrence(task.recurrence, new Date(now).toISOString());
      }
      return task;
    });
  }

  async cancelRecurring(
    id: string,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<RecurringTaskRecord>> {
    return this.#updateRecurring(id, signal, (task) => {
      if (task.status !== "cancelled") {
        task.status = "cancelled";
        task.nextRunAt = null;
      }
      return task;
    });
  }

  async get(id: string): Promise<TaskStoreResult<TaskRecordV4>> {
    if (typeof id !== "string" || id.length === 0) return fail("INVALID_INPUT", "Task id must be non-empty");
    try {
      const document = await this.#read();
      const task = document.tasks.find((candidate) => candidate.id === id);
      return task === undefined || task.kind !== "arrangement"
        ? fail("TASK_NOT_FOUND", `Task not found: ${id}`)
        : { ok: true, value: cloneRecord(task) };
    } catch (error) {
      return errorResult(error, neverAborted, false);
    }
  }

  async cancel(
    id: string,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecordV4>> {
    if (typeof id !== "string" || id.length === 0) return fail("INVALID_INPUT", "Task id must be non-empty");
    try {
      throwIfAborted(signal);
      const value = await this.#update(signal, (document) => {
        const task = arrangementById(document, id);
        if (task.status === "cancelled") return task;
        if (!arrangementWaiting(task)) {
          raise("TASK_NOT_CANCELLABLE", `Task cannot be cancelled in ${task.status} state`);
        }
        task.status = "cancelled";
        task.retryAt = null;
        task.finishedAt = new Date(this.#now()).toISOString();
        return task;
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async reschedule(
    id: string,
    runAt: string,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecordV4>> {
    if (typeof id !== "string" || id.length === 0) {
      return fail("INVALID_INPUT", "Task id must be non-empty");
    }
    try {
      throwIfAborted(signal);
      const normalizedRunAt = normalizeRunAt(runAt);
      const value = await this.#update(signal, (document) => {
        const task = arrangementById(document, id);
        if (!arrangementWaiting(task) || task.recurringTaskId != null) {
          raise("TASK_NOT_RESCHEDULABLE", `Task cannot be rescheduled in ${task.status} state`);
        }
        if (Date.parse(normalizedRunAt) <= this.#now()) {
          raise("INVALID_INPUT", "Task runAt must be later than the current time");
        }
        task.runAt = normalizedRunAt;
        if (task.retryAt !== null) task.retryAt = normalizedRunAt;
        return task;
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async acknowledge(
    id: string,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecordV4>> {
    if (typeof id !== "string" || id.length === 0) {
      return fail("INVALID_INPUT", "Task id must be non-empty");
    }
    try {
      throwIfAborted(signal);
      const value = await this.#update(signal, (document) => {
        const task = arrangementById(document, id);
        if (task.status !== "completed" && !arrangementNeedsAttention(task)) {
          raise(
            "TASK_NOT_ACKNOWLEDGEABLE",
            `Task cannot be acknowledged in ${task.status} state`,
          );
        }
        if (task.acknowledgedAt === null) {
          task.acknowledgedAt = new Date(this.#now()).toISOString();
        }
        return task;
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async claimNextDue(
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecordV4 | null>> {
    try {
      throwIfAborted(signal);
      const now = this.#now();
      const value = await this.#update(signal, (document) => {
        const dueTasks = document.tasks
          .filter((task): task is TaskRecordV4 => task.kind === "arrangement" && arrangementWaiting(task) && Date.parse(task.retryAt ?? task.runAt) <= now && task.attempts.length < TASK_MAX_ATTEMPTS)
          .map((task) => ({
            kind: "task" as const,
            runAt: task.retryAt ?? task.runAt,
            createdAt: task.createdAt,
            id: task.id,
            task,
          }));
        const dueRecurringTasks = document.recurringTasks
          .filter((task) => task.status === "active" && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= now)
          .map((task) => ({
            kind: "recurring" as const,
            runAt: task.nextRunAt as string,
            createdAt: task.createdAt,
            id: task.id,
            task,
          }));
        const due = [...dueTasks, ...dueRecurringTasks].sort((a, b) => {
          const runAt = Date.parse(a.runAt) - Date.parse(b.runAt);
          if (runAt !== 0) return runAt;
          const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
          return created !== 0 ? created : a.id.localeCompare(b.id);
        })[0];
        if (due === undefined) return null;

        const nowIso = new Date(now).toISOString();
        if (due.kind === "task") {
          due.task.status = "running";
          due.task.startedAt = nowIso;
          due.task.threadId = this.#generateId();
          due.task.retryAt = null;
          due.task.attempts.push({ number: due.task.attempts.length + 1, runId: null, startedAt: nowIso, finishedAt: null, status: "running", error: null });
          if (due.task.threadId.length === 0) {
            raise("WRITE_FAILED", "Task thread id generator returned an empty id");
          }
          return due.task;
        }

        const taskId = this.#generateId();
        const threadId = this.#generateId();
        if (taskId.length === 0 || threadId.length === 0 || taskId === threadId) {
          raise("WRITE_FAILED", "Recurring task id generator returned invalid ids");
        }
        const task: TaskRecordV4 = {
          kind: "arrangement",
          id: taskId,
          prompt: due.task.prompt,
          runAt: due.task.arrangement ? latestOccurrence(due.task.recurrence, nowIso) : due.task.nextRunAt as string,
          status: "running",
          createdAt: nowIso,
          startedAt: nowIso,
          finishedAt: null,
          threadId,
          runId: null,
          resultText: null,
          error: null,
          acknowledgedAt: null,
          recurringTaskId: due.task.id,
          attempts: [{ number: 1, runId: null, startedAt: nowIso, finishedAt: null, status: "running", error: null }],
          retryAt: null, notification: null, pendingOutcome: null,
          ...(due.task.arrangement ? { arrangement: { ...due.task.arrangement } } : {}),
        };
        due.task.nextRunAt = nextOccurrence(due.task.recurrence, nowIso);
        document.tasks.push(task);
        return task;
      });
      return { ok: true, value: value === null ? null : cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async finish(
    id: string,
    outcome: TaskFinish,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecordV4>> {
    if (typeof id !== "string" || id.length === 0) return fail("INVALID_INPUT", "Task id must be non-empty");
    try {
      throwIfAborted(signal);
      validateFinish(outcome);
      const value = await this.#update(signal, (document) => {
        const task = arrangementById(document, id);
        if (task.status !== "running") raise("INVALID_INPUT", "Only a running task can be finished");
        if (outcome.status === "completed" && outcome.runId === null && !allowsDeterministic(task)) raise("INVALID_INPUT", "Deterministic completion is not permitted for this task");
        if (task.pendingOutcome !== null && !isDeepStrictEqual(task.pendingOutcome, outcome)) raise("INVALID_INPUT", "Finish outcome differs from persisted outcome");
        const now = this.#now();
        task.status = outcome.status === "completed" ? "completed" : "pending";
        task.finishedAt = new Date(now).toISOString();
        task.runId = outcome.runId;
        task.acknowledgedAt = null;
        task.retryAt = null;
        task.pendingOutcome = null;
        if (outcome.status === "completed" && outcome.runId === null) task.execution = "deterministic";
        finishAttempt(task, outcome, task.finishedAt);
        task.notification = outcome.notification === true ? { status: "pending", attempts: 0, nextAttemptAt: task.finishedAt, error: null } : null;
        if (outcome.status === "completed") {
          task.resultText = outcome.resultText;
          task.error = null;
        } else {
          task.resultText = null;
          task.error = { ...outcome.error };
        }
        if (task.recurringTaskId !== null && task.recurringTaskId !== undefined) {
          const recurringTask = document.recurringTasks.find(
            (candidate) => candidate.id === task.recurringTaskId,
          );
          if (recurringTask !== undefined) advanceRecurringTask(recurringTask, now);
        }
        return task;
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async interruptRunning(
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<number>> {
    try {
      throwIfAborted(signal);
      const value = await this.#update(signal, (document) => {
        let interrupted = 0;
        const now = this.#now();
        for (const task of document.tasks) {
          if (task.kind !== "arrangement" || task.status !== "running") continue;
          if (task.pendingOutcome !== null) raise("INVALID_INPUT", "Pending outcomes must be recovered before interrupting");
          task.status = "pending";
          task.finishedAt = new Date(now).toISOString();
          task.error = {
            code: "WORKER_INTERRUPTED",
            message: "Task was interrupted by worker shutdown or restart",
          };
          task.acknowledgedAt = null;
          finishAttempt(task, { status: "interrupted", runId: task.runId, error: task.error }, task.finishedAt);
          interrupted += 1;
        }
        return interrupted;
      });
      return { ok: true, value };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async listRunning(): Promise<TaskStoreResult<TaskRecordV4[]>> {
    try {
      const tasks = (await this.#read()).tasks.filter((task): task is TaskRecordV4 => task.kind === "arrangement" && task.status === "running");
      if (tasks.length > 100) raise("TASK_FILE_INVALID", "Too many running tasks to recover safely");
      return { ok: true, value: tasks.map(cloneRecord) };
    } catch (error) { return errorResult(error, neverAborted, false); }
  }

  async getHealthCounts(): Promise<TaskStoreResult<{ unacknowledgedCount: number; notificationFailureCount: number }>> {
    try {
      const tasks = (await this.#read()).tasks;
      return { ok: true, value: {
        unacknowledgedCount: tasks.filter((task) => task.kind === "arrangement" && task.acknowledgedAt === null && (task.status === "completed" || arrangementNeedsAttention(task))).length,
        notificationFailureCount: tasks.filter((task) => task.kind === "arrangement" && task.notification?.status === "failed").length,
      } };
    } catch (error) { return errorResult(error, neverAborted, false); }
  }

  async recordRunId(id: string, runId: string): Promise<TaskStoreResult<TaskRecordV4>> {
    if (typeof runId !== "string" || runId.length === 0) return fail("INVALID_INPUT", "Run id must be non-empty");
    return this.#updateTask(id, (task) => {
      if (task.status !== "running" || task.pendingOutcome !== null) raise("INVALID_INPUT", "Only a running task accepts a Run id");
      if (task.runId !== null && task.runId !== runId) raise("INVALID_INPUT", "Run id already recorded");
      task.runId = runId;
      task.attempts.at(-1)!.runId = runId;
      return task;
    });
  }

  async recordOutcome(id: string, outcome: TaskFinish): Promise<TaskStoreResult<TaskRecordV4>> {
    try { validateFinish(outcome); } catch (error) { return errorResult(error, neverAborted, true); }
    return this.#updateTask(id, (task) => {
      if (task.status !== "running" || task.runId !== outcome.runId || task.pendingOutcome !== null) raise("INVALID_INPUT", "Outcome does not match active Run");
      if (outcome.status === "completed" && outcome.runId === null && !allowsDeterministic(task)) raise("INVALID_INPUT", "Deterministic completion is not permitted for this task");
      task.pendingOutcome = structuredClone(outcome);
      return task;
    });
  }

  async retry(id: string, input: { error: TaskError; runId: string | null; nextRunAt: string }): Promise<TaskStoreResult<TaskRecordV4>> {
    try {
      validateFinish({ status: "failed", runId: input.runId, error: input.error });
      const next = normalizeRunAt(input.nextRunAt);
      return await this.#updateTask(id, (task) => {
        if (task.status !== "running" || task.attempts.length >= TASK_MAX_ATTEMPTS || task.pendingOutcome !== null) raise("INVALID_INPUT", "Task cannot be retried");
        if (Date.parse(next) <= this.#now()) raise("INVALID_INPUT", "Retry must be in the future");
        finishAttempt(task, { status: "failed", runId: input.runId, error: input.error }, new Date(this.#now()).toISOString());
        task.status = "pending";
        task.retryAt = next;
        task.startedAt = null; task.finishedAt = null; task.runId = null; task.threadId = null; task.error = null; task.resultText = null;
        return task;
      });
    } catch (error) { return errorResult(error, neverAborted, true); }
  }

  async listNotifications(now = this.#now()): Promise<TaskStoreResult<TaskRecordV4[]>> {
    try {
      if (!Number.isFinite(now)) raise("INVALID_INPUT", "Notification time must be finite");
      return { ok: true, value: (await this.#read()).tasks.filter((task): task is TaskRecordV4 => task.kind === "arrangement" && task.acknowledgedAt === null && task.notification !== null && notificationIsDue(task.notification, now)).slice(0, TASK_LIST_MAX_LIMIT).map(cloneRecord) };
    } catch (error) { return errorResult(error, neverAborted, false); }
  }

  async recordNotification(id: string, outcome: TaskNotificationRecord): Promise<TaskStoreResult<TaskRecordV4>> {
    try {
      if (!outcome.ok) {
        validateTaskError(outcome.error);
        if (outcome.nextAttemptAt !== null) validateStoredTimestamp(outcome.nextAttemptAt, "Notification nextAttemptAt");
      }
      return await this.#updateTask(id, (task) => {
        const notification = task.notification;
        if (!notification || !notificationCanRecord(notification)) raise("INVALID_INPUT", "Notification is not pending");
        if (!outcome.ok && outcome.nextAttemptAt !== null && Date.parse(outcome.nextAttemptAt) <= this.#now()) raise("INVALID_INPUT", "Notification retry must be in the future");
        notification.attempts += 1;
        notification.status = notificationStatusFor(outcome);
        notification.error = outcome.ok ? null : { ...outcome.error };
        notification.nextAttemptAt = outcome.ok || notification.attempts >= TASK_MAX_NOTIFICATION_ATTEMPTS ? null : outcome.nextAttemptAt;
        return task;
      });
    } catch (error) { return errorResult(error, neverAborted, true); }
  }

  async #updateTask(id: string, operation: (task: TaskRecordV4) => TaskRecordV4): Promise<TaskStoreResult<TaskRecordV4>> {
    if (typeof id !== "string" || id.length === 0) return fail("INVALID_INPUT", "Task id must be non-empty");
    try {
      const value = await this.#update(neverAborted, (document) => {
        const task = arrangementById(document, id);
        return operation(task);
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) { return errorResult(error, neverAborted, true); }
  }

  async #updateRecurring(
    id: string,
    signal: AbortSignal,
    operation: (task: RecurringTaskRecord) => RecurringTaskRecord,
  ): Promise<TaskStoreResult<RecurringTaskRecord>> {
    if (typeof id !== "string" || id.length === 0) {
      return fail("INVALID_INPUT", "Recurring task id must be non-empty");
    }
    try {
      throwIfAborted(signal);
      const value = await this.#update(signal, (document) => {
        const task = document.recurringTasks.find((candidate) => candidate.id === id);
        if (task === undefined) {
          raise("RECURRING_TASK_NOT_FOUND", `Recurring task not found: ${id}`);
        }
        return operation(task);
      });
      return { ok: true, value: cloneRecurringTask(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async #read(): Promise<TaskDocumentV5> {
    await this.#inspectRoot();
    let directoryDetails;
    try {
      directoryDetails = await lstat(this.#directory);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        return this.#emptyDocument();
      }
      throw error;
    }
    if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
      raise("TASK_FILE_INVALID", "Task storage path is not a regular directory");
    }
    await this.#rejectLegacyWorkTaskFile();
    let fileDetails;
    try {
      fileDetails = await lstat(this.#file);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        return this.#emptyDocument();
      }
      throw error;
    }
    if (fileDetails.isSymbolicLink() || !fileDetails.isFile()) {
      raise("TASK_FILE_INVALID", "Task storage path is not a regular file");
    }
    if (fileDetails.size > TASK_FILE_MAX_BYTES) raise("TASK_FILE_INVALID", "Task file exceeds size limit");
    const text = await readFile(this.#file, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      raise("TASK_FILE_INVALID", "Task file must contain valid JSON");
    }
    if (isObject(value) && (value.version === 1 || value.version === 2 || value.version === 3 || value.version === 4)) migrationRequired(this.#file);
    return validateDocument(value);
  }

  async #rejectLegacyWorkTaskFile(): Promise<void> {
    try {
      const stats = await lstat(join(this.#directory, "work-tasks.json"));
      if (stats.isFile() || stats.isSymbolicLink()) migrationRequired(this.#file);
    } catch (error) {
      if (filesystemCode(error) !== "ENOENT") throw error;
    }
  }

  #emptyDocument(): TaskDocumentV5 {
    return { version: 5, tasks: [], recurringTasks: [] };
  }

  async #inspectRoot(): Promise<void> {
    let details;
    try {
      details = await lstat(this.#root);
    } catch {
      raise("READ_FAILED", "Workspace cannot be inspected");
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      raise("READ_FAILED", "Workspace is not a directory");
    }
  }

  async #ensureDirectory(): Promise<void> {
    await this.#inspectRoot();
    await mkdir(this.#directory, { recursive: true });
    const details = await lstat(this.#directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      raise("WRITE_FAILED", "Task storage path is not a regular directory");
    }
  }

  async #update<T>(
    signal: AbortSignal,
    operation: (document: TaskDocument) => T,
  ): Promise<T> {
    await this.#ensureDirectory();
    const lock = await acquireFlock(this.#lockFile, signal);
    try {
      if (this.#commitUncertain) raise("COMMIT_UNCERTAIN", "Task save acknowledgement is uncertain; restart and reread before further writes");
      if (this.#writeFailed) raise("WRITE_FAILED", "Task storage failed; restart and reconcile before further dispatch");
      throwIfAborted(signal);
      const document = await this.#read();
      const before = JSON.stringify(document);
      const value = operation(document);
      // Idle worker polling and exact receipt replays are reads, not writes.
      // Preserve lazy migration and avoid replacing/fsyncing an unchanged file.
      if (JSON.stringify(document) !== before) {
        const serialized = `${JSON.stringify(document)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > TASK_FILE_MAX_BYTES) raise("TASK_FILE_INVALID", "Task file exceeds size limit");
        validateDocument(JSON.parse(serialized) as unknown);
        await this.#write(document, signal);
      }
      return value;
    } finally {
      await lock.release();
    }
  }

  async #write(document: TaskDocumentV5, signal: AbortSignal): Promise<void> {
    await this.#ensureDirectory();
    const temporary = join(this.#directory, `.tasks.json.runloom-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    let renamed = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      throwIfAborted(signal);
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await handle.sync();
      throwIfAborted(signal);
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#file);
      renamed = true;
      created = false;
      if (process.platform !== "win32") {
        const directory = await open(this.#directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (created) await rm(temporary, { force: true }).catch(() => undefined);
      if (!signal.aborted || error !== abortReason(signal)) this.#writeFailed = true;
      if (renamed) {
        this.#commitUncertain = true;
        raise("COMMIT_UNCERTAIN", "Task file was replaced but acknowledgement is uncertain; restart and reread, do not repeat execution");
      }
      throw error;
    }
  }
}

export const TaskStore = WorkspaceTaskStore;

function notificationCanRecord(notification: TaskNotification): boolean {
  switch (notification.status) {
    case "pending":
    case "failed":
      return notification.attempts < TASK_MAX_NOTIFICATION_ATTEMPTS;
    case "submitted":
    case "omitted":
      return false;
    default: {
      const unreachable: never = notification.status;
      return unreachable;
    }
  }
}

function notificationIsDue(notification: TaskNotification, now: number): boolean {
  switch (notification.status) {
    case "pending":
    case "failed":
      return notification.attempts < TASK_MAX_NOTIFICATION_ATTEMPTS && notification.nextAttemptAt !== null && Date.parse(notification.nextAttemptAt) <= now;
    case "submitted":
    case "omitted":
      return false;
    default: {
      const unreachable: never = notification.status;
      return unreachable;
    }
  }
}

function notificationStatusFor(outcome: TaskNotificationRecord): TaskNotification["status"] {
  if (!outcome.ok) return "failed";
  switch (outcome.delivery) {
    case "omitted":
      return "omitted";
    case undefined:
      return "submitted";
    default: {
      const unreachable: never = outcome.delivery;
      return unreachable;
    }
  }
}

function notificationSurvivesRestore(status: TaskNotification["status"]): boolean {
  switch (status) {
    case "submitted":
    case "omitted":
      return true;
    case "pending":
    case "failed":
      return false;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/** Explicit offline restore: keep execution history, revoke all future dispatch. */
export function restoreTaskDocument(value: unknown, restoredAt: string): TaskDocumentV5 {
  validateStoredTimestamp(restoredAt, "Restore time");
  const document = validateDocument(value);
  for (const task of document.tasks) {
    if (task.kind !== "arrangement") continue;
    task.retryAt = null; task.pendingOutcome = null;
    // Submitted and foreground-omitted states are historical. Pending intent is not restored.
    if (task.notification === null || !notificationSurvivesRestore(task.notification.status)) task.notification = null;
    if (arrangementWaiting(task)) { task.status = "cancelled"; task.finishedAt = restoredAt; }
    if (task.status === "running") {
      const error = { code: "RESTORED_INTERRUPTED", message: "Restored execution requires review; no model or tool was replayed" };
      task.status = "pending"; task.finishedAt = restoredAt; task.error = error;
      const attempt = task.attempts.at(-1)!;
      attempt.status = "interrupted"; attempt.finishedAt = restoredAt; attempt.error = error;
    }
  }
  for (const recurring of document.recurringTasks) if (recurring.status === "active") { recurring.status = "paused"; recurring.nextRunAt = null; }
  return validateDocument(document);
}

// Backup inspection shares the read contract without creating a Store or writes.
export { validateDocument as validateTaskDocument };

export function createTaskStore(
  filePath: string,
  options: TaskStoreOptions = {},
): WorkspaceTaskStore {
  return new WorkspaceTaskStore(filePath, options);
}

export function taskWorkerLockPath(dataDirectory: string): string {
  return resolve(dataDirectory, TASK_WORKER_LOCK_FILE_NAME);
}
