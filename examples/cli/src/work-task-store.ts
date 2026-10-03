import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { acquireFlock, tryAcquireFlock, type FlockHandle } from "./flock.js";
import type { ExecutionRecordStore, ExecutionToolRecord } from "./execution-record-store.js";
import { rejectSymlinkComponents, validateWorkspacePath } from "./workspace-path.js";

export const WORK_TASK_FILE_NAME = ".runloom/work-tasks.json";
export const WORK_TASK_LOCK_FILE_NAME = ".runloom/work-tasks.json.lock";
export const WORK_TASK_FILE_MAX_BYTES = 512 * 1024;
export const WORK_TASK_MAX_ENTRIES = 100;
export const WORK_TASK_MAX_BYTES = 32 * 1024;

const LIMITS = {
  goalBytes: 2_048,
  textBytes: 1_024,
  noteBytes: 2_048,
  deliverySummaryBytes: 8_192,
  constraints: 24,
  acceptance: 24,
  runIds: 64,
  refs: 64,
  reconciliations: 64,
} as const;

export const workTaskStatuses = [
  "ready", "running", "paused", "needs_review", "awaiting_acceptance", "completed", "cancelled",
] as const;
export type WorkTaskStatus = (typeof workTaskStatuses)[number];

export const acceptanceStatuses = ["passed", "failed", "blocked", "not_run"] as const;
export type AcceptanceStatus = (typeof acceptanceStatuses)[number];

export type AcceptanceVerification =
  | { kind: "human" }
  | { kind: "artifact_exists"; path: string }
  | { kind: "shell_exit_zero"; command: string; cwd: string };

export type WorkTaskEvidence =
  | { id: string; kind: "tool"; runId: string; toolCallId: string; toolName: "shell_exec"; command: string; cwd: string; verifiedAt: string; outcome: "succeeded" }
  | { id: string; kind: "artifact"; runId: string; toolCallId: string; path: string; sha256: string; verifiedAt: string }
  | { id: string; kind: "human"; criterionId: string; acceptedAt: string };

export interface AcceptanceCriterion {
  id: string;
  description: string;
  method: "automatic" | "human";
  verification: AcceptanceVerification;
  required: boolean;
  status: AcceptanceStatus;
  evidenceRefs: string[];
  note: string | null;
}

export interface WorkTaskDelivery {
  summary: string;
  artifactRefs: string[];
  evidence: WorkTaskEvidence[];
  unresolved: string[];
}

export const workTaskObservedOutcomes = [
  "applied", "partially_applied", "not_applied", "still_unknown",
] as const;
export type WorkTaskObservedOutcome = (typeof workTaskObservedOutcomes)[number];

export interface WorkTaskReconciliation {
  id: string;
  runId: string;
  actor: "human";
  observedOutcome: WorkTaskObservedOutcome;
  decision: "continue" | "cancel";
  note: string;
  confirmedAt: string;
}

export interface WorkTask {
  id: string;
  revision: number;
  threadId: string;
  goal: string;
  constraints: string[];
  acceptance: AcceptanceCriterion[];
  status: WorkTaskStatus;
  runIds: string[];
  delivery: WorkTaskDelivery | null;
  reconciliations: WorkTaskReconciliation[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkTaskInput {
  threadId: string;
  goal: string;
  constraints?: string[];
  acceptance: Array<Pick<AcceptanceCriterion, "id" | "description" | "method" | "verification" | "required">>;
}

export interface WorkTaskListInput {
  status?: WorkTaskStatus;
  threadId?: string;
  limit?: number;
}

export type WorkTaskErrorCode =
  | "WORK_TASK_INVALID_INPUT"
  | "WORK_TASK_NOT_FOUND"
  | "WORK_TASK_REVISION_CONFLICT"
  | "WORK_TASK_INVALID_STATE"
  | "WORK_TASK_LIMIT_EXCEEDED"
  | "WORK_TASK_FILE_INVALID"
  | "WORK_TASK_VERSION_UNSUPPORTED"
  | "WORK_TASK_SYMLINK_NOT_ALLOWED"
  | "WORK_TASK_READ_FAILED"
  | "WORK_TASK_WRITE_FAILED";

export interface WorkTaskFailure {
  ok: false;
  error: { code: WorkTaskErrorCode; message: string };
}
export type WorkTaskResult<T> = { ok: true; value: T } | WorkTaskFailure;

export interface WorkTaskStore {
  claimThread(threadId: string): Promise<FlockHandle>;
  create(input: CreateWorkTaskInput): Promise<WorkTaskResult<WorkTask>>;
  get(id: string): Promise<WorkTaskResult<WorkTask>>;
  list(input?: WorkTaskListInput): Promise<WorkTaskResult<WorkTask[]>>;
  beginRun(id: string, input: { expectedRevision: number; runId: string }): Promise<WorkTaskResult<WorkTask>>;
  pause(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>>;
  requestChanges(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>>;
  markNeedsReview(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>>;
  settleRecoveredRun(id: string, input: {
    expectedRevision: number;
    latestRunId: string;
    disposition: "paused" | "needs_review";
  }): Promise<WorkTaskResult<WorkTask>>;
  reconcile(id: string, input: {
    expectedRevision: number;
    observedOutcome: WorkTaskObservedOutcome;
    decision: "continue" | "cancel";
    note: string;
  }): Promise<WorkTaskResult<WorkTask>>;
  submitDelivery(id: string, input: { expectedRevision: number; delivery: WorkTaskDelivery }): Promise<WorkTaskResult<WorkTask>>;
  recordAcceptance(id: string, input: {
    expectedRevision: number;
    criterionId: string;
    actor: "automatic" | "human";
    status: AcceptanceStatus;
    evidence?: WorkTaskEvidence[];
    note?: string | null;
  }): Promise<WorkTaskResult<WorkTask>>;
  cancel(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>>;
}

interface WorkTaskDocument { version: 1; tasks: WorkTask[] }

class WorkTaskStoreError extends Error {
  constructor(readonly code: WorkTaskErrorCode, message: string) {
    super(message);
    this.name = "WorkTaskStoreError";
  }
}

function raise(code: WorkTaskErrorCode, message: string): never {
  throw new WorkTaskStoreError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    raise("WORK_TASK_FILE_INVALID", `${field} contains unsupported fields`);
  }
}

function text(value: unknown, field: string, maxBytes: number, file = false): string {
  if (typeof value !== "string" || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    raise(file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT", `${field} is invalid`);
  }
  return value;
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function strings(value: unknown, field: string, maxItems: number, maxBytes: number, file = false): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    raise(file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT", `${field} is invalid`);
  }
  return value.map((item, index) => text(item, `${field}[${index}]`, maxBytes, file));
}

function parseVerification(value: unknown, method: "automatic" | "human", field: string, file: boolean): AcceptanceVerification {
  const code = file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT";
  if (!isRecord(value) || typeof value.kind !== "string") raise(code, `${field} is invalid`);
  if (value.kind === "human") {
    if (method !== "human" || Object.keys(value).some((key) => key !== "kind")) raise(code, `${field} does not match method`);
    return { kind: "human" };
  }
  if (method !== "automatic") raise(code, `${field} does not match method`);
  if (value.kind === "artifact_exists") {
    if (Object.keys(value).some((key) => !["kind", "path"].includes(key))) raise(code, `${field} contains unsupported fields`);
    return { kind: "artifact_exists", path: text(value.path, `${field}.path`, LIMITS.textBytes, file) };
  }
  if (value.kind === "shell_exit_zero") {
    if (Object.keys(value).some((key) => !["kind", "command", "cwd"].includes(key))) raise(code, `${field} contains unsupported fields`);
    return {
      kind: "shell_exit_zero",
      command: text(value.command, `${field}.command`, LIMITS.textBytes, file),
      cwd: value.cwd === undefined ? "." : text(value.cwd, `${field}.cwd`, LIMITS.textBytes, file),
    };
  }
  raise(code, `${field} is invalid`);
}

function parseEvidence(value: unknown, field: string, file: boolean): WorkTaskEvidence {
  const code = file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT";
  if (!isRecord(value) || typeof value.kind !== "string") raise(code, `${field} is invalid`);
  const id = text(value.id, `${field}.id`, 128, file);
  if (value.kind === "tool") {
    if (Object.keys(value).some((key) => !["id", "kind", "runId", "toolCallId", "toolName", "command", "cwd", "verifiedAt", "outcome"].includes(key)) ||
        !timestamp(value.verifiedAt) || value.outcome !== "succeeded" || value.toolName !== "shell_exec") raise(code, `${field} is invalid`);
    return { id, kind: "tool", runId: text(value.runId, `${field}.runId`, 128, file), toolCallId: text(value.toolCallId, `${field}.toolCallId`, 128, file), toolName: "shell_exec", command: text(value.command, `${field}.command`, LIMITS.textBytes, file), cwd: text(value.cwd, `${field}.cwd`, LIMITS.textBytes, file), verifiedAt: value.verifiedAt, outcome: "succeeded" };
  }
  if (value.kind === "artifact") {
    if (Object.keys(value).some((key) => !["id", "kind", "runId", "toolCallId", "path", "sha256", "verifiedAt"].includes(key)) ||
        typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || !timestamp(value.verifiedAt)) raise(code, `${field} is invalid`);
    return { id, kind: "artifact", runId: text(value.runId, `${field}.runId`, 128, file), toolCallId: text(value.toolCallId, `${field}.toolCallId`, 128, file), path: text(value.path, `${field}.path`, LIMITS.textBytes, file), sha256: value.sha256, verifiedAt: value.verifiedAt };
  }
  if (value.kind === "human") {
    if (Object.keys(value).some((key) => !["id", "kind", "criterionId", "acceptedAt"].includes(key)) || !timestamp(value.acceptedAt)) raise(code, `${field} is invalid`);
    return { id, kind: "human", criterionId: text(value.criterionId, `${field}.criterionId`, 128, file), acceptedAt: value.acceptedAt };
  }
  raise(code, `${field} is invalid`);
}

function evidence(value: unknown, field: string, file: boolean): WorkTaskEvidence[] {
  const code = file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT";
  if (!Array.isArray(value) || value.length > LIMITS.refs) raise(code, `${field} is invalid`);
  const parsed = value.map((item, index) => parseEvidence(item, `${field}[${index}]`, file));
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length) raise(code, `${field} contains duplicate IDs`);
  return parsed;
}

function parseCriterion(value: unknown, field: string, file: boolean): AcceptanceCriterion {
  if (!isRecord(value)) raise(file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT", `${field} is invalid`);
  const allowed = file
    ? ["id", "description", "method", "verification", "required", "status", "evidenceRefs", "note"]
    : ["id", "description", "method", "verification", "required"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    raise(file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT", `${field} contains unsupported fields`);
  }
  if ((value.method !== "automatic" && value.method !== "human") || typeof value.required !== "boolean") {
    raise(file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT", `${field} is invalid`);
  }
  if (file && (!acceptanceStatuses.includes(value.status as AcceptanceStatus) ||
      (value.note !== null && (typeof value.note !== "string" || Buffer.byteLength(value.note, "utf8") > LIMITS.noteBytes)))) {
    raise("WORK_TASK_FILE_INVALID", `${field} is invalid`);
  }
  return {
    id: text(value.id, `${field}.id`, 128, file),
    description: text(value.description, `${field}.description`, LIMITS.textBytes, file),
    method: value.method,
    verification: parseVerification(value.verification, value.method, `${field}.verification`, file),
    required: value.required,
    status: file ? value.status as AcceptanceStatus : "not_run",
    evidenceRefs: file ? strings(value.evidenceRefs, `${field}.evidenceRefs`, LIMITS.refs, 128, true) : [],
    note: file ? value.note as string | null : null,
  };
}

function parseDelivery(value: unknown, file: boolean): WorkTaskDelivery {
  if (!isRecord(value)) raise(file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT", "delivery is invalid");
  const allowed = ["summary", "artifactRefs", "evidence", "unresolved"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    raise(file ? "WORK_TASK_FILE_INVALID" : "WORK_TASK_INVALID_INPUT", "delivery contains unsupported fields");
  }
  return {
    summary: text(value.summary, "delivery.summary", LIMITS.deliverySummaryBytes, file),
    artifactRefs: strings(value.artifactRefs, "delivery.artifactRefs", LIMITS.refs, LIMITS.textBytes, file),
    evidence: evidence(value.evidence, "delivery.evidence", file),
    unresolved: strings(value.unresolved, "delivery.unresolved", LIMITS.refs, LIMITS.textBytes, file),
  };
}

function parseReconciliation(value: unknown): WorkTaskReconciliation {
  if (!isRecord(value)) raise("WORK_TASK_FILE_INVALID", "Reconciliation must be an object");
  assertKeys(value, ["id", "runId", "actor", "observedOutcome", "decision", "note", "confirmedAt"], "reconciliation");
  if (value.actor !== "human" || !workTaskObservedOutcomes.includes(value.observedOutcome as WorkTaskObservedOutcome) ||
      (value.decision !== "continue" && value.decision !== "cancel") || !timestamp(value.confirmedAt)) {
    raise("WORK_TASK_FILE_INVALID", "Reconciliation is invalid");
  }
  if (value.decision === "continue" && value.observedOutcome === "still_unknown") {
    raise("WORK_TASK_FILE_INVALID", "A still-unknown reconciliation cannot continue");
  }
  return {
    id: text(value.id, "reconciliation.id", 128, true),
    runId: text(value.runId, "reconciliation.runId", 128, true),
    actor: "human",
    observedOutcome: value.observedOutcome as WorkTaskObservedOutcome,
    decision: value.decision,
    note: text(value.note, "reconciliation.note", LIMITS.noteBytes, true),
    confirmedAt: value.confirmedAt,
  };
}

function parseTask(value: unknown): WorkTask {
  if (!isRecord(value)) raise("WORK_TASK_FILE_INVALID", "Task must be an object");
  assertKeys(value, ["id", "revision", "threadId", "goal", "constraints", "acceptance", "status", "runIds", "delivery", "reconciliations", "createdAt", "updatedAt"], "task");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1 ||
      !workTaskStatuses.includes(value.status as WorkTaskStatus) || !timestamp(value.createdAt) || !timestamp(value.updatedAt) ||
      !Array.isArray(value.acceptance) || value.acceptance.length > LIMITS.acceptance || value.delivery === undefined) {
    raise("WORK_TASK_FILE_INVALID", "Task contains invalid fields");
  }
  const acceptance = value.acceptance.map((item, index) => parseCriterion(item, `acceptance[${index}]`, true));
  const runIds = strings(value.runIds, "runIds", LIMITS.runIds, 128, true);
  const reconciliations = value.reconciliations === undefined
    ? []
    : Array.isArray(value.reconciliations) && value.reconciliations.length <= LIMITS.reconciliations
      ? value.reconciliations.map(parseReconciliation)
      : raise("WORK_TASK_FILE_INVALID", "Reconciliation list is invalid");
  if (acceptance.length === 0 || !acceptance.some((item) => item.required) ||
      new Set(acceptance.map((item) => item.id)).size !== acceptance.length || new Set(runIds).size !== runIds.length) {
    raise("WORK_TASK_FILE_INVALID", "Task contains duplicate IDs");
  }
  const task: WorkTask = {
    id: text(value.id, "id", 128, true), revision: value.revision as number,
    threadId: text(value.threadId, "threadId", 256, true), goal: text(value.goal, "goal", LIMITS.goalBytes, true),
    constraints: strings(value.constraints, "constraints", LIMITS.constraints, LIMITS.textBytes, true), acceptance,
    status: value.status as WorkTaskStatus, runIds, delivery: value.delivery === null ? null : parseDelivery(value.delivery, true),
    reconciliations,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
  };
  const evidenceIds = new Set(task.delivery?.evidence.map((item) => item.id) ?? []);
  if (task.acceptance.some((criterion) => criterion.evidenceRefs.some((id) => !evidenceIds.has(id)))) {
    raise("WORK_TASK_FILE_INVALID", "Acceptance criterion references missing evidence");
  }
  const savedEvidence = new Map(task.delivery?.evidence.map((item) => [item.id, item]) ?? []);
  if ((task.delivery?.evidence.some((item) => item.kind !== "human" && !task.runIds.includes(item.runId)) ?? false) ||
      task.reconciliations.some((item) => !task.runIds.includes(item.runId)) ||
      new Set(task.reconciliations.map((item) => item.id)).size !== task.reconciliations.length ||
      task.acceptance.some((criterion) => new Set(criterion.evidenceRefs).size !== criterion.evidenceRefs.length)) {
    raise("WORK_TASK_FILE_INVALID", "Task evidence does not belong to its Run history");
  }
  if (task.acceptance.some((criterion) => criterion.status === "passed" &&
      !criterion.evidenceRefs.some((id) => {
        const item = savedEvidence.get(id);
        return item !== undefined && evidenceMatches(criterion, item);
      }))) {
    raise("WORK_TASK_FILE_INVALID", "Passed acceptance criterion lacks matching evidence");
  }
  if (task.status === "completed" && (task.delivery === null || !requiredPassed(task))) raise("WORK_TASK_FILE_INVALID", "Completed task has unmet required criteria");
  if (task.status === "awaiting_acceptance" && task.delivery === null) raise("WORK_TASK_FILE_INVALID", "Awaiting task lacks delivery");
  if (task.status === "ready" && task.delivery !== null) raise("WORK_TASK_FILE_INVALID", "Ready task contains delivery");
  if (["running", "paused", "needs_review"].includes(task.status) && task.delivery !== null &&
      task.acceptance.some((criterion) => criterion.status !== "not_run" || criterion.evidenceRefs.length !== 0 || criterion.note !== null)) {
    raise("WORK_TASK_FILE_INVALID", "Historical delivery cannot carry active acceptance");
  }
  if (task.status === "ready" && task.runIds.length !== 0) raise("WORK_TASK_FILE_INVALID", "Ready task contains Run IDs");
  if (["running", "paused", "needs_review", "awaiting_acceptance", "completed"].includes(task.status) && task.runIds.length === 0) {
    raise("WORK_TASK_FILE_INVALID", "Started task lacks Run history");
  }
  if (task.updatedAt < task.createdAt) raise("WORK_TASK_FILE_INVALID", "Task timestamps are out of order");
  if (Buffer.byteLength(JSON.stringify(task), "utf8") > WORK_TASK_MAX_BYTES) raise("WORK_TASK_FILE_INVALID", "Task exceeds size limit");
  return task;
}

function parseDocument(value: unknown): WorkTaskDocument {
  if (!isRecord(value)) raise("WORK_TASK_FILE_INVALID", "Work task file must be an object");
  assertKeys(value, ["version", "tasks"], "document");
  if (value.version !== 1) raise("WORK_TASK_VERSION_UNSUPPORTED", "Unsupported work task version");
  if (!Array.isArray(value.tasks) || value.tasks.length > WORK_TASK_MAX_ENTRIES) raise("WORK_TASK_FILE_INVALID", "Task list is invalid");
  const tasks = value.tasks.map(parseTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) raise("WORK_TASK_FILE_INVALID", "Duplicate task ID");
  return { version: 1, tasks };
}

function requiredPassed(task: WorkTask): boolean {
  return task.acceptance.filter((item) => item.required).every((item) => item.status === "passed");
}

function evidenceMatches(criterion: AcceptanceCriterion, item: WorkTaskEvidence): boolean {
  return criterion.verification.kind === "human"
    ? item.kind === "human" && item.criterionId === criterion.id
    : criterion.verification.kind === "artifact_exists"
      ? item.kind === "artifact" && item.path === criterion.verification.path
      : item.kind === "tool" && item.toolName === "shell_exec" &&
        item.command === criterion.verification.command && item.cwd === criterion.verification.cwd;
}

function validateWritableDocument(document: WorkTaskDocument): void {
  for (const task of document.tasks) {
    if (!Number.isSafeInteger(task.revision) || task.revision < 1) {
      raise("WORK_TASK_LIMIT_EXCEEDED", "Work task revision limit reached");
    }
    if ((task.delivery?.evidence.length ?? 0) > LIMITS.refs ||
        Buffer.byteLength(JSON.stringify(task), "utf8") > WORK_TASK_MAX_BYTES) {
      raise("WORK_TASK_LIMIT_EXCEEDED", "Work task exceeds size limit");
    }
  }
  // Use the same cross-field validator as the read path before replacing the file.
  parseDocument(document);
}

class WorkTaskStoreImpl implements WorkTaskStore {
  readonly #root: string;
  readonly #file: string;
  readonly #lock: string;
  readonly #now: () => Date;
  readonly #generateId: () => string;
  readonly #executionRecords: Pick<ExecutionRecordStore, "getRun"> | undefined;

  constructor(workspace: string, options: {
    now?: () => Date;
    generateId?: () => string;
    executionRecords?: Pick<ExecutionRecordStore, "getRun">;
  } = {}) {
    this.#root = resolve(workspace);
    this.#file = join(this.#root, WORK_TASK_FILE_NAME);
    this.#lock = join(this.#root, WORK_TASK_LOCK_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#generateId = options.generateId ?? randomUUID;
    this.#executionRecords = options.executionRecords;
  }

  async claimThread(threadId: string): Promise<FlockHandle> {
    try {
      const normalized = text(threadId, "threadId", 256);
      await this.#ensureDirectory();
      const digest = createHash("sha256").update(normalized).digest("hex");
      const path = join(dirname(this.#file), `.work-task-owner-${digest}.lock`);
      await this.#inspectOptionalFile(path, "thread lock");
      const handle = await tryAcquireFlock(path);
      if (handle === null) raise("WORK_TASK_INVALID_STATE", "Work task Thread is already controlled by another process");
      return handle;
    } catch (error) {
      if (error instanceof WorkTaskStoreError) throw error;
      raise("WORK_TASK_WRITE_FAILED", "Unable to claim work task Thread");
    }
  }

  async create(input: CreateWorkTaskInput): Promise<WorkTaskResult<WorkTask>> {
    try {
      if (!isRecord(input) || !Array.isArray(input.acceptance) || input.acceptance.length === 0 || input.acceptance.length > LIMITS.acceptance) {
        raise("WORK_TASK_INVALID_INPUT", "Acceptance criteria are required");
      }
      const criteria = input.acceptance.map((item, index) => parseCriterion(item, `acceptance[${index}]`, false));
      if (new Set(criteria.map((item) => item.id)).size !== criteria.length) raise("WORK_TASK_INVALID_INPUT", "Acceptance criterion IDs must be unique");
      if (!criteria.some((item) => item.required)) raise("WORK_TASK_INVALID_INPUT", "At least one required acceptance criterion is required");
      const at = this.#now().toISOString();
      const task: WorkTask = {
        id: text(this.#generateId(), "id", 128), revision: 1,
        threadId: text(input.threadId, "threadId", 256), goal: text(input.goal, "goal", LIMITS.goalBytes),
        constraints: strings(input.constraints ?? [], "constraints", LIMITS.constraints, LIMITS.textBytes), acceptance: criteria,
        status: "ready", runIds: [], delivery: null, createdAt: at, updatedAt: at,
        reconciliations: [],
      };
      return await this.#mutate((document) => {
        if (document.tasks.length >= WORK_TASK_MAX_ENTRIES) raise("WORK_TASK_LIMIT_EXCEEDED", "Work task limit reached");
        if (document.tasks.some((item) => item.id === task.id)) raise("WORK_TASK_INVALID_INPUT", "Generated task ID already exists");
        document.tasks.unshift(task);
        return task;
      });
    } catch (error) { return this.#error(error, "WORK_TASK_WRITE_FAILED"); }
  }

  async get(id: string): Promise<WorkTaskResult<WorkTask>> {
    try {
      text(id, "id", 128);
      const task = (await this.#load()).tasks.find((item) => item.id === id);
      return task ? { ok: true, value: structuredClone(task) } : { ok: false, error: { code: "WORK_TASK_NOT_FOUND", message: "Work task not found" } };
    } catch (error) { return this.#error(error, "WORK_TASK_READ_FAILED"); }
  }

  async list(input: WorkTaskListInput = {}): Promise<WorkTaskResult<WorkTask[]>> {
    try {
      const status = input.status;
      const limit = input.limit;
      if ((status !== undefined && !workTaskStatuses.includes(status)) ||
          (input.threadId !== undefined && (typeof input.threadId !== "string" || input.threadId.length === 0)) ||
          (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > WORK_TASK_MAX_ENTRIES))) {
        raise("WORK_TASK_INVALID_INPUT", "Invalid work task list filter");
      }
      let tasks = (await this.#load()).tasks;
      if (status) tasks = tasks.filter((task) => task.status === status);
      if (input.threadId) tasks = tasks.filter((task) => task.threadId === input.threadId);
      return { ok: true, value: structuredClone(tasks.slice(0, limit ?? 20)) };
    } catch (error) { return this.#error(error, "WORK_TASK_READ_FAILED"); }
  }

  beginRun(id: string, input: { expectedRevision: number; runId: string }): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, input.expectedRevision, (task, document) => {
      if (!["ready", "paused"].includes(task.status)) raise("WORK_TASK_INVALID_STATE", "Task cannot begin a Run in its current state");
      const runId = text(input.runId, "runId", 128);
      if (document.tasks.some((item) => item.runIds.includes(runId))) raise("WORK_TASK_INVALID_INPUT", "Run is already linked to a work task");
      if (task.runIds.length >= LIMITS.runIds) raise("WORK_TASK_LIMIT_EXCEEDED", "Run history limit reached");
      task.runIds.push(runId);
      task.status = "running";
    });
  }

  pause(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, expectedRevision, (task) => {
      if (task.status !== "running") raise("WORK_TASK_INVALID_STATE", "Only a running task can be paused");
      task.status = "paused";
    });
  }

  markNeedsReview(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, expectedRevision, (task) => {
      if (!["ready", "running", "paused"].includes(task.status)) raise("WORK_TASK_INVALID_STATE", "Task cannot require review in its current state");
      task.status = "needs_review";
    });
  }

  settleRecoveredRun(id: string, input: {
    expectedRevision: number;
    latestRunId: string;
    disposition: "paused" | "needs_review";
  }): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, input.expectedRevision, (task) => {
      if (task.status !== "running") raise("WORK_TASK_INVALID_STATE", "Only a running task can be recovered");
      const latestRunId = text(input.latestRunId, "latestRunId", 128);
      if (task.runIds.at(-1) !== latestRunId) {
        raise("WORK_TASK_REVISION_CONFLICT", "Work task Run history changed during recovery");
      }
      if (input.disposition !== "paused" && input.disposition !== "needs_review") {
        raise("WORK_TASK_INVALID_INPUT", "Recovery disposition is invalid");
      }
      task.status = input.disposition;
    });
  }

  reconcile(id: string, input: {
    expectedRevision: number;
    observedOutcome: WorkTaskObservedOutcome;
    decision: "continue" | "cancel";
    note: string;
  }): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, input.expectedRevision, (task) => {
      if (task.status !== "needs_review") raise("WORK_TASK_INVALID_STATE", "Only a task requiring review can be reconciled");
      if (!workTaskObservedOutcomes.includes(input.observedOutcome) ||
          (input.decision !== "continue" && input.decision !== "cancel")) {
        raise("WORK_TASK_INVALID_INPUT", "Reconciliation input is invalid");
      }
      if (input.decision === "continue" && input.observedOutcome === "still_unknown") {
        raise("WORK_TASK_INVALID_INPUT", "A still-unknown outcome cannot be continued");
      }
      const runId = task.runIds.at(-1);
      if (runId === undefined) raise("WORK_TASK_INVALID_STATE", "Reconciliation requires a task Run");
      if (task.reconciliations.length >= LIMITS.reconciliations) {
        raise("WORK_TASK_LIMIT_EXCEEDED", "Reconciliation history limit reached");
      }
      const reconciliationId = text(this.#generateId(), "reconciliation.id", 128);
      if (task.reconciliations.some((item) => item.id === reconciliationId)) {
        raise("WORK_TASK_INVALID_INPUT", "Generated reconciliation ID already exists");
      }
      task.reconciliations.push({
        id: reconciliationId,
        runId,
        actor: "human",
        observedOutcome: input.observedOutcome,
        decision: input.decision,
        note: text(input.note, "reconciliation.note", LIMITS.noteBytes),
        confirmedAt: this.#now().toISOString(),
      });
      task.status = input.decision === "continue" ? "paused" : "cancelled";
    });
  }

  requestChanges(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, expectedRevision, (task) => {
      if (task.status !== "awaiting_acceptance") raise("WORK_TASK_INVALID_STATE", "Only an awaiting delivery can be returned for changes");
      for (const criterion of task.acceptance) {
        criterion.status = "not_run";
        criterion.evidenceRefs = [];
        criterion.note = null;
      }
      // Retain the last delivery for reference, never as current acceptance.
      task.status = "paused";
    });
  }

  submitDelivery(id: string, input: { expectedRevision: number; delivery: WorkTaskDelivery }): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, input.expectedRevision, (task) => {
      if (!["paused", "awaiting_acceptance"].includes(task.status)) {
        raise("WORK_TASK_INVALID_STATE", "Task cannot submit delivery in its current state");
      }
      const delivery = parseDelivery(input.delivery, false);
      if (delivery.evidence.length !== 0) {
        raise("WORK_TASK_INVALID_INPUT", "Delivery evidence is program-verified and cannot be supplied by the caller");
      }
      task.delivery = delivery;
      for (const criterion of task.acceptance) {
        criterion.status = "not_run";
        criterion.evidenceRefs = [];
        criterion.note = null;
      }
      task.status = "awaiting_acceptance";
    });
  }

  async recordAcceptance(id: string, input: { expectedRevision: number; criterionId: string; actor: "automatic" | "human"; status: AcceptanceStatus; evidence?: WorkTaskEvidence[]; note?: string | null }): Promise<WorkTaskResult<WorkTask>> {
    try {
      const snapshot = await this.get(id);
      if (!snapshot.ok) return snapshot;
      const snapshotCriterion = snapshot.value.acceptance.find((item) => item.id === input.criterionId);
      if (snapshot.value.status !== "awaiting_acceptance" || snapshot.value.delivery === null) {
        raise("WORK_TASK_INVALID_STATE", "Delivery must be active before recording acceptance");
      }
      if (snapshotCriterion === undefined) raise("WORK_TASK_INVALID_INPUT", "Acceptance criterion not found");
      if (input.actor !== snapshotCriterion.method || !acceptanceStatuses.includes(input.status)) {
        raise("WORK_TASK_INVALID_INPUT", "Acceptance input does not match criterion method");
      }
      const suppliedEvidence = input.evidence ?? [];
      if (!Array.isArray(suppliedEvidence) ||
          (input.status === "passed" ? suppliedEvidence.length !== 1 : suppliedEvidence.length !== 0)) {
        raise("WORK_TASK_INVALID_INPUT", "Passed acceptance requires exactly one proof; other statuses require none");
      }
      if (input.actor === "automatic" && input.status === "passed") {
        await this.#verifyAutomaticEvidence(snapshot.value, snapshotCriterion, suppliedEvidence);
      }
    } catch (error) {
      return this.#error(error, "WORK_TASK_READ_FAILED");
    }
    return this.#update(id, input.expectedRevision, (task) => {
      if (task.status !== "awaiting_acceptance") raise("WORK_TASK_INVALID_STATE", "Only an awaiting delivery can change acceptance");
      if (task.delivery === null) raise("WORK_TASK_INVALID_STATE", "Delivery must be submitted before recording acceptance");
      if (!acceptanceStatuses.includes(input.status)) raise("WORK_TASK_INVALID_INPUT", "Acceptance status is invalid");
      const criterion = task.acceptance.find((item) => item.id === input.criterionId);
      if (!criterion) raise("WORK_TASK_INVALID_INPUT", "Acceptance criterion not found");
      if (input.actor !== criterion.method) raise("WORK_TASK_INVALID_INPUT", "Acceptance actor does not match criterion method");
      const additions = evidence(input.evidence ?? [], "evidence", false);
      const allIds = new Set(task.delivery.evidence.map((item) => item.id));
      if (additions.some((item) => allIds.has(item.id))) raise("WORK_TASK_INVALID_INPUT", "Evidence ID already exists");
      if (input.status === "passed") {
        const matches = additions.some((item) => evidenceMatches(criterion, item) &&
          (item.kind === "human" || task.runIds.includes(item.runId)));
        if (!matches) raise("WORK_TASK_INVALID_INPUT", "Passed criterion requires matching task evidence");
      }
      task.delivery.evidence.push(...additions);
      criterion.status = input.status;
      criterion.evidenceRefs = additions.map((item) => item.id);
      criterion.note = input.note === undefined || input.note === null ? null : text(input.note, "note", LIMITS.noteBytes);
      task.status = task.delivery !== null && requiredPassed(task) ? "completed" : task.delivery !== null ? "awaiting_acceptance" : task.status;
    });
  }

  async #verifyAutomaticEvidence(task: WorkTask, criterion: AcceptanceCriterion, candidates: WorkTaskEvidence[]): Promise<void> {
    const candidate = candidates.find((item): item is Exclude<WorkTaskEvidence, { kind: "human" }> =>
      item.kind !== "human" && evidenceMatches(criterion, item));
    if (candidate === undefined || !task.runIds.includes(candidate.runId)) {
      raise("WORK_TASK_INVALID_INPUT", "Automatic acceptance lacks matching task evidence");
    }
    if (this.#executionRecords === undefined) {
      raise("WORK_TASK_INVALID_STATE", "Automatic acceptance requires execution receipts");
    }
    const latestRunId = task.runIds.at(-1);
    const run = latestRunId === undefined
      ? null
      : await this.#executionRecords.getRun(task.threadId, latestRunId);
    if (run === undefined || run === null) {
      raise("WORK_TASK_INVALID_INPUT", "Automatic evidence requires a current task Run receipt");
    }
    if (run.workTaskId !== task.id || run.phase !== "primary" || run.status === "running" ||
        run.status === "interrupted" || run.tools.some((tool) => tool.status === "unknown")) {
      raise("WORK_TASK_INVALID_INPUT", "Latest task Run contains an uncertain or foreign receipt");
    }
    if (candidate.runId !== run.runId) {
      raise("WORK_TASK_INVALID_INPUT", "Automatic evidence must come from the latest task Run");
    }
    const matchingTools = run.tools.filter((item) => candidate.kind === "tool"
      ? this.#shellInputMatches(item, candidate.command, candidate.cwd)
      : this.#artifactInputMatches(item, candidate.path));
    const tool = matchingTools.at(-1);
    if (tool?.toolCallId !== candidate.toolCallId) {
      raise("WORK_TASK_INVALID_INPUT", "Automatic evidence is not the latest matching tool receipt");
    }
    if (tool === undefined || tool.status !== "completed" || tool.inputTruncated || tool.resultTruncated) {
      raise("WORK_TASK_INVALID_INPUT", "Automatic evidence has no matching completed tool receipt");
    }
    if (candidate.kind === "tool") {
      if (!this.#validShellReceipt(tool, candidate)) {
        raise("WORK_TASK_INVALID_INPUT", "Shell evidence does not match its execution receipt");
      }
      return;
    }
    if (!this.#validArtifactReceipt(tool, candidate)) {
      raise("WORK_TASK_INVALID_INPUT", "Artifact evidence does not match its write receipt");
    }
    const path = validateWorkspacePath(this.#root, candidate.path);
    if (!path.ok || await rejectSymlinkComponents(this.#root, path.relativePath, new AbortController().signal)) {
      raise("WORK_TASK_INVALID_INPUT", "Artifact path is not a safe workspace file");
    }
    try {
      const stats = await lstat(path.target);
      if (!stats.isFile() || stats.size > 8 * 1024 * 1024) raise("WORK_TASK_INVALID_INPUT", "Artifact is not a verifiable regular file");
      const digest = createHash("sha256").update(await readFile(path.target)).digest("hex");
      if (digest !== candidate.sha256) raise("WORK_TASK_INVALID_INPUT", "Artifact hash no longer matches current content");
    } catch (error) {
      if (error instanceof WorkTaskStoreError) throw error;
      raise("WORK_TASK_INVALID_INPUT", "Artifact could not be verified");
    }
  }

  #validShellReceipt(tool: ExecutionToolRecord, candidate: Extract<WorkTaskEvidence, { kind: "tool" }>): boolean {
    if (tool.toolName !== "shell_exec" || tool.shell?.exitCode !== 0 || tool.shell.timedOut || tool.shell.cancelled) return false;
    return this.#shellInputMatches(tool, candidate.command, candidate.cwd);
  }

  #shellInputMatches(tool: ExecutionToolRecord, command: string, cwd: string): boolean {
    if (tool.toolName !== "shell_exec" || tool.inputTruncated) return false;
    try {
      const input = JSON.parse(tool.inputPreview) as unknown;
      return isRecord(input) && input.command === command && (input.cwd ?? ".") === cwd;
    } catch { return false; }
  }

  #validArtifactReceipt(tool: ExecutionToolRecord, candidate: Extract<WorkTaskEvidence, { kind: "artifact" }>): boolean {
    if (!this.#artifactInputMatches(tool, candidate.path)) return false;
    try {
      const output = tool.resultPreview === null ? null : JSON.parse(tool.resultPreview) as unknown;
      return isRecord(output) && output.ok === true && output.path === candidate.path;
    } catch { return false; }
  }

  #artifactInputMatches(tool: ExecutionToolRecord, path: string): boolean {
    if ((tool.toolName !== "write_file" && tool.toolName !== "edit_file") || tool.inputTruncated) return false;
    try {
      const input = JSON.parse(tool.inputPreview) as unknown;
      return isRecord(input) && input.path === path;
    } catch { return false; }
  }

  cancel(id: string, expectedRevision: number): Promise<WorkTaskResult<WorkTask>> {
    return this.#update(id, expectedRevision, (task) => {
      if (["running", "needs_review", "completed", "cancelled"].includes(task.status)) {
        raise("WORK_TASK_INVALID_STATE", "Task cannot be cancelled in its current state; needs_review requires reconciliation");
      }
      task.status = "cancelled";
    });
  }

  async #update(id: string, expectedRevision: number, update: (task: WorkTask, document: WorkTaskDocument) => void): Promise<WorkTaskResult<WorkTask>> {
    try {
      text(id, "id", 128);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) raise("WORK_TASK_INVALID_INPUT", "expectedRevision must be a positive integer");
      return await this.#mutate((document) => {
        const task = document.tasks.find((item) => item.id === id);
        if (!task) raise("WORK_TASK_NOT_FOUND", "Work task not found");
        if (task.revision !== expectedRevision) raise("WORK_TASK_REVISION_CONFLICT", `Work task revision is ${task.revision}; expected ${expectedRevision}`);
        update(task, document);
        task.revision += 1;
        task.updatedAt = this.#now().toISOString();
        if (Buffer.byteLength(JSON.stringify(task), "utf8") > WORK_TASK_MAX_BYTES) raise("WORK_TASK_LIMIT_EXCEEDED", "Work task exceeds size limit");
        return task;
      });
    } catch (error) { return this.#error(error, "WORK_TASK_WRITE_FAILED"); }
  }

  async #mutate<T>(update: (document: WorkTaskDocument) => T): Promise<WorkTaskResult<T>> {
    await this.#ensureDirectory();
    await this.#inspectOptionalFile(this.#lock, "lock");
    const lock = await acquireFlock(this.#lock);
    try {
      const document = await this.#load();
      const value = update(document);
      validateWritableDocument(document);
      const serialized = `${JSON.stringify(document)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > WORK_TASK_FILE_MAX_BYTES) raise("WORK_TASK_LIMIT_EXCEEDED", "Work task file exceeds size limit");
      await this.#write(serialized);
      return { ok: true, value: structuredClone(value) };
    } finally { await lock.release(); }
  }

  async #inspectRoot(): Promise<void> {
    let stats;
    try { stats = await lstat(this.#root); }
    catch { raise("WORK_TASK_READ_FAILED", "Workspace is unavailable"); }
    if (stats.isSymbolicLink()) raise("WORK_TASK_SYMLINK_NOT_ALLOWED", "Workspace must not be a symlink");
    if (!stats.isDirectory()) raise("WORK_TASK_READ_FAILED", "Workspace is not a directory");
  }

  async #ensureDirectory(): Promise<void> {
    await this.#inspectRoot();
    const directory = dirname(this.#file);
    try { await mkdir(directory); }
    catch (error) { if (fileCode(error) !== "EEXIST") raise("WORK_TASK_WRITE_FAILED", "Unable to create work task directory"); }
    const stats = await lstat(directory);
    if (stats.isSymbolicLink()) raise("WORK_TASK_SYMLINK_NOT_ALLOWED", "Work task directory must not be a symlink");
    if (!stats.isDirectory()) raise("WORK_TASK_FILE_INVALID", "Work task directory is invalid");
  }

  async #inspectOptionalFile(path: string, label: string): Promise<boolean> {
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) raise("WORK_TASK_SYMLINK_NOT_ALLOWED", `Work task ${label} must not be a symlink`);
      if (!stats.isFile()) raise("WORK_TASK_FILE_INVALID", `Work task ${label} is not a regular file`);
      if (path === this.#file && stats.size > WORK_TASK_FILE_MAX_BYTES) raise("WORK_TASK_FILE_INVALID", "Work task file exceeds size limit");
      return true;
    } catch (error) {
      if (fileCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async #load(): Promise<WorkTaskDocument> {
    await this.#inspectRoot();
    const directory = dirname(this.#file);
    try {
      const stats = await lstat(directory);
      if (stats.isSymbolicLink()) raise("WORK_TASK_SYMLINK_NOT_ALLOWED", "Work task directory must not be a symlink");
      if (!stats.isDirectory()) raise("WORK_TASK_FILE_INVALID", "Work task directory is invalid");
    } catch (error) {
      if (fileCode(error) === "ENOENT") return { version: 1, tasks: [] };
      throw error;
    }
    if (!(await this.#inspectOptionalFile(this.#file, "file"))) return { version: 1, tasks: [] };
    try { return parseDocument(JSON.parse(await readFile(this.#file, "utf8")) as unknown); }
    catch (error) {
      if (error instanceof WorkTaskStoreError) throw error;
      if (error instanceof SyntaxError) raise("WORK_TASK_FILE_INVALID", "Work task file contains invalid JSON");
      raise("WORK_TASK_READ_FAILED", "Unable to read work task file");
    }
  }

  async #write(serialized: string): Promise<void> {
    const directory = dirname(this.#file);
    const temporary = join(directory, `.work-tasks.${randomUUID()}.tmp`);
    let handle;
    let created = false;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      created = true;
      await handle.writeFile(serialized, "utf8");
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#file);
      created = false;
    } catch {
      raise("WORK_TASK_WRITE_FAILED", "Unable to write work task file");
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (created) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #error(error: unknown, fallback: WorkTaskErrorCode): WorkTaskFailure {
    if (error instanceof WorkTaskStoreError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: fallback, message: fallback === "WORK_TASK_READ_FAILED" ? "Unable to read work task store" : "Unable to write work task store" } };
  }
}

export function createWorkTaskStore(
  workspace: string,
  options?: { now?: () => Date; generateId?: () => string; executionRecords?: Pick<ExecutionRecordStore, "getRun"> },
): WorkTaskStore {
  return new WorkTaskStoreImpl(workspace, options);
}
