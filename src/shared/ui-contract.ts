import type { UIMessage } from "ai";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";

/**
 * The only surface between the Electron main process and the renderer.
 *
 * The renderer never sees runtime objects. It receives a stream of
 * `MainToRenderer` messages and issues a small set of typed requests that
 * forward to AssistantController. Visible state matches the controller:
 * idle | running | compacting | resuming | command, plus at most one
 * pending tool approval keyed by approvalId.
 */

export type RunPhase = "primary" | "consolidation";

export type UiState =
  | { kind: "idle" }
  | { kind: "running"; runId: string | null; phase: RunPhase }
  | { kind: "compacting" }
  | { kind: "resuming" }
  | { kind: "command"; name: string };

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  preview: string;
}

export interface ShellProgressChunk {
  toolCallId: string;
  sequence: number;
  stream: "stdout" | "stderr";
  text: string;
  truncated: boolean;
}

export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  status: "completed" | "failed";
  summary: string;
  truncated: boolean;
}

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
  /** Primary Run wall-clock budget from the TUI config (confirmation pauses excluded). */
  totalTimeoutMs: number;
  /** Shell command budget from the TUI config. */
  shellTimeoutMs: number;
}

export interface UiSnapshot {
  state: UiState;
  pendingApproval: PendingApproval | null;
  recentOutput: string;
  outputTruncated: boolean;
  toolActivity: readonly ToolActivity[];
  lastPrimaryResult: RunResult | null;
  lastConsolidationResult: RunResult | null;
  resultTextTruncated: boolean;
  /** Main-process buffer. The controller snapshot does not include live Shell output. */
  shellProgress: readonly ShellProgressChunk[];
}

export type MainToRenderer =
  | { type: "state"; state: UiState }
  | { type: "output"; text: string }
  | { type: "home"; text: string; reset?: boolean }
  | { type: "approval"; approval: PendingApproval }
  | { type: "approval-cleared"; approvalId: string }
  | { type: "event"; phase: RunPhase; event: AgentEvent }
  | { type: "result"; phase: RunPhase; result: RunResult }
  | { type: "shell-progress"; phase: RunPhase; runId: string; progress: ShellProgressChunk }
  | { type: "error"; message: string };

export type ConfirmInput = { approvalId: string; decision: "allow" | "deny" };

export type RunResponse =
  | { ok: true; runId: string }
  | { ok: false; reason: "busy" | "empty" | "starting" };

export type CommandResponse =
  | { ok: true }
  | { ok: false; reason: "busy" | "unknown" | "empty" | "cancelled" }
  | { ok: false; reason: "failed"; message: string };

export type ConfirmResponse = { accepted: boolean };

export interface RendererApi {
  info(): Promise<AppInfo>;
  snapshot(): Promise<UiSnapshot>;
  history(): Promise<UIMessage[]>;
  home(): Promise<CommandResponse>;
  run(text: string): Promise<RunResponse>;
  cancel(): Promise<void>;
  confirm(input: ConfirmInput): Promise<ConfirmResponse>;
  command(line: string): Promise<CommandResponse>;
  hide(): Promise<void>;
  onMessage(listener: (message: MainToRenderer) => void): () => void;
}

export const IPC = {
  info: "runloom:info",
  snapshot: "runloom:snapshot",
  history: "runloom:history",
  home: "runloom:home",
  run: "runloom:run",
  cancel: "runloom:cancel",
  confirm: "runloom:confirm",
  command: "runloom:command",
  hide: "runloom:hide",
  message: "runloom:message",
} as const;
