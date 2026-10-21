// Browser-safe subset for renderer code: pure formatting/validation helpers with no Node.js imports.

export { defaultContextBudget, contextBudgetStatus, contextBudgetThresholds } from "./context-budget.js";
export { memoryConsolidationFailureText } from "./memory-failure.js";
export { MODEL_PURPOSE_LABELS, estimatedModelCost } from "./model-usage.js";
export { formatOnceWhen, reminderWhen } from "./reminder-speech.js";
export { taskNotificationCopy } from "./task-notification-copy.js";
export type { HomeItem, HomeSection, HomeSnapshot, HomeTask } from "./home.js";
