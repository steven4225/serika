import type { ExecutionRunRecord, ExecutionToolStatus } from "./execution-record-store.js";
import { latestOwnedRun } from "./work-task-artifacts.js";
import type { WorkTask } from "./work-task-store.js";

/** Derived from existing records; not disk verification, acceptance, or replay authority. */
export interface WorkTaskContinuation {
  taskId: string;
  revision: number;
  previousDelivery: { summary: string; artifactRefs: string[]; unresolved: string[]; truncated: boolean } | null;
  latestRun: {
    runId: string;
    status: ExecutionRunRecord["status"];
    completion?: ExecutionRunRecord["completion"];
    conclusion: string | null;
    conclusionTruncated: boolean;
    tools: { toolCallId: string; toolName: string; status: ExecutionToolStatus; path: string | null }[];
    toolsTruncated: boolean;
  } | null;
  receiptUnavailable: boolean;
  requiresReview: boolean;
}

export function workTaskContinuation(task: WorkTask, record: ExecutionRunRecord | null): WorkTaskContinuation {
  const run = latestOwnedRun(task, record);
  const summary = task.delivery?.summary ?? "";
  let boundedSummary = "";
  for (const character of summary) {
    if (Buffer.byteLength(boundedSummary + character, "utf8") > 2048) break;
    boundedSummary += character;
  }
  return {
    taskId: task.id, revision: task.revision,
    previousDelivery: task.delivery ? {
      summary: boundedSummary,
      artifactRefs: task.delivery.artifactRefs.slice(0, 4),
      unresolved: task.delivery.unresolved.slice(0, 4),
      truncated: summary !== boundedSummary || task.delivery.artifactRefs.length > 4 || task.delivery.unresolved.length > 4,
    } : null,
    latestRun: run ? {
      runId: run.runId, status: run.status, conclusion: run.resultTextPreview,
      ...(run.completion === undefined ? {} : { completion: { ...run.completion } }),
      conclusionTruncated: run.resultTextTruncated,
      tools: run.tools.slice(-8).map(tool => ({
        toolCallId: tool.toolCallId, toolName: tool.toolName, status: tool.status, path: tool.fileInput?.path ?? null,
      })),
      toolsTruncated: run.tools.length > 8,
    } : null,
    receiptUnavailable: task.runIds.length > 0 && run === null,
    requiresReview: task.status === "needs_review",
  };
}
