export interface ComputerConnectionCheck {
  checkedAt: string;
  ok: boolean;
  errorCode?: string;
}
export interface ComputerConnectionView {
  executable: string | null;
  allowedBundleIds: string[];
  enabled: boolean;
  lastCheck: ComputerConnectionCheck | null;
}
export interface ComputerDriverSelection { token: string; executable: string }
export interface ComputerConnectionInput { token: string; allowedBundleIds: string[] }

import type { HerdrBinding } from "@aisdk-agent/example-cli/dist/local-terminal.js";
export interface HerdrTargetInput { target: { session: string; paneId: string; terminalId: string } | null; expected: HerdrBinding | null }
import type { MemoryLibraryAction, MemoryLibraryView, MemoryLibraryDocument } from "@aisdk-agent/example-cli/dist/memory-library.js";
import type { MemoryImportEntry, MemoryImportConfirm, MemoryImportPreview, MemoryImportReceipt } from "@aisdk-agent/example-cli/dist/memory-import.js";
import type { RecipeEntry, RecipeChange } from "@aisdk-agent/example-cli/dist/recipe-store.js";
import type { UIMessage } from "ai";
import type { HistoryPage, HistoryPageInput } from "./history.js";
import type { BackupResult, RestoreResult, RestorePreview } from "./backup.js";
import type { ResidentServiceState } from "./resident-service.js";
import type { ConversationDraftScope, ConversationDraft, ConversationDraftState, DesktopSteerInput, DesktopSteerResponse, TaskDraftUpdate } from "./conversation-drafts.js";
import type { FormalMemory, MemoryPage, MemoryListInput, MemoryEditInput } from "@aisdk-agent/example-cli/dist/memory-management.js";
import type { MemoryAction, MemoryActionPreview, MemoryHistoryInput, MemoryHistoryPage, MemoryMaintenance } from "@aisdk-agent/example-cli/dist/memory-controls.js";
import type { AssistantRunOptions, AssistantSteerRecord, AutomationResult } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
export type { AssistantSteerRecord } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { AutomationDiagnostics, SkillRunInput, SkillResult } from "@aisdk-agent/example-cli/dist/automation-execution.js";
import type { AutomationOverview, AutomationScheduleAction, ScheduleSkillInput, ScheduledSkillSaved } from "@aisdk-agent/example-cli/dist/automation-scheduling.js";
import type { AssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import type { TaskListV3, TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import type { MemoryConsolidationRequest, MemoryConsolidationSourcePage } from "@aisdk-agent/example-cli/dist/memory-consolidation.js";
import type { MemoryTemporalQuery, MemoryTemporalView } from "@aisdk-agent/example-cli/dist/memory-store.js";
import type { MemoryReferenceSnapshot } from "@aisdk-agent/example-cli/dist/memory-query-rewrite.js";
import type { AgentEvent, RunResult } from "@aisdk-agent/core";
import type { ExecutionRunRecord } from "@aisdk-agent/example-cli/dist/execution-record-store.js";
import type { ModelUsagePage } from "@aisdk-agent/example-cli/dist/model-usage.js";
export type { ExecutionRunRecord, ExecutionToolRecord } from "@aisdk-agent/example-cli/dist/execution-record-store.js";
import type { ContextDiagnostics, ContextResult } from "@aisdk-agent/example-cli/dist/context-diagnostics.js";
import type { ContextBudgetConfig } from "@aisdk-agent/example-cli/dist/context-budget.js";
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

export type RunPhase = "primary" | "consolidation" | "skill";

export type UiState =
  | { kind: "idle" }
  | { kind: "running"; runId: string | null; phase: RunPhase; background?: true; source?: "telegram" | "qq" }
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
  errorCode?: string;
  summary: string;
  truncated: boolean;
}

export interface AppInfo {
  memoryLibrary?: true;
  attachments?: true;
  pomodoroControls?: true;
  herdrBinding?: HerdrBinding;
  autonomy?: { enabled: boolean; workspaceRoot: string | null };
  recoveryWorkspace?: { originalWorkspace: string };
  runtimeRecovery?: { state: "failed"; message: string };
  /** Actual loaded main-process identity; optional for preview/older bridges. */
  build?: import("./build-identity.js").AppBuildInfo;
  entryMode?: "daily" | "test";
  /** Built-in support and current configuration only; not a permission grant. */
  modules?: { id: string; enabled: boolean }[];
  capabilities?: import("@aisdk-agent/example-cli/dist/capability-status.js").CapabilityStatus;
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
    writePolicy?: "review" | "automatic";
    queryRewriteEnabled?: boolean;
  };
  workTasks: boolean;
}

export interface UiSnapshot {
  state: UiState;
  /** Ordinary chat can preempt automatic consolidation; this grants no tool authority. */
  canSubmit: boolean;
  canSteer: boolean;
  steers: readonly AssistantSteerRecord[];
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
  | { type: "task-result-available" }
  | { type: "identity-changed"; info: AppInfo; reason?: "modules" | "context" | "terminal" | "computer"; configurationError?: string }
  | { type: "state"; state: UiState }
  | { type: "output"; text: string }
  | { type: "home"; text: string; reset?: boolean }
  | { type: "approval"; approval: PendingApproval }
  | { type: "approval-cleared"; approvalId: string }
  | { type: "steer"; steer: AssistantSteerRecord }
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

export type ListRunsResponse =
  | { ok: true; runs: ExecutionRunRecord[]; modelUsage?: ModelUsagePage }
  | { ok: false; reason: "unavailable"; message: string };

export type GetRunResponse =
  | { ok: true; run: ExecutionRunRecord | null }
  | { ok: false; reason: "unavailable"; message: string };

export interface ContextModeInput { mode: "daily" | "long-task"; expectedBudget: ContextBudgetConfig }

export interface RendererApi {
  pomodoro?(action: "status" | "start" | "cancel", minutes?: number): Promise<import("@aisdk-agent/example-cli/dist/modules/pomodoro-module.js").PomodoroResult>;
  previewMemoryImport(entries: MemoryImportEntry[]): Promise<MemoryResult<MemoryImportPreview>>;
  confirmMemoryImport(input: MemoryImportConfirm): Promise<MemoryResult<MemoryImportReceipt>>;
  getMemoryImportReceipt(operationId: string): Promise<MemoryResult<MemoryImportReceipt | null>>;
  listRecipes(): Promise<MemoryResult<RecipeEntry[]>>;
  changeRecipe(input: RecipeChange): Promise<MemoryResult<RecipeEntry>>;

  telegramStatus?(): Promise<import("./telegram.js").TelegramStatus>;
  setTelegramAutonomyEnabled?(input: import("./telegram.js").TelegramAutonomySettingInput): Promise<import("./telegram.js").TelegramStatus>;
  setTelegramEnabled?(enabled: boolean): Promise<import("./telegram.js").TelegramStatus>;
  beginTelegramPairing?(): Promise<import("./telegram.js").TelegramStatus>;
  confirmTelegramPairing?(code: string): Promise<import("./telegram.js").TelegramStatus>;
  reviewTelegramInput?(input: { key: string; note: string }): Promise<import("./telegram.js").TelegramStatus>;
  setTelegramTaskRoute?(input: { id: string; kind: "once" | "recurring"; enabled: boolean }): Promise<import("./telegram.js").TelegramStatus>;
  retryTelegramDelivery?(key: string): Promise<import("./telegram.js").TelegramStatus>;
  resolveTelegramDelivery?(input: { key: string; action: "cancel" | "review"; note?: string }): Promise<import("./telegram.js").TelegramStatus>;
  residentStatus?(): Promise<ResidentServiceState>;
  setResidentEnabled?(enabled: boolean): Promise<ResidentServiceState>;
  loadConversationDraft(scope: ConversationDraftScope): Promise<ConversationDraftState>;
  saveConversationDraft(scope: ConversationDraftScope, draft: ConversationDraft): Promise<void>;
  saveTaskDraft(scope: ConversationDraftScope, update: TaskDraftUpdate): Promise<void>;
  acknowledgeSteer(scope: ConversationDraftScope, id: string): Promise<AssistantSteerRecord | null>;
  releaseSteer(scope: ConversationDraftScope, id: string): Promise<boolean>;
  retryConnection(): Promise<void>;
  listThreads(query?: string): Promise<ThreadSummary[]>;
  createThread(options?: { preserveDraft: boolean; taskDraft?: string; chatDraft?: string }): Promise<void>;
  selectThread(threadId: string): Promise<void>;
  chooseHistoryDirectory(): Promise<string | null>;
  discoverThreads(directory: string): Promise<ThreadSummary[]>;
  registerThread(input: { threadId: string; transcriptDirectory: string; confirmedWorkspace: true }): Promise<void>;
  enableMemory(): Promise<void>;
  getComputerConnection?(): Promise<ComputerConnectionView>;
  chooseComputerDriver?(): Promise<ComputerDriverSelection | null>;
  discoverComputerApps?(token: string): Promise<string[]>;
  saveComputerConnection?(input: ComputerConnectionInput): Promise<void>;
  checkComputerConnection?(): Promise<ComputerConnectionView>;
  setModuleEnabled?(input: { id: string; enabled: boolean; expectedEnabled: boolean }): Promise<void>;
  consolidateMemory(input: MemoryConsolidationRequest): Promise<MemoryResult<{ runId: string }>>;
  listMemoryConsolidationSources(offset?: number): Promise<MemoryResult<MemoryConsolidationSourcePage>>;
  getRssSubscriptions(): Promise<RssResult<RssView>>;
  updateRssSubscriptions(input: RssAction): Promise<RssResult<RssView>>;
  getRssInbox(): Promise<RssResult<RssInbox>>;
  acknowledgeRssResult(id: string): Promise<RssResult<void>>;
  getTaskInbox(): Promise<AutomationResult<TaskListV3>>;
  /** Consumes a process-local click route, not the task or its unread state. */
  takeTaskResultOpen?(): Promise<{ taskId: string; workspaceRoot: string } | null>;
  getScheduledTask(id: string): Promise<AutomationResult<TaskRecordV4>>;
  acknowledgeTaskResult(id: string): Promise<AutomationResult<TaskRecordV4>>;
  rssWorkerStatus(): Promise<RssWorkerResponse>;
  setRssWorkerEnabled(enabled: boolean): Promise<RssWorkerResponse>;
  notificationStatus(): Promise<NotificationReadinessStatus>;
  testNotification(): Promise<NotificationTestResult>;
  openNotificationSettings?(): Promise<{ ok: boolean; message: string }>;
  info(): Promise<AppInfo>;
  snapshot(): Promise<UiSnapshot>;
  history(): Promise<UIMessage[]>;
  historyPage(input?: HistoryPageInput): Promise<HistoryPage>;
  backupData(): Promise<BackupResult | null>;
  previewRestoreData?(): Promise<RestorePreview | null>;
  restoreData(previewId?: string): Promise<RestoreResult | null>;
  activateRestoreData?(previewId: string | null): Promise<void>;
  home(): Promise<CommandResponse>;
  run(text: string, options?: AssistantRunOptions): Promise<RunResponse>;
  steer(input: DesktopSteerInput): Promise<DesktopSteerResponse>;
  cancel(): Promise<void>;
  confirm(input: ConfirmInput): Promise<ConfirmResponse>;
  command(line: string): Promise<CommandResponse>;
  listRuns(): Promise<ListRunsResponse>;
  getRun(runId: string): Promise<GetRunResponse>;
  getContextDiagnostics(): Promise<ContextResult<ContextDiagnostics>>;
  setContextMode?(input: ContextModeInput): Promise<void>;
  /** Bounded metadata only; no Skill instructions, source paths or tool authority. */
  getAutomationDiagnostics(): Promise<AutomationDiagnostics>;
  getAutomationOverview(): Promise<AutomationResult<AutomationOverview>>;
  scheduleSkill(input: ScheduleSkillInput): Promise<AutomationResult<ScheduledSkillSaved>>;
  changeAutomationSchedule(input: AutomationScheduleAction): Promise<AutomationResult<null>>;
  getDreamingOverview(): ReturnType<AssistantController["getDreamingOverview"]>;
  dream(): ReturnType<AssistantController["dream"]>;
  changeLearnedSkill(input: Parameters<AssistantController["changeLearnedSkill"]>[0]): ReturnType<AssistantController["changeLearnedSkill"]>;
  getLearnedSkillReferences(): Promise<ReturnType<AssistantController["getLearnedSkillReferences"]>>;
  listHerdrSessions?(): Promise<{ name: string; running: boolean }[]>;
  listHerdrPanes?(session: string): Promise<{ paneId: string; terminalId: string; title: string }[]>;
  setHerdrTarget?(input: HerdrTargetInput): Promise<void>;
  setAutonomyEnabled?(input: { enabled: boolean; expectedEnabled: boolean }): Promise<void>;
  setDreamingEnabled(input: { enabled: boolean; expectedEnabled: boolean }): Promise<void>;
  /** Success means a Run started, not that the Skill completed or its output is correct. */
  runSkill(input: SkillRunInput): Promise<SkillResult<{ runId: string }>>;
  getMemoryLibrary(): Promise<MemoryResult<MemoryLibraryView>>;
  readMemoryDocument(id: string): Promise<MemoryResult<MemoryLibraryDocument>>;
  changeMemoryLibrary(input: MemoryLibraryAction): Promise<MemoryResult<MemoryLibraryView>>;
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
  pomodoro: "runloom:pomodoro",
  previewMemoryImport: "runloom:previewMemoryImport",
  confirmMemoryImport: "runloom:confirmMemoryImport",
  getMemoryImportReceipt: "runloom:getMemoryImportReceipt",
  listRecipes: "runloom:listRecipes",
  changeRecipe: "runloom:changeRecipe",

  telegramStatus: "runloom:telegramStatus",
  telegramAutonomyEnabled: "runloom:telegramAutonomyEnabled",
  telegramEnabled: "runloom:telegramEnabled",
  telegramPairing: "runloom:telegramPairing",
  telegramBind: "runloom:telegramBind",
  telegramReview: "runloom:telegramReview",
  telegramTaskRoute: "runloom:telegramTaskRoute",
  telegramRetryDelivery: "runloom:telegramRetryDelivery",
  telegramResolveDelivery: "runloom:telegramResolveDelivery",
  residentStatus: "runloom:residentStatus",
  residentEnabled: "runloom:residentEnabled",
  draftLoad: "runloom:draftLoad",
  draftSave: "runloom:draftSave",
  taskDraftSave: "runloom:taskDraftSave",
  steerAcknowledge: "runloom:steerAcknowledge",
  steerRelease: "runloom:steerRelease",
  retryConnection: "runloom:retryConnection",
  taskResultOpen: "runloom:taskResultOpen",
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
  taskInbox: "runloom:taskInbox",
  scheduledTask: "runloom:scheduledTask",
  taskResultAck: "runloom:taskResultAck",
  rssWorkerStatus: "runloom:rssWorkerStatus",
  rssWorkerEnabled: "runloom:rssWorkerEnabled",
  notificationStatus: "runloom:notificationStatus",
  notificationTest: "runloom:notificationTest",
  notificationSettings: "runloom:notificationSettings",
  info: "runloom:info",
  computerView: "runloom:computerView",
  computerDriver: "runloom:computerDriver",
  computerApps: "runloom:computerApps",
  computerSave: "runloom:computerSave",
  computerCheck: "runloom:computerCheck",
  moduleEnabled: "runloom:moduleEnabled",
  snapshot: "runloom:snapshot",
  history: "runloom:history",
  historyPage: "runloom:history-page",
  backupData: "runloom:backup-data",
  restoreData: "runloom:restore-data",
  previewRestoreData: "runloom:preview-restore-data",
  activateRestoreData: "runloom:activate-restore-data",
  home: "runloom:home",
  run: "runloom:run",
  steer: "runloom:steer",
  cancel: "runloom:cancel",
  confirm: "runloom:confirm",
  command: "runloom:command",
  listRuns: "runloom:listRuns",
  getRun: "runloom:getRun",
  contextDiagnostics: "runloom:contextDiagnostics",
  contextMode: "runloom:contextMode",
  automationDiagnostics: "runloom:automationDiagnostics",
  automationOverview: "runloom:automationOverview",
  scheduleSkill: "runloom:scheduleSkill",
  automationScheduleChange: "runloom:automationScheduleChange",
  dreamingOverview: "runloom:dreamingOverview",
  dream: "runloom:dream",
  learnedSkillChange: "runloom:learnedSkillChange",
  learnedSkillReferences: "runloom:learnedSkillReferences",
  herdrSessions: "runloom:herdrSessions",
  herdrPanes: "runloom:herdrPanes",
  herdrTarget: "runloom:herdrTarget",
  autonomyEnabled: "runloom:autonomyEnabled",
  dreamingEnabled: "runloom:dreamingEnabled",
  runSkill: "runloom:runSkill",
  memoryLibraryGet: "memory-library:get",
  memoryDocumentRead: "memory-library:read",
  memoryLibraryChange: "memory-library:change",
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
  | { ok: true; registered: boolean; running: boolean; rssEnabled: boolean; notifyEnabled?: boolean; notificationRoutingEnabled?: boolean; setupReady?: boolean; configurationMessage?: string; processStartedAt?: string | null }
  | { ok: false; message: string };

export interface NotificationReadinessStatus {
  helperConfigured: boolean;
  authorization: "not_requested" | "authorized" | "denied" | "unknown";
  message: string;
}
export type NotificationTestResult =
  | { ok: true; submitted: true; message: string }
  | { ok: false; message: string };

export interface ThreadSummary {
  threadId: string;
  transcriptDirectory: string;
  title: string;
  messageCount: number | null;
  /** Transcript file modification time, not inferred conversation activity. */
  savedAt?: string;
  error?: string;
  preview?: string;
  /** Search is performed in the main process; full message bodies never enter the list IPC. */
  matchesQuery?: boolean;
  /** True only after messages, tasks and execution receipts were all checked. */
  emptyVerified?: boolean;
  taskCount?: number;
  runCount?: number;
  activityAt?: string;
}
