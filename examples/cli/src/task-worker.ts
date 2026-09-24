import { randomUUID } from "node:crypto";
import type {
  AgentErrorData,
  RunHandle,
  RunRequest,
  RunResult,
} from "@aisdk-agent/core";
import { AgentError } from "@aisdk-agent/core";
import type { TaskError, TaskFinish, TaskRecord, TaskStore } from "./task-store.js";
import type { TaskWorkerSnapshotContext } from "./task-worker-context.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface TaskWorkerRuntime {
  run<TContext>(request: RunRequest<TContext>): Promise<RunHandle>;
}

export interface TaskWorkerOptions {
  store: TaskStore;
  runtime: TaskWorkerRuntime;
  signal: AbortSignal;
  pollIntervalMs?: number;
  generateId?: () => string;
  loadWorkspaceContext?: (
    task: TaskRecord,
    signal: AbortSignal,
  ) => Promise<TaskWorkerSnapshotContext>;
  onTaskStarted?: (task: TaskRecord) => void;
  onTaskFinished?: (task: TaskRecord) => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Worker stopped", "AbortError");
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error && error.code === "ABORT_ERR"))
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function taskError(error: unknown, fallbackCode = "RUNTIME_ERROR"): TaskError {
  if (error instanceof AgentError) {
    return {
      code: error.data.code,
      message: error.data.message,
    };
  }
  if (typeof error === "object" && error !== null) {
    const data = error as Partial<AgentErrorData> & { code?: unknown };
    if (typeof data.code === "string" && typeof data.message === "string") {
      return { code: data.code, message: data.message };
    }
  }
  return { code: fallbackCode, message: errorMessage(error) };
}

function workerStoppedError(): TaskError {
  return {
    code: "TASK_INTERRUPTED",
    message: "Worker stopped while the task was running",
  };
}

function storeFailure(result: { ok: false; error: TaskError }): Error {
  return new Error(`${result.error.code}: ${result.error.message}`);
}

function unwrap<T>(
  result:
    | { ok: true; value: T }
    | { ok: false; error: TaskError },
): T {
  if (!result.ok) throw storeFailure(result);
  return result.value;
}

function waitForSignal(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function consumeEvents(events: RunHandle["events"]): Promise<void> {
  for await (const _event of events) {
    // Runtime events are persisted by DefaultAgentRuntime. The worker only
    // needs to drain the channel so a completed run has no pending consumer.
  }
}

function runResultError(result: RunResult): TaskError {
  return result.error
    ? { code: result.error.code, message: result.error.message }
    : { code: `RUN_${result.status.toUpperCase()}`, message: `Run ${result.status}` };
}

function outcomeForResult(
  result: RunResult,
  stopped: boolean,
): TaskFinish {
  if (result.status === "completed") {
    return {
      status: "completed",
      runId: result.runId,
      resultText: result.text,
    };
  }
  return {
    status: stopped ? "interrupted" : "failed",
    runId: result.runId,
    error: stopped ? workerStoppedError() : runResultError(result),
  };
}

async function finishTask(
  options: TaskWorkerOptions,
  task: TaskRecord,
  outcome: TaskFinish,
): Promise<TaskRecord> {
  // Do not pass the stop signal to the terminal write. Once execution has
  // started, a successful stop request must not turn a committed outcome into
  // a false "not written" result.
  const finished = await options.store.finish(task.id, outcome);
  const terminalTask = unwrap(finished);
  try {
    // The durable terminal write is the source of truth. A notification hook
    // is best effort and must never turn a finished task back into a worker
    // failure or cause it to be replayed.
    options.onTaskFinished?.(terminalTask);
  } catch {
    // Notification implementations own reporting their asynchronous failures.
  }
  return terminalTask;
}

async function executeTask(
  options: TaskWorkerOptions,
  task: TaskRecord,
): Promise<TaskRecord> {
  options.onTaskStarted?.(task);
  const stoppedBeforeStart = options.signal.aborted;
  if (stoppedBeforeStart) {
    return finishTask(options, task, {
      status: "interrupted",
      runId: null,
      error: workerStoppedError(),
    });
  }

  let workspaceContext: TaskWorkerSnapshotContext | undefined;
  try {
    workspaceContext = await options.loadWorkspaceContext?.(task, options.signal);
  } catch (error) {
    return finishTask(options, task, options.signal.aborted
      ? { status: "interrupted", runId: null, error: workerStoppedError() }
      : { status: "failed", runId: null, error: taskError(error, "WORKSPACE_CONTEXT_READ_FAILED") });
  }
  if (options.signal.aborted) {
    return finishTask(options, task, {
      status: "interrupted",
      runId: null,
      error: workerStoppedError(),
    });
  }

  const request: RunRequest = {
    agentId: "scheduled-responder",
    threadId: task.threadId!,
    signal: options.signal,
    ...(workspaceContext === undefined ? {} : { context: workspaceContext }),
    messages: [
      {
        id: (options.generateId ?? randomUUID)(),
        role: "user",
        metadata: { source: "scheduled-task" },
        parts: [{ type: "text", text: task.prompt }],
      },
    ],
  };

  let handle: RunHandle;
  try {
    // Runtime startup is expected to be quick and returns a cancelable handle.
    // If stop arrives during startup, cancel is sent immediately after the
    // handle becomes available.
    handle = await options.runtime.run(request);
  } catch (error) {
    const outcome = options.signal.aborted
      ? {
          status: "interrupted" as const,
          runId: null,
          error: workerStoppedError(),
        }
      : {
          status: "failed" as const,
          runId: null,
          error: taskError(error),
        };
    return finishTask(options, task, outcome);
  }

  let cancelSent = false;
  const cancelHandle = (): void => {
    if (cancelSent) return;
    cancelSent = true;
    void handle.cancel("worker_stopped").catch(() => undefined);
  };
  options.signal.addEventListener("abort", cancelHandle, { once: true });
  if (options.signal.aborted) cancelHandle();
  const eventsDone = consumeEvents(handle.events);
  let result: RunResult;
  try {
    result = await handle.result;
    await eventsDone;
  } catch (error) {
    // A rejected handle is a runtime failure rather than a reason to replay
    // the task. A stop request maps the in-flight task to interrupted.
    return finishTask(options, task, {
      status: options.signal.aborted ? "interrupted" : "failed",
      runId: handle.runId,
      error: options.signal.aborted ? workerStoppedError() : taskError(error),
    });
  } finally {
    options.signal.removeEventListener("abort", cancelHandle);
  }

  return finishTask(
    options,
    task,
    outcomeForResult(result, options.signal.aborted),
  );
}

/**
 * Recover stale in-flight tasks, then process due tasks sequentially until the
 * supplied signal is aborted. A failed terminal write throws and stops the
 * loop immediately; the current task remains `running` for next-startup
 * recovery and is never replayed in this process.
 */
export async function runTaskWorker(options: TaskWorkerOptions): Promise<void> {
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(interval) || interval < 0) {
    throw new Error("pollIntervalMs must be a non-negative finite number");
  }

  // Recovery is intentionally performed before checking the stop signal so a
  // worker that receives SIGINT during startup still leaves a clean task file.
  unwrap(await options.store.interruptRunning());

  while (!options.signal.aborted) {
    let claimed: TaskRecord | null;
    try {
      claimed = unwrap(await options.store.claimNextDue(options.signal));
    } catch (error) {
      if (isAbortError(error, options.signal)) return;
      throw error;
    }

    if (claimed !== null) {
      await executeTask(options, claimed);
      continue;
    }

    try {
      await waitForSignal(interval, options.signal);
    } catch (error) {
      if (isAbortError(error, options.signal)) return;
      throw error;
    }
  }
}
