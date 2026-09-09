import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { UIMessage } from "ai";
import type {
  BeforeToolExecute,
  BeforeToolExecuteInput,
  MessageStore,
  RunHandle,
  RunRequest,
  RunResult,
  ToolExecutionDecision,
} from "@aisdk-agent/core";

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
  input?: Readable;
  output?: Writable;
  generateId?: () => string;
  toolConfirmation?: ToolConfirmation;
  commands?: ReadonlyMap<string, TuiCommand>;
}

export interface ToolConfirmation {
  beforeToolExecute: BeforeToolExecute;
  handleLine(line: string): boolean;
}

export type ToolConfirmationPrompt = (
  input: BeforeToolExecuteInput,
) => string | Promise<string | undefined> | undefined;

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

function confirmationPrompt(
  toolName: string,
  input: unknown,
): string {
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
  options: { prompt?: ToolConfirmationPrompt } = {},
): ToolConfirmation {
  let pending: PendingConfirmation | undefined;

  const clearPending = (entry: PendingConfirmation): void => {
    if (pending !== entry) return;
    pending = undefined;
    entry.signal.removeEventListener("abort", entry.onAbort);
  };

  const beforeToolExecute: BeforeToolExecute = (input) => {
    if (input.signal.aborted) return Promise.reject(abortReason(input.signal));
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
          writePrompt(text ?? confirmationPrompt(input.toolName, input.input)),
        (error: unknown) => {
          clearPending(entry);
          reject(error);
        },
      );
    } else {
      writePrompt(customPrompt ?? confirmationPrompt(input.toolName, input.input));
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

  return { beforeToolExecute, handleLine };
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

function renderHistory(output: Writable, messages: UIMessage[]): void {
  if (messages.length === 0) return;

  write(output, "\nHistory (committed transcript)\n");
  for (const message of messages) {
    const text = messageText(message);
    write(output, `${message.role}: ${text || "[non-text message]"}\n`);
  }
  write(output, "\n");
}

async function renderEvents(
  output: Writable,
  events: RunHandle["events"],
): Promise<string> {
  let renderedText = "";
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
        write(output, `\n[tool ${event.data.toolName}]\n`);
        break;
      case "tool.call.failed":
        write(output, `\n[tool failed: ${event.data.error.message}]\n`);
        break;
      default:
        break;
    }
  }
  return renderedText;
}

function renderResult(
  output: Writable,
  result: RunResult,
  renderedText: string,
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
    try {
      const userMessage: UIMessage = {
        id: generateId(),
        role: "user",
        parts: [{ type: "text", text }],
      };
      const handle = await options.runtime.run({
        agentId: options.agentId,
        threadId: options.threadId,
        messages: [userMessage],
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
      const renderedText = await eventsDone;
      renderResult(output, result, renderedText);
    } catch (error) {
      const phase = runStarted ? "Run could not finish" : "Run could not start";
      write(output, `\n\n${phase}: ${String(error)}\n\n`);
    } finally {
      state = { kind: "idle" };
      runStarting = false;
      cancelSentForRun = undefined;
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
