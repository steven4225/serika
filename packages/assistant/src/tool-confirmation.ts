import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import type {
  BeforeToolExecute,
  BeforeToolExecuteInput,
  ToolExecutionDecision,
} from "@serika/core";
import { dirname, resolve, sep } from "node:path";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import type { ToolPermissionFacts } from "./module-host.js";
import { validateWorkspacePath } from "./workspace-path.js";

export interface ToolConfirmation {
  beforeToolExecute: BeforeToolExecute;
  handleLine(line: string): boolean;
  getPending(): PendingToolApproval | undefined;
  /** `remember` also keeps the offered conversation grant; only valid with "allow" when one is offered. */
  resolveApproval(input: { approvalId: string; decision: "allow" | "deny"; remember?: boolean }): boolean;
  subscribePending(listener: (pending: PendingToolApproval | undefined) => void): () => void;
  setPendingAuthorization(rule: RunAuthorizationInput): void;
  setPendingShellAuthorization(): void;
  setPendingWebAuthorization(origins: readonly string[]): void;
  /** A Telegram Run neither uses nor offers remembered conversation grants. */
  beginRun(autonomous?: boolean, source?: "telegram"): void;
  endRun(): void;
  /** Grants remembered in this conversation (process memory only). */
  listRemembered(): RememberedGrant[];
  forgetRemembered(id: string): boolean;
}

/**
 * An approval the user chose to remember for this conversation. It lives in
 * this confirmation's memory only: never persisted, gone on restart or when
 * the conversation's assistant is replaced, and bound to the granting agent.
 * - `tool`: every call of one read-risk tool;
 * - `directory`: one file tool writing files directly in one workspace
 *   directory (`scope`, "" is the root), not its subdirectories;
 * - `origin`: one tool reading one exact web origin (a tool declaring an origin scope).
 */
export interface RememberedGrant {
  id: string;
  agentId: string;
  toolName: string;
  kind: "tool" | "directory" | "origin";
  scope: string;
  label: string;
}

export type ToolRiskLookup = (toolName: string) => string | undefined;
/** Permission facts the registering module declared for a tool. */
export type ToolPermissionLookup = (toolName: string) => ToolPermissionFacts | undefined;

/** One tool call awaiting a user decision. The preview may still be loading. */
export interface PendingToolApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  preview: string;
  /** Present when this call can be allowed and remembered for the conversation. */
  remember?: { label: string };
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

function inputOrigin(input: unknown, argument: string): string | undefined {
  if (typeof input !== "object" || input === null || !(argument in input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[argument];
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** The web origin a tool's declared origin scope reads from this input. */
function scopedOrigin(facts: ToolPermissionFacts | undefined, input: unknown): string | undefined {
  return facts?.scope?.kind === "origin" ? inputOrigin(input, facts.scope.argument) : undefined;
}

function webAuthorizationAllows(
  authorization: WebAuthorization | undefined,
  input: BeforeToolExecuteInput,
  facts: ToolPermissionFacts | undefined,
): boolean {
  if (authorization === undefined || facts?.defaults?.runAuthorization !== "origin") return false;
  const origin = scopedOrigin(facts, input.input);
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

/** Tools whose approval is never remembered, whatever their declared risk. */
const NEVER_REMEMBERED_PREFIXES = ["computer_", "recipe_", "memory_"] as const;
const NEVER_REMEMBERED_TOOLS = new Set(["shell_exec"]);
const MAX_REMEMBERED_GRANTS = 64;

type GrantCandidate = Omit<RememberedGrant, "id">;

function fileDirectory(workspaceRoot: string, input: unknown): string | undefined {
  const validated = validateWorkspacePath(workspaceRoot, readFilePath(input));
  if (!validated.ok || validated.relativePath === "") return undefined;
  const directory = dirname(validated.relativePath);
  return directory === "." ? "" : directory;
}

function grantCandidate(
  input: BeforeToolExecuteInput,
  workspaceRoot: string | undefined,
  toolRisk: ToolRiskLookup | undefined,
  facts: ToolPermissionFacts | undefined,
): GrantCandidate | undefined {
  const { toolName } = input;
  const agentId = input.definition.id;
  if (NEVER_REMEMBERED_TOOLS.has(toolName) ||
    NEVER_REMEMBERED_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return undefined;
  if (toolName === "write_file" || toolName === "edit_file") {
    if (workspaceRoot === undefined) return undefined;
    const scope = fileDirectory(workspaceRoot, input.input);
    if (scope === undefined) return undefined;
    const place = scope === "" ? "工作区根目录" : `${scope}${sep}`;
    return { agentId, toolName, kind: "directory", scope,
      label: `本次对话内允许 ${toolName} 改动 ${place} 下的文件（不含子目录）` };
  }
  if (facts?.defaults?.remember === "scope" && facts.scope?.kind === "origin") {
    const origin = scopedOrigin(facts, input.input);
    if (origin === undefined) return undefined;
    return { agentId, toolName, kind: "origin", scope: origin, label: `本次对话内允许 ${toolName} 读取 ${origin}` };
  }
  if (toolRisk?.(toolName) === "read") {
    return { agentId, toolName, kind: "tool", scope: "", label: `本次对话内不再询问 ${toolName}` };
  }
  return undefined;
}

function sameGrant(a: GrantCandidate, b: GrantCandidate): boolean {
  return a.agentId === b.agentId && a.toolName === b.toolName && a.kind === b.kind && a.scope === b.scope;
}

interface PendingConfirmation {
  approval: PendingToolApproval;
  grant?: GrantCandidate;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (decision: ToolExecutionDecision) => void;
  reject: (reason: unknown) => void;
  steerSignal?: AbortSignal;
  onSteer?: () => void;
}

export function createToolConfirmation(
  output: Writable,
  options: {
    prompt?: ToolConfirmationPrompt;
    onPendingChange?: (pending: PendingToolApproval | undefined) => void;
    generateId?: () => string;
    workspaceRoot?: string;
    persistentAuthorizations?: readonly RunAuthorizationInput[];
    shellSandboxMode?: ShellSandboxMode;
    /** Declared tool risk; only read-risk tools can be remembered by name. */
    toolRisk?: ToolRiskLookup;
    /** Permission facts declared by the registering modules. */
    toolPermissions?: ToolPermissionLookup;
  } = {},
): ToolConfirmation {
  let pending: PendingConfirmation | undefined;
  /** Tools denied for the rest of this Run because a declared denial blocks them, with the reason. */
  const blockedThisRun = new Map<string, string>();
  const facts = (toolName: string) => options.toolPermissions?.(toolName);
  let nextRunAuthorization: RunAuthorization | undefined;
  let activeRunAuthorization: RunAuthorization | undefined;
  let nextShellAuthorization = false;
  let activeShellAuthorization = false;
  let activeAutonomy = false;
  let nextWebAuthorization: WebAuthorization | undefined;
  let activeWebAuthorization: WebAuthorization | undefined;
  let rememberedActive = true;
  let nextGrantId = 1;
  const remembered: RememberedGrant[] = [];
  const pendingListeners = new Set<(pending: PendingToolApproval | undefined) => void>();
  const persistentAuthorizations = (options.persistentAuthorizations ?? []).map(
    (rule) => normalizeAuthorization(rule, options.workspaceRoot),
  );

  const getPending = (): PendingToolApproval | undefined =>
    pending === undefined ? undefined : {
      ...pending.approval,
      ...(pending.approval.remember ? { remember: { ...pending.approval.remember } } : {}),
    };

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
    const blockedReason = blockedThisRun.get(input.toolName);
    if (blockedReason !== undefined) {
      return Promise.resolve({
        allow: false,
        reason: blockedReason,
      });
    }
    if (activeAutonomy && (input.toolName === "shell_exec" ||
      (RUN_AUTHORIZED_FILE_TOOLS as readonly string[]).includes(input.toolName))) {
      return Promise.resolve({ allow: true });
    }
    if (activeShellAuthorization && input.toolName === "shell_exec") {
      return Promise.resolve({ allow: true });
    }
    if (webAuthorizationAllows(activeWebAuthorization, input, facts(input.toolName))) {
      return Promise.resolve({ allow: true });
    }
    if (
      authorizationAllows(activeRunAuthorization, input) ||
      persistentAuthorizations.some((rule) => authorizationAllows(rule, input))
    ) {
      return Promise.resolve({ allow: true });
    }
    const candidate = rememberedActive
      ? grantCandidate(input, options.workspaceRoot, options.toolRisk, facts(input.toolName))
      : undefined;
    if (candidate !== undefined && remembered.some((grant) => sameGrant(grant, candidate))) {
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
        ...(candidate !== undefined && remembered.length < MAX_REMEMBERED_GRANTS
          ? { remember: { label: candidate.label } } : {}),
      },
      ...(candidate !== undefined && remembered.length < MAX_REMEMBERED_GRANTS ? { grant: candidate } : {}),
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
        const remember = entry.approval.remember;
        write(output, remember === undefined
          ? `\n[confirmation] Waiting for y/n; the tool has not run yet.\n${text}`
          : `\n[confirmation] Waiting for y/n/r; the tool has not run yet. r = allow and ${remember.label}.\n${text}`);
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
    remember?: boolean;
  }): boolean => {
    const entry = pending;
    if (entry === undefined || entry.approval.approvalId !== input.approvalId) return false;
    // Remembering is only the offered grant of an allow; never a silent plain allow.
    if (input.remember === true && (input.decision !== "allow" || entry.grant === undefined)) return false;
    // The empty approval is published before asynchronous preview preparation.
    // All callers (desktop, IM and TUI), not just the renderer, must wait for it.
    if (input.decision === "allow" && entry.approval.preview.trim().length === 0) return false;
    clearPending(entry);
    if (input.decision === "allow") {
      if (input.remember === true && entry.grant !== undefined &&
        !remembered.some((grant) => sameGrant(grant, entry.grant!))) {
        remembered.push({ id: String(nextGrantId++), ...entry.grant });
      }
      entry.resolve({ allow: true });
    } else {
      const denied = entry.approval.toolName;
      for (const blocked of facts(denied)?.denialBlocksForRun ?? []) {
        if (!blockedThisRun.has(blocked)) blockedThisRun.set(blocked, `${denied} was denied in this Run`);
      }
      entry.resolve({ allow: false, reason: "User denied this tool call" });
    }
    return true;
  };

  const handleLine = (line: string): boolean => {
    const entry = pending;
    if (entry === undefined) return false;
    const answer = line.trim().toLowerCase();
    const canRemember = entry.grant !== undefined;
    if (answer !== "y" && answer !== "n" && !(canRemember && answer === "r")) {
      write(output, canRemember
        ? "\nPlease enter y, n or r (allow and remember in this conversation).\nAllow this call? [y/n/r] "
        : "\nPlease enter y or n.\nAllow this call? [y/n] ");
      return true;
    }

    return resolveApproval({
      approvalId: entry.approval.approvalId,
      decision: answer === "n" ? "deny" : "allow",
      ...(answer === "r" ? { remember: true } : {}),
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

  const beginRun = (autonomous = false, source?: "telegram"): void => {
    activeAutonomy = autonomous;
    rememberedActive = source !== "telegram";
    blockedThisRun.clear();
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
    rememberedActive = true;
    blockedThisRun.clear();
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
    listRemembered: () => remembered.map((grant) => ({ ...grant })),
    forgetRemembered: (id) => {
      const index = remembered.findIndex((grant) => grant.id === id);
      if (index < 0) return false;
      remembered.splice(index, 1);
      return true;
    },
  };
}
