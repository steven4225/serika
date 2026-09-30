import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import { acquireFlock, tryAcquireFlock, type FlockHandle } from "./flock.js";

export const EXECUTION_RECORD_FILE = "execution-records.json";
export const EXECUTION_RECORD_MAX_RUNS = 50;
export const EXECUTION_RECORD_MAX_TOOLS = 64;
export const EXECUTION_RECORD_MAX_BYTES = 256 * 1024;
export const EXECUTION_RECORD_PREVIEW_BYTES = 2 * 1024;

export type ExecutionRunStatus = RunResult["status"] | "running" | "interrupted";
export type ExecutionToolStatus =
  | "requested" | "not_started" | "started" | "completed" | "failed" | "unknown";
export type ExecutionPhase = "primary" | "consolidation";

export interface ExecutionToolRecord {
  toolCallId: string;
  toolName: string;
  status: ExecutionToolStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  inputPreview: string;
  inputTruncated: boolean;
  resultPreview: string | null;
  resultTruncated: boolean;
  errorPreview: string | null;
  shell: { exitCode: number | null; timedOut: boolean; cancelled: boolean } | null;
}

export interface ExecutionRunRecord {
  runId: string;
  threadId: string;
  workTaskId?: string;
  phase: ExecutionPhase;
  status: ExecutionRunStatus;
  startedAt: string;
  finishedAt: string | null;
  resultTextPreview: string | null;
  resultTextTruncated: boolean;
  errorPreview: string | null;
  tools: ExecutionToolRecord[];
}

export type ExecutionRecordErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "LIMIT_EXCEEDED"
  | "FILE_INVALID" | "VERSION_UNSUPPORTED" | "SYMLINK_NOT_ALLOWED"
  | "READ_FAILED" | "WRITE_FAILED";

export class ExecutionRecordError extends Error {
  constructor(readonly code: ExecutionRecordErrorCode, message: string) {
    super(message);
    this.name = "ExecutionRecordError";
  }
}

type Document = { version: 1; runs: ExecutionRunRecord[] };
type ToolEvent = Extract<AgentEvent, { type: "tool.call.requested" | "tool.call.started" | "tool.call.completed" | "tool.call.failed" }>;
const emptyDocument = (): Document => ({ version: 1, runs: [] });

function fail(code: ExecutionRecordErrorCode, message: string): never {
  throw new ExecutionRecordError(code, message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function preview(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= EXECUTION_RECORD_PREVIEW_BYTES) return { text, truncated: false };
  // Decode may replace an incomplete final code point. That is display-only.
  return { text: bytes.subarray(0, EXECUTION_RECORD_PREVIEW_BYTES).toString("utf8"), truncated: true };
}

function stringifyPreview(value: unknown): { text: string; truncated: boolean } {
  let serialized: string;
  try { serialized = JSON.stringify(value) ?? "null"; }
  catch { serialized = "[unserializable]"; }
  return preview(serialized);
}

function validPreview(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= EXECUTION_RECORD_PREVIEW_BYTES + 3;
}

function validateTool(value: unknown): ExecutionToolRecord {
  if (!isObject(value)) fail("FILE_INVALID", "Tool record must be an object");
  if (typeof value.toolCallId !== "string" || !value.toolCallId ||
      typeof value.toolName !== "string" || !value.toolName ||
      !["requested", "not_started", "started", "completed", "failed", "unknown"].includes(String(value.status)) ||
      !timestamp(value.requestedAt) ||
      (value.startedAt !== null && !timestamp(value.startedAt)) ||
      (value.finishedAt !== null && !timestamp(value.finishedAt)) ||
      !validPreview(value.inputPreview) || typeof value.inputTruncated !== "boolean" ||
      (value.resultPreview !== null && !validPreview(value.resultPreview)) ||
      typeof value.resultTruncated !== "boolean" ||
      (value.errorPreview !== null && !validPreview(value.errorPreview))) {
    fail("FILE_INVALID", "Tool record contains invalid fields");
  }
  if (value.shell !== null && (!isObject(value.shell) ||
      (value.shell.exitCode !== null && (!Number.isInteger(value.shell.exitCode) ||
        Math.abs(value.shell.exitCode as number) > 255)) ||
      typeof value.shell.timedOut !== "boolean" || typeof value.shell.cancelled !== "boolean")) {
    fail("FILE_INVALID", "Shell receipt is invalid");
  }
  return value as unknown as ExecutionToolRecord;
}

function validateRun(value: unknown): ExecutionRunRecord {
  if (!isObject(value)) fail("FILE_INVALID", "Run record must be an object");
  if (typeof value.runId !== "string" || !value.runId ||
      typeof value.threadId !== "string" || !value.threadId ||
      (value.workTaskId !== undefined && (typeof value.workTaskId !== "string" || !value.workTaskId)) ||
      (value.phase !== "primary" && value.phase !== "consolidation") ||
      !["running", "completed", "failed", "cancelled", "timed_out", "interrupted"].includes(String(value.status)) ||
      !timestamp(value.startedAt) || (value.finishedAt !== null && !timestamp(value.finishedAt)) ||
      (value.resultTextPreview !== null && !validPreview(value.resultTextPreview)) ||
      typeof value.resultTextTruncated !== "boolean" ||
      (value.errorPreview !== null && !validPreview(value.errorPreview)) ||
      !Array.isArray(value.tools) || value.tools.length > EXECUTION_RECORD_MAX_TOOLS) {
    fail("FILE_INVALID", "Run record contains invalid fields");
  }
  const tools = (value.tools as unknown[]).map(validateTool);
  if (new Set(tools.map((tool) => tool.toolCallId)).size !== tools.length) {
    fail("FILE_INVALID", "Duplicate tool call ID");
  }
  return value as unknown as ExecutionRunRecord;
}

function validateDocument(value: unknown): Document {
  if (!isObject(value)) fail("FILE_INVALID", "Execution record file must be an object");
  if (value.version !== 1) fail("VERSION_UNSUPPORTED", "Unsupported execution record version");
  if (!Array.isArray(value.runs) || value.runs.length > EXECUTION_RECORD_MAX_RUNS) {
    fail("FILE_INVALID", "Execution run list is invalid");
  }
  const runs = (value.runs as unknown[]).map(validateRun);
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    fail("FILE_INVALID", "Duplicate run ID");
  }
  return { version: 1, runs };
}

function filesystemCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function shellReceipt(output: unknown): ExecutionToolRecord["shell"] {
  if (!isObject(output) || output.ok !== true ||
      (output.exitCode !== null && !Number.isInteger(output.exitCode)) ||
      typeof output.timedOut !== "boolean" || typeof output.cancelled !== "boolean") return null;
  return {
    exitCode: output.exitCode as number | null,
    timedOut: output.timedOut,
    cancelled: output.cancelled,
  };
}

/** Local display/audit receipts. This is not Durable Runtime or replay state. */
export class ExecutionRecordStore {
  readonly #directory: string;
  readonly #file: string;
  readonly #lock: string;
  readonly #now: () => Date;

  constructor(directory: string, options: { now?: () => Date } = {}) {
    this.#directory = resolve(directory);
    this.#file = join(this.#directory, EXECUTION_RECORD_FILE);
    this.#lock = `${this.#file}.lock`;
    this.#now = options.now ?? (() => new Date());
  }

  /** Hold across one embedded-controller lifetime before recovering a Thread. */
  async claimThread(threadId: string): Promise<FlockHandle> {
    if (!threadId) fail("INVALID_INPUT", "Thread ID is required");
    await this.#inspectDirectory();
    const name = createHash("sha256").update(threadId).digest("hex");
    const path = join(this.#directory, `.execution-owner-${name}.lock`);
    await this.#inspectFile(path);
    const lease = await tryAcquireFlock(path);
    if (lease === null) fail("CONFLICT", "Thread is already owned by another controller process");
    return lease;
  }

  async startRun(input: { runId: string; threadId: string; workTaskId?: string; phase: ExecutionPhase; startedAt?: string }): Promise<void> {
    if (!input.runId || !input.threadId || !["primary", "consolidation"].includes(input.phase) ||
        (input.workTaskId !== undefined && !input.workTaskId) ||
        (input.startedAt !== undefined && !timestamp(input.startedAt))) fail("INVALID_INPUT", "Invalid Run identity");
    await this.#mutate((document) => {
      if (document.runs.some((run) => run.runId === input.runId)) fail("CONFLICT", "Run already recorded");
      document.runs.unshift({
        runId: input.runId, threadId: input.threadId,
        ...(input.workTaskId === undefined ? {} : { workTaskId: input.workTaskId }),
        phase: input.phase,
        status: "running", startedAt: input.startedAt ?? this.#now().toISOString(), finishedAt: null,
        resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [],
      });
    }, input.runId);
  }

  async recordToolEvent(runId: string, event: ToolEvent): Promise<void> {
    if (event.runId !== runId) fail("INVALID_INPUT", "Tool event belongs to another Run");
    await this.#mutate((document) => {
      const run = document.runs.find((item) => item.runId === runId);
      if (!run) fail("NOT_FOUND", "Run not found");
      if (run.status !== "running") fail("CONFLICT", "Run is terminal");
      const tool = run.tools.find((item) => item.toolCallId === event.data.toolCallId);
      if (event.type === "tool.call.requested") {
        if (tool) fail("CONFLICT", "Tool call already requested");
        if (run.tools.length >= EXECUTION_RECORD_MAX_TOOLS) fail("LIMIT_EXCEEDED", "Too many tool calls in Run");
        const input = stringifyPreview(event.data.input);
        run.tools.push({ toolCallId: event.data.toolCallId, toolName: event.data.toolName,
          status: "requested", requestedAt: event.occurredAt, startedAt: null, finishedAt: null,
          inputPreview: input.text, inputTruncated: input.truncated,
          resultPreview: null, resultTruncated: false, errorPreview: null, shell: null });
        return;
      }
      if (!tool || tool.toolName !== event.data.toolName) fail("CONFLICT", "Tool call identity mismatch");
      if (event.type === "tool.call.started") {
        if (tool.status !== "requested") fail("CONFLICT", "Tool call did not await start");
        tool.status = "started";
        tool.startedAt = event.occurredAt;
        return;
      }
      if (tool.status !== "requested" && tool.status !== "started") fail("CONFLICT", "Tool call is terminal");
      tool.status = event.type === "tool.call.completed" ? "completed" : "failed";
      tool.finishedAt = event.occurredAt;
      if (event.type === "tool.call.completed") {
        const result = stringifyPreview(event.data.output);
        tool.resultPreview = result.text;
        tool.resultTruncated = result.truncated;
        if (tool.toolName === "shell_exec") tool.shell = shellReceipt(event.data.output);
      } else {
        tool.errorPreview = preview(event.data.error.message).text;
      }
    }, runId);
  }

  async finishRun(runId: string, result: RunResult): Promise<void> {
    if (result.runId !== runId) fail("INVALID_INPUT", "Result belongs to another Run");
    await this.#mutate((document) => {
      const run = document.runs.find((item) => item.runId === runId);
      if (!run) fail("NOT_FOUND", "Run not found");
      if (run.status !== "running" || run.threadId !== result.threadId) fail("CONFLICT", "Run cannot be finished");
      const text = preview(result.text);
      run.status = result.status;
      run.finishedAt = this.#now().toISOString();
      run.resultTextPreview = text.text;
      run.resultTextTruncated = text.truncated;
      run.errorPreview = result.error ? preview(result.error.message).text : null;
      for (const tool of run.tools) {
        if (tool.status === "started") tool.status = "unknown";
        else if (tool.status === "requested") tool.status = "not_started";
      }
    }, runId);
  }

  /** A failed Core create has no RunResult, but its journal intent must close. */
  async failStart(runId: string, error: unknown): Promise<void> {
    await this.#mutate((document) => {
      const run = document.runs.find((item) => item.runId === runId);
      if (!run) fail("NOT_FOUND", "Run not found");
      if (run.status !== "running" || run.tools.length !== 0) {
        fail("CONFLICT", "Only an unstarted Run can fail during creation");
      }
      run.status = "failed";
      run.finishedAt = this.#now().toISOString();
      run.errorPreview = preview(String(error)).text;
    }, runId);
  }

  async recoverInterrupted(threadId: string): Promise<number> {
    if (!threadId) fail("INVALID_INPUT", "Thread ID is required");
    let recovered = 0;
    await this.#mutate((document) => {
      const at = this.#now().toISOString();
      for (const run of document.runs) {
        if (run.threadId !== threadId || run.status !== "running") continue;
        recovered += 1;
        run.status = "interrupted";
        run.finishedAt = at;
        for (const tool of run.tools) {
          if (tool.status === "started") tool.status = "unknown";
          else if (tool.status === "requested") tool.status = "not_started";
        }
      }
    });
    return recovered;
  }

  async listRuns(threadId: string, limit = 20): Promise<ExecutionRunRecord[]> {
    if (!threadId) fail("INVALID_INPUT", "Thread ID is required");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXECUTION_RECORD_MAX_RUNS) {
      fail("INVALID_INPUT", "Run list limit is invalid");
    }
    return (await this.#load()).runs.filter((run) => run.threadId === threadId).slice(0, limit);
  }

  async getRun(threadId: string, runId: string): Promise<ExecutionRunRecord | null> {
    if (!threadId || !runId) fail("INVALID_INPUT", "Thread and Run IDs are required");
    return (await this.#load()).runs.find((run) => run.threadId === threadId && run.runId === runId) ?? null;
  }

  async #inspectDirectory(): Promise<void> {
    let stats;
    try { stats = await lstat(this.#directory); }
    catch (error) { fail("READ_FAILED", `Transcript directory unavailable: ${String(error)}`); }
    if (stats.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", "Transcript directory must not be a symlink");
    if (!stats.isDirectory()) fail("READ_FAILED", "Transcript path is not a directory");
  }

  async #inspectFile(file: string): Promise<boolean> {
    try {
      const stats = await lstat(file);
      if (stats.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", "Execution record path must not be a symlink");
      if (!stats.isFile()) fail("FILE_INVALID", "Execution record path is not a regular file");
      if (stats.size > EXECUTION_RECORD_MAX_BYTES) fail("FILE_INVALID", "Execution record file exceeds size limit");
      return true;
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async #load(): Promise<Document> {
    await this.#inspectDirectory();
    if (!(await this.#inspectFile(this.#file))) return emptyDocument();
    try { return validateDocument(JSON.parse(await readFile(this.#file, "utf8")) as unknown); }
    catch (error) {
      if (error instanceof ExecutionRecordError) throw error;
      if (error instanceof SyntaxError) fail("FILE_INVALID", "Execution record file contains invalid JSON");
      fail("READ_FAILED", "Unable to read execution record file");
    }
  }

  async #mutate(update: (document: Document) => void, protectedRunId?: string): Promise<void> {
    await this.#inspectDirectory();
    if (await this.#inspectFile(this.#lock)) {
      // Existing regular lock file is safe to hand to flock.
    }
    const lock = await acquireFlock(this.#lock);
    try {
      const document = await this.#load();
      update(document);
      const oldestPrunable = (): number => {
        for (let index = document.runs.length - 1; index >= 0; index -= 1) {
          const run = document.runs[index]!;
          if (run.status !== "running" && run.runId !== protectedRunId) return index;
        }
        return -1;
      };
      while (document.runs.length > EXECUTION_RECORD_MAX_RUNS) {
        const index = oldestPrunable();
        if (index < 0) fail("LIMIT_EXCEEDED", "Active Run records exceed retention limit");
        document.runs.splice(index, 1);
      }
      let serialized = `${JSON.stringify(document)}\n`;
      while (Buffer.byteLength(serialized, "utf8") > EXECUTION_RECORD_MAX_BYTES) {
        const index = oldestPrunable();
        if (index < 0) fail("LIMIT_EXCEEDED", "Execution record file exceeds size limit");
        document.runs.splice(index, 1);
        serialized = `${JSON.stringify(document)}\n`;
      }
      const temporary = join(this.#directory, `.execution-records.${randomUUID()}.tmp`);
      let created = false;
      try {
        const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        created = true;
        try { await handle.writeFile(serialized, "utf8"); }
        finally { await handle.close(); }
        await rename(temporary, this.#file);
        created = false;
      } finally {
        if (created) await rm(temporary, { force: true });
      }
    } finally { await lock.release(); }
  }
}

export function createExecutionRecordStore(
  directory: string, options?: { now?: () => Date },
): ExecutionRecordStore {
  return new ExecutionRecordStore(directory, options);
}
