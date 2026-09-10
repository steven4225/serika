import { randomUUID } from "node:crypto";
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

import { acquireFlock } from "./flock.js";
import { abortReason, throwIfAborted, validateWorkspacePath } from "./workspace-path.js";

export const TASK_FILE_NAME = ".runloom/tasks.json";
export const TASK_LOCK_FILE_NAME = ".runloom/tasks.json.lock";
export const TASK_WORKER_LOCK_FILE_NAME = ".runloom/task-worker.lock";
export const TASK_PROMPT_MAX_BYTES = 16 * 1024;
export const TASK_LIST_DEFAULT_LIMIT = 20;
export const TASK_LIST_MAX_LIMIT = 50;
export const TASK_PREVIEW_MAX_CHARACTERS = 120;

export const taskStatuses = [
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];

export interface TaskError {
  code: string;
  message: string;
}

export interface TaskRecord {
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
}

export interface TaskDocument {
  version: 1;
  tasks: TaskRecord[];
}

export interface CreateTaskInput {
  prompt: string;
  runAt: string;
}

export interface TaskSummary {
  id: string;
  promptPreview: string;
  runAt: string;
  status: TaskStatus;
}

export interface TaskListInput {
  status?: TaskStatus;
  limit?: number;
}

export interface TaskList {
  tasks: TaskSummary[];
  truncated: boolean;
}

export type TaskFinish =
  | {
      status: "completed";
      runId: string;
      resultText: string;
    }
  | {
      status: "failed" | "interrupted";
      runId: string | null;
      error: TaskError;
    };

export const taskStoreErrorCodes = [
  "INVALID_INPUT",
  "TASK_NOT_FOUND",
  "TASK_NOT_CANCELLABLE",
  "TASK_FILE_INVALID",
  "TASK_VERSION_UNSUPPORTED",
  "READ_FAILED",
  "WRITE_FAILED",
] as const;

export type TaskStoreErrorCode = (typeof taskStoreErrorCodes)[number];

export interface TaskFailure {
  ok: false;
  error: { code: TaskStoreErrorCode; message: string };
}

export type TaskStoreResult<T> = { ok: true; value: T } | TaskFailure;

export interface TaskStore {
  create(input: CreateTaskInput, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecord>>;
  list(input?: TaskListInput): Promise<TaskStoreResult<TaskList>>;
  get(id: string): Promise<TaskStoreResult<TaskRecord>>;
  cancel(id: string, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecord>>;
  claimNextDue(signal?: AbortSignal): Promise<TaskStoreResult<TaskRecord | null>>;
  finish(id: string, outcome: TaskFinish, signal?: AbortSignal): Promise<TaskStoreResult<TaskRecord>>;
  interruptRunning(signal?: AbortSignal): Promise<TaskStoreResult<number>>;
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

function cloneError(error: TaskError | null): TaskError | null {
  return error === null ? null : { ...error };
}

function cloneRecord(record: TaskRecord): TaskRecord {
  return { ...record, error: cloneError(record.error) };
}

function promptPreview(prompt: string): string {
  return Array.from(prompt).slice(0, TASK_PREVIEW_MAX_CHARACTERS).join("");
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

function validateRecord(value: unknown): TaskRecord {
  if (!isObject(value)) raise("TASK_FILE_INVALID", "Task records must be objects");
  if (typeof value.id !== "string" || value.id.length === 0) {
    raise("TASK_FILE_INVALID", "Task id must be non-empty");
  }
  validateStoredPrompt(value.prompt);
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
  if (!isTaskStatus(value.status)) raise("TASK_FILE_INVALID", "Task status is invalid");
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

  if (value.status === "scheduled" || value.status === "cancelled") {
    if (value.startedAt !== null || value.threadId !== null || value.runId !== null ||
        value.resultText !== null || error !== null ||
        (value.status === "scheduled" && value.finishedAt !== null)) {
      raise("TASK_FILE_INVALID", `Task ${value.status} state has inconsistent execution fields`);
    }
  }
  if (value.status === "running") {
    if (value.startedAt === null || value.finishedAt !== null || value.threadId === null ||
        value.runId !== null || value.resultText !== null || error !== null) {
      raise("TASK_FILE_INVALID", "Task running state has inconsistent execution fields");
    }
  }
  if (value.status === "completed") {
    if (value.startedAt === null || value.finishedAt === null || value.threadId === null ||
        value.runId === null || value.resultText === null || error !== null) {
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
  };
}

function validateDocument(value: unknown): TaskDocument {
  if (!isObject(value)) raise("TASK_FILE_INVALID", "Task file must contain a JSON object");
  if (value.version !== 1) raise("TASK_VERSION_UNSUPPORTED", "Unsupported task file version");
  if (!Array.isArray(value.tasks)) raise("TASK_FILE_INVALID", "Task file tasks must be an array");
  const ids = new Set<string>();
  const tasks: TaskRecord[] = [];
  for (const taskValue of value.tasks) {
    const task = validateRecord(taskValue);
    if (ids.has(task.id)) raise("TASK_FILE_INVALID", `Duplicate task id: ${task.id}`);
    ids.add(task.id);
    tasks.push(task);
  }
  return { version: 1, tasks };
}

function validateCreateInput(input: unknown): CreateTaskInput & { runAt: string } {
  if (!isObject(input)) raise("INVALID_INPUT", "Task input must be an object");
  validatePrompt(input.prompt);
  const runAt = normalizeRunAt(input.runAt);
  return { prompt: input.prompt, runAt };
}

function validateTaskListInput(input: unknown): Required<Pick<TaskListInput, "limit">> & TaskListInput {
  if (input === undefined) return { limit: TASK_LIST_DEFAULT_LIMIT };
  if (!isObject(input)) raise("INVALID_INPUT", "Task list input must be an object");
  if (input.status !== undefined && !isTaskStatus(input.status)) {
    raise("INVALID_INPUT", "Task list status is invalid");
  }
  if (input.limit !== undefined &&
      (typeof input.limit !== "number" || !Number.isInteger(input.limit) ||
       input.limit < 1 || input.limit > TASK_LIST_MAX_LIMIT)) {
    raise("INVALID_INPUT", `Task list limit must be an integer from 1 to ${TASK_LIST_MAX_LIMIT}`);
  }
  return {
    ...(input.status === undefined ? {} : { status: input.status }),
    limit: input.limit === undefined ? TASK_LIST_DEFAULT_LIMIT : input.limit,
  };
}

function validateFinish(outcome: unknown): asserts outcome is TaskFinish {
  if (!isObject(outcome) || !isTaskStatus(outcome.status) ||
      !["completed", "failed", "interrupted"].includes(outcome.status)) {
    raise("INVALID_INPUT", "Task finish status is invalid");
  }
  if (outcome.status === "completed") {
    if (typeof outcome.runId !== "string" || outcome.runId.length === 0 ||
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
  if (signal.aborted) throw abortReason(signal);
  if (error instanceof TaskStoreError) return fail(error.code, error.message);
  return fail(
    write ? "WRITE_FAILED" : "READ_FAILED",
    write ? "Unable to write tasks" : "Unable to read tasks",
  );
}

export class WorkspaceTaskStore implements TaskStore {
  readonly #root: string;
  readonly #file: string;
  readonly #directory: string;
  readonly #lockFile: string;
  readonly #now: () => number;
  readonly #generateId: () => string;

  constructor(workspace: string, options: TaskStoreOptions = {}) {
    const root = resolve(workspace);
    const validated = validateWorkspacePath(root, TASK_FILE_NAME);
    if (!validated.ok) throw new TaskStoreError("INVALID_INPUT", validated.message);
    this.#root = root;
    this.#file = validated.target;
    this.#directory = dirname(this.#file);
    this.#lockFile = resolve(root, TASK_LOCK_FILE_NAME);
    this.#now = options.now ?? Date.now;
    this.#generateId = options.generateId ?? randomUUID;
  }

  async create(
    input: CreateTaskInput,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecord>> {
    try {
      throwIfAborted(signal);
      const normalized = validateCreateInput(input);
      if (Date.parse(normalized.runAt) <= this.#now()) {
        raise("INVALID_INPUT", "Task runAt must be later than the current time");
      }
      const task: TaskRecord = {
        id: this.#generateId(),
        prompt: normalized.prompt,
        runAt: normalized.runAt,
        status: "scheduled",
        createdAt: new Date(this.#now()).toISOString(),
        startedAt: null,
        finishedAt: null,
        threadId: null,
        runId: null,
        resultText: null,
        error: null,
      };
      if (task.id.length === 0) raise("WRITE_FAILED", "Task id generator returned an empty id");
      const value = await this.#update(signal, (document) => {
        document.tasks.push(task);
        return task;
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async list(input?: TaskListInput): Promise<TaskStoreResult<TaskList>> {
    try {
      const validated = validateTaskListInput(input);
      const document = await this.#read();
      const filtered = validated.status === undefined
        ? document.tasks
        : document.tasks.filter((task) => task.status === validated.status);
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
            promptPreview: promptPreview(task.prompt),
            runAt: task.runAt,
            status: task.status,
          })),
          truncated: sorted.length > validated.limit,
        },
      };
    } catch (error) {
      return errorResult(error, neverAborted, false);
    }
  }

  async get(id: string): Promise<TaskStoreResult<TaskRecord>> {
    if (typeof id !== "string" || id.length === 0) return fail("INVALID_INPUT", "Task id must be non-empty");
    try {
      const document = await this.#read();
      const task = document.tasks.find((candidate) => candidate.id === id);
      return task === undefined
        ? fail("TASK_NOT_FOUND", `Task not found: ${id}`)
        : { ok: true, value: cloneRecord(task) };
    } catch (error) {
      return errorResult(error, neverAborted, false);
    }
  }

  async cancel(
    id: string,
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecord>> {
    if (typeof id !== "string" || id.length === 0) return fail("INVALID_INPUT", "Task id must be non-empty");
    try {
      throwIfAborted(signal);
      const value = await this.#update(signal, (document) => {
        const task = document.tasks.find((candidate) => candidate.id === id);
        if (task === undefined) raise("TASK_NOT_FOUND", `Task not found: ${id}`);
        if (task.status === "cancelled") return task;
        if (task.status !== "scheduled") {
          raise("TASK_NOT_CANCELLABLE", `Task cannot be cancelled in ${task.status} state`);
        }
        task.status = "cancelled";
        task.finishedAt = new Date(this.#now()).toISOString();
        return task;
      });
      return { ok: true, value: cloneRecord(value) };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async claimNextDue(
    signal: AbortSignal = neverAborted,
  ): Promise<TaskStoreResult<TaskRecord | null>> {
    try {
      throwIfAborted(signal);
      const now = this.#now();
      const value = await this.#update(signal, (document) => {
        const due = document.tasks
          .filter((task) => task.status === "scheduled" && Date.parse(task.runAt) <= now)
          .sort((a, b) => {
            const runAt = Date.parse(a.runAt) - Date.parse(b.runAt);
            if (runAt !== 0) return runAt;
            const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
            return created !== 0 ? created : a.id.localeCompare(b.id);
          })[0];
        if (due === undefined) return null;
        due.status = "running";
        due.startedAt = new Date(now).toISOString();
        due.threadId = this.#generateId();
        if (due.threadId.length === 0) raise("WRITE_FAILED", "Task thread id generator returned an empty id");
        return due;
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
  ): Promise<TaskStoreResult<TaskRecord>> {
    if (typeof id !== "string" || id.length === 0) return fail("INVALID_INPUT", "Task id must be non-empty");
    try {
      throwIfAborted(signal);
      validateFinish(outcome);
      const value = await this.#update(signal, (document) => {
        const task = document.tasks.find((candidate) => candidate.id === id);
        if (task === undefined) raise("TASK_NOT_FOUND", `Task not found: ${id}`);
        if (task.status !== "running") raise("INVALID_INPUT", "Only a running task can be finished");
        task.status = outcome.status;
        task.finishedAt = new Date(this.#now()).toISOString();
        task.runId = outcome.runId;
        if (outcome.status === "completed") {
          task.resultText = outcome.resultText;
          task.error = null;
        } else {
          task.resultText = null;
          task.error = { ...outcome.error };
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
        for (const task of document.tasks) {
          if (task.status !== "running") continue;
          task.status = "interrupted";
          task.finishedAt = new Date(this.#now()).toISOString();
          task.error = {
            code: "WORKER_INTERRUPTED",
            message: "Task was interrupted by worker shutdown or restart",
          };
          interrupted += 1;
        }
        return interrupted;
      });
      return { ok: true, value };
    } catch (error) {
      return errorResult(error, signal, true);
    }
  }

  async #read(): Promise<TaskDocument> {
    await this.#inspectRoot();
    let directoryDetails;
    try {
      directoryDetails = await lstat(this.#directory);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") return { version: 1, tasks: [] };
      throw error;
    }
    if (directoryDetails.isSymbolicLink() || !directoryDetails.isDirectory()) {
      raise("TASK_FILE_INVALID", "Task storage path is not a regular directory");
    }
    let fileDetails;
    try {
      fileDetails = await lstat(this.#file);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") return { version: 1, tasks: [] };
      throw error;
    }
    if (fileDetails.isSymbolicLink() || !fileDetails.isFile()) {
      raise("TASK_FILE_INVALID", "Task storage path is not a regular file");
    }
    const text = await readFile(this.#file, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      raise("TASK_FILE_INVALID", "Task file must contain valid JSON");
    }
    return validateDocument(value);
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
      throwIfAborted(signal);
      const document = await this.#read();
      const value = operation(document);
      await this.#write(document, signal);
      return value;
    } finally {
      await lock.release();
    }
  }

  async #write(document: TaskDocument, signal: AbortSignal): Promise<void> {
    await this.#ensureDirectory();
    const temporary = join(this.#directory, `.tasks.json.runloom-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      created = true;
      throwIfAborted(signal);
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      throwIfAborted(signal);
      await handle.close();
      handle = undefined;
      await rename(temporary, this.#file);
      created = false;
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (created) await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export const TaskStore = WorkspaceTaskStore;

export function createTaskStore(
  workspace: string,
  options: TaskStoreOptions = {},
): TaskStore {
  return new WorkspaceTaskStore(workspace, options);
}

export function taskWorkerLockPath(workspace: string): string {
  return resolve(workspace, TASK_WORKER_LOCK_FILE_NAME);
}
