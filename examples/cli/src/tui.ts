import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { UIMessage } from "ai";
import type { MessageStore } from "@aisdk-agent/core";
import type {
  RunHandle,
  RunRequest,
  RunResult,
} from "@aisdk-agent/core";

type Runtime = {
  run<TContext>(request: RunRequest<TContext>): Promise<RunHandle>;
};

type TuiState =
  | { kind: "idle" }
  | { kind: "running"; handle: RunHandle };

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
}

function write(output: Writable, text: string): void {
  output.write(text);
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
  const tasks = new Set<Promise<void>>();

  if (isTTY(input)) readline.prompt();

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
      if (isTTY(input)) readline.prompt();
    }
  };

  readline.on("SIGINT", () => {
    if (state.kind === "running") {
      if (cancelSentForRun !== state.handle.runId) {
        cancelSentForRun = state.handle.runId;
        void state.handle.cancel("user_interrupt");
        write(output, "\nCancelling current run...\n");
      }
      return;
    }
    readline.close();
  });

  try {
    for await (const line of readline) {
      const task = submit(line);
      tasks.add(task);
      void task.finally(() => tasks.delete(task));
    }
    await Promise.all(tasks);
  } finally {
    readline.close();
  }
}
