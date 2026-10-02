import type { UIMessage } from "ai";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import type { ContextDiagnostics, ContextResult } from "@aisdk-agent/example-cli/dist/context-diagnostics.js";
import type {
  CandidateListInput,
  CandidatePage,
  CandidatePreview,
  CandidateResolution,
  CandidateResolveInput,
  MemoryResult,
} from "@aisdk-agent/example-cli/dist/memory-candidates.js";

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
  outcomeUnknown?: boolean;
  summary: string;
  truncated: boolean;
}

export interface AppInfo {
  modelAlias: string;
  modelId?: string;
  computer: { enabled: boolean; allowedBundleIds: string[] };
  identitySource?: "saved" | "explicit";
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
  /** Actual module state. The desktop does not rewrite this into the user's config. */
  memory: {
    enabled: boolean;
    autoConsolidate: boolean;
  };
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
  | { type: "memory-updated"; reason: "proposals" | "review" | "write" }
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

/** Local audit receipts. Not live progress and not a replay source. */
export type ExecutionRunStatus =
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type ExecutionToolStatus =
  | "requested"
  | "not_started"
  | "started"
  | "completed"
  | "failed"
  | "unknown";

export interface ExecutionToolRecord {
  toolCallId: string;
  toolName: string;
  status: ExecutionToolStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  inputPreview: string;
  inputTruncated: boolean;
  resultPreview: string | null;
  resultTruncated: boolean;
  errorPreview: string | null;
  shell: { exitCode: number | null; timedOut: boolean; cancelled: boolean } | null;
}

export interface ExecutionRunRecord {
  runId: string;
  threadId: string;
  phase: RunPhase;
  status: ExecutionRunStatus;
  startedAt: string;
  finishedAt: string | null;
  resultTextPreview: string | null;
  resultTextTruncated: boolean;
  errorPreview: string | null;
  tools: ExecutionToolRecord[];
}

export type ListRunsResponse =
  | { ok: true; runs: ExecutionRunRecord[] }
  | { ok: false; reason: "unavailable"; message: string };

export type GetRunResponse =
  | { ok: true; run: ExecutionRunRecord | null }
  | { ok: false; reason: "unavailable"; message: string };

export interface RendererApi {
  info(): Promise<AppInfo>;
  snapshot(): Promise<UiSnapshot>;
  history(): Promise<UIMessage[]>;
  home(): Promise<CommandResponse>;
  run(text: string): Promise<RunResponse>;
  cancel(): Promise<void>;
  confirm(input: ConfirmInput): Promise<ConfirmResponse>;
  command(line: string): Promise<CommandResponse>;
  listRuns(): Promise<ListRunsResponse>;
  getRun(runId: string): Promise<GetRunResponse>;
  getContextDiagnostics(): Promise<ContextResult<ContextDiagnostics>>;
  listMemoryCandidates(input?: CandidateListInput): Promise<MemoryResult<CandidatePage>>;
  getMemoryCandidate(id: string): Promise<MemoryResult<CandidatePreview>>;
  resolveMemoryCandidate(input: CandidateResolveInput): Promise<MemoryResult<CandidateResolution>>;
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
  listRuns: "runloom:listRuns",
  getRun: "runloom:getRun",
  contextDiagnostics: "runloom:contextDiagnostics",
  memoryCandidatesList: "runloom:memoryCandidatesList",
  memoryCandidateGet: "runloom:memoryCandidateGet",
  memoryCandidateResolve: "runloom:memoryCandidateResolve",
  hide: "runloom:hide",
  message: "runloom:message",
} as const;
