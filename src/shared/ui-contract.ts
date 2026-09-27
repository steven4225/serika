import type { UIMessage } from "ai";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";

/**
 * The only surface between the Electron main process and the renderer.
 *
 * The renderer never sees runtime objects. It receives a stream of
 * `MainToRenderer` messages and issues a small set of typed requests. The
 * visible state machine mirrors the TUI: idle | running | compacting |
 * resuming, plus at most one pending tool confirmation.
 */

export type UiState =
  | { kind: "idle" }
  | { kind: "running"; runId: string | null }
  | { kind: "compacting" }
  | { kind: "resuming" };

export interface AppInfo {
  modelAlias: string;
  threadId: string;
  /** The thread id was generated for this process; a restart will not return here. */
  temporaryThread: boolean;
  directory: string;
  /** The transcript directory was created for this process only. */
  temporaryDirectory: boolean;
  workspaceRoot: string | null;
  tuiMode: boolean;
  /** Registered idle commands, without the leading slash. */
  commands: string[];
  hasCompaction: boolean;
  hasResume: boolean;
}

export type MainToRenderer =
  | { type: "state"; state: UiState }
  /** Text written by modules or commands. Same text the TUI would print. */
  | { type: "output"; text: string }
  /** The read-only Home page text, rendered by the runtime. `reset` starts a fresh page. */
  | { type: "home"; text: string; reset?: boolean }
  /** A tool confirmation is waiting. Exactly one may be pending. */
  | { type: "confirmation"; prompt: string }
  | { type: "confirmation-cleared" }
  | { type: "event"; event: AgentEvent }
  | { type: "result"; result: RunResult }
  | { type: "error"; message: string };

export type BusyReason = "running" | "compacting" | "resuming" | "starting";

export type RunResponse =
  | { ok: true; runId: string }
  | { ok: false; reason: BusyReason | "empty" };

export type CommandResponse =
  | { ok: true }
  | { ok: false; reason: BusyReason | "unknown" | "empty" };

export type ConfirmResponse = { accepted: boolean };

export interface RendererApi {
  info(): Promise<AppInfo>;
  history(): Promise<UIMessage[]>;
  home(): Promise<void>;
  run(text: string): Promise<RunResponse>;
  cancel(): Promise<void>;
  /** `y` allows, `n` denies. Any other line keeps waiting, as in the TUI. */
  confirm(line: "y" | "n"): Promise<ConfirmResponse>;
  /** A line starting with `/`, e.g. `/resume`. */
  command(line: string): Promise<CommandResponse>;
  /** Hide the window; the tray icon or global shortcut brings it back. */
  hide(): Promise<void>;
  onMessage(listener: (message: MainToRenderer) => void): () => void;
}

export const IPC = {
  info: "runloom:info",
  history: "runloom:history",
  home: "runloom:home",
  run: "runloom:run",
  cancel: "runloom:cancel",
  confirm: "runloom:confirm",
  command: "runloom:command",
  hide: "runloom:hide",
  message: "runloom:message",
} as const;
