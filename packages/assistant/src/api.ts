// Public API for hosts (desktop, future apps). Hosts must import from here, never from dist/* files.
// Keep this list explicit: every addition is a new public contract.

export { createRuntimeApp } from "./app.js";
export type { ModuleNotification, RuntimeApp, TaskAutomationHost } from "./app.js";
export { formatHome, readHomeSnapshot } from "./home.js";
export type { HomeItem, HomeSection, HomeSnapshot, HomeTask } from "./home.js";
export { createAssistantController } from "./assistant-controller.js";
export type { AssistantController, AssistantEvent, AssistantRunOptions, AssistantRunRecords, AssistantSnapshot, AssistantState, AssistantSteerResponse, AutomationResult } from "./assistant-controller.js";
export type { AssistantMemoryControls } from "./controller-memory.js";
export type { AssistantWorkTaskControls } from "./controller-work-tasks.js";
export type { AssistantAutomationControls } from "./controller-automation.js";
export type { AssistantDreamingControls } from "./controller-dreaming.js";
export type { AssistantRssControls } from "./controller-rss.js";
export type { AssistantRecipeControls } from "./controller-recipes.js";
export type { AutomationDiagnostics, SkillResult, SkillRunInput, SkillSummary } from "./automation-execution.js";
export type { AutomationOverview, AutomationScheduleAction, ScheduleSkillInput, ScheduledSkillSaved } from "./automation-scheduling.js";
export { formatCapabilityStatus } from "./capability-status.js";
export type { CapabilityStatus } from "./capability-status.js";
export { validateChatAttachments } from "./chat-attachments.js";
export type { ChatAttachment } from "./chat-attachments.js";
export { CHECKPOINT_FILE_MAX_BYTES, validateCheckpointDocument } from "./checkpoint-store.js";
export { defaultContextBudget, contextBudgetStatus, contextBudgetThresholds, validateRequestedContextBudgetConfig } from "./context-budget.js";
export type { ContextBudgetConfig, ModelCapacityEvidence } from "./context-budget.js";
export type { ContextDiagnostics, ContextResult } from "./context-diagnostics.js";
export { createDemoModel } from "./demo-model.js";
export { validateDreamingDocument } from "./dreaming.js";
export type { DreamingChangeInput } from "./dreaming.js";
export { EXECUTION_RECORD_MAX_TOOLS, ExecutionRecordStore, validateExecutionRunRecord } from "./execution-record-store.js";
export type { AssistantSteerRecord, ExecutionRunRecord } from "./execution-record-store.js";
export { acquireFlock, tryAcquireFlock } from "./flock.js";
export type { FlockHandle } from "./flock.js";
export type { MemoryAction, MemoryMaintenance } from "./memory-controls.js";
export type { MemoryFactReceipt } from "./memory-factual-receipts.js";
export { memoryConsolidationFailureText } from "./memory-failure.js";
export type { MemoryLibraryAction, MemoryLibraryDocument, MemoryLibraryView } from "./memory-library.js";
export type { FormalMemory, MemoryEditInput, MemoryListInput, MemoryPage } from "./memory-management.js";
export type { MemoryReferenceSnapshot } from "./memory-snapshot.js";
export { MEMORY_FILE_MAX_BYTES } from "./memory-types.js";
export { configureCliModel, inspectCliModelConfig } from "./model-config.js";
export { MODEL_PURPOSE_LABELS, estimatedModelCost } from "./model-usage.js";
export type { ModelCallRecord, ModelPurpose, ModelUsagePage } from "./model-usage.js";
export { createPomodoroService } from "./modules/pomodoro-module.js";
export type { PomodoroResult, PomodoroService, PomodoroStatus } from "./modules/pomodoro-module.js";
export type { SavedTaskArrangement } from "./modules/task-module.js";
export type { RecipeChange, RecipeEntry } from "./recipe-store.js";
export type { Recurrence } from "./recurrence.js";
export { formatOnceWhen, readRecurrence, reminderSubject, reminderWhen } from "./reminder-speech.js";
export type { ReminderConfirmationFields, ReminderSpeechClock } from "./reminder-speech.js";
export { validateRssDocument } from "./rss-subscriptions.js";
export type { RssAction, RssInbox, RssResult, RssView } from "./rss-subscriptions.js";
export { formatLocalTaskTime, MODEL_TIME_ZONE } from "./task-instructions.js";
export { taskNotificationCopy } from "./task-notification-copy.js";
export { writeDesktopFrontmost } from "./task-notification-presentation.js";
export { parseTaskResultLink, taskResultWorkspaceKey } from "./task-result-link.js";
export { createTaskStore, restoreTaskDocument, validateTaskDocument } from "./task-store.js";
export type { TaskArrangement, TaskListInput, TaskListV3, TaskNotification, TaskRecordV4 } from "./task-store.js";
export { readTaskWorkerHealth } from "./task-worker-health.js";
export { assertWorkerPathSafe, createTaskWorkerService, writeWorkerFileAtomic } from "./task-worker-service.js";
export type { ServiceCommandRunner } from "./task-worker-service.js";
export { BUILTIN_MODULE_IDS, resolveTuiModuleConfig } from "./tui-module-config.js";
export type { BuiltinModuleId, TelegramAutonomyGrant } from "./tui-module-config.js";
export { WORK_TASK_FILE_MAX_BYTES, validateWorkTaskDocument } from "./work-task-store.js";
export type { WorkTaskResult } from "./work-task-store.js";
export type { ExecutionToolRecord } from "./execution-record-store.js";
export type { WorkTask, WorkTaskStatus, WorkTaskObservedOutcome } from "./work-task-store.js";
export type { WorkTaskContinuation } from "./work-task-continuation.js";
export type { WorkTaskReadInput, WorkTaskArtifactInput, WorkTaskReadResult, WorkTaskDeliveryDraft, WorkTaskArtifactPreview } from "./work-task-artifacts.js";
export { assertAssemblyCombination } from "./assembly.js";
export type { AssistantAssembly } from "./assembly.js";
export { checkAssistantStartup, readinessExitCode } from "./startup-check.js";
export type { ReadinessCheck, ReadinessSnapshot, StartupAssembly } from "./startup-check.js";
export type { TuiCommand, TuiResume } from "./host-commands.js";
export type { ToolConfirmation } from "./tool-confirmation.js";
export { AUTO_CONSOLIDATION_AGENT_ID, isAutoConsolidationRequest } from "./consolidation.js";
export { automaticConsolidationMessage, waitForConsolidationHandoff } from "./consolidation-lifecycle.js";
export { userMessageClock } from "./memory-observation-policy.js";

export { assertExperimentalDataPaths } from "./experimental-data.js";

export { validateV6MemoryDocument } from "./memory-v6-store.js";

export { excludedRunView } from "./transcript-access.js";

export type { MemoryResult, MemoryKind, MemorySource } from "./memory-types.js";

export { assistantDataPaths } from "./data-paths.js";
export type { AssistantDataPaths } from "./data-paths.js";

export { resolveApplicationHome } from "./application-home.js";

export { HerdrClient, herdrTargetSchema, type HerdrTarget, type HerdrPane, type HerdrSession } from "./herdr.js";
export { ComputerDriverUnavailableError } from "./tui-module-config.js";
export { computerConfigSchema, createDriverCall, discoverComputerApps } from "./modules/computer-module.js";

export { ConfigUpgradeRequiredError } from "./tui-module-config.js";
