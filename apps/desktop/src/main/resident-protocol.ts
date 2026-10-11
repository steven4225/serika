import type { AppInfo, MainToRenderer, UiSnapshot } from "../shared/ui-contract.js";
import type { DesktopRuntime } from "./desktop-runtime.js";
import type { RuntimeBridge } from "./runtime-bridge.js";

export const RESIDENT_VERSION = 1;
export const MAX_RESIDENT_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_RESIDENT_PENDING = 32;

// Deliberately excludes shutdown, threadActivity, and arbitrary property access.
export const RESIDENT_HOST_METHODS = ["exportBackup", "listThreads", "discoverThreads", "registerThread", "createThread", "selectThread", "enableMemory", "setModuleEnabled", "setContextMode", "setDreamingEnabled", "getLifecycleStatus", "retryConnection", "telegramStatus", "setTelegramEnabled", "beginTelegramPairing", "confirmTelegramPairing", "reviewTelegramInput", "setTelegramTaskRoute", "retryTelegramDelivery", "resolveTelegramDelivery"] as const satisfies readonly (keyof DesktopRuntime)[];
export const RESIDENT_BRIDGE_METHODS = [
  "history", "historyPage", "home", "run", "steer", "cancel", "confirm", "command", "listRuns", "getRun",
  "getContextDiagnostics", "getAutomationDiagnostics", "getAutomationOverview", "scheduleSkill", "changeAutomationSchedule",
  "getDreamingOverview", "dream", "changeLearnedSkill", "getLearnedSkillReferences", "runSkill",
  "listMemories", "getMemory", "updateMemory", "getMemoryHistory", "queryMemory", "previewMemoryAction", "applyMemoryAction", "getMemoryMaintenance",
  "consolidateMemory", "listMemoryConsolidationSources", "getMemoryReferences",
  "getRssSubscriptions", "updateRssSubscriptions", "getRssInbox", "acknowledgeRssResult", "getTaskInbox", "getScheduledTask", "acknowledgeTaskResult",
  "listMemoryCandidates", "getMemoryCandidate", "resolveMemoryCandidate",
  "createWorkTask", "listWorkTasks", "getWorkTask", "getWorkTaskDeliveryDraft", "getWorkTaskContinuation", "getWorkTaskArtifact", "runWorkTask",
  "submitWorkTaskDelivery", "recordHumanAcceptance", "reconcileWorkTask", "cancelWorkTask", "requestWorkTaskChanges",
] as const satisfies readonly (keyof RuntimeBridge)[];

type AsyncMethod<T> = T extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
export type RemoteRuntimeBridge = { [K in typeof RESIDENT_BRIDGE_METHODS[number]]: AsyncMethod<RuntimeBridge[K]> } & { snapshot(): UiSnapshot };
export type RemoteRuntimeMethods = { [K in typeof RESIDENT_HOST_METHODS[number]]: AsyncMethod<DesktopRuntime[K]> };
export interface ResidentScope { userData: string; configPath: string; workspaceRoot: string }
export interface ResidentState { info: AppInfo; snapshot: UiSnapshot }
export type ResidentClientFrame =
  | { type: "hello"; version: number; token: string; scope: ResidentScope }
  | { type: "request"; id: string; target: "host" | "current" | "state"; method: string; args: unknown[] };
export type ResidentServerFrame =
  | { type: "response-chunk"; id: string; index: number; count: number; data: string }
  | { type: "ready"; state: ResidentState }
  | { type: "event"; message: MainToRenderer; state: ResidentState }
  | { type: "response"; id: string; ok: true; value: unknown; state: ResidentState }
  | { type: "response"; id: string; ok: false; error: string; state: ResidentState }
  | { type: "rejected"; error: string };
