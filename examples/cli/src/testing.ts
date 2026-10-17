// Test fixtures and internal constants for host tests. Not for production host code.

export { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
export { DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";
export { EXECUTION_RECORD_FILE, createExecutionRecordStore } from "./execution-record-store.js";
export type { CandidateDraft } from "./memory-candidates.js";
export { createMemoryConsolidation } from "./memory-consolidation.js";
export { createMemoryStore } from "./memory-store.js";
export { readDesktopFrontmost } from "./task-notification-presentation.js";
export { taskResultLink } from "./task-result-link.js";
export { RSS_DIGEST_TASK_PROMPT, TASK_FILE_NAME, TASK_WORKER_LOCK_FILE_NAME } from "./task-store.js";
export { createTaskDesktopNotifier } from "./task-worker-entry.js";
export { createTaskWorkerHealthWriter } from "./task-worker-health.js";
export { createWorkTaskStore } from "./work-task-store.js";
