import type { UIMessage } from "ai";
import type { FormalMemory, MemoryPage, MemoryListInput, MemoryEditInput } from "@aisdk-agent/example-cli/dist/memory-management.js";
import type { MemoryAction, MemoryActionPreview, MemoryHistoryInput, MemoryHistoryPage, MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { AssistantRunOptions } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { MemoryConsolidationRequest, MemoryConsolidationSourcePage } from "@aisdk-agent/example-cli/dist/memory-consolidation.js";
import type { MemoryTemporalQuery, MemoryTemporalView } from "@aisdk-agent/example-cli/dist/memory-store.js";
import type { MemoryReferenceSnapshot } from "@aisdk-agent/example-cli/dist/memory-query-rewrite.js";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import type { ContextDiagnostics, ContextResult } from "@aisdk-agent/example-cli/dist/context-diagnostics.js";
import type { RssAction, RssInbox, RssResult, RssView } from "@aisdk-agent/example-cli/dist/rss-subscriptions.js";
import type { WorkTask, WorkTaskInputs, WorkTaskResult, WorkTaskReadInput, WorkTaskArtifactInput, WorkTaskReadResult, WorkTaskDeliveryDraft, WorkTaskArtifactPreview } from "./work-tasks.js";
import type { WorkTaskContinuation } from "./work-tasks.js";
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
  entryMode?: "daily" | "test";
  /** Built-in support and current configuration only; not a permission grant. */
  modules?: { id: string; enabled: boolean }[];
  moduleOptions?: { webSearch: boolean; webFeed: boolean; autoConsolidate: boolean };
  configPath?: string | null;
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
    queryRewriteEnabled?: boolean;
  };
  workTasks: boolean;
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
  | { type: "identity-changed"; info: AppInfo }
  | { type: "state"; state: UiState }
  | { type: "output"; text: string }
  | { type: "home"; text: string; reset?: boolean }
  | { type: "approval"; approval: PendingApproval }
  | { type: "approval-cleared"; approvalId: string }
  | { type: "event"; phase: RunPhase; event: AgentEvent }
  | { type: "result"; phase: RunPhase; result: RunResult }
  | { type: "shell-progress"; phase: RunPhase; runId: string; progress: ShellProgressChunk }
  | { type: "memory-updated"; reason: "proposals" | "review" | "write" }
  | { type: "memory-references-changed" }
  | { type: "work-task-updated"; task: WorkTask }
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
  workTaskId?: string;
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
  listThreads(): Promise<ThreadSummary[]>;
  createThread(): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  chooseHistoryDirectory(): Promise<string | null>;
  discoverThreads(directory: string): Promise<ThreadSummary[]>;
  registerThread(input: { threadId: string; transcriptDirectory: string; confirmedWorkspace: true }): Promise<void>;
  enableMemory(): Promise<void>;
  consolidateMemory(input: MemoryConsolidationRequest): Promise<MemoryResult<{ runId: string }>>;
  listMemoryConsolidationSources(offset?: number): Promise<MemoryResult<MemoryConsolidationSourcePage>>;
  getRssSubscriptions(): Promise<RssResult<RssView>>;
  updateRssSubscriptions(input: RssAction): Promise<RssResult<RssView>>;
  getRssInbox(): Promise<RssResult<RssInbox>>;
  acknowledgeRssResult(id: string): Promise<RssResult<void>>;
  rssWorkerStatus(): Promise<RssWorkerResponse>;
  setRssWorkerEnabled(enabled: boolean): Promise<RssWorkerResponse>;
  info(): Promise<AppInfo>;
  snapshot(): Promise<UiSnapshot>;
  history(): Promise<UIMessage[]>;
  home(): Promise<CommandResponse>;
  run(text: string, options?: AssistantRunOptions): Promise<RunResponse>;
  cancel(): Promise<void>;
  confirm(input: ConfirmInput): Promise<ConfirmResponse>;
  command(line: string): Promise<CommandResponse>;
  listRuns(): Promise<ListRunsResponse>;
  getRun(runId: string): Promise<GetRunResponse>;
  getContextDiagnostics(): Promise<ContextResult<ContextDiagnostics>>;
  listMemories(input?: MemoryListInput): Promise<MemoryResult<MemoryPage>>;
  getMemory(id: string): Promise<MemoryResult<FormalMemory>>;
  updateMemory(input: MemoryEditInput): Promise<MemoryResult<FormalMemory>>;
  getMemoryHistory(input: MemoryHistoryInput): Promise<MemoryResult<MemoryHistoryPage>>;
  queryMemory(input: MemoryTemporalQuery & { id: string }): Promise<MemoryResult<MemoryTemporalView>>;
  previewMemoryAction(input: MemoryAction): Promise<MemoryResult<MemoryActionPreview>>;
  applyMemoryAction(input: MemoryAction): Promise<MemoryResult<FormalMemory | null>>;
  getMemoryMaintenance(): Promise<MemoryResult<MemoryMaintenance>>;
  getMemoryReferences(): Promise<(MemoryReferenceSnapshot & { runId: string }) | null>;
  listMemoryCandidates(input?: CandidateListInput): Promise<MemoryResult<CandidatePage>>;
  getMemoryCandidate(id: string): Promise<MemoryResult<CandidatePreview>>;
  resolveMemoryCandidate(input: CandidateResolveInput): Promise<MemoryResult<CandidateResolution>>;
  createWorkTask(input: WorkTaskInputs["createWorkTask"]): Promise<WorkTaskResult<WorkTask>>;
  listWorkTasks(): Promise<WorkTaskResult<WorkTask[]>>;
  getWorkTask(id: string): Promise<WorkTaskResult<WorkTask>>;
  getWorkTaskDeliveryDraft(input: WorkTaskReadInput): Promise<WorkTaskReadResult<WorkTaskDeliveryDraft>>;
  getWorkTaskContinuation(input: WorkTaskReadInput): Promise<WorkTaskResult<WorkTaskContinuation>>;
  getWorkTaskArtifact(input: WorkTaskArtifactInput): Promise<WorkTaskReadResult<WorkTaskArtifactPreview>>;
  runWorkTask(input: WorkTaskInputs["runWorkTask"]): Promise<RunResponse>;
  submitWorkTaskDelivery(input: WorkTaskInputs["submitWorkTaskDelivery"]): Promise<WorkTaskResult<WorkTask>>;
  recordHumanAcceptance(input: WorkTaskInputs["recordHumanAcceptance"]): Promise<WorkTaskResult<WorkTask>>;
  reconcileWorkTask(input: WorkTaskInputs["reconcileWorkTask"]): Promise<WorkTaskResult<WorkTask>>;
  cancelWorkTask(input: WorkTaskInputs["cancelWorkTask"]): Promise<WorkTaskResult<WorkTask>>;
  requestWorkTaskChanges(input: WorkTaskInputs["requestWorkTaskChanges"]): Promise<WorkTaskResult<WorkTask>>;
  hide(): Promise<void>;
  onMessage(listener: (message: MainToRenderer) => void): () => void;
}

export const IPC = {
  threadsList: "runloom:threadsList",
  threadCreate: "runloom:threadCreate",
  threadSelect: "runloom:threadSelect",
  historyDirectory: "runloom:historyDirectory",
  threadsDiscover: "runloom:threadsDiscover",
  threadRegister: "runloom:threadRegister",
  memoryEnable: "runloom:memoryEnable",
  memoryConsolidate: "runloom:memoryConsolidate",
  memoryConsolidationSources: "runloom:memoryConsolidationSources",
  rssGet: "runloom:rssGet",
  rssUpdate: "runloom:rssUpdate",
  rssInbox: "runloom:rssInbox",
  rssAck: "runloom:rssAck",
  rssWorkerStatus: "runloom:rssWorkerStatus",
  rssWorkerEnabled: "runloom:rssWorkerEnabled",
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
  memoriesList: "runloom:memoriesList",
  memoryGet: "runloom:memoryGet",
  memoryUpdate: "runloom:memoryUpdate",
  memoryHistory: "runloom:memoryHistory",
  memoryQuery: "runloom:memoryQuery",
  memoryPreview: "runloom:memoryPreview",
  memoryApply: "runloom:memoryApply",
  memoryMaintenance: "runloom:memoryMaintenance",
  memoryReferences: "runloom:memoryReferences",
  memoryCandidatesList: "runloom:memoryCandidatesList",
  memoryCandidateGet: "runloom:memoryCandidateGet",
  memoryCandidateResolve: "runloom:memoryCandidateResolve",
  createWorkTask: "runloom:createWorkTask",
  listWorkTasks: "runloom:listWorkTasks",
  getWorkTask: "runloom:getWorkTask",
  getWorkTaskDeliveryDraft: "runloom:getWorkTaskDeliveryDraft",
  getWorkTaskContinuation: "runloom:getWorkTaskContinuation",
  getWorkTaskArtifact: "runloom:getWorkTaskArtifact",
  runWorkTask: "runloom:runWorkTask",
  submitWorkTaskDelivery: "runloom:submitWorkTaskDelivery",
  recordHumanAcceptance: "runloom:recordHumanAcceptance",
  reconcileWorkTask: "runloom:reconcileWorkTask",
  cancelWorkTask: "runloom:cancelWorkTask",
  requestWorkTaskChanges: "runloom:requestWorkTaskChanges",
  hide: "runloom:hide",
  message: "runloom:message",
} as const;

export type RssWorkerResponse =
  | { ok: true; registered: boolean; running: boolean; rssEnabled: boolean }
  | { ok: false; message: string };

export interface ThreadSummary {
  threadId: string;
  transcriptDirectory: string;
  title: string;
  messageCount: number | null;
  error?: string;
}
