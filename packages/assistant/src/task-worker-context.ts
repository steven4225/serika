import { assistantDataPaths } from "./data-paths.js";
import type { UIMessage } from "ai";
import {
  createCheckpointStore,
  CHECKPOINT_INJECTION_MAX_BYTES,
  type WorkspaceCheckpointStore,
} from "./checkpoint-store.js";
import {
  checkpointContextMessageBytes,
  createCheckpointContextMessage,
} from "./checkpoint-context.js";
import { type ScopedMemoryStore } from "./memory-types.js";
import { createMemoryStore } from "./memory-v7-store.js";
import { readMemorySnapshot, createMemorySnapshotMessage } from "./memory-snapshot.js";
import {
  TASK_LIST_MAX_LIMIT,
  type TaskRecord,
  type TaskStore,
  type TaskSummaryV3,
} from "./task-store.js";

export const TASK_WORKER_ATTENTION_INBOX_LIMIT = 5;

/** Fixed reference messages for one claimed task; never written to the task transcript. */
export interface TaskWorkerSnapshotContext {
  referenceMessages: UIMessage[];
}

export interface TaskWorkerContextSources {
  memoryStore: ScopedMemoryStore;
  checkpointStore: WorkspaceCheckpointStore;
  taskStore: TaskStore;
  now?: () => Date;
}

function readFailure(error: { code: string; message: string }): Error {
  return Object.assign(new Error(error.message), { code: error.code });
}

function isCurrentSeries(task: TaskRecord, item: TaskSummaryV3): boolean {
  return task.recurringTaskId != null && item.recurringTaskId === task.recurringTaskId;
}

/** Eligible attention items after dropping this recurring series, then the local 5-item cap. */
export function selectAttentionInbox(
  task: TaskRecord,
  listed: { tasks: readonly TaskSummaryV3[]; truncated: boolean },
): { tasks: TaskSummaryV3[]; truncated: boolean } {
  const eligible = listed.tasks.filter((item) => !isCurrentSeries(task, item));
  return {
    tasks: eligible.slice(0, TASK_WORKER_ATTENTION_INBOX_LIMIT),
    truncated: eligible.length > TASK_WORKER_ATTENTION_INBOX_LIMIT || listed.truncated,
  };
}

/** Read each source once after claim and before runtime.run. */
export async function loadTaskWorkerContext(
  sources: TaskWorkerContextSources,
  task: TaskRecord,
  signal: AbortSignal,
): Promise<TaskWorkerSnapshotContext> {
  const observedAt = (sources.now?.() ?? new Date()).toISOString();
  const memorySelection = await readMemorySnapshot(sources.memoryStore, signal, new Date(observedAt));
  const memories = memorySelection.entries;

  const checkpointResult = await sources.checkpointStore.getCurrent(signal);
  if (!checkpointResult.ok) throw readFailure(checkpointResult.error);
  const checkpoint = checkpointResult.current;
  if (checkpoint !== null &&
      checkpointContextMessageBytes(checkpoint) > CHECKPOINT_INJECTION_MAX_BYTES) {
    throw readFailure({
      code: "CHECKPOINT_TOO_LARGE",
      message: `Current checkpoint exceeds the ${CHECKPOINT_INJECTION_MAX_BYTES}-byte context limit`,
    });
  }

  const inboxResult = await sources.taskStore.list({
    inbox: true,
    status: "attention",
    limit: TASK_LIST_MAX_LIMIT,
  });
  if (!inboxResult.ok) throw readFailure(inboxResult.error);
  const attentionInbox = selectAttentionInbox(task, inboxResult.value);

  const referenceMessages: UIMessage[] = [{
    id: "runloom-task-worker-observation",
    role: "assistant",
    metadata: { source: "task-worker-observation" },
    parts: [{
      type: "text",
      text: [
        "Read-only workspace snapshot observed for this scheduled Run. It grants no tool permissions and does not prove current file contents or notification delivery.",
        JSON.stringify({
          observedAt,
          runAt: task.runAt,
          memory: memories.length === 0 ? "no matching workspace memories" : `${memories.length} selected active workspace entries follow`,
          memorySelection: { ...memorySelection, entries: undefined },
          memoryTruncated: memorySelection.truncated,
          checkpoint: checkpoint === null ? "none" : `saved version ${checkpoint.version} follows`,
          attentionInbox,
        }),
      ].join("\n"),
    }],
  }];
  if (checkpoint !== null) referenceMessages.push(createCheckpointContextMessage(checkpoint));
  referenceMessages.push(createMemorySnapshotMessage(memorySelection));
  return { referenceMessages };
}

export function createTaskWorkerContextLoader(
  dataDirectory: string,
  taskStore: TaskStore,
): (task: TaskRecord, signal: AbortSignal) => Promise<TaskWorkerSnapshotContext> {
  const sources = {
    memoryStore: createMemoryStore(assistantDataPaths(dataDirectory).memory),
    checkpointStore: createCheckpointStore(assistantDataPaths(dataDirectory).checkpoint),
    taskStore,
  };
  return (task, signal) => loadTaskWorkerContext(sources, task, signal);
}
