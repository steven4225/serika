import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import { acquireFlock, tryAcquireFlock, type FlockHandle } from "./flock.js";
import { compactTraceEvent, validTrace, validTraceUsage, TRACE_MAX_EVENTS, TRACE_MAX_BYTES, type ExecutionTrace } from "./execution-trace.js";
import { MODEL_CALL_LIMIT, validModelCall, type ModelCallRecord, type ModelUsagePage } from "./model-usage.js";

export const EXECUTION_RECORD_FILE = "execution-records.json";
export const EXECUTION_RECORD_MAX_RUNS = 50;
export const EXECUTION_RECORD_MAX_TOOLS = 64;
export const EXECUTION_RECORD_MAX_BYTES = 256 * 1024;
export const EXECUTION_RECORD_PREVIEW_BYTES = 2 * 1024;
const FILE_WRITE_MAX_BYTES = 65_536;
const FILE_PATH_MAX_BYTES = 1_024;
const SHA256 = /^[0-9a-f]{64}$/;

export type ExecutionRunStatus = RunResult["status"] | "running" | "interrupted";
export type ExecutionToolStatus =
  | "requested" | "not_started" | "started" | "completed" | "failed" | "unknown";
export type ExecutionPhase = "primary" | "consolidation" | "skill";

export interface AssistantSteerRecord {
  id: string;
  runId: string;
  text: string;
  status: "accepted" | "applied" | "not_applied";
  receivedAt: string;
  appliedAt?: string;
  messageId?: string;
  reason?: string;
}

export interface ExecutionToolRecord {
  toolCallId: string;
  toolName: string;
  status: ExecutionToolStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Actual confirmation creation observed by the Controller, not inferred from request latency. */
  approvalRequestedAt?: string;
  inputPreview: string;
  inputTruncated: boolean;
  resultPreview: string | null;
  resultTruncated: boolean;
  errorPreview: string | null;
  shell: { exitCode: number | null; timedOut: boolean; cancelled: boolean } | null;
  /** Captured from the full request before dispatch; never reconstructed from a preview. */
  fileInput?: { path: string; sha256?: string };
  /** Successful file-tool result, independently bounded from display previews. */
  fileWrite?: { path: string; bytes: number; sha256: string };
  /** Digest of the full successful read output, not the display preview or later disk. */
  fileRead?: { path: string; bytes: number; sha256: string };
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
  completion?: RunResult["completion"];
  /** Host-observed versions prepared during this primary Run; never model claims. */
  memoryReferences?: { id: string; revision: number }[];
  memoryReferencesTruncated?: boolean;
  /** Audit only: never a replay queue. Unapplied messages remain visible after restart. */
  steers?: AssistantSteerRecord[];
  trace?: ExecutionTrace;
}

export type ExecutionRecordErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "LIMIT_EXCEEDED"
  | "FILE_INVALID" | "VERSION_UNSUPPORTED" | "SYMLINK_NOT_ALLOWED"
  | "READ_FAILED" | "WRITE_FAILED" | "COMMIT_UNCERTAIN";

export class ExecutionRecordError extends Error {
  constructor(readonly code: ExecutionRecordErrorCode, message: string) {
    super(message);
    this.name = "ExecutionRecordError";
  }
}

type Document = { version: 1; runs: ExecutionRunRecord[]; modelUsage?: ModelUsagePage };
type ToolEvent = Extract<AgentEvent, { type: "tool.call.requested" | "tool.call.started" | "tool.call.completed" | "tool.call.failed" | "tool.call.superseded" }>;
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

function filePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= FILE_PATH_MAX_BYTES;
}

function fileRequest(toolName: string, input: unknown): ExecutionToolRecord["fileInput"] {
  if (!["write_file", "edit_file", "read_file"].includes(toolName) || !isObject(input) || !filePath(input.path)) return undefined;
  return { path: input.path,
    ...(toolName === "write_file" && typeof input.content === "string"
      ? { sha256: createHash("sha256").update(input.content, "utf8").digest("hex") } : {}),
  };
}

function fileResult(tool: ExecutionToolRecord, output: unknown): ExecutionToolRecord["fileWrite"] {
  if (!["write_file", "edit_file"].includes(tool.toolName)) return undefined;
  if (tool.startedAt === null || tool.fileInput === undefined || !isObject(output) ||
      output.ok !== true || output.path !== tool.fileInput.path || typeof output.sha256 !== "string" ||
      !SHA256.test(output.sha256) || !Number.isSafeInteger(output.bytes) ||
      (output.bytes as number) < 0 || (output.bytes as number) > FILE_WRITE_MAX_BYTES ||
      (tool.toolName === "write_file" && tool.fileInput.sha256 !== output.sha256)) return undefined;
  return { path: tool.fileInput.path, bytes: output.bytes as number, sha256: output.sha256 };
}

function fileReadResult(tool: ExecutionToolRecord, output: unknown): ExecutionToolRecord["fileRead"] {
  if (tool.toolName !== "read_file" || tool.startedAt === null || !tool.fileInput || !isObject(output) ||
      output.ok !== true || output.path !== tool.fileInput.path || typeof output.content !== "string" ||
      !Number.isSafeInteger(output.bytes) || (output.bytes as number) < 0 || (output.bytes as number) > 65536 ||
      Buffer.byteLength(output.content, "utf8") !== output.bytes) return undefined;
  return { path: tool.fileInput.path, bytes: output.bytes as number,
    sha256: createHash("sha256").update(output.content, "utf8").digest("hex") };
}

export function hasMatchingFileReadback(tools: ExecutionToolRecord[], write: ExecutionToolRecord, path: string, sha256: string, bytes: number): boolean {
  const index = tools.indexOf(write);
  if (index < 0) return false;
  const read = tools.slice(index + 1).filter(tool => tool.toolName === "read_file" && tool.fileInput?.path === path).at(-1);
  return read?.status === "completed" && read.startedAt !== null && read.fileRead?.path === path &&
    read.fileRead.sha256 === sha256 && read.fileRead.bytes === bytes;
}

/** Match intent even for a failed later write, so an earlier success cannot substitute for it. */
export function matchesFileWritePath(tool: ExecutionToolRecord, path: string): boolean {
  if (!["write_file", "edit_file"].includes(tool.toolName)) return false;
  if (tool.fileInput !== undefined) return tool.fileInput.path === path;
  if (tool.inputTruncated) return false;
  try { const input: unknown = JSON.parse(tool.inputPreview); return isObject(input) && input.path === path; }
  catch { return false; }
}

/** Legacy complete previews still work; missing compact data never repairs a truncated old receipt. */
export function readFileWriteReceipt(tool: ExecutionToolRecord, path: string):
  { sha256: string | null; bytes: number | null } | undefined {
  if (tool.status !== "completed" || !matchesFileWritePath(tool, path)) return undefined;
  if (tool.fileWrite !== undefined) {
    if (tool.startedAt === null || tool.fileWrite.path !== path || tool.fileInput?.path !== path ||
        (tool.toolName === "write_file" && tool.fileInput.sha256 !== tool.fileWrite.sha256)) return undefined;
    return { sha256: tool.fileWrite.sha256, bytes: tool.fileWrite.bytes };
  }
  if (tool.inputTruncated || tool.resultTruncated || tool.resultPreview === null) return undefined;
  try {
    const output: unknown = JSON.parse(tool.resultPreview);
    // A hash-bearing new result must have its compact, bound receipt. Never downgrade it.
    return isObject(output) && output.ok === true && output.path === path && output.sha256 === undefined
      ? { sha256: null, bytes: null } : undefined;
  } catch { return undefined; }
}

function validateTool(value: unknown): ExecutionToolRecord {
  if (!isObject(value)) fail("FILE_INVALID", "Tool record must be an object");
  if (typeof value.toolCallId !== "string" || !value.toolCallId ||
      typeof value.toolName !== "string" || !value.toolName ||
      !["requested", "not_started", "started", "completed", "failed", "unknown"].includes(String(value.status)) ||
      !timestamp(value.requestedAt) ||
      (value.startedAt !== null && !timestamp(value.startedAt)) ||
      (value.finishedAt !== null && !timestamp(value.finishedAt)) ||
      (value.approvalRequestedAt !== undefined && !timestamp(value.approvalRequestedAt)) ||
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
  if (value.fileInput !== undefined && (!isObject(value.fileInput) || !filePath(value.fileInput.path) ||
      Object.keys(value.fileInput).some((key) => !["path", "sha256"].includes(key)) ||
      !["write_file", "edit_file", "read_file"].includes(String(value.toolName)) ||
      (value.toolName !== "write_file" && value.fileInput.sha256 !== undefined) ||
      (value.fileInput.sha256 !== undefined && (typeof value.fileInput.sha256 !== "string" || !SHA256.test(value.fileInput.sha256))))) {
    fail("FILE_INVALID", "File input receipt is invalid");
  }
  if (value.fileWrite !== undefined && (!isObject(value.fileWrite) || !filePath(value.fileWrite.path) ||
      Object.keys(value.fileWrite).some((key) => !["path", "bytes", "sha256"].includes(key)) ||
      !["write_file", "edit_file"].includes(String(value.toolName)) ||
      !isObject(value.fileInput) || value.fileWrite.path !== value.fileInput.path ||
      value.status !== "completed" || value.startedAt === null ||
      typeof value.fileWrite.sha256 !== "string" || !SHA256.test(value.fileWrite.sha256) ||
      !Number.isSafeInteger(value.fileWrite.bytes) || (value.fileWrite.bytes as number) < 0 ||
      (value.fileWrite.bytes as number) > FILE_WRITE_MAX_BYTES ||
      (value.toolName === "write_file" && value.fileInput.sha256 !== value.fileWrite.sha256))) {
    fail("FILE_INVALID", "File write receipt is invalid");
  }
  if (value.fileRead !== undefined && (!isObject(value.fileRead) || value.toolName !== "read_file" ||
      !filePath(value.fileRead.path) || !isObject(value.fileInput) || value.fileRead.path !== value.fileInput.path ||
      Object.keys(value.fileRead).some(key => !["path", "bytes", "sha256"].includes(key)) ||
      value.status !== "completed" || value.startedAt === null ||
      typeof value.fileRead.sha256 !== "string" || !SHA256.test(value.fileRead.sha256) ||
      !Number.isSafeInteger(value.fileRead.bytes) || (value.fileRead.bytes as number) < 0 || (value.fileRead.bytes as number) > 65536)) {
    fail("FILE_INVALID", "File read receipt is invalid");
  }
  return value as unknown as ExecutionToolRecord;
}

export function validateExecutionRunRecord(value: unknown): ExecutionRunRecord {
  if (!isObject(value)) fail("FILE_INVALID", "Run record must be an object");
  if (typeof value.runId !== "string" || !value.runId ||
      typeof value.threadId !== "string" || !value.threadId ||
      (value.workTaskId !== undefined && (typeof value.workTaskId !== "string" || !value.workTaskId)) ||
      (value.phase !== "primary" && value.phase !== "consolidation" && value.phase !== "skill") ||
      !["running", "completed", "failed", "cancelled", "timed_out", "interrupted"].includes(String(value.status)) ||
      !timestamp(value.startedAt) || (value.finishedAt !== null && !timestamp(value.finishedAt)) ||
      (value.resultTextPreview !== null && !validPreview(value.resultTextPreview)) ||
      typeof value.resultTextTruncated !== "boolean" ||
      (value.errorPreview !== null && !validPreview(value.errorPreview)) ||
      !Array.isArray(value.tools) || value.tools.length > EXECUTION_RECORD_MAX_TOOLS) {
    fail("FILE_INVALID", "Run record contains invalid fields");
  }
  const tools = (value.tools as unknown[]).map(validateTool);
  if (value.trace !== undefined && !validTrace(value.trace)) fail("FILE_INVALID", "Execution trace is invalid");
  if (value.steers !== undefined && (!Array.isArray(value.steers) || value.steers.length > 8 ||
      value.steers.some(item => !isObject(item) || typeof item.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.id) ||
        item.runId !== value.runId || typeof item.text !== "string" || !item.text.trim() || Buffer.byteLength(item.text, "utf8") > 4096 ||
        !["accepted", "applied", "not_applied"].includes(String(item.status)) || !timestamp(item.receivedAt) ||
        (item.appliedAt !== undefined && !timestamp(item.appliedAt)) ||
        (item.messageId !== undefined && (typeof item.messageId !== "string" || !item.messageId)) ||
        (item.reason !== undefined && (typeof item.reason !== "string" || item.reason.length > 256))) ||
      new Set(value.steers.map(item => (item as AssistantSteerRecord).id)).size !== value.steers.length)) {
    fail("FILE_INVALID", "Steering receipts are invalid");
  }
  if (value.memoryReferences !== undefined && (!Array.isArray(value.memoryReferences) || value.memoryReferences.length > 16 ||
      value.memoryReferences.some(item => !isObject(item) || Object.keys(item).some(key => !["id", "revision"].includes(key)) ||
        typeof item.id !== "string" || !item.id || item.id.length > 256 || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1))) {
    fail("FILE_INVALID", "Memory version references are invalid");
  }
  if (value.memoryReferencesTruncated !== undefined && typeof value.memoryReferencesTruncated !== "boolean") fail("FILE_INVALID", "Memory reference coverage is invalid");
  if (value.completion !== undefined && (!isObject(value.completion) ||
      !["delivered", "needs_confirmation", "needs_information", "budget_exhausted", "needs_review"].includes(String(value.completion.reason)) ||
      !Number.isSafeInteger(value.completion.corrections) || (value.completion.corrections as number) < 0 || (value.completion.corrections as number) > 32)) {
    fail("FILE_INVALID", "Run completion report is invalid");
  }
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
  const runs = (value.runs as unknown[]).map(validateExecutionRunRecord);
  if (new Set(runs.map((run) => run.runId)).size !== runs.length) {
    fail("FILE_INVALID", "Duplicate run ID");
  }
  if (value.modelUsage !== undefined) {
    const page = value.modelUsage;
    if (!isObject(page) || !Array.isArray(page.calls) || page.calls.length > MODEL_CALL_LIMIT ||
        !page.calls.every(validModelCall) || new Set(page.calls.map(call => call.id)).size !== page.calls.length ||
        !Number.isSafeInteger(page.droppedCount) || (page.droppedCount as number) < 0) {
      fail("FILE_INVALID", "Model usage records are invalid");
    }
  }
  return { version: 1, runs, ...(value.modelUsage === undefined ? {} : { modelUsage: value.modelUsage as unknown as ModelUsagePage }) };
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
  readonly #traceGaps = new Set<string>();
  #commitUncertain = false;
  #writeFailed = false;

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
    if (!input.runId || !input.threadId || !["primary", "consolidation", "skill"].includes(input.phase) ||
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
        trace: { version: 1, events: [], truncated: false, incomplete: false },
      });
    }, input.runId);
  }

  /** Invalid optional metadata may be omitted; actual storage failure stops dispatch. */
  async recordTraceEvent(event: AgentEvent): Promise<void> {
    const compact = compactTraceEvent(event);
    if (compact === null) return;
    try {
      await this.#mutate(document => {
        const run = document.runs.find(item => item.runId === event.runId && item.threadId === event.threadId);
        if (!run || run.status !== "running" || !run.trace) fail("CONFLICT", "Trace belongs to an active Run");
        const trace = run.trace;
        if (trace.events.some(item => item.sequence === compact.sequence)) return;
        if (trace.events.length >= TRACE_MAX_EVENTS ||
            Buffer.byteLength(JSON.stringify([...trace.events, compact])) > TRACE_MAX_BYTES) {
          trace.truncated = true;
          return;
        }
        trace.events.push(compact);
        if (!validTrace(trace)) fail("INVALID_INPUT", "Invalid trace metadata");
      }, event.runId);
    } catch (error) {
      this.#traceGaps.add(event.runId);
      if (this.#writeFailed || this.#commitUncertain ||
          !(error instanceof ExecutionRecordError) ||
          !["INVALID_INPUT", "CONFLICT", "NOT_FOUND", "LIMIT_EXCEEDED"].includes(error.code)) throw error;
    }
  }

  async recordApprovalRequested(threadId: string, toolCallId: string, toolName: string): Promise<void> {
    const at = this.#now().toISOString();
    let runId: string | undefined;
    try {
      await this.#mutate(document => {
        // Controller owns this Thread; tool IDs alone are never global identities.
        const run = document.runs.find(item => item.threadId === threadId && item.status === "running" &&
          item.tools.some(tool => tool.toolCallId === toolCallId && tool.toolName === toolName));
        if (!run) return;
        runId = run.runId;
        const tool = run.tools.find(tool => tool.toolCallId === toolCallId)!;
        tool.approvalRequestedAt ??= at;
      });
    } catch (error) {
      if (runId) this.#traceGaps.add(runId);
      if (this.#writeFailed || this.#commitUncertain ||
          !(error instanceof ExecutionRecordError) ||
          !["INVALID_INPUT", "CONFLICT", "NOT_FOUND", "LIMIT_EXCEEDED"].includes(error.code)) throw error;
    }
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
        const capturedFile = fileRequest(event.data.toolName, event.data.input);
        run.tools.push({ toolCallId: event.data.toolCallId, toolName: event.data.toolName,
          status: "requested", requestedAt: event.occurredAt, startedAt: null, finishedAt: null,
          inputPreview: input.text, inputTruncated: input.truncated,
          resultPreview: null, resultTruncated: false, errorPreview: null, shell: null,
          ...(capturedFile === undefined ? {} : { fileInput: capturedFile }) });
        return;
      }
      if (!tool || tool.toolName !== event.data.toolName) fail("CONFLICT", "Tool call identity mismatch");
      if (event.type === "tool.call.superseded") {
        if (tool.status !== "requested" && tool.status !== "started") fail("CONFLICT", "Dispatched tool cannot be superseded");
        tool.status = "not_started";
        tool.startedAt = null;
        tool.finishedAt = event.occurredAt;
        tool.errorPreview = "Superseded by a steering instruction before dispatch";
        return;
      }
      if (event.type === "tool.call.started") {
        if (tool.status !== "requested") fail("CONFLICT", "Tool call did not await start");
        tool.status = "started";
        tool.startedAt = event.occurredAt;
        return;
      }
      if (tool.status !== "requested" && tool.status !== "started") fail("CONFLICT", "Tool call is terminal");
      tool.status = event.type === "tool.call.completed" ? "completed"
        : event.data.error.code === "TOOL_OUTCOME_UNKNOWN" ? "unknown" : "failed";
      tool.finishedAt = event.occurredAt;
      if (event.type === "tool.call.completed") {
        const result = stringifyPreview(event.data.output);
        tool.resultPreview = result.text;
        tool.resultTruncated = result.truncated;
        if (tool.toolName === "shell_exec") tool.shell = shellReceipt(event.data.output);
        const written = fileResult(tool, event.data.output);
        if (written !== undefined) tool.fileWrite = written;
        const read = fileReadResult(tool, event.data.output);
        if (read !== undefined) tool.fileRead = read;
      } else {
        tool.errorPreview = preview(event.data.error.message).text;
      }
    }, runId);
  }

  async recordSteerEvent(event: Extract<AgentEvent, { type: "run.steer.accepted" | "run.steer.applied" | "run.steer.not_applied" }>): Promise<void> {
    await this.#mutate(document => {
      const run = document.runs.find(item => item.runId === event.runId);
      if (!run || run.phase !== "primary" || run.status !== "running") fail("CONFLICT", "Steering belongs to an active primary Run");
      const steers = run.steers ??= [];
      const previous = steers.find(item => item.id === event.data.id);
      if (event.type === "run.steer.accepted") {
        if (previous) {
          if (previous.text !== event.data.text) fail("CONFLICT", "Steering ID already has different content");
          return;
        }
        if (steers.length >= 8) fail("LIMIT_EXCEEDED", "Too many steering messages");
        steers.push({ id: event.data.id, runId: event.runId, text: event.data.text,
          status: "accepted", receivedAt: event.occurredAt });
      } else {
        if (!previous || previous.status !== "accepted") fail("CONFLICT", "Steering receipt cannot transition");
        if (event.type === "run.steer.applied") {
          previous.status = "applied"; previous.appliedAt = event.occurredAt; previous.messageId = event.data.messageId;
        } else { previous.status = "not_applied"; previous.reason = event.data.reason.slice(0, 256); }
      }
    }, event.runId);
  }

  async finishRun(runId: string, result: RunResult, memory?: { references: { id: string; revision: number }[]; truncated: boolean }): Promise<void> {
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
      if (run.trace) {
        if (validTraceUsage(result.usage)) run.trace.usage = structuredClone(result.usage);
        if (Number.isSafeInteger(result.steps) && result.steps >= 0) run.trace.steps = result.steps;
      }
      for (const steer of run.steers ?? []) {
        if (steer.status === "accepted") { steer.status = "not_applied"; steer.reason = result.status; }
      }
      if (result.completion !== undefined) run.completion = structuredClone(result.completion);
      if (memory !== undefined && run.phase === "primary") {
        run.memoryReferences = structuredClone(memory.references);
        run.memoryReferencesTruncated = memory.truncated;
      }
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
      for (const call of document.modelUsage?.calls ?? []) {
        if (call.threadId === threadId && call.status === "pending") {
          call.status = "unknown"; call.finishedAt = at;
        }
      }
      for (const run of document.runs) {
        if (run.threadId !== threadId || run.status !== "running") continue;
        recovered += 1;
        run.status = "interrupted";
        run.finishedAt = at;
        for (const steer of run.steers ?? []) {
          if (steer.status === "accepted") { steer.status = "not_applied"; steer.reason = "interrupted"; }
        }
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

  /** Same journal/lock/durability boundary as execution receipts; metadata only, never replay. */
  async startModelCall(call: ModelCallRecord): Promise<void> {
    if (!validModelCall(call) || call.status !== "pending") fail("INVALID_INPUT", "Invalid model call");
    await this.#mutate(document => {
      const page = document.modelUsage ??= { calls: [], droppedCount: 0 };
      if (page.calls.some(item => item.id === call.id)) fail("CONFLICT", "Duplicate model call");
      page.calls.unshift(structuredClone(call));
    });
  }

  async finishModelCall(id: string, status: ModelCallRecord["status"], usage: ModelCallRecord["usage"]): Promise<void> {
    if (!["not_dispatched", "returned", "failed", "cancelled", "unknown"].includes(status) || !validTraceUsage(usage)) fail("INVALID_INPUT", "Invalid model call resolution");
    await this.#mutate(document => {
      const call = document.modelUsage?.calls.find(item => item.id === id);
      if (!call) fail("NOT_FOUND", "Model call not found");
      // Cancellation/recovery wins over late results. Exact repeats never add a call.
      if (call.status !== "pending") return;
      call.status = status; call.usage = structuredClone(usage); call.finishedAt = this.#now().toISOString();
    });
  }

  async listModelUsage(threadId: string): Promise<ModelUsagePage> {
    if (!threadId) fail("INVALID_INPUT", "Thread ID is required");
    const page = (await this.#load()).modelUsage;
    return { calls: page?.calls.filter(call => call.threadId === threadId) ?? [], droppedCount: page?.droppedCount ?? 0 };
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
    if (this.#commitUncertain) fail("COMMIT_UNCERTAIN", "Execution receipt acknowledgement is uncertain; restart and reconcile before further writes");
    if (this.#writeFailed) fail("WRITE_FAILED", "Execution receipt storage failed; restart and reconcile before further dispatch");
    await this.#inspectDirectory();
    if (await this.#inspectFile(this.#lock)) {
      // Existing regular lock file is safe to hand to flock.
    }
    const lock = await acquireFlock(this.#lock);
    try {
      if (this.#commitUncertain) fail("COMMIT_UNCERTAIN", "Execution receipt acknowledgement is uncertain; restart before further writes");
      if (this.#writeFailed) fail("WRITE_FAILED", "Execution receipt storage failed; restart and reconcile before further dispatch");
      const document = await this.#load();
      update(document);
      const pruneCall = (): boolean => {
        const page = document.modelUsage;
        if (!page) return false;
        let index = page.calls.length - 1;
        while (index >= 0 && page.calls[index]!.status === "pending") index -= 1;
        if (index < 0) return false;
        page.calls.splice(index, 1); page.droppedCount += 1;
        return true;
      };
      while ((document.modelUsage?.calls.length ?? 0) > MODEL_CALL_LIMIT) {
        if (!pruneCall()) fail("LIMIT_EXCEEDED", "Active model calls exceed retention limit");
      }
      for (const run of document.runs) {
        if (run.trace && this.#traceGaps.has(run.runId)) run.trace.incomplete = true;
      }
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
      // Usage metadata yields before authoritative tool receipts, never evict active calls.
      while (Buffer.byteLength(serialized, "utf8") > EXECUTION_RECORD_MAX_BYTES && pruneCall()) {
        serialized = `${JSON.stringify(document)}\n`;
      }
      // Display metadata yields before authoritative tool receipts or dispatch barriers.
      for (const run of [...document.runs].reverse()) {
        if (Buffer.byteLength(serialized, "utf8") <= EXECUTION_RECORD_MAX_BYTES) break;
        if (!run.trace?.events.length) continue;
        run.trace.events = []; run.trace.truncated = true;
        serialized = `${JSON.stringify(document)}\n`;
      }
      while (Buffer.byteLength(serialized, "utf8") > EXECUTION_RECORD_MAX_BYTES) {
        const index = oldestPrunable();
        if (index < 0) fail("LIMIT_EXCEEDED", "Execution record file exceeds size limit");
        document.runs.splice(index, 1);
        serialized = `${JSON.stringify(document)}\n`;
      }
      const temporary = join(this.#directory, `.execution-records.${randomUUID()}.tmp`);
      let created = false;
      let renamed = false;
      try {
        const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        created = true;
        try { await handle.writeFile(serialized, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.#file);
        renamed = true;
        created = false;
        if (process.platform !== "win32") {
          const directory = await open(this.#directory, "r");
          try { await directory.sync(); } finally { await directory.close(); }
        }
        for (const run of document.runs) this.#traceGaps.delete(run.runId);
      } catch (error) {
        this.#writeFailed = true;
        if (renamed) {
          this.#commitUncertain = true;
          fail("COMMIT_UNCERTAIN", "Execution receipt was replaced but acknowledgement is uncertain; reread after restart, never replay tools");
        }
        fail("WRITE_FAILED", `Execution receipt save failed before replacement: ${String(error)}`);
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
