import type { ExecutionRunRecord } from "../../shared/ui-contract.js";
import type { WorkTask, WorkTaskStatus } from "../../shared/work-tasks.js";

export const taskStatusLabels: Record<WorkTaskStatus, string> = {
  ready: "待开始", running: "正在执行", paused: "已暂停 · 可开下一轮", needs_review: "效果待核对",
  awaiting_acceptance: "交付待验收", completed: "验收通过", cancelled: "任务已取消",
};

export const criterionStatusLabels = { passed: "通过", failed: "未通过", blocked: "被阻断", not_run: "尚未验收" };

export function selectCurrentTask(tasks: readonly WorkTask[]): WorkTask | null {
  return tasks.find(task => task.status === "needs_review") ?? tasks.find(task => task.status === "running") ??
    tasks.find(task => task.status === "awaiting_acceptance") ?? tasks.find(task => !["completed", "cancelled"].includes(task.status)) ?? tasks[0] ?? null;
}

export function taskActions(task: WorkTask) {
  return {
    run: task.status === "ready" || task.status === "paused",
    delivery: task.status === "paused" || task.status === "awaiting_acceptance",
    accept: task.status === "awaiting_acceptance" && task.delivery !== null,
    rework: task.status === "awaiting_acceptance",
    reconcile: task.status === "needs_review",
    cancel: ["ready", "paused", "awaiting_acceptance"].includes(task.status),
  };
}

/** Reconciled means a human report exists, not that old receipts became successful. */
export function unreconciledRuns(runs: readonly ExecutionRunRecord[], tasks: readonly WorkTask[]): ExecutionRunRecord[] {
  return runs.filter(run => run.tools.some(tool => tool.status === "unknown") && !tasks.some(task =>
    task.id === run.workTaskId && task.threadId === run.threadId && task.runIds.includes(run.runId) &&
    task.reconciliations.some(report => report.runId === run.runId),
  ));
}

export function isTaskRun(task: WorkTask, run: ExecutionRunRecord): boolean {
  return run.workTaskId === task.id && run.threadId === task.threadId && run.phase === "primary" && task.runIds.includes(run.runId);
}

export function lines(text: string): string[] { return text.split("\n").map(line => line.trim()).filter(Boolean); }
