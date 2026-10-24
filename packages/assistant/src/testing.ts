import { DirectoryAccess } from "./directory-access.js";
import { join } from "node:path";
// Test fixtures and internal constants for host tests. Not for production host code.

export { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
export { DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";
export { EXECUTION_RECORD_FILE, createExecutionRecordStore } from "./execution-record-store.js";
export { createMemoryStore } from "./memory-v6-store.js";
export { readDesktopFrontmost } from "./task-notification-presentation.js";
export { taskResultLink } from "./task-result-link.js";
export { RSS_DIGEST_TASK_PROMPT, TASK_WORKER_LOCK_FILE_NAME } from "./task-store.js";
export { createTaskDesktopNotifier } from "./task-worker-entry.js";
export { createTaskWorkerHealthWriter } from "./task-worker-health.js";
export { createWorkTaskStore } from "./work-task-store.js";
export { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";
export { createCheckpointStore } from "./checkpoint-store.js";
export type { CheckpointDraft } from "./checkpoint-store.js";
export { createModuleHost } from "./module-host.js";
export { createCheckpointModule } from "./modules/checkpoint-module.js";
export { createReadFileModule } from "./modules/read-file-module.js";
export { createTaskModule } from "./modules/task-module.js";
export { reminderConfirmation } from "./reminder-speech.js";
export type { ReadFileResult } from "./read-file.js";
export { createBuiltinSkill } from "./skill-catalog.js";
export { createToolConfirmation } from "./tool-confirmation.js";
export type { RunAuthorization } from "./tool-confirmation.js";
export { createWriteFileTool } from "./write-file.js";

export function createTestDirectoryAccess(path: string): DirectoryAccess {
  return new DirectoryAccess({ load: async () => [{ path, access: "readwrite" }], protectedPaths: [] });
}

import { createModuleHost as createHostForFacts, type ToolPermissionFacts } from "./module-host.js";
import { createComputerModule as computerForFacts } from "./modules/computer-module.js";
import { createMemoryStore as memoryStoreForFacts } from "./memory-v6-store.js";
import { createMemoryModule as memoryForFacts } from "./modules/memory-module.js";
import { createCheckpointModule as checkpointForFacts } from "./modules/checkpoint-module.js";
import { createTodoistModule as todoistForFacts } from "./modules/todoist-module.js";
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
 * The task module declares only confirmation cards that read its store, so it is left out.
 */
export function builtinToolPermissions(options: { shell?: "host" | "docker" } = {}): ReadonlyMap<string, ToolPermissionFacts> {
  const shell = options.shell === "docker"
    ? { sandbox: { backend: "docker" as const, image: "img", readablePaths: [], writablePaths: [] } }
    : {};
  const memoryStore = memoryStoreForFacts(join(".", ".runloom/memory.json"));
  const getMessages = async () => [];
  const host = createHostForFacts([
    pomodoroForFacts(),
    readFileForFacts(createTestDirectoryAccess(".")),
    shellForFacts(".", shell),
    recipesForFacts({ store: new RecipeStoreForFacts(".", join(".", ".runloom/recipes.json")), records: recordsForFacts("."), threadId: "facts",
      currentRun: () => undefined, shell }),
    webForFacts({ searchEnabled: true, feedEnabled: true }),
    computerForFacts({ enabled: true, executable: "/facts/cua-driver", allowedBundleIds: ["com.example.App"] }),
    memoryForFacts(memoryStore, getMessages, { threadId: "facts", workspaceRoot: "." }),
    checkpointForFacts(checkpointStoreForFacts(join(".", ".runloom/checkpoint.json")), { threadId: "facts", workspaceRoot: "." }),
    todoistForFacts({ apiToken: "facts", timeZone: "UTC" }),
  ], { notify() {} });
  host.dispose();
  return host.toolPermissions;
}
