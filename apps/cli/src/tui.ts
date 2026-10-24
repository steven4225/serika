import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { UIMessage } from "ai";
import type {
  AgentEvent,
  MessageStore,
  RunHandle,
  RunRequest,
  RunResult,
} from "@serika/core";
import {
  isAutoConsolidationRequest,
  userMessageClock,
  type ToolConfirmation,
  type TuiCommand,
  type TuiResume,
} from "@serika/assistant";

type Runtime = {
  run<TContext>(request: RunRequest<TContext>): Promise<RunHandle>;
};

type TuiState =
  | { kind: "idle" }
  | { kind: "running"; handle: RunHandle }
  | { kind: "resuming"; controller: AbortController };

function write(output: Writable, text: string): void {
  output.write(text);
}

function isTTY(stream: Readable | Writable): boolean {
  return (stream as Readable & { isTTY?: boolean }).isTTY === true;
}

export interface RunTuiOptions {
  projectId?: string | null;
  runtime: Runtime;
  store: Pick<MessageStore, "getMessages">;
  threadId: string;
  agentId: string;
  /** This Thread's eligible committed backlog only; no model or cursor mutation. */
  input?: Readable;
  output?: Writable;
  generateId?: () => string;
  toolConfirmation?: ToolConfirmation;
  resume?: TuiResume;
  renderHome?: () => Promise<void>;
  commands?: ReadonlyMap<string, TuiCommand>;
  registerNotificationRedraw?: (redraw: () => void) => void;
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
  completedActions: CompletedAction[];
  unknownActions: UnknownToolAction[];
}> {
  let renderedText = "";
  let requestedMemoryTool = false;
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
  return { renderedText, requestedMemoryTool, completedActions, unknownActions };
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
  const tasks = new Set<Promise<void>>();
  const getState = (): TuiState => state;

  options.registerNotificationRedraw?.(() => {
    if (isTTY(input) && !inputClosed && state.kind === "idle" && !runStarting && !dispatchingCommand) {
      readline.prompt(true);
    }
  });

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
      started?: () => void,
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
          context: { agentId },
          ...(signal ? { signal } : {}),
        });
        state = { kind: "running", handle };
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
        renderResult(output, result, rendered.renderedText, rendered.completedActions, rendered.unknownActions);
        state = { kind: "idle" };
        return { result, requestedMemoryTool: rendered.requestedMemoryTool };
      } finally {
        options.toolConfirmation?.endRun();
      }
    };

  const submit = async (text: string): Promise<void> => {
    if (state.kind !== "idle" || runStarting) {
      write(output, "\nBusy: wait for the current run to finish.\n");
      return;
    }
    if (text.trim() === "") return;
    runStarting = true;
    let runStarted = false;

    try {
      const userMessage: UIMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text }],
        metadata: { ...userMessageClock(), memoryProjectId: options.projectId ?? null },
      };
      options.resume?.beginRun();
      try {
        await executeRun(options.agentId, userMessage, undefined, () => { runStarted = true; });
      } finally {
        options.resume?.endRun();
      }
    } catch (error) {
      write(output, `\n\n${runStarted ? "Run could not finish" : "Run could not start"}: ${String(error)}\n\n`);
    } finally {
      state = { kind: "idle" };
      runStarting = false;
      cancelSentForRun = undefined;
      stopRequestReason = undefined;
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

  readline.on("SIGINT", () => {
    if (state.kind === "running") {
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
