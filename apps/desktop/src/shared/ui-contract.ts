import type { HerdrTarget, AssistantSnapshot, PendingHerdrSelection, SelectHerdrTargetInput } from "@serika/assistant";
import type { MemoryLibraryAction, MemoryLibraryView, MemoryLibraryDocument } from "@serika/assistant";
import type { RecipeEntry, RecipeChange } from "@serika/assistant";
import type { UIMessage } from "ai";
import type { HistoryPage, HistoryPageInput } from "./history.js";
import type { BackupResult, RestoreResult, RestorePreview } from "./backup.js";
import type { ResidentServiceState } from "./resident-service.js";
import type { ConversationDraftScope, ConversationDraft, ConversationDraftState, DesktopSteerInput, DesktopSteerResponse, TaskDraftUpdate } from "./conversation-drafts.js";
import type { FormalMemory, MemoryPage, MemoryListInput, MemoryEditInput } from "@serika/assistant";
import type { MemoryAction, MemoryMaintenance } from "@serika/assistant";
import type { AssistantRunOptions, AssistantSteerRecord, AutomationResult } from "@serika/assistant";
export type { AssistantSteerRecord } from "@serika/assistant";
import type { AutomationDiagnostics, SkillRunInput, SkillResult } from "@serika/assistant";
import type { AutomationOverview, AutomationScheduleAction, ScheduleSkillInput, ScheduledSkillSaved } from "@serika/assistant";
import type { AssistantController } from "@serika/assistant";
import type { TaskListV3, TaskRecordV4 } from "@serika/assistant";
import type { MemoryReferenceSnapshot } from "@serika/assistant";
import type { AgentEvent, RunResult } from "@serika/core";
import type { HomeSnapshot, ReminderConfirmationFields } from "@serika/assistant";
import type { ExecutionRunRecord } from "@serika/assistant";
import type { ModelUsagePage } from "@serika/assistant";
export type { ExecutionRunRecord, ExecutionToolRecord } from "@serika/assistant";
import type { ContextDiagnostics, ContextResult } from "@serika/assistant";
import type { ContextBudgetConfig } from "@serika/assistant";
import type { RssAction, RssInbox, RssResult, RssView } from "@serika/assistant";
import type { WorkTask, WorkTaskInputs, WorkTaskResult, WorkTaskReadInput, WorkTaskArtifactInput, WorkTaskReadResult, WorkTaskDeliveryDraft, WorkTaskArtifactPreview } from "./work-tasks.js";
import type { WorkTaskContinuation } from "./work-tasks.js";
import type { MemoryResult } from "@serika/assistant";

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
  | { kind: "running"; runId: string | null; phase: RunPhase; background?: true; source?: "telegram" }
  | { kind: "compacting" }
  | { kind: "resuming" }
  | { kind: "command"; name: string };

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  preview: string;
  herdr?: NonNullable<NonNullable<AssistantSnapshot["pendingApproval"]>["herdr"]>;
  /** Present when this call may be allowed and remembered for the conversation. */
  remember?: { label: string };
  /** Present for a reminder card: the fields its preview text was built from. */
  reminder?: ReminderConfirmationFields;
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

export interface HerdrTargetInput { target: Pick<HerdrTarget, "session" | "paneId" | "terminalId"> | null; expected: HerdrTarget | null }
export type { HerdrSession, HerdrPane } from "@serika/assistant";
import type { HerdrSession, HerdrPane } from "@serika/assistant";

export interface ComputerConnectionView { enabled: boolean; executable: string; allowedBundleIds: string[]; revision: string }
export interface ComputerConnectionInput { enabled: boolean; executable: string; allowedBundleIds: string[]; expectedRevision: string }
export type ComputerConnectionCheck = { executable: string; permissions: "not_checked" } & ({ ok: true; apps: string[] } | { ok: false; error: { code: string; message: string } });

export type DirectoryAuthorization = Awaited<ReturnType<typeof import("@serika/assistant").resolveTuiModuleConfig>>["authorizedDirectories"][number];
export interface DirectorySettingsInput { directories: readonly DirectoryAuthorization[]; expectedDirectories: readonly DirectoryAuthorization[] }

export interface AppInfo {
  terminalTarget?: HerdrTarget;
  memoryLibrary?: true;
  attachments?: true;
  pomodoroControls?: true;
  autonomy?: { enabled: boolean; directory: string | null };
  recoveryWorkspace?: { originalWorkspace: string };
  runtimeRecovery?: { state: "failed"; message: string };
  /** Actual loaded main-process identity; optional for preview/older bridges. */
  build?: import("./build-identity.js").AppBuildInfo;
  entryMode?: "daily" | "test";
  /** Built-in support and current configuration only; not a permission grant. */
  modules?: { id: string; enabled: boolean }[];
  capabilities?: import("@serika/assistant").CapabilityStatus;
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
  projectDirectory: string | null;
  project?: import("@serika/assistant").Project | null;
  authorizedDirectories: readonly DirectoryAuthorization[];
  tuiMode: boolean;
  /** Registered idle commands, without the leading slash. */
  commands: string[];
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
  workTasks: boolean;
}

export interface UiSnapshot {
  state: UiState;
  /** Ordinary chat can preempt automatic consolidation; this grants no tool authority. */
  canSubmit: boolean;
  canSteer: boolean;
  steers: readonly AssistantSteerRecord[];
  pendingApproval: PendingApproval | null;
  pendingHerdrSelection?: PendingHerdrSelection | null;
  recentOutput: string;
  outputTruncated: boolean;
  toolActivity: readonly ToolActivity[];
  lastPrimaryResult: RunResult | null;
  resultTextTruncated: boolean;
  /** Main-process buffer. The controller snapshot does not include live Shell output. */
  shellProgress: readonly ShellProgressChunk[];
}

export type MainToRenderer =
  | { type: "task-result-available" }
  | { type: "identity-changed"; info: AppInfo; reason?: "modules" | "context" | "directories"; configurationError?: string }
  | { type: "state"; state: UiState }
  | { type: "output"; text: string }
  /** Structured Home; `null` clears the panel while a fresh snapshot is read. */
  | { type: "home"; snapshot: HomeSnapshot | null }
  /** A module notification (`ModuleContext.notify`); main shows it as a system notification. */
  | { type: "module-notification"; moduleId: string; message: string }
  | { type: "approval"; approval: PendingApproval }
  | { type: "approval-cleared"; approvalId: string }
  | { type: "approval-decision"; runId: string | null; input: ConfirmInput; approval: PendingApproval | null; accepted: boolean; source: "desktop-ipc"; decidedAt: string }
  | { type: "herdr-selection"; selection: PendingHerdrSelection }
  | { type: "herdr-selection-cleared"; selectionId: string }
  | { type: "herdr-selection-decision"; runId: string | null; input: SelectHerdrTargetInput; selection: PendingHerdrSelection | null; accepted: boolean; source: "desktop-ipc"; decidedAt: string }
  | { type: "steer"; steer: AssistantSteerRecord }
  | { type: "event"; phase: RunPhase; event: AgentEvent }
  | { type: "result"; phase: RunPhase; result: RunResult }
  | { type: "shell-progress"; phase: RunPhase; runId: string; progress: ShellProgressChunk }
  | { type: "memory-updated"; reason: "write" }
  | { type: "memory-references-changed" }
  | { type: "work-task-updated"; task: WorkTask }
  | { type: "error"; message: string };

/** `remember: true` is valid only with "allow" on an approval that offers `remember`. */
export type ConfirmInput = { approvalId: string; decision: "allow" | "deny"; remember?: true };

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

/** Receipt status. A denied call stays "failed"; the receipt's errorCode "TOOL_DENIED" marks it as denied. */
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

export interface RendererApi {
  pomodoro?(action: "status" | "start" | "cancel", minutes?: number): Promise<import("@serika/assistant").PomodoroResult>;
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
  enableMemory(): Promise<void>;
  selectProject?(directory: string | null): Promise<void>;
  setAuthorizedDirectories?(input: DirectorySettingsInput): Promise<void>;
  setModuleEnabled?(input: { id: string; enabled: boolean; expectedEnabled: boolean }): Promise<void>;
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
  selectHerdrTarget(input: SelectHerdrTargetInput): Promise<ConfirmResponse>;
  command(line: string): Promise<CommandResponse>;
  listRuns(): Promise<ListRunsResponse>;
  getRun(runId: string): Promise<GetRunResponse>;
  getContextDiagnostics(): Promise<ContextResult<ContextDiagnostics>>;
  /** Bounded metadata only; no Skill instructions, source paths or tool authority. */
  getAutomationDiagnostics(): Promise<AutomationDiagnostics>;
  getAutomationOverview(): Promise<AutomationResult<AutomationOverview>>;
  scheduleSkill(input: ScheduleSkillInput): Promise<AutomationResult<ScheduledSkillSaved>>;
  changeAutomationSchedule(input: AutomationScheduleAction): Promise<AutomationResult<null>>;
  getDreamingOverview(): ReturnType<AssistantController["dreaming"]["getOverview"]>;
  dream(): ReturnType<AssistantController["dreaming"]["dream"]>;
  changeLearnedSkill(input: Parameters<AssistantController["dreaming"]["changeLearnedSkill"]>[0]): ReturnType<AssistantController["dreaming"]["changeLearnedSkill"]>;
  getLearnedSkillReferences(): Promise<ReturnType<AssistantController["dreaming"]["getLearnedSkillReferences"]>>;
  getComputerConnection?(): Promise<ComputerConnectionView>;
  findComputerDrivers?(): Promise<string[]>;
  checkComputerConnection?(path: string): Promise<ComputerConnectionCheck>;
  saveComputerConnection?(input: ComputerConnectionInput): Promise<void>;
  listHerdrSessions?(): Promise<HerdrSession[]>;
  listHerdrPanes?(session: string): Promise<HerdrPane[]>;
  setHerdrTarget?(input: HerdrTargetInput): Promise<void>;
  setAutonomyEnabled?(input: { enabled: boolean; expectedEnabled: boolean }): Promise<void>;
  /** Success means a Run started, not that the Skill completed or its output is correct. */
  runSkill(input: SkillRunInput): Promise<SkillResult<{ runId: string }>>;
  getMemoryLibrary(): Promise<MemoryResult<MemoryLibraryView>>;
  readMemoryDocument(id: string): Promise<MemoryResult<MemoryLibraryDocument>>;
  changeMemoryLibrary(input: MemoryLibraryAction): Promise<MemoryResult<MemoryLibraryView>>;
  listMemories(input?: MemoryListInput): Promise<MemoryResult<MemoryPage>>;
  getMemory(id: string): Promise<MemoryResult<FormalMemory>>;
  updateMemory(input: MemoryEditInput): Promise<MemoryResult<FormalMemory>>;
  applyMemoryAction(input: MemoryAction): Promise<MemoryResult<FormalMemory | null>>;
  getMemoryMaintenance(): Promise<MemoryResult<MemoryMaintenance>>;
  getMemoryReferences(): Promise<(MemoryReferenceSnapshot & { runId: string }) | null>;
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

  draftLoad: "runloom:draftLoad",
  draftSave: "runloom:draftSave",
  taskDraftSave: "runloom:taskDraftSave",
  steerAcknowledge: "runloom:steerAcknowledge",
  steerRelease: "runloom:steerRelease",
  taskResultOpen: "runloom:taskResultOpen",
  rssWorkerStatus: "runloom:rssWorkerStatus",
  rssWorkerEnabled: "runloom:rssWorkerEnabled",
  notificationStatus: "runloom:notificationStatus",
  notificationTest: "runloom:notificationTest",
  notificationSettings: "runloom:notificationSettings",
  info: "runloom:info",
  backupData: "runloom:backup-data",
  restoreData: "runloom:restore-data",
  previewRestoreData: "runloom:preview-restore-data",
  activateRestoreData: "runloom:activate-restore-data",
  steer: "runloom:steer",
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

export type { PendingHerdrSelection, SelectHerdrTargetInput } from "@serika/assistant";
