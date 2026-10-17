import { randomUUID } from "node:crypto";
import type {
  AgentErrorData,
  RunHandle,
  RunRequest,
  RunResult,
} from "@serika/core";
import { AgentError } from "@serika/core";
import { FOREGROUND_NOTIFICATION_OMITTED, type DesktopNotificationDelivery } from "./task-notification-copy.js";
import type { TaskError, TaskFinish, TaskRecord, TaskRecordV4, TaskStore } from "./task-store.js";
import type { TaskWorkerSnapshotContext } from "./task-worker-context.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface TaskWorkerRuntime {
  run<TContext>(request: RunRequest<TContext>): Promise<RunHandle>;
}

export interface PreparedWorkerTask {
  agentId: string;
  prompt: string;
  formatResult(text: string): string;
  /** Program-owned result; skips the model but retains outcome/finish persistence. */
  deterministicResult?: string;
  notifyOnSuccess?: boolean;
  message?: import("ai").UIMessage;
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
  onTaskRetry?: (task: TaskRecordV4) => void;
  /** Only configured text/read-only responders may opt into whole-Run retry. */
  safeRetry?: boolean;
  /** Process availability is not itself authorization for an arrangement. */
  todoistPlanningAvailable?: boolean;
  now?: () => number;
  notify?: (task: TaskRecord) => Promise<void | DesktopNotificationDelivery>;
  prepareTask?: (task: TaskRecord, signal: AbortSignal) => Promise<PreparedWorkerTask | undefined>;
  prepareSkillTask?: (task: TaskRecord, signal: AbortSignal) => Promise<PreparedWorkerTask>;
  recoverPreparedTasks?: () => Promise<void>;
  settlePreparedTask?: (task: TaskRecord) => Promise<void>;
}

const RETRY_DELAYS = [1_000, 5_000] as const;
const TRANSIENT_MODEL_CODES = new Set(["MODEL_UNAVAILABLE", "MODEL_RATE_LIMIT", "MODEL_TIMEOUT"]);

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

async function consumeEvents(events: RunHandle["events"], onEvent?: (event: import("@serika/core").AgentEvent) => void): Promise<void> {
  for await (const event of events) {
    onEvent?.(event);
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
  task: TaskRecordV4,
  outcome: TaskFinish,
  notifyOnSuccess = true,
): Promise<TaskRecord> {
  // Do not pass the stop signal to the terminal write. Once execution has
  // started, a successful stop request must not turn a committed outcome into
  // a false "not written" result.
  const attempts = task.attempts.length;
  if (task.arrangement?.kind !== "skill" && options.safeRetry === true && !options.signal.aborted &&
      outcome.status === "failed" && TRANSIENT_MODEL_CODES.has(outcome.error.code) &&
      attempts > 0 && attempts < 3) {
    const retrying = unwrap(await options.store.retry(task.id, {
      error: outcome.error,
      runId: outcome.runId,
      nextRunAt: new Date((options.now ?? Date.now)() + RETRY_DELAYS[attempts - 1]!).toISOString(),
    }));
    try { options.onTaskRetry?.(retrying); } catch { /* Durable retry wins. */ }
    return retrying;
  }
  const durableOutcome: TaskFinish = {
    ...outcome,
    ...(options.notify === undefined || (outcome.status === "completed" && !notifyOnSuccess) ? {} : { notification: true }),
  };
  unwrap(await options.store.recordOutcome(task.id, durableOutcome));
  const finished = await options.store.finish(task.id, durableOutcome);
  const terminalTask = unwrap(finished);
  await options.settlePreparedTask?.(terminalTask);
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
  task: TaskRecordV4,
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
  let prepared: PreparedWorkerTask | undefined;
  try {
    if (task.arrangement?.kind === "reminder") {
      return finishTask(options, task, { status: "completed", runId: null, execution: "deterministic", resultText: task.prompt });
    }
    if (task.arrangement?.kind === "todoist-brief" && options.todoistPlanningAvailable !== true) {
      throw new AgentError({ code: "TOOL_DENIED", message: "This worker has no Todoist planning source configured", retryable: false, phase: "approval" });
    }
    if (task.arrangement?.kind === "skill") {
      if (!options.prepareSkillTask) throw Object.assign(new Error("This worker has no trusted Skill executor"), { code: "SKILL_UNAVAILABLE" });
      prepared = await options.prepareSkillTask(task, options.signal);
    }
    if (task.arrangement === undefined || task.arrangement.kind === "rss-digest") prepared = await options.prepareTask?.(task, options.signal);
    if (task.arrangement?.kind === "rss-digest" && prepared === undefined) {
      throw new AgentError({ code: "TOOL_DENIED", message: "RSS arrangement has no matching authorized subscription binding", retryable: false, phase: "approval" });
    }
    // New arrangements grant only their declared source, never global Memory/checkpoint access.
    if (task.arrangement === undefined) workspaceContext = await options.loadWorkspaceContext?.(task, options.signal);
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

  if (prepared?.deterministicResult !== undefined) {
    return finishTask(options, task, { status: "completed", runId: null, execution: "deterministic", resultText: prepared.deterministicResult }, prepared.notifyOnSuccess !== false);
  }

  const request: RunRequest = {
    agentId: prepared?.agentId ?? (task.arrangement?.kind === "todoist-brief" ? "scheduled-todoist" : "scheduled-responder"),
    threadId: task.threadId!,
    signal: options.signal,
    ...(workspaceContext === undefined ? {} : { context: workspaceContext }),
    messages: [
      prepared?.message ?? {
        id: (options.generateId ?? randomUUID)(),
        role: "user",
        metadata: { source: "scheduled-task" },
        parts: [{ type: "text", text: prepared?.prompt ?? task.prompt }],
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
  let planningQuerySucceeded = false;
  const eventsDone = consumeEvents(handle.events, event => {
    if (task.arrangement?.kind !== "todoist-brief" || event.type !== "tool.call.completed" || event.data.toolName !== "todoist_list_tasks") return;
    const output = event.data.output;
    if (typeof output === "object" && output !== null && "ok" in output && output.ok === true && "value" in output && typeof output.value === "object" && output.value !== null && "view" in output.value && output.value.view === "planning") planningQuerySucceeded = true;
  });
  // Link the real invocation before awaiting its result. If this write fails,
  // stop the handle and leave the task for conservative startup recovery.
  try {
    unwrap(await options.store.recordRunId(task.id, handle.runId));
  } catch (error) {
    cancelHandle();
    await Promise.allSettled([handle.result, eventsDone]);
    options.signal.removeEventListener("abort", cancelHandle);
    throw error;
  }
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

  if (result.status === "completed" && prepared !== undefined) {
    result = { ...result, text: prepared.formatResult(result.text) };
  }
  if (result.status === "completed" && task.arrangement?.kind === "todoist-brief" && !planningQuerySucceeded) {
    return finishTask(options, task, { status: "failed", runId: handle.runId, error: { code: "TASK_SOURCE_QUERY_FAILED", message: "Todoist report has no successful planning query receipt; model text alone is not a source result" } });
  }
  return finishTask(
    options,
    task,
    outcomeForResult(result, options.signal.aborted),
    prepared?.notifyOnSuccess !== false,
  );
}

function notificationRecord(delivery: void | DesktopNotificationDelivery): { ok: true; delivery?: "omitted" } {
  switch (delivery) {
    case FOREGROUND_NOTIFICATION_OMITTED:
      return { ok: true, delivery: "omitted" };
    case "submitted":
      return { ok: true };
    default: {
      if (typeof delivery === "string") {
        const unreachable: never = delivery;
        return unreachable;
      }
      return { ok: true };
    }
  }
}

async function drainNotifications(options: TaskWorkerOptions): Promise<void> {
  if (options.notify === undefined) return;
  const due = unwrap(await options.store.listNotifications((options.now ?? Date.now)()));
  for (const task of due) {
    if (options.signal.aborted) return;
    let delivery: void | DesktopNotificationDelivery;
    try {
      delivery = await options.notify(task);
    } catch (error) {
      const attempt = (task.notification?.attempts ?? 0) + 1;
      unwrap(await options.store.recordNotification(task.id, {
        ok: false,
        error: taskError(error, "NOTIFICATION_FAILED"),
        nextAttemptAt: attempt < 3
          ? new Date((options.now ?? Date.now)() + RETRY_DELAYS[attempt - 1]!).toISOString()
          : null,
      }));
      continue;
    }
    // The record is separate from OS submission. A crash before this write may
    // submit again, but must never replay the model task. Foreground omission
    // is not an OS submission.
    unwrap(await options.store.recordNotification(task.id, notificationRecord(delivery)));
  }
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
  const running = unwrap(await options.store.listRunning());
  for (const task of running) {
    const outcome = task.pendingOutcome;
    if (outcome !== null && outcome.runId === task.runId) {
      const terminal = unwrap(await options.store.finish(task.id, outcome));
      try { options.onTaskFinished?.(terminal); } catch { /* Durable outcome wins. */ }
    }
  }
  unwrap(await options.store.interruptRunning());
  await options.recoverPreparedTasks?.();

  while (!options.signal.aborted) {
    await drainNotifications(options);
    if (options.signal.aborted) return;
    let claimed: TaskRecordV4 | null;
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
