import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import type {
  BeforeToolExecute,
  BeforeToolExecuteInput,
  ToolExecutionDecision,
} from "@serika/core";
import { resolve, sep } from "node:path";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { validateWorkspacePath } from "./workspace-path.js";

export interface ToolConfirmation {
  beforeToolExecute: BeforeToolExecute;
  handleLine(line: string): boolean;
  getPending(): PendingToolApproval | undefined;
  resolveApproval(input: { approvalId: string; decision: "allow" | "deny" }): boolean;
  subscribePending(listener: (pending: PendingToolApproval | undefined) => void): () => void;
  setPendingAuthorization(rule: RunAuthorizationInput): void;
  setPendingShellAuthorization(): void;
  setPendingWebAuthorization(origins: readonly string[]): void;
  beginRun(autonomous?: boolean): void;
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
  let activeAutonomy = false;
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
    if (activeAutonomy && (input.toolName === "shell_exec" ||
      (RUN_AUTHORIZED_FILE_TOOLS as readonly string[]).includes(input.toolName))) {
      return Promise.resolve({ allow: true });
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

  const beginRun = (autonomous = false): void => {
    activeAutonomy = autonomous;
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
    activeAutonomy = false;
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
