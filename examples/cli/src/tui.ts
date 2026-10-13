import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { userMessageClock } from "./memory-observation-policy.js";
import type { Readable, Writable } from "node:stream";
import type { UIMessage } from "ai";
import type {
  AgentEvent,
  BeforeToolExecute,
  BeforeToolExecuteInput,
  MessageStore,
  RunHandle,
  RunRequest,
  RunResult,
  ToolExecutionDecision,
} from "@aisdk-agent/core";
import { resolve, sep } from "node:path";
import {
  AUTO_CONSOLIDATION_AGENT_ID,
  AUTO_CONSOLIDATION_SOURCE,
  isAutoConsolidationRequest,
} from "./consolidation.js";
import { validateWorkspacePath } from "./workspace-path.js";
import { prepareConsolidationExtraction, stageConsolidationExtraction, type MemoryConsolidation } from "./memory-consolidation.js";
import type { MemoryResult } from "./memory-candidates.js";
import { automaticConsolidationMessage, automaticConsolidationSkip, waitForConsolidationHandoff } from "./consolidation-lifecycle.js";

type Runtime = {
  run<TContext>(request: RunRequest<TContext>): Promise<RunHandle>;
};

type TuiState =
  | { kind: "idle" }
  | { kind: "running"; handle: RunHandle; background?: true }
  | { kind: "consolidating"; controller: AbortController }
  | { kind: "compacting"; controller: AbortController }
  | { kind: "resuming"; controller: AbortController };

/** An idle command handled directly by the terminal adapter. */
export interface TuiCommand {
  execute(args: string): void | Promise<void>;
}

function isTTY(stream: Readable | Writable): boolean {
  return (stream as Readable & { isTTY?: boolean }).isTTY === true;
}

export interface RunTuiOptions {
  runtime: Runtime;
  store: Pick<MessageStore, "getMessages">;
  threadId: string;
  agentId: string;
  autoConsolidationAgentId?: string;
  hostConsolidationExtraction?: true;
  memoryConsolidation?: MemoryConsolidation;
  /** This Thread's eligible committed backlog only; no model or cursor mutation. */
  getMemoryConsolidationBacklog?: () => Promise<MemoryResult<number>>;
  input?: Readable;
  output?: Writable;
  generateId?: () => string;
  toolConfirmation?: ToolConfirmation;
  compaction?: TuiCompaction;
  resume?: TuiResume;
  renderHome?: () => Promise<void>;
  commands?: ReadonlyMap<string, TuiCommand>;
  registerNotificationRedraw?: (redraw: () => void) => void;
}

/**
 * The TUI owns the lifecycle of a manual compaction, while the compactor owns
 * context selection, summary generation, and persistence. Keeping this
 * boundary callback-based means /compact never creates a user Run or a second
 * AgentLoop.
 */
export interface TuiCompaction {
  compact(
    signal: AbortSignal,
  ): Promise<{ message?: string } | void>;
}

/** /resume inspects without a Run; only the next primary Run can use its observation. */
export interface TuiResume {
  inspect(signal: AbortSignal): Promise<string>;
  clear(): void;
  beginRun(): void;
  endRun(): void;
}

export interface ToolConfirmation {
  beforeToolExecute: BeforeToolExecute;
  handleLine(line: string): boolean;
  getPending(): PendingToolApproval | undefined;
  resolveApproval(input: { approvalId: string; decision: "allow" | "deny" }): boolean;
  subscribePending(listener: (pending: PendingToolApproval | undefined) => void): () => void;
  setPendingAuthorization(rule: RunAuthorizationInput): void;
  setPendingShellAuthorization(): void;
  setPendingWebAuthorization(origins: readonly string[]): void;
  beginRun(): void;
  endRun(): void;
}

/** One tool call awaiting a user decision. The preview may still be loading. */
export interface PendingToolApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  preview: string;
}

/** Shell approval can be scoped to a single Run only when the executor is an
 * actual sandbox. Host execution must continue to ask for every call. */
export type ShellSandboxMode = "none" | "host" | "docker";

export const RUN_AUTHORIZED_FILE_TOOLS = [
  "list_directory",
  "search_files",
  "read_file",
  "write_file",
  "edit_file",
] as const;

export type RunAuthorizedFileTool = (typeof RUN_AUTHORIZED_FILE_TOOLS)[number];

/** A non-persistent file-tool rule that applies to one subsequent Run. */
export interface RunAuthorization {
  workspaceRoot: string;
  allowedPaths: readonly string[];
  tools: readonly RunAuthorizedFileTool[];
  lifetime: "run";
}

export type RunAuthorizationInput = Omit<RunAuthorization, "workspaceRoot"> & {
  workspaceRoot?: string;
};

/** A non-persistent web origin allow-list that applies to one subsequent Run. */
export interface WebAuthorization {
  allowedOrigins: readonly string[];
  lifetime: "run";
}

export type ToolConfirmationPrompt = (
  input: BeforeToolExecuteInput,
) => string | Promise<string | undefined> | undefined;

const AUTO_APPROVED_TOOL_NAMES = new Set([
  "pomodoro_start",
  "pomodoro_status",
  "pomodoro_cancel",
]);

const AUTO_CONSOLIDATION_READ_TOOLS = new Set(["memory_prepare_consolidation", "memory_stage_candidates"]);

function write(output: Writable, text: string): void {
  output.write(text);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function readFilePath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("path" in input)) {
    return undefined;
  }
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? path : undefined;
}

function toolPath(input: unknown): string {
  if (typeof input !== "object" || input === null || !("path" in input)) {
    return ".";
  }
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : ".";
}

function normalizeAuthorization(
  rule: RunAuthorizationInput,
  defaultWorkspaceRoot: string | undefined,
): RunAuthorization {
  if (rule.lifetime !== "run") {
    throw new Error('Only lifetime "run" is supported');
  }
  const workspaceRootValue = rule.workspaceRoot ?? defaultWorkspaceRoot;
  if (workspaceRootValue === undefined) {
    throw new Error("A workspace root is required for run authorization");
  }
  const workspaceRoot = resolve(workspaceRootValue);
  const tools = [...new Set(rule.tools)];
  if (tools.length === 0) throw new Error("At least one file tool is required");
  for (const toolName of tools) {
    if (!(RUN_AUTHORIZED_FILE_TOOLS as readonly string[]).includes(toolName)) {
      throw new Error(`Tool is not eligible for run authorization: ${toolName}`);
    }
  }
  const allowedPaths = rule.allowedPaths.map((path) => {
    const validated = validateWorkspacePath(workspaceRoot, path);
    if (!validated.ok) {
      throw new Error(`Invalid authorization path ${JSON.stringify(path)}: ${validated.message}`);
    }
    return validated.relativePath;
  });
  if (allowedPaths.length === 0) throw new Error("At least one workspace path is required");
  return {
    workspaceRoot,
    allowedPaths: [...new Set(allowedPaths)],
    tools: tools as RunAuthorizedFileTool[],
    lifetime: "run",
  };
}

function pathWithin(candidate: string, allowed: string): boolean {
  return candidate === allowed || allowed === "" || candidate.startsWith(`${allowed}${sep}`);
}

function authorizationAllows(
  authorization: RunAuthorization | undefined,
  input: BeforeToolExecuteInput,
): boolean {
  if (authorization === undefined) return false;
  if (!(authorization.tools as readonly string[]).includes(input.toolName)) return false;
  const requested = validateWorkspacePath(
    authorization.workspaceRoot,
    toolPath(input.input),
  );
  if (!requested.ok) return false;
  return authorization.allowedPaths.some((allowed) =>
    pathWithin(requested.relativePath, allowed),
  );
}

function normalizeWebOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid web origin ${JSON.stringify(origin)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Web origin must use http or https: ${JSON.stringify(origin)}`);
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `Web authorization requires an exact origin without credentials or path: ${JSON.stringify(origin)}`,
    );
  }
  return parsed.origin;
}

function webInputOrigin(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("url" in input)) {
    return undefined;
  }
  const value = (input as { url?: unknown }).url;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function webAuthorizationAllows(
  authorization: WebAuthorization | undefined,
  input: BeforeToolExecuteInput,
): boolean {
  if (authorization === undefined || input.toolName !== "web_fetch") return false;
  const origin = webInputOrigin(input.input);
  return origin !== undefined && authorization.allowedOrigins.includes(origin);
}

function confirmationPrompt(
  toolName: string,
  input: unknown,
  shellSandboxMode: ShellSandboxMode = "none",
): string {
  if (toolName === "shell_exec" && typeof input === "object" && input !== null) {
    const shellInput = input as { command?: unknown; cwd?: unknown };
    if (shellSandboxMode === "docker") {
      return (
        `\nTool: ${toolName}\n` +
        `Command: ${JSON.stringify(shellInput.command)}\n` +
        `Cwd: ${JSON.stringify(shellInput.cwd ?? ".")} (relative to sandbox mounts)\n` +
        "The command runs in the configured Docker sandbox with declared mounts, a read-only root filesystem, and no network. Unmounted host files are not visible. Output may be truncated.\n" +
        "Allow this call? [y/n] "
      );
    }
    return (
      `\nTool: ${toolName}\n` +
      `Command: ${JSON.stringify(shellInput.command)}\n` +
      `Cwd: ${JSON.stringify(shellInput.cwd ?? ".")} (relative to workspace)\n` +
      "Output may be truncated; the workspace cwd is not an operating-system sandbox.\n" +
      "Allow this call? [y/n] "
    );
  }
  const path = toolName === "read_file" ? readFilePath(input) : undefined;
  if (path !== undefined) {
    return (
      `\nTool: ${toolName}\n` +
      `Path: ${JSON.stringify(path)}\n` +
      "Reading this file will place its contents in the model context and the " +
      "completed run's committed transcript.\n" +
      "Allow this call? [y/n] "
    );
  }
  if (toolName === "write_file" && typeof input === "object" && input !== null) {
    const writeInput = input as { path?: unknown; content?: unknown };
    return (
      `\nTool: ${toolName}\n` +
      `Path: ${JSON.stringify(writeInput.path)}\n` +
      `Content: ${JSON.stringify(writeInput.content)}\n` +
      "Allow this call? [y/n] "
    );
  }
  if (toolName === "edit_file" && typeof input === "object" && input !== null) {
    const editInput = input as {
      path?: unknown;
      oldText?: unknown;
      newText?: unknown;
    };
    return (
      `\nTool: ${toolName}\n` +
      `Path: ${JSON.stringify(editInput.path)}\n` +
      `Old text: ${JSON.stringify(editInput.oldText)}\n` +
      `New text: ${JSON.stringify(editInput.newText)}\n` +
      "Allow this call? [y/n] "
    );
  }
  return `\nTool: ${toolName}\nInput: ${JSON.stringify(input)}\nAllow this call? [y/n] `;
}

interface PendingConfirmation {
  approval: PendingToolApproval;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (decision: ToolExecutionDecision) => void;
  reject: (reason: unknown) => void;
  steerSignal?: AbortSignal;
  onSteer?: () => void;
}

const SEARCH_DENIED_FETCH_REASON = "web_search was denied in this Run";

export function createToolConfirmation(
  output: Writable,
  options: {
    prompt?: ToolConfirmationPrompt;
    onPendingChange?: (pending: PendingToolApproval | undefined) => void;
    generateId?: () => string;
    workspaceRoot?: string;
    persistentAuthorizations?: readonly RunAuthorizationInput[];
    shellSandboxMode?: ShellSandboxMode;
  } = {},
): ToolConfirmation {
  let pending: PendingConfirmation | undefined;
  let searchDeniedThisRun = false;
  let nextRunAuthorization: RunAuthorization | undefined;
  let activeRunAuthorization: RunAuthorization | undefined;
  let nextShellAuthorization = false;
  let activeShellAuthorization = false;
  let nextWebAuthorization: WebAuthorization | undefined;
  let activeWebAuthorization: WebAuthorization | undefined;
  const pendingListeners = new Set<(pending: PendingToolApproval | undefined) => void>();
  const persistentAuthorizations = (options.persistentAuthorizations ?? []).map(
    (rule) => normalizeAuthorization(rule, options.workspaceRoot),
  );

  const getPending = (): PendingToolApproval | undefined =>
    pending === undefined ? undefined : { ...pending.approval };

  const notifyPending = (): void => {
    const current = getPending();
    try {
      options.onPendingChange?.(current);
    } catch {
      // A UI listener cannot decide whether the tool is allowed to run.
    }
    for (const listener of pendingListeners) {
      try {
        listener(current);
      } catch {
        // Keep notifying other observers and leave the approval pending.
      }
    }
  };

  const subscribePending = (
    listener: (pending: PendingToolApproval | undefined) => void,
  ): (() => void) => {
    pendingListeners.add(listener);
    return () => { pendingListeners.delete(listener); };
  };

  const clearPending = (entry: PendingConfirmation): void => {
    if (pending !== entry) return;
    pending = undefined;
    entry.signal.removeEventListener("abort", entry.onAbort);
    if (entry.onSteer) entry.steerSignal?.removeEventListener("abort", entry.onSteer);
    notifyPending();
  };

  const beforeToolExecute: BeforeToolExecute = (input) => {
    if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
    if (input.steerSignal?.aborted) return Promise.reject(abortReason(input.steerSignal));
    if (
      input.definition.id === AUTO_CONSOLIDATION_AGENT_ID &&
      AUTO_CONSOLIDATION_READ_TOOLS.has(input.toolName)
    ) {
      return Promise.resolve({ allow: true });
    }
    if (AUTO_APPROVED_TOOL_NAMES.has(input.toolName)) {
      return Promise.resolve({ allow: true });
    }
    if (
      searchDeniedThisRun &&
      (input.toolName === "web_fetch" || input.toolName === "feed_read")
    ) {
      return Promise.resolve({
        allow: false,
        reason: SEARCH_DENIED_FETCH_REASON,
      });
    }
    if (activeShellAuthorization && input.toolName === "shell_exec") {
      return Promise.resolve({ allow: true });
    }
    if (webAuthorizationAllows(activeWebAuthorization, input)) {
      return Promise.resolve({ allow: true });
    }
    if (
      authorizationAllows(activeRunAuthorization, input) ||
      persistentAuthorizations.some((rule) => authorizationAllows(rule, input))
    ) {
      return Promise.resolve({ allow: true });
    }
    if (pending !== undefined) {
      throw new Error("Tool confirmation is already pending");
    }

    let resolve!: (decision: ToolExecutionDecision) => void;
    let reject!: (reason: unknown) => void;
    const decision = new Promise<ToolExecutionDecision>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    let entry!: PendingConfirmation;
    const onAbort = (): void => {
      clearPending(entry);
      reject(abortReason(input.signal));
    };
    entry = {
      approval: {
        approvalId: options.generateId?.() ?? randomUUID(),
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: input.input,
        preview: "",
      },
      signal: input.signal,
      onAbort,
      resolve,
      reject,
      ...(input.steerSignal ? { steerSignal: input.steerSignal, onSteer: () => {
        clearPending(entry);
        reject(abortReason(input.steerSignal!));
      } } : {}),
    };
    pending = entry;
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (entry.onSteer) entry.steerSignal?.addEventListener("abort", entry.onSteer, { once: true });
    if (input.steerSignal?.aborted) { entry.onSteer?.(); return decision; }
    if (input.signal.aborted) {
      onAbort();
      return decision;
    }
    // Observers learn about the approval as soon as it exists, with an empty
    // preview. Tools whose preview is computed asynchronously (task_reschedule
    // reads the task store first) must not leave a snapshot without the
    // pending approval in the meantime; a second notification follows once
    // the preview text is written.
    notifyPending();

    const writePrompt = (text: string): void => {
      if (pending !== entry) return;
      try {
        entry.approval.preview = text;
        notifyPending();
        if (pending !== entry) return;
        write(output, `\n[confirmation] Waiting for y/n; the tool has not run yet.\n${text}`);
      } catch (error) {
        clearPending(entry);
        reject(error);
      }
    };
    let customPrompt: string | Promise<string | undefined> | undefined;
    try {
      customPrompt = options.prompt?.(input);
    } catch (error) {
      clearPending(entry);
      reject(error);
      return decision;
    }
    if (customPrompt instanceof Promise) {
      void customPrompt.then(
        (text) =>
          writePrompt(text ?? confirmationPrompt(input.toolName, input.input, options.shellSandboxMode)),
        (error: unknown) => {
          clearPending(entry);
          reject(error);
        },
      );
    } else {
      writePrompt(customPrompt ?? confirmationPrompt(input.toolName, input.input, options.shellSandboxMode));
    }
    return decision;
  };

  const resolveApproval = (input: {
    approvalId: string;
    decision: "allow" | "deny";
  }): boolean => {
    const entry = pending;
    if (entry === undefined || entry.approval.approvalId !== input.approvalId) return false;
    // The empty approval is published before asynchronous preview preparation.
    // All callers (desktop, IM and TUI), not just the renderer, must wait for it.
    if (input.decision === "allow" && entry.approval.preview.trim().length === 0) return false;
    clearPending(entry);
    if (input.decision === "allow") {
      entry.resolve({ allow: true });
    } else {
      if (entry.approval.toolName === "web_search") searchDeniedThisRun = true;
      entry.resolve({ allow: false, reason: "User denied this tool call" });
    }
    return true;
  };

  const handleLine = (line: string): boolean => {
    const entry = pending;
    if (entry === undefined) return false;
    const answer = line.trim().toLowerCase();
    if (answer !== "y" && answer !== "n") {
      write(output, "\nPlease enter y or n.\nAllow this call? [y/n] ");
      return true;
    }

    return resolveApproval({
      approvalId: entry.approval.approvalId,
      decision: answer === "y" ? "allow" : "deny",
    });
  };

  const setPendingAuthorization = (rule: RunAuthorizationInput): void => {
    nextRunAuthorization = normalizeAuthorization(rule, options.workspaceRoot);
  };

  const setPendingShellAuthorization = (): void => {
    if (options.shellSandboxMode !== "docker") {
      throw new Error(
        "Shell authorization requires Docker sandbox mode; host shell remains per-call confirmation",
      );
    }
    nextShellAuthorization = true;
  };

  const setPendingWebAuthorization = (origins: readonly string[]): void => {
    if (origins.length === 0) {
      throw new Error("At least one web origin is required");
    }
    const normalized = [...new Set(origins.map(normalizeWebOrigin))];
    nextWebAuthorization = { allowedOrigins: normalized, lifetime: "run" };
  };

  const beginRun = (): void => {
    searchDeniedThisRun = false;
    activeRunAuthorization = nextRunAuthorization;
    nextRunAuthorization = undefined;
    activeShellAuthorization =
      options.shellSandboxMode === "docker" && nextShellAuthorization;
    nextShellAuthorization = false;
    activeWebAuthorization = nextWebAuthorization;
    nextWebAuthorization = undefined;
  };

  const endRun = (): void => {
    searchDeniedThisRun = false;
    activeRunAuthorization = undefined;
    activeShellAuthorization = false;
    activeWebAuthorization = undefined;
    nextRunAuthorization = undefined;
    nextShellAuthorization = false;
    nextWebAuthorization = undefined;
    if (pending !== undefined) {
      const entry = pending;
      clearPending(entry);
      entry.reject(new Error("Run authorization ended"));
    }
  };

  return {
    beforeToolExecute,
    handleLine,
    getPending,
    resolveApproval,
    subscribePending,
    setPendingAuthorization,
    setPendingShellAuthorization,
    setPendingWebAuthorization,
    beginRun,
    endRun,
  };
}

function toolPartText(part: Extract<UIMessage["parts"][number], { type: "dynamic-tool" }>): string {
  if (part.state === "output-error") {
    return `[tool ${part.toolName} failed: ${part.errorText}]`;
  }
  if (part.state === "output-available") {
    const output =
      typeof part.output === "string" ? part.output : JSON.stringify(part.output);
    return `[tool ${part.toolName}] ${output}`;
  }
  return `[tool ${part.toolName}]`;
}

function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "dynamic-tool") return toolPartText(part);
      return "";
    })
    .filter((part) => part.length > 0)
    .join(" ");
}

type CompletedFileAction = {
  toolName: "write_file" | "edit_file";
  path: string;
  bytes: number;
};

type CompletedPomodoroAction = {
  toolName: "pomodoro_start" | "pomodoro_status" | "pomodoro_cancel";
  summary: string;
};

type CompletedTaskCreateAction = {
  toolName: "task_create";
  id: string;
  runAt: string;
  prompt: string;
};

type CompletedTaskRescheduleAction = {
  toolName: "task_reschedule";
  id: string;
  runAt: string;
};

type CompletedTaskAction = CompletedTaskCreateAction | CompletedTaskRescheduleAction;

type CompletedMemoryAction = {
  toolName: "memory_add" | "memory_update" | "memory_apply_candidate";
  id: string;
  revision: number;
};

type CompletedCheckpointAction = {
  toolName: "checkpoint_save";
  id: string;
  version: number;
  status: "active" | "paused" | "completed";
};

type CompletedAction =
  | CompletedFileAction
  | CompletedPomodoroAction
  | CompletedTaskAction
  | CompletedMemoryAction
  | CompletedCheckpointAction;

type UnknownToolAction = {
  toolName: string;
  toolCallId: string;
  summary: string;
  message: string;
};

function unknownToolInputSummary(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const value = input as { path?: unknown; cwd?: unknown };
  if (typeof value.path === "string") return `path=${value.path}`;
  if (toolName === "shell_exec") {
    return typeof value.cwd === "string" ? `cwd=${value.cwd}; command=redacted` : "command=redacted";
  }
  return "input=redacted";
}

function completedFileAction(event: Extract<AgentEvent, { type: "tool.call.completed" }>): CompletedFileAction | undefined {
  if (event.data.toolName !== "write_file" && event.data.toolName !== "edit_file") {
    return undefined;
  }
  const output = event.data.output;
  if (typeof output !== "object" || output === null) return undefined;
  const result = output as { ok?: unknown; path?: unknown; bytes?: unknown };
  if (
    result.ok !== true ||
    typeof result.path !== "string" ||
    !Number.isInteger(result.bytes) ||
    (result.bytes as number) < 0
  ) {
    return undefined;
  }
  return {
    toolName: event.data.toolName,
    path: result.path,
    bytes: result.bytes as number,
  };
}

function completedPomodoroAction(
  event: Extract<AgentEvent, { type: "tool.call.completed" }>,
): CompletedPomodoroAction | undefined {
  if (
    event.data.toolName !== "pomodoro_start" &&
    event.data.toolName !== "pomodoro_status" &&
    event.data.toolName !== "pomodoro_cancel"
  ) {
    return undefined;
  }
  const output = event.data.output;
  if (typeof output !== "object" || output === null) return undefined;
  const result = output as {
    outcome?: unknown;
    status?: { state?: unknown; durationMinutes?: unknown; endsAt?: unknown; remainingSeconds?: unknown };
  };
  const outcome = result.outcome;
  const status = result.status;
  const state = status?.state;
  if (typeof outcome !== "string" || typeof state !== "string" || status === undefined) {
    return undefined;
  }
  if (outcome === "started" && state === "running") {
    if (
      !Number.isInteger(status.durationMinutes) ||
      typeof status.endsAt !== "string"
    ) return undefined;
    return {
      toolName: event.data.toolName,
      summary: `已启动 ${status.durationMinutes} 分钟番茄钟，预计 ${status.endsAt} 结束。`,
    };
  }
  if (outcome === "cancelled" && state === "idle") {
    return { toolName: event.data.toolName, summary: "已取消番茄钟。" };
  }
  if (outcome === "status") {
    if (state === "idle") {
      return { toolName: event.data.toolName, summary: "当前没有运行中的番茄钟。" };
    }
    if (!Number.isInteger(status.remainingSeconds)) return undefined;
    return {
      toolName: event.data.toolName,
      summary: `番茄钟仍在运行，剩余 ${status.remainingSeconds} 秒。`,
    };
  }
  if (outcome === "already_running" && state === "running") {
    if (!Number.isInteger(status.remainingSeconds)) return undefined;
    return {
      toolName: event.data.toolName,
      summary: `已有番茄钟运行中，剩余 ${status.remainingSeconds} 秒，未重置。`,
    };
  }
  if (outcome === "not_running" && state === "idle") {
    return { toolName: event.data.toolName, summary: "当前没有运行中的番茄钟。" };
  }
  return undefined;
}

function completedTaskAction(
  event: Extract<AgentEvent, { type: "tool.call.completed" }>,
): CompletedTaskAction | undefined {
  if (event.data.toolName !== "task_create" && event.data.toolName !== "task_reschedule") return undefined;
  const output = event.data.output;
  if (typeof output !== "object" || output === null) return undefined;
  const result = output as {
    ok?: unknown;
    value?: { id?: unknown; runAt?: unknown; prompt?: unknown };
  };
  if (
    result.ok !== true ||
    typeof result.value !== "object" ||
    result.value === null ||
    typeof result.value.id !== "string" ||
    typeof result.value.runAt !== "string"
  ) {
    return undefined;
  }
  if (event.data.toolName === "task_reschedule") {
    return {
      toolName: "task_reschedule",
      id: result.value.id,
      runAt: result.value.runAt,
    };
  }
  if (typeof result.value.prompt !== "string") return undefined;
  return {
    toolName: "task_create",
    id: result.value.id,
    runAt: result.value.runAt,
    prompt: result.value.prompt,
  };
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function completedMemoryAction(
  event: Extract<AgentEvent, { type: "tool.call.completed" }>,
): CompletedMemoryAction | undefined {
  if (event.data.toolName === "memory_apply_candidate") {
    const result = event.data.output as { ok?: boolean; value?: { memoryId?: unknown; memoryRevision?: unknown } } | null;
    if (result?.ok === true && typeof result.value?.memoryId === "string" && positiveSafeInteger(result.value.memoryRevision)) {
      return { toolName: "memory_apply_candidate", id: result.value.memoryId, revision: result.value.memoryRevision };
    }
    return undefined;
  }
  if (event.data.toolName !== "memory_add" && event.data.toolName !== "memory_update") {
    return undefined;
  }
  const output = event.data.output;
  if (typeof output !== "object" || output === null) return undefined;
  const result = output as {
    ok?: unknown;
    entry?: { id?: unknown; revision?: unknown } | null;
  };
  const entry = result.entry;
  if (
    result.ok !== true ||
    typeof entry !== "object" ||
    entry === null ||
    typeof entry.id !== "string" ||
    entry.id.length === 0 ||
    !positiveSafeInteger(entry.revision)
  ) {
    return undefined;
  }
  return {
    toolName: event.data.toolName,
    id: entry.id,
    revision: entry.revision,
  };
}

function completedCheckpointAction(
  event: Extract<AgentEvent, { type: "tool.call.completed" }>,
): CompletedCheckpointAction | undefined {
  if (event.data.toolName !== "checkpoint_save") return undefined;
  const output = event.data.output;
  if (typeof output !== "object" || output === null) return undefined;
  const result = output as {
    ok?: unknown;
    checkpoint?: { id?: unknown; version?: unknown; status?: unknown } | null;
  };
  const checkpoint = result.checkpoint;
  if (
    result.ok !== true ||
    typeof checkpoint !== "object" || checkpoint === null ||
    typeof checkpoint.id !== "string" || checkpoint.id.length === 0 ||
    !positiveSafeInteger(checkpoint.version) ||
    (checkpoint.status !== "active" && checkpoint.status !== "paused" && checkpoint.status !== "completed")
  ) {
    return undefined;
  }
  return {
    toolName: "checkpoint_save",
    id: checkpoint.id,
    version: checkpoint.version,
    status: checkpoint.status,
  };
}

function renderHistory(output: Writable, messages: UIMessage[]): void {
  if (messages.length === 0) return;

  write(output, "\nHistory (committed transcript)\n");
  for (const message of messages) {
    const text = messageText(message);
    const role = isAutoConsolidationRequest(message)
      ? "auto-consolidation"
      : message.role;
    write(output, `${role}: ${text || "[non-text message]"}\n`);
  }
  write(output, "\n");
}

async function renderEvents(
  output: Writable,
  events: RunHandle["events"],
): Promise<{
  renderedText: string;
  requestedMemoryTool: boolean;
  consolidationAttempts: { prepare: number; stage: number };
  completedActions: CompletedAction[];
  unknownActions: UnknownToolAction[];
}> {
  let renderedText = "";
  let requestedMemoryTool = false;
  const consolidationAttempts = { prepare: 0, stage: 0 };
  const completedActions: CompletedAction[] = [];
  const unknownActions: UnknownToolAction[] = [];
  const requestedTools = new Map<string, { toolName: string; input: unknown }>();
  for await (const event of events) {
    switch (event.type) {
      case "model.retry.scheduled":
        write(
          output,
          `\n[model retry ${event.data.nextAttempt}/${event.data.maxAttempts} in ${event.data.delayMs}ms: ${event.data.error.code}]\n`,
        );
        break;
      case "message.delta":
        renderedText += event.data.text;
        write(output, event.data.text);
        break;
      case "step.started":
        write(output, `\n[step ${event.data.stepNumber}] `);
        break;
      case "tool.call.requested":
        if (event.data.toolName === "memory_prepare_consolidation") consolidationAttempts.prepare++;
        if (event.data.toolName === "memory_stage_candidates") consolidationAttempts.stage++;
        requestedMemoryTool ||= event.data.toolName.startsWith("memory_");
        requestedTools.set(event.data.toolCallId, {
          toolName: event.data.toolName,
          input: event.data.input,
        });
        write(output, `\n[tool ${event.data.toolName}]\n`);
        break;
      case "tool.call.failed":
        write(output, `\n[tool failed: ${event.data.error.message}]\n`);
        if (event.data.error.code === "TOOL_OUTCOME_UNKNOWN") {
          const requested = requestedTools.get(event.data.toolCallId);
          unknownActions.push({
            toolName: event.data.toolName,
            toolCallId: event.data.toolCallId,
            summary: unknownToolInputSummary(
              event.data.toolName,
              requested?.input,
            ),
            message: event.data.error.message,
          });
        }
        break;
      case "tool.call.completed": {
        const action = completedFileAction(event);
        if (action !== undefined) completedActions.push(action);
        const pomodoroAction = completedPomodoroAction(event);
        if (pomodoroAction !== undefined) completedActions.push(pomodoroAction);
        const taskAction = completedTaskAction(event);
        if (taskAction !== undefined) completedActions.push(taskAction);
        const memoryAction = completedMemoryAction(event);
        if (memoryAction !== undefined) completedActions.push(memoryAction);
        const checkpointAction = completedCheckpointAction(event);
        if (checkpointAction !== undefined) completedActions.push(checkpointAction);
        break;
      }
      default:
        break;
    }
  }
  return { renderedText, requestedMemoryTool, consolidationAttempts, completedActions, unknownActions };
}

function renderResult(
  output: Writable,
  result: RunResult,
  renderedText: string,
  completedActions: readonly CompletedAction[],
  unknownActions: readonly UnknownToolAction[],
): void {
  if (result.status === "completed") {
    // result.text is only the last model step. Deltas already painted the
    // stream; reprinting it duplicates or appends the wrong slice.
    if (renderedText.length === 0 && result.text.length > 0) {
      write(output, `\n\n${result.text}\n\n`);
    } else {
      write(output, "\n\n");
    }
    return;
  }

  write(output, `\n\nRun ${result.status}`);
  if (result.error) write(output, `: ${result.error.message}`);
  if (completedActions.length > 0) {
    write(output, "\n已完成的操作：\n");
    for (const action of completedActions) {
      if ("path" in action) {
        write(output, `- ${action.toolName}: ${action.path} (${action.bytes} bytes)\n`);
      } else if (action.toolName === "task_create") {
        write(
          output,
          `- task_create: 已创建任务 ${action.id}，执行时间 ${action.runAt}，内容：${action.prompt}\n`,
        );
      } else if (action.toolName === "task_reschedule") {
        write(output, `- task_reschedule: 已改期任务 ${action.id}，新执行时间 ${action.runAt}\n`);
      } else if (action.toolName === "checkpoint_save") {
        write(
          output,
          `- checkpoint_save: 已保存工作进度 ${action.id}，版本 ${action.version}，状态 ${action.status}\n`,
        );
      } else if ("revision" in action) {
        if (action.toolName === "memory_add") {
          write(output, `- memory_add: 已保存记忆 ${action.id}，版本 ${action.revision}\n`);
        } else if (action.toolName === "memory_update") {
          write(output, `- memory_update: 已更新记忆 ${action.id}，版本 ${action.revision}\n`);
        } else {
          write(output, `- ${action.toolName}: 已保存记忆 ${action.id}，版本 ${action.revision}\n`);
        }
      } else {
        write(output, `- ${action.toolName}: ${action.summary}\n`);
      }
    }
  }
  if (unknownActions.length > 0) {
    write(output, "结果不确定，重试前请先核查：\n");
    for (const action of unknownActions) {
      write(
        output,
        `- ${action.toolName}${action.summary ? ` (${action.summary})` : ` (${action.toolCallId})`}: ${action.message}\n`,
      );
    }
    write(output, "本次 Run 不会自动重试该操作。\n");
  }
  write(output, "\n\n");
}

function commandParts(line: string): { name: string; args: string } {
  const trimmed = line.trim();
  const whitespace = trimmed.search(/\s/);
  if (whitespace === -1) return { name: trimmed.slice(1), args: "" };
  return {
    name: trimmed.slice(1, whitespace),
    args: trimmed.slice(whitespace).trimStart(),
  };
}

/**
 * Run the thin terminal adapter. Runtime remains the only owner of execution;
 * this function only renders committed history/events and forwards input.
 */
export async function runTui(options: RunTuiOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const generateId = options.generateId ?? (() => crypto.randomUUID());
  const history = await options.store.getMessages(options.threadId);
  renderHistory(output, history);
  if (options.renderHome !== undefined) {
    try {
      await options.renderHome();
    } catch (error) {
      write(output, `\n[home] Failed: ${String(error)}\n`);
    }
  }

  const readline = createInterface({
    input,
    output,
    terminal: isTTY(input) && isTTY(output),
  });

  let state: TuiState = { kind: "idle" };
  let runStarting = false;
  let cancelSentForRun: string | undefined;
  let stopRequestReason: string | undefined;
  let inputClosed = false;
  let dispatchingCommand = false;
  let backgroundTask: Promise<void> | undefined;
  let backgroundController: AbortController | undefined;
  const tasks = new Set<Promise<void>>();
  const getState = (): TuiState => state;

  options.registerNotificationRedraw?.(() => {
    if (isTTY(input) && !inputClosed && state.kind === "idle" && !runStarting && !dispatchingCommand) {
      readline.prompt(true);
    }
  });

  if (isTTY(input)) readline.prompt();

  const requestStop = (reason: string, announce: boolean): void => {
    backgroundController?.abort(new DOMException(reason, "AbortError"));
    if (stopRequestReason === undefined) stopRequestReason = reason;
    if (state.kind === "consolidating") {
      state.controller.abort(new DOMException(reason, "AbortError"));
      stopRequestReason = undefined;
      return;
    }
    if (state.kind === "running") {
      const handle = state.handle;
      if (cancelSentForRun !== handle.runId) {
        cancelSentForRun = handle.runId;
        void handle.cancel(reason);
        if (announce) write(output, "\nCancelling current run...\n");
      }
      stopRequestReason = undefined;
      return;
    }
    if (state.kind === "compacting") {
      state.controller.abort(new DOMException("Context compaction cancelled", "AbortError"));
      if (announce) write(output, "\nCancelling context compaction...\n");
      stopRequestReason = undefined;
      return;
    }
    if (state.kind === "resuming") {
      state.controller.abort(new DOMException("Git inspection cancelled", "AbortError"));
      if (announce) write(output, "\nCancelling Git inspection...\n");
      stopRequestReason = undefined;
      return;
    }
    if (runStarting) {
      return;
    }
    readline.close();
  };

    const executeRun = async (
      agentId: string,
      message: UIMessage,
      signal?: AbortSignal,
      background = false,
      started?: () => void,
    ): Promise<{
      result: RunResult;
      requestedMemoryTool: boolean;
    }> => {
      options.toolConfirmation?.beginRun();
      options.memoryConsolidation?.begin(agentId);
      try {
        const hostExtraction = options.hostConsolidationExtraction === true && agentId === AUTO_CONSOLIDATION_AGENT_ID && options.memoryConsolidation !== undefined;
        if (hostExtraction) message = await prepareConsolidationExtraction(options.memoryConsolidation!, message, signal);
        const handle = await options.runtime.run({
          agentId,
          threadId: options.threadId,
          messages: [message],
          context: { agentId },
          ...(signal ? { signal } : {}),
        });
        state = { kind: "running", handle, ...(background ? { background: true as const } : {}) };
        started?.();
        cancelSentForRun = undefined;
        const pendingStopReason = stopRequestReason;
        stopRequestReason = undefined;
        if (pendingStopReason !== undefined || signal?.aborted) {
          await handle.cancel(pendingStopReason ?? (signal?.reason instanceof Error ? signal.reason.message : "Foreground chat has priority"));
        }

        const eventsDone = renderEvents(output, handle.events);
        const result = await handle.result;
        const rendered = await eventsDone;
        if (options.memoryConsolidation) {
          try {
            const extracted = hostExtraction && result.status === "completed" ? await stageConsolidationExtraction(options.memoryConsolidation, result.text, signal) : undefined;
            const finalized = extracted && !extracted.ok ? extracted : await options.memoryConsolidation.finalize({ status: result.status,
              ...(hostExtraction && rendered.consolidationAttempts.prepare === 0 && rendered.consolidationAttempts.stage === 0 ? {} : { consolidationAttempts: rendered.consolidationAttempts }) }, signal);
            if (!finalized.ok) write(output, `\n[memory] ${finalized.error.code === "MEMORY_COMMIT_UNCERTAIN" ? "写入确认不确定，请先读取当前记忆；不能据此判定未保存" : "整理未完成"}：${finalized.error.message}\n`);
            else {
              const pending = finalized.value.pendingCandidateIds ?? finalized.value.candidateIds;
              if (pending.length > 0) write(output, `\n有 ${pending.length} 项记忆需要你确认，尚未写入有效记忆。\n`);
              for (const receipt of finalized.value.accepted ?? []) write(output, `\n记忆${receipt.operation === "retract" ? "已撤回" : receipt.operation === "disable" ? "已停用" : receipt.operation === "add" ? "已保存" : "已更新"}，可查看或撤回。\n`);
            }
          } catch (error) {
            write(output, `\n[memory] 整理确认失败，请先核对当前记忆：${String(error)}\n`);
          }
        }
        const failedConsolidation =
          agentId === AUTO_CONSOLIDATION_AGENT_ID &&
          (result.status === "failed" || result.status === "timed_out");
        if (!failedConsolidation) {
          renderResult(
            output,
            result,
            rendered.renderedText,
            rendered.completedActions,
            rendered.unknownActions,
          );
        }
        state = { kind: "idle" };
        return { result, requestedMemoryTool: rendered.requestedMemoryTool };
      } finally {
        options.memoryConsolidation?.discard();
        options.toolConfirmation?.endRun();
      }
    };

  const startAutomaticConsolidation = (): void => {
    if (inputClosed || state.kind !== "idle" || runStarting || dispatchingCommand || backgroundTask || !options.autoConsolidationAgentId) return;
    const agentId = options.autoConsolidationAgentId;
    const background = new AbortController();
    backgroundController = background;
    state = { kind: "consolidating", controller: background };
    const task = (async () => {
      try {
        const capacity = await options.memoryConsolidation?.canStart(background.signal);
        if (background.signal.aborted) return;
        if (capacity && (!capacity.ok || !capacity.value.canStart)) {
          write(output, "\n[memory] 自动整理已跳过：候选队列已满或读取失败，请先审核候选。\n");
          return;
        }
        write(output, "\n正在自动整理记忆（后台），新的对话优先。\n");
        const consolidation = await executeRun(agentId, automaticConsolidationMessage(generateId()), background.signal, true);
        if (consolidation.result.status === "failed" || consolidation.result.status === "timed_out") {
          write(output, `\n\nAutomatic consolidation failed: ${consolidation.result.error?.message ?? consolidation.result.status}\n\n`);
        }
      } catch (error) {
        if (!background.signal.aborted) write(output, `\n\nAutomatic consolidation failed: ${String(error)}\n\n`);
      } finally {
        if (backgroundController === background) backgroundController = undefined;
        const current = getState();
        if ((current.kind === "running" && current.background) || current.kind === "consolidating") state = { kind: "idle" };
        if (isTTY(input) && !inputClosed && !runStarting) readline.prompt();
      }
    })();
    backgroundTask = task;
    tasks.add(task);
    void task.finally(() => { tasks.delete(task); if (backgroundTask === task) backgroundTask = undefined; });
  };

  const submit = async (text: string): Promise<void> => {
    if ((state.kind !== "idle" && state.kind !== "consolidating" && !(state.kind === "running" && state.background)) || runStarting) {
      write(output, "\nBusy: wait for the current run to finish.\n");
      return;
    }
    if (text.trim() === "") return;
    runStarting = true;
    let shouldConsolidate = false;
    let runStarted = false;

    try {
      const previous = backgroundTask;
      if (previous) {
        backgroundController?.abort(new DOMException("Foreground chat has priority", "AbortError"));
        if (state.kind === "running" && state.background) void state.handle.cancel("Foreground chat has priority");
        if (!await waitForConsolidationHandoff(previous)) {
          write(output, "\n后台整理尚未停止，本条消息未提交，请稍后重试。\n");
          return;
        }
      }
      const userMessage: UIMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text }],
        metadata: userMessageClock(),
      };
      options.resume?.beginRun();
      let primary: Awaited<ReturnType<typeof executeRun>>;
      try {
        primary = await executeRun(options.agentId, userMessage, undefined, false, () => { runStarted = true; });
      } finally {
        options.resume?.endRun();
      }
      shouldConsolidate = automaticConsolidationSkip({ enabled: options.autoConsolidationAgentId !== undefined,
        status: primary.result.status, requestedMemoryTool: primary.requestedMemoryTool,
        cancelled: stopRequestReason !== undefined || cancelSentForRun !== undefined }) === undefined;
    } catch (error) {
      write(output, `\n\n${runStarted ? "Run could not finish" : "Run could not start"}: ${String(error)}\n\n`);
    } finally {
      if (!backgroundTask) state = { kind: "idle" };
      runStarting = false;
      cancelSentForRun = undefined;
      stopRequestReason = undefined;
      if (shouldConsolidate) startAutomaticConsolidation();
      if (isTTY(input) && !inputClosed) readline.prompt();
    }
  };

  const dispatchCommand = async (line: string): Promise<void> => {
    const { name, args } = commandParts(line);

    if (name === "resume" && options.resume !== undefined) {
      if (args.trim() !== "") {
        write(output, "\n[resume] Usage: /resume\n");
        return;
      }
      if (state.kind !== "idle" || runStarting) {
        write(output, "\nBusy: wait for the current operation to finish.\n");
        return;
      }
      options.resume.clear();
      const controller = new AbortController();
      state = { kind: "resuming", controller };
      write(output, "\nInspecting Git reality...\n");
      const task = (async () => {
        try {
          const message = await options.resume!.inspect(controller.signal);
          if (controller.signal.aborted) {
            options.resume!.clear();
            write(output, "\n[resume] Cancelled.\n");
          } else {
            write(output, `\n[resume] ${message}\n`);
          }
        } catch (error) {
          options.resume!.clear();
          if (controller.signal.aborted) {
            write(output, "\n[resume] Cancelled.\n");
          } else {
            write(output, `\n[resume] Failed: ${String(error)}\n`);
          }
        } finally {
          if (state.kind === "resuming" && state.controller === controller) {
            state = { kind: "idle" };
          }
          if (
            state.kind === "idle" &&
            isTTY(input) &&
            !inputClosed &&
            !runStarting &&
            !dispatchingCommand
          ) {
            readline.prompt();
          }
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return;
    }

    // Manual compaction is a TUI operation, not an Agent Run. Start it as a
    // tracked task so the readline loop can remain responsive to Ctrl+C and
    // can reject lines received while the compactor is busy.
    if (name === "compact" && options.compaction !== undefined) {
      if (args.trim() !== "") {
        write(output, "\n[compact] Usage: /compact\n");
        return;
      }
      if (state.kind !== "idle" || runStarting) {
        write(output, "\nBusy: wait for the current operation to finish.\n");
        return;
      }
      const controller = new AbortController();
      state = { kind: "compacting", controller };
      write(output, "\nCompacting context...\n");
      const task = (async () => {
        try {
          const result = await options.compaction!.compact(controller.signal);
          if (controller.signal.aborted) {
            write(output, "\n[compact] Cancelled.\n");
          } else {
            write(output, `\n[compact] ${result?.message ?? "Context compacted."}\n`);
          }
        } catch (error) {
          if (controller.signal.aborted) {
            write(output, "\n[compact] Cancelled.\n");
          } else {
            write(output, `\n[compact] Failed: ${String(error)}\n`);
          }
        } finally {
          if (state.kind === "compacting" && state.controller === controller) {
            state = { kind: "idle" };
          }
          if (
            state.kind === "idle" &&
            isTTY(input) &&
            !inputClosed &&
            !runStarting &&
            !dispatchingCommand
          ) {
            readline.prompt();
          }
        }
      })();
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
      return;
    }

    const command = name === "" ? undefined : options.commands?.get(name);
    if (command === undefined) {
      write(output, `\nUnknown command: ${line.trim()}\n`);
      return;
    }
    try {
      dispatchingCommand = true;
      await command.execute(args);
    } catch (error) {
      write(output, `\nCommand /${name} failed: ${String(error)}\n`);
    } finally {
      dispatchingCommand = false;
    }
  };

  // Defer startup work until handlers exist; foreground input wins any race.
  if (options.autoConsolidationAgentId && options.getMemoryConsolidationBacklog) {
    const startup = (async () => {
      try {
        const backlog = await options.getMemoryConsolidationBacklog!();
        if (!backlog.ok) write(output, `\n[memory] 自动整理不可用：${backlog.error.message}\n`);
        else if (backlog.value > 0) startAutomaticConsolidation();
      } catch (error) { write(output, `\n[memory] 自动整理不可用：${String(error)}\n`); }
    })();
    tasks.add(startup);
    void startup.finally(() => tasks.delete(startup));
  }

  readline.on("SIGINT", () => {
    if (state.kind === "consolidating") { requestStop("user_interrupt", true); return; }
    if (state.kind === "running") {
      requestStop("user_interrupt", true);
      return;
    }
    if (state.kind === "compacting") {
      requestStop("user_interrupt", true);
      return;
    }
    if (state.kind === "resuming") {
      requestStop("user_interrupt", true);
      return;
    }
    if (runStarting) {
      requestStop("user_interrupt", true);
      return;
    }
    readline.close();
  });

  try {
    for await (const line of readline) {
      if (options.toolConfirmation?.handleLine(line) === true) continue;
      const currentState = getState();
      if (currentState.kind === "compacting") {
        write(output, "\nBusy: context compaction is in progress.\n");
        continue;
      }
      if (currentState.kind === "resuming") {
        write(output, "\nBusy: Git inspection is in progress.\n");
        continue;
      }
      if (state.kind === "idle" && !runStarting && line.trim().startsWith("/")) {
        await dispatchCommand(line);
        if (isTTY(input) && !inputClosed) readline.prompt();
        continue;
      }
      const task = submit(line);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
    inputClosed = true;
    requestStop("stdin_closed", false);
    await Promise.all(tasks);
  } finally {
    options.resume?.clear();
    readline.close();
  }
}
