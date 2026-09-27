import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import type { UIMessage } from "ai";
import type { RunHandle, RunResult } from "@aisdk-agent/core";
import type { RuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { AUTO_CONSOLIDATION_SOURCE } from "@aisdk-agent/example-cli/dist/consolidation.js";
import type {
  AppInfo,
  CommandResponse,
  ConfirmResponse,
  MainToRenderer,
  RunResponse,
  UiState,
} from "../shared/ui-contract.js";

const CONFIRMATION_SUFFIX = /Allow this call\? \[y\/n\]\s*$/;
const CONFIRMATION_PREAMBLE = /^\s*\[confirmation\][^\n]*\n/;
const CONFIRMATION_REPROMPT = /Please enter y or n\./;
const MODULE_NOTIFICATION = /^\s*\[module:([^\]]+)\]\s*([\s\S]*?)\s*$/;

/** Parsed `[module:id] message` line written by the module host's notify hook. */
export function parseModuleNotification(text: string): { moduleId: string; message: string } | undefined {
  const match = MODULE_NOTIFICATION.exec(text);
  if (match === null) return undefined;
  return { moduleId: match[1]!, message: match[2]! };
}

export type Send = (message: MainToRenderer) => void;

/**
 * Routes text the runtime writes to its `output` stream into typed renderer
 * messages. `renderHome` and module notifications all write plain text; the
 * bridge only decides which channel a chunk belongs to.
 *
 * Confirmation detection reads the TUI prompt suffix. This is the P1 bridge
 * until `createToolConfirmation` exposes an explicit pending hook.
 */
export class RendererSink extends Writable {
  #send: Send;
  #channel: "output" | "home" = "output";
  /** Observes every message before it is sent; used by the bridge to track state. */
  observer: ((message: MainToRenderer) => void) | undefined;

  constructor(send: Send) {
    super({ decodeStrings: false });
    this.#send = (message) => {
      this.observer?.(message);
      send(message);
    };
  }

  async captureHome(render: () => Promise<void>): Promise<void> {
    const previous = this.#channel;
    this.#channel = "home";
    this.#send({ type: "home", text: "", reset: true });
    try {
      await render();
    } finally {
      this.#channel = previous;
    }
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (this.#channel === "home") {
      this.#send({ type: "home", text });
    } else if (CONFIRMATION_SUFFIX.test(text) && !CONFIRMATION_REPROMPT.test(text)) {
      const prompt = text.replace(CONFIRMATION_PREAMBLE, "").replace(CONFIRMATION_SUFFIX, "").trim();
      this.#send({ type: "confirmation", prompt });
    } else {
      this.#send({ type: "output", text });
    }
    callback();
  }
}

function commandParts(line: string): { name: string; args: string } {
  const trimmed = line.trim().replace(/^\//, "");
  const space = trimmed.search(/\s/);
  if (space === -1) return { name: trimmed, args: "" };
  return { name: trimmed.slice(0, space), args: trimmed.slice(space + 1) };
}

/**
 * Drives one assembled `RuntimeApp` for a single window. Owns the visible
 * state machine and enforces the same rules as the TUI: one Run at a time,
 * busy input rejected rather than queued, one pending confirmation.
 */
export class RuntimeBridge {
  readonly #app: RuntimeApp;
  readonly #sink: RendererSink;
  readonly #send: Send;
  readonly #modelAlias: string;
  #state: UiState = { kind: "idle" };
  #handle: RunHandle | undefined;
  #busyController: AbortController | undefined;
  #confirmationPending = false;

  constructor(app: RuntimeApp, modelAlias: string, sink: RendererSink, send: Send) {
    this.#app = app;
    this.#modelAlias = modelAlias;
    this.#sink = sink;
    const track = (message: MainToRenderer): void => {
      if (message.type === "confirmation") this.#confirmationPending = true;
      if (message.type === "confirmation-cleared") this.#confirmationPending = false;
    };
    this.#send = (message) => {
      track(message);
      send(message);
    };
    // Confirmation prompts arrive through the sink, not through #send.
    sink.observer = track;
  }

  info(): AppInfo {
    return {
      modelAlias: this.#modelAlias,
      threadId: this.#app.threadId,
      directory: this.#app.directory,
      workspaceRoot: this.#app.workspaceRoot ?? null,
      tuiMode: this.#app.tuiMode,
      commands: [
        ...(this.#app.commands ? [...this.#app.commands.keys()] : []),
        ...(this.#app.compaction ? ["compact"] : []),
        ...(this.#app.resume ? ["resume"] : []),
      ].sort(),
      hasCompaction: this.#app.compaction !== undefined,
      hasResume: this.#app.resume !== undefined,
    };
  }

  state(): UiState {
    return this.#state;
  }

  async history() {
    return this.#app.store.getMessages(this.#app.threadId);
  }

  async home(): Promise<void> {
    await this.#sink.captureHome(() => this.#app.renderHome());
  }

  #setState(state: UiState): void {
    this.#state = state;
    this.#send({ type: "state", state });
  }

  #busyReason(): RunResponse | CommandResponse | undefined {
    switch (this.#state.kind) {
      case "idle":
        return undefined;
      case "running":
        return { ok: false, reason: "running" };
      case "compacting":
        return { ok: false, reason: "compacting" };
      case "resuming":
        return { ok: false, reason: "resuming" };
      default: {
        const exhaustive: never = this.#state;
        return exhaustive;
      }
    }
  }

  /**
   * One Run through the existing AgentLoop: begin/end the confirmation scope,
   * forward every event, return the result. Mirrors `executeRun` in tui.ts.
   */
  async #executeRun(
    agentId: string,
    message: UIMessage,
    onStarted?: (handle: RunHandle) => void,
  ): Promise<{ result: RunResult; requestedMemoryTool: boolean }> {
    this.#app.toolConfirmation?.beginRun();
    try {
      const handle = await this.#app.runtime.run({
        agentId,
        threadId: this.#app.threadId,
        messages: [message],
        context: { agentId },
      });
      this.#handle = handle;
      onStarted?.(handle);
      let requestedMemoryTool = false;
      const pump = (async () => {
        for await (const event of handle.events) {
          if (event.type === "tool.call.requested" && event.data.toolName.startsWith("memory_")) {
            requestedMemoryTool = true;
          }
          this.#send({ type: "event", event });
        }
      })();
      const result = await handle.result;
      await pump;
      return { result, requestedMemoryTool };
    } finally {
      this.#handle = undefined;
      this.#app.toolConfirmation?.endRun();
      if (this.#confirmationPending) this.#send({ type: "confirmation-cleared" });
    }
  }

  async run(text: string): Promise<RunResponse> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ok: false, reason: "empty" };
    const busy = this.#busyReason();
    if (busy !== undefined) return busy as RunResponse;

    this.#setState({ kind: "running", runId: null });
    const userMessage: UIMessage = {
      id: randomUUID(),
      role: "user",
      parts: [{ type: "text", text: trimmed }],
    };

    let started: ((handle: RunHandle) => void) | undefined;
    const startedHandle = new Promise<RunHandle>((resolve) => {
      started = resolve;
    });
    let startFailed: ((error: unknown) => void) | undefined;
    const startFailure = new Promise<never>((_resolve, reject) => {
      startFailed = reject;
    });

    void (async () => {
      let primary: { result: RunResult; requestedMemoryTool: boolean } | undefined;
      this.#app.resume?.beginRun();
      try {
        try {
          primary = await this.#executeRun(this.#app.agentId, userMessage, (handle) => {
            this.#setState({ kind: "running", runId: handle.runId });
            started?.(handle);
          });
        } finally {
          this.#app.resume?.endRun();
        }
        this.#send({ type: "result", result: primary.result });

        // Passive memory consolidation, exactly as the TUI does it: only after a
        // completed ordinary Run that did not itself touch memory tools.
        const consolidator = this.#app.autoConsolidationAgentId;
        if (
          consolidator !== undefined &&
          primary.result.status === "completed" &&
          !primary.requestedMemoryTool
        ) {
          this.#send({ type: "output", text: "\n正在自动整理记忆...\n" });
          const consolidationMessage: UIMessage = {
            id: randomUUID(),
            role: "user",
            metadata: { source: AUTO_CONSOLIDATION_SOURCE },
            parts: [{ type: "text", text: "请整理最近已提交的对话，先取材，再提出记忆建议；不要保存。" }],
          };
          try {
            const consolidation = await this.#executeRun(consolidator, consolidationMessage);
            if (consolidation.result.status === "failed" || consolidation.result.status === "timed_out") {
              const detail = consolidation.result.error?.message ?? consolidation.result.status;
              this.#send({ type: "output", text: `\nAutomatic consolidation failed: ${detail}\n` });
            } else {
              this.#send({ type: "result", result: consolidation.result });
            }
          } catch (error) {
            this.#send({ type: "output", text: `\nAutomatic consolidation failed: ${String(error)}\n` });
          }
        }
      } catch (error) {
        if (primary === undefined) {
          startFailed?.(error);
          this.#send({ type: "error", message: `Run could not start: ${String(error)}` });
        } else {
          this.#send({ type: "error", message: `Run could not finish: ${String(error)}` });
        }
      } finally {
        this.#setState({ kind: "idle" });
      }
    })();

    try {
      const handle = await Promise.race([startedHandle, startFailure]);
      return { ok: true, runId: handle.runId };
    } catch {
      return { ok: false, reason: "starting" };
    }
  }

  async cancel(): Promise<void> {
    if (this.#handle !== undefined) {
      await this.#handle.cancel("Cancelled from desktop");
      return;
    }
    this.#busyController?.abort(new Error("Cancelled from desktop"));
  }

  confirm(line: "y" | "n"): ConfirmResponse {
    const confirmation = this.#app.toolConfirmation;
    if (confirmation === undefined) return { accepted: false };
    const accepted = confirmation.handleLine(line);
    if (accepted) this.#send({ type: "confirmation-cleared" });
    return { accepted };
  }

  async command(line: string): Promise<CommandResponse> {
    const { name, args } = commandParts(line);
    if (name.length === 0) return { ok: false, reason: "empty" };
    const busy = this.#busyReason();
    if (busy !== undefined) return busy as CommandResponse;

    if (name === "compact" && this.#app.compaction !== undefined) {
      return this.#withBusy({ kind: "compacting" }, async (signal) => {
        const result = await this.#app.compaction!.compact(signal);
        this.#send({ type: "output", text: `\n[compact] ${result?.message ?? "Context compacted."}\n` });
      }, "[compact]");
    }
    if (name === "resume" && this.#app.resume !== undefined) {
      return this.#withBusy({ kind: "resuming" }, async (signal) => {
        const text = await this.#app.resume!.inspect(signal);
        this.#send({ type: "output", text: `\n[resume]\n${text}\n` });
      }, "[resume]");
    }
    const command = this.#app.commands?.get(name);
    if (command === undefined) {
      this.#send({ type: "output", text: `\nUnknown command: /${name}\n` });
      return { ok: false, reason: "unknown" };
    }
    try {
      await command.execute(args);
    } catch (error) {
      this.#send({ type: "output", text: `\nCommand /${name} failed: ${String(error)}\n` });
    }
    return { ok: true };
  }

  async #withBusy(
    state: Extract<UiState, { kind: "compacting" | "resuming" }>,
    work: (signal: AbortSignal) => Promise<void>,
    label: string,
  ): Promise<CommandResponse> {
    const controller = new AbortController();
    this.#busyController = controller;
    this.#setState(state);
    try {
      await work(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        if (state.kind === "resuming") this.#app.resume?.clear();
        this.#send({ type: "output", text: `\n${label} Cancelled.\n` });
      } else {
        this.#send({ type: "output", text: `\n${label} Failed: ${String(error)}\n` });
      }
    } finally {
      this.#busyController = undefined;
      this.#setState({ kind: "idle" });
    }
    return { ok: true };
  }

  dispose(): void {
    this.#app.dispose();
  }
}
