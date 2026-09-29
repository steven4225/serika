import { Writable } from "node:stream";
import type {
  AssistantController,
  AssistantEvent,
  AssistantSnapshot,
  AssistantState,
} from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { RuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { ShellProgressBuffer } from "../shared/shell-progress.js";
import type {
  AppInfo,
  CommandResponse,
  ConfirmInput,
  ConfirmResponse,
  MainToRenderer,
  RunResponse,
  UiSnapshot,
  UiState,
} from "../shared/ui-contract.js";

const TUI_DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const TUI_DEFAULT_SHELL_TIMEOUT_MS = 30_000;

const MODULE_NOTIFICATION = /^\s*\[module:([^\]]+)\]\s*([\s\S]*?)\s*$/;

/** Parsed `[module:id] message` line written by the module host's notify hook. */
export function parseModuleNotification(text: string): { moduleId: string; message: string } | undefined {
  const match = MODULE_NOTIFICATION.exec(text);
  if (match === null) return undefined;
  return { moduleId: match[1]!, message: match[2]! };
}

export type Send = (message: MainToRenderer) => void;

/**
 * Writable passed to `createRuntimeApp`. Every chunk is teed into
 * `controller.recordOutput` so reload snapshots keep command/Home/module text.
 */
export class TeeOutput extends Writable {
  #send: Send;
  #controller: AssistantController | undefined;
  #pending: string[] = [];
  #home = false;

  constructor(send: Send) {
    super({ decodeStrings: false });
    this.#send = send;
  }

  attach(controller: AssistantController): void {
    this.#controller = controller;
    for (const text of this.#pending) controller.recordOutput(text);
    this.#pending = [];
  }

  beginHome(): void {
    this.#home = true;
    this.#send({ type: "home", text: "", reset: true });
  }

  endHome(): void {
    this.#home = false;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.#controller !== undefined) this.#controller.recordOutput(text);
    else this.#pending.push(text);
    if (this.#home) this.#send({ type: "home", text });
    callback();
  }
}

export function toUiState(state: AssistantState): UiState {
  return state;
}

export function assistantEventToRenderer(event: AssistantEvent): MainToRenderer {
  switch (event.type) {
    case "state":
      return { type: "state", state: toUiState(event.state) };
    case "approval":
      return { type: "approval", approval: event.approval };
    case "approval-cleared":
      return { type: "approval-cleared", approvalId: event.approvalId };
    case "run-event":
      return { type: "event", phase: event.phase, event: event.event };
    case "run-result":
      return { type: "result", phase: event.phase, result: event.result };
    case "shell-progress":
      return {
        type: "shell-progress",
        phase: event.phase,
        runId: event.runId,
        progress: event.progress,
      };
    case "output":
      return { type: "output", text: event.text };
    case "error":
      return { type: "error", message: event.message };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function toUiSnapshot(snapshot: AssistantSnapshot, shellProgress: UiSnapshot["shellProgress"]): UiSnapshot {
  return {
    state: toUiState(snapshot.state),
    pendingApproval: snapshot.pendingApproval,
    recentOutput: snapshot.recentOutput,
    outputTruncated: snapshot.outputTruncated,
    toolActivity: snapshot.toolActivity,
    lastPrimaryResult: snapshot.lastPrimaryResult,
    lastConsolidationResult: snapshot.lastConsolidationResult,
    resultTextTruncated: snapshot.resultTextTruncated,
    shellProgress,
  };
}

export interface BridgeIdentity {
  modelAlias: string;
  temporaryThread: boolean;
  temporaryDirectory: boolean;
}

/**
 * Thin IPC adapter over AssistantController. Owns the Shell progress buffer
 * used to survive renderer reloads; it does not run a second AgentLoop.
 */
export class RuntimeBridge {
  readonly #app: RuntimeApp;
  readonly #controller: AssistantController;
  readonly #output: TeeOutput;
  readonly #identity: BridgeIdentity;
  readonly #shell = new ShellProgressBuffer();
  readonly #unsubscribe: () => void;

  constructor(
    app: RuntimeApp,
    controller: AssistantController,
    identity: BridgeIdentity,
    output: TeeOutput,
    send: Send,
  ) {
    this.#app = app;
    this.#controller = controller;
    this.#identity = identity;
    this.#output = output;
    this.#unsubscribe = controller.subscribe((event) => {
      if (event.type === "shell-progress") this.#shell.apply(event.progress);
      send(assistantEventToRenderer(event));
    });
  }

  info(): AppInfo {
    return {
      modelAlias: this.#identity.modelAlias,
      threadId: this.#app.threadId,
      temporaryThread: this.#identity.temporaryThread,
      directory: this.#app.directory,
      temporaryDirectory: this.#identity.temporaryDirectory,
      workspaceRoot: this.#app.workspaceRoot ?? null,
      tuiMode: this.#app.tuiMode,
      commands: [
        ...(this.#app.commands ? [...this.#app.commands.keys()] : []),
        ...(this.#app.compaction ? ["compact"] : []),
        ...(this.#app.resume ? ["resume"] : []),
      ].sort(),
      hasCompaction: this.#app.compaction !== undefined,
      hasResume: this.#app.resume !== undefined,
      totalTimeoutMs: this.#app.moduleConfig?.totalTimeoutMs ?? TUI_DEFAULT_TOTAL_TIMEOUT_MS,
      shellTimeoutMs: this.#app.moduleConfig?.shellTimeoutMs ?? TUI_DEFAULT_SHELL_TIMEOUT_MS,
    };
  }

  snapshot(): UiSnapshot {
    return toUiSnapshot(this.#controller.getSnapshot(), this.#shell.snapshot());
  }

  history() {
    return this.#controller.getHistory();
  }

  async home(): Promise<CommandResponse> {
    this.#output.beginHome();
    try {
      return await this.#controller.command("/home");
    } finally {
      this.#output.endHome();
    }
  }

  async run(text: string): Promise<RunResponse> {
    if (text.trim().length === 0) return { ok: false, reason: "empty" };
    if (this.#controller.getSnapshot().state.kind !== "idle") {
      return this.#controller.run(text);
    }
    this.#shell.clear();
    return this.#controller.run(text);
  }

  cancel(): Promise<void> {
    return this.#controller.cancel();
  }

  confirm(input: ConfirmInput): ConfirmResponse {
    return { accepted: this.#controller.confirm(input) };
  }

  command(line: string): Promise<CommandResponse> {
    return this.#controller.command(line);
  }

  async shutdown(): Promise<void> {
    this.#unsubscribe();
    await this.#controller.shutdown();
  }
}
