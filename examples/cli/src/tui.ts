import { createInterface } from "node:readline/promises";
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
  AUTO_CONSOLIDATION_SOURCE,
  isAutoConsolidationRequest,
} from "./consolidation.js";
import { validateWorkspacePath } from "./workspace-path.js";

type Runtime = {
  run<TContext>(request: RunRequest<TContext>): Promise<RunHandle>;
};

type TuiState =
  | { kind: "idle" }
  | { kind: "running"; handle: RunHandle };

/** A synchronous command handled directly by the terminal adapter. */
export interface TuiCommand {
  execute(args: string): void;
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
  input?: Readable;
  output?: Writable;
  generateId?: () => string;
  toolConfirmation?: ToolConfirmation;
  commands?: ReadonlyMap<string, TuiCommand>;
}

export interface ToolConfirmation {
  beforeToolExecute: BeforeToolExecute;
  handleLine(line: string): boolean;
  setPendingAuthorization(rule: RunAuthorizationInput): void;
  setPendingShellAuthorization(): void;
  beginRun(): void;
  endRun(): void;
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

export type ToolConfirmationPrompt = (
  input: BeforeToolExecuteInput,
) => string | Promise<string | undefined> | undefined;

const AUTO_APPROVED_TOOL_NAMES = new Set([
  "pomodoro_start",
  "pomodoro_status",
  "pomodoro_cancel",
]);

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
  signal: AbortSignal;
  onAbort: () => void;
  resolve: (decision: ToolExecutionDecision) => void;
  reject: (reason: unknown) => void;
}

export function createToolConfirmation(
  output: Writable,
  options: {
    prompt?: ToolConfirmationPrompt;
    workspaceRoot?: string;
    persistentAuthorizations?: readonly RunAuthorizationInput[];
    shellSandboxMode?: ShellSandboxMode;
  } = {},
): ToolConfirmation {
  let pending: PendingConfirmation | undefined;
  let nextRunAuthorization: RunAuthorization | undefined;
  let activeRunAuthorization: RunAuthorization | undefined;
  let nextShellAuthorization = false;
  let activeShellAuthorization = false;
  const persistentAuthorizations = (options.persistentAuthorizations ?? []).map(
    (rule) => normalizeAuthorization(rule, options.workspaceRoot),
  );

  const clearPending = (entry: PendingConfirmation): void => {
    if (pending !== entry) return;
    pending = undefined;
    entry.signal.removeEventListener("abort", entry.onAbort);
  };

  const beforeToolExecute: BeforeToolExecute = (input) => {
    if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
    if (AUTO_APPROVED_TOOL_NAMES.has(input.toolName)) {
      return Promise.resolve({ allow: true });
    }
    if (activeShellAuthorization && input.toolName === "shell_exec") {
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
    entry = { signal: input.signal, onAbort, resolve, reject };
    pending = entry;
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
      return decision;
    }

    const writePrompt = (text: string): void => {
      if (pending !== entry) return;
      try {
        write(output, text);
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

  const handleLine = (line: string): boolean => {
    const entry = pending;
    if (entry === undefined) return false;
    const answer = line.trim().toLowerCase();
    if (answer !== "y" && answer !== "n") {
      write(output, "\nPlease enter y or n.\nAllow this call? [y/n] ");
      return true;
    }

    clearPending(entry);
    if (answer === "y") {
      entry.resolve({ allow: true });
    } else {
      entry.resolve({ allow: false, reason: "User denied this tool call" });
    }
    return true;
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

  const beginRun = (): void => {
    activeRunAuthorization = nextRunAuthorization;
    nextRunAuthorization = undefined;
    activeShellAuthorization =
      options.shellSandboxMode === "docker" && nextShellAuthorization;
    nextShellAuthorization = false;
  };

  const endRun = (): void => {
    activeRunAuthorization = undefined;
    activeShellAuthorization = false;
    if (pending !== undefined) {
      const entry = pending;
      clearPending(entry);
      entry.reject(new Error("Run authorization ended"));
    }
  };

  return {
    beforeToolExecute,
    handleLine,
    setPendingAuthorization,
    setPendingShellAuthorization,
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

type CompletedTaskAction = {
  toolName: "task_create";
  id: string;
  runAt: string;
  prompt: string;
};

type CompletedAction = CompletedFileAction | CompletedPomodoroAction | CompletedTaskAction;

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
  if (event.data.toolName !== "task_create") return undefined;
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
    typeof result.value.runAt !== "string" ||
    typeof result.value.prompt !== "string"
  ) {
    return undefined;
  }
  return {
    toolName: "task_create",
    id: result.value.id,
    runAt: result.value.runAt,
    prompt: result.value.prompt,
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
  completedActions: CompletedAction[];
}> {
  let renderedText = "";
  let requestedMemoryTool = false;
  const completedActions: CompletedAction[] = [];
  for await (const event of events) {
    switch (event.type) {
      case "message.delta":
        renderedText += event.data.text;
        write(output, event.data.text);
        break;
      case "step.started":
        write(output, `\n[step ${event.data.stepNumber}] `);
        break;
      case "tool.call.requested":
        requestedMemoryTool ||= event.data.toolName.startsWith("memory_");
        write(output, `\n[tool ${event.data.toolName}]\n`);
        break;
      case "tool.call.failed":
        write(output, `\n[tool failed: ${event.data.error.message}]\n`);
        break;
      case "tool.call.completed": {
        const action = completedFileAction(event);
        if (action !== undefined) completedActions.push(action);
        const pomodoroAction = completedPomodoroAction(event);
        if (pomodoroAction !== undefined) completedActions.push(pomodoroAction);
        const taskAction = completedTaskAction(event);
        if (taskAction !== undefined) completedActions.push(taskAction);
        break;
      }
      default:
        break;
    }
  }
  return { renderedText, requestedMemoryTool, completedActions };
}

function renderResult(
  output: Writable,
  result: RunResult,
  renderedText: string,
  completedActions: readonly CompletedAction[],
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
      } else {
        write(output, `- ${action.toolName}: ${action.summary}\n`);
      }
    }
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
  const tasks = new Set<Promise<void>>();

  if (isTTY(input)) readline.prompt();

  const requestStop = (reason: string, announce: boolean): void => {
    if (stopRequestReason === undefined) stopRequestReason = reason;
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
    if (runStarting) {
      return;
    }
    readline.close();
  };

  const submit = async (text: string): Promise<void> => {
    if (state.kind === "running" || runStarting) {
      write(output, "\nBusy: wait for the current run to finish.\n");
      return;
    }
    if (text.trim() === "") return;

    runStarting = true;
    let runStarted = false;
    const executeRun = async (
      agentId: string,
      message: UIMessage,
    ): Promise<{
      result: RunResult;
      requestedMemoryTool: boolean;
    }> => {
      options.toolConfirmation?.beginRun();
      try {
        const handle = await options.runtime.run({
          agentId,
          threadId: options.threadId,
          messages: [message],
        });
        runStarted = true;
        state = { kind: "running", handle };
        cancelSentForRun = undefined;
        const pendingStopReason = stopRequestReason;
        stopRequestReason = undefined;
        if (pendingStopReason !== undefined) {
          await handle.cancel(pendingStopReason);
        }

        const eventsDone = renderEvents(output, handle.events);
        const result = await handle.result;
        const rendered = await eventsDone;
        renderResult(
          output,
          result,
          rendered.renderedText,
          rendered.completedActions,
        );
        state = { kind: "idle" };
        return { result, requestedMemoryTool: rendered.requestedMemoryTool };
      } finally {
        options.toolConfirmation?.endRun();
      }
    };

    try {
      const userMessage: UIMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text }],
      };
      const primary = await executeRun(options.agentId, userMessage);
      if (
        primary.result.status === "completed" &&
        !primary.requestedMemoryTool &&
        options.autoConsolidationAgentId !== undefined &&
        stopRequestReason === undefined
      ) {
        write(output, "\n正在自动整理记忆...\n");
        const consolidationMessage: UIMessage = {
          id: generateId(),
          role: "user",
          metadata: { source: AUTO_CONSOLIDATION_SOURCE },
          parts: [
            {
              type: "text",
              text: "请整理最近已提交的对话，先取材，再提出记忆建议；不要保存。",
            },
          ],
        };
        try {
          await executeRun(options.autoConsolidationAgentId, consolidationMessage);
        } catch (error) {
          write(output, `\n\nAutomatic consolidation failed: ${String(error)}\n\n`);
        }
      }
    } catch (error) {
      const phase = runStarted ? "Run could not finish" : "Run could not start";
      write(output, `\n\n${phase}: ${String(error)}\n\n`);
    } finally {
      state = { kind: "idle" };
      runStarting = false;
      cancelSentForRun = undefined;
      stopRequestReason = undefined;
      if (isTTY(input) && !inputClosed) readline.prompt();
    }
  };

  const dispatchCommand = (line: string): void => {
    const { name, args } = commandParts(line);
    const command = name === "" ? undefined : options.commands?.get(name);
    if (command === undefined) {
      write(output, `\nUnknown command: ${line.trim()}\n`);
      return;
    }
    try {
      command.execute(args);
    } catch (error) {
      write(output, `\nCommand /${name} failed: ${String(error)}\n`);
    }
  };

  readline.on("SIGINT", () => {
    if (state.kind === "running") {
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
      if (state.kind === "idle" && !runStarting && line.trim().startsWith("/")) {
        dispatchCommand(line);
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
    readline.close();
  }
}
