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
export { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";
export { CHECKPOINT_FILE_NAME, createCheckpointStore } from "./checkpoint-store.js";
export type { CheckpointDraft } from "./checkpoint-store.js";
export { createModuleHost } from "./module-host.js";
export { createCheckpointModule } from "./modules/checkpoint-module.js";
export { createReadFileModule } from "./modules/read-file-module.js";
export type { ReadFileResult } from "./read-file.js";
export { createBuiltinSkill } from "./skill-catalog.js";
export { createToolConfirmation } from "./tool-confirmation.js";
export type { RunAuthorization } from "./tool-confirmation.js";
export { createWriteFileTool } from "./write-file.js";

import { createModuleHost as createHostForFacts, type ToolPermissionFacts } from "./module-host.js";
import { createComputerModule as computerForFacts } from "./modules/computer-module.js";
import { createMemoryConsolidation as consolidationForFacts } from "./memory-consolidation.js";
import { createMemoryStore as memoryStoreForFacts } from "./memory-store.js";
import { createMemoryModule as memoryForFacts } from "./modules/memory-module.js";
import { createCheckpointModule as checkpointForFacts } from "./modules/checkpoint-module.js";
import { createCheckpointStore as checkpointStoreForFacts } from "./checkpoint-store.js";
import { createPomodoroModule as pomodoroForFacts } from "./modules/pomodoro-module.js";
import { createReadFileModule as readFileForFacts } from "./modules/read-file-module.js";
import { createRecipeModule as recipesForFacts } from "./modules/recipe-module.js";
import { createShellModule as shellForFacts } from "./modules/shell-module.js";
import { createWebModule as webForFacts } from "./modules/web-module.js";
import { RecipeStore as RecipeStoreForFacts } from "./recipe-store.js";
import { createExecutionRecordStore as recordsForFacts } from "./execution-record-store.js";

/**
 * Permission facts as the migrated built-in modules declare them, for tests
 * that drive the permission rules directly instead of assembling an app.
 * `shell: "docker"` declares the Docker-sandboxed executor instead of the host.
 */
export function builtinToolPermissions(options: { shell?: "host" | "docker" } = {}): ReadonlyMap<string, ToolPermissionFacts> {
  const shell = options.shell === "docker"
    ? { sandbox: { backend: "docker" as const, image: "img", readablePaths: [], writablePaths: [] } }
    : {};
  const memoryStore = memoryStoreForFacts(".");
  const getMessages = async () => [];
  const host = createHostForFacts([
    pomodoroForFacts(),
    readFileForFacts("."),
    shellForFacts(".", shell),
    recipesForFacts({ store: new RecipeStoreForFacts("."), records: recordsForFacts("."), threadId: "facts",
      currentRun: () => undefined, shell }),
    webForFacts({ searchEnabled: true, feedEnabled: true }),
    computerForFacts({ enabled: true, executable: "/facts/cua-driver", allowedBundleIds: ["com.example.App"] }),
    memoryForFacts(memoryStore, getMessages, { threadId: "facts", workspaceRoot: ".",
      consolidation: consolidationForFacts({ store: memoryStore, getMessages, threadId: "facts" }) }),
    checkpointForFacts(checkpointStoreForFacts("."), { threadId: "facts", workspaceRoot: "." }),
  ], { notify() {} });
  host.dispose();
  return host.toolPermissions;
}
