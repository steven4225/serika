import type { ExecutionRecordStore, ExecutionRunRecord } from "./execution-record-store.js";
import {
  WORK_TASK_MAX_ENTRIES,
  type WorkTask,
  type WorkTaskResult,
  type WorkTaskStore,
} from "./work-task-store.js";

export type RecoveredWorkTaskDisposition = "paused" | "needs_review" | "running";

function ownsRun(task: WorkTask, run: ExecutionRunRecord): boolean {
  return run.threadId === task.threadId && run.workTaskId === task.id && run.phase === "primary";
}

export function classifyRecoveredWorkTask(
  task: WorkTask,
  runs: readonly (ExecutionRunRecord | null)[],
): RecoveredWorkTaskDisposition {
  const latest = runs.at(-1) ?? null;
  if (latest === null || !ownsRun(task, latest) || latest.tools.some((tool) => tool.status === "unknown")) {
    return "needs_review";
  }
  if (latest?.status === "running") return "running";
  return "paused";
}

export async function recoverRunningWorkTasks(input: {
  threadId: string;
  workTasks: WorkTaskStore;
  executionRecords: Pick<ExecutionRecordStore, "getRun">;
}): Promise<WorkTask[]> {
  const listed = await input.workTasks.list({ threadId: input.threadId, limit: WORK_TASK_MAX_ENTRIES });
  if (!listed.ok) throw new Error(`${listed.error.code}: ${listed.error.message}`);
  const recovered: WorkTask[] = [];
  for (const task of listed.value.filter((item) => item.status === "running")) {
    const latestRunId = task.runIds.at(-1);
    if (latestRunId === undefined) {
      throw new Error(`WORK_TASK_FILE_INVALID: running WorkTask ${task.id} has no Run`);
    }
    const runs = [await input.executionRecords.getRun(task.threadId, latestRunId)];
    const disposition = classifyRecoveredWorkTask(task, runs);
    if (disposition === "running") continue;
    const settled: WorkTaskResult<WorkTask> = await input.workTasks.settleRecoveredRun(task.id, {
      expectedRevision: task.revision,
      latestRunId,
      disposition,
    });
    if (!settled.ok) throw new Error(`${settled.error.code}: ${settled.error.message}`);
    recovered.push(settled.value);
  }
  return recovered;
}
