import type { RendererApi } from "./ui-contract.js";

/**
 * Renderer methods forwarded unchanged over IPC. `current` targets the active
 * RuntimeBridge (local or resident), `host` the runtime owner. The number is how
 * many renderer arguments pass through; extra arguments are dropped.
 * Adding a plain method: implement it on the target, declare it on RendererApi, list it here.
 */
export const IPC_FORWARDS = {
  current: {
    snapshot: 0,
    getRssSubscriptions: 0,
    updateRssSubscriptions: 1,
    getRssInbox: 0,
    acknowledgeRssResult: 1,
    getTaskInbox: 0,
    getScheduledTask: 1,
    acknowledgeTaskResult: 1,
    getContextDiagnostics: 0,
    getAutomationDiagnostics: 0,
    getAutomationOverview: 0,
    scheduleSkill: 1,
    changeAutomationSchedule: 1,
    getDreamingOverview: 0,
    dream: 0,
    changeLearnedSkill: 1,
    getLearnedSkillReferences: 0,
    runSkill: 1,
    getMemoryLibrary: 0,
    readMemoryDocument: 1,
    changeMemoryLibrary: 1,
    listMemories: 1,
    getMemory: 1,
    listRecipes: 0,
    changeRecipe: 1,
    updateMemory: 1,
    applyMemoryAction: 1,
    getMemoryMaintenance: 0,
    getMemoryReferences: 0,
    history: 0,
    historyPage: 1,
    home: 0,
    run: 2,
    cancel: 0,
    confirm: 1,
    command: 1,
    listRuns: 0,
    getRun: 1,
    createWorkTask: 1,
    listWorkTasks: 0,
    getWorkTask: 1,
    getWorkTaskDeliveryDraft: 1,
    getWorkTaskContinuation: 1,
    getWorkTaskArtifact: 1,
    runWorkTask: 1,
    submitWorkTaskDelivery: 1,
    recordHumanAcceptance: 1,
    reconcileWorkTask: 1,
    cancelWorkTask: 1,
    requestWorkTaskChanges: 1,
  },
  host: {
    pomodoro: 2,
    residentStatus: 0,
    setResidentEnabled: 1,
    telegramStatus: 0,
    setTelegramAutonomyEnabled: 1,
    setTelegramEnabled: 1,
    beginTelegramPairing: 0,
    confirmTelegramPairing: 1,
    reviewTelegramInput: 1,
    setTelegramTaskRoute: 1,
    retryTelegramDelivery: 1,
    resolveTelegramDelivery: 1,
    retryConnection: 0,
    listThreads: 1,
    createThread: 1,
    selectThread: 1,
    enableMemory: 0,
    setModuleEnabled: 1,
    setAuthorizedDirectories: 1,
    selectProject: 1,
    setAutonomyEnabled: 1,
    getComputerConnection: 0,
    findComputerDrivers: 0,
    checkComputerConnection: 1,
    saveComputerConnection: 1,
    listHerdrSessions: 0,
    listHerdrPanes: 1,
    setHerdrTarget: 1,
  },
} as const satisfies Record<"current" | "host", Partial<Record<keyof RendererApi, 0 | 1 | 2>>>;

export type ForwardTarget = keyof typeof IPC_FORWARDS;
export type ForwardedMethod = { [T in ForwardTarget]: keyof typeof IPC_FORWARDS[T] }[ForwardTarget];

export function forwardChannel(target: ForwardTarget, method: string): string {
  return `runloom:${target}:${method}`;
}
