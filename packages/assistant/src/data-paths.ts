import { join, resolve } from "node:path";

export function assistantDataPaths(directory: string) {
  const root = resolve(directory);
  return {
    memory: join(root, "memory.json"),
    memoryFailures: join(root, "memory-extraction-failures.jsonl"),
    checkpoint: join(root, "checkpoint.json"),
    tasks: join(root, "tasks.json"),
    workTasks: join(root, "work-tasks.json"),
    recipes: join(root, "recipes.json"),
    rss: join(root, "rss.json"),
    dreaming: join(root, "dreaming.json"),
  };
}
export type AssistantDataPaths = ReturnType<typeof assistantDataPaths>;
