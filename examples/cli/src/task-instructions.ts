import type { UIMessage } from "ai";

export type TaskInstructionsContext = {
  now: Date;
  timeZone: string;
};

export type TaskContextInjectionOptions = TaskInstructionsContext & {
  taskEnabled: boolean;
  definitionId: string;
};

/**
 * The task module accepts absolute ISO timestamps. Keep the relative-time
 * guidance at the model boundary so a natural-language request becomes a
 * real task_create call instead of an untracked promise.
 */
export function buildTaskInstructions({
  now,
  timeZone,
}: TaskInstructionsContext): string {
  return (
    "When task tools are available, treat requests to be reminded or to arrange a one-time task as an instruction to call task_create immediately. " +
    "For example, '一分钟后提醒我喝水' or '安排一个任务' must result in task_create when the time is clear; do not only explain the /task command and do not claim that a task was scheduled without a successful tool result. " +
    "task_create requires prompt and runAt. runAt must be an ISO 8601 timestamp with an explicit timezone (use Z or a numeric offset), never a date-only or timezone-less local time. " +
    `The current time is ${now.toISOString()} and the local timezone is ${timeZone}. ` +
    "Convert relative times from that context. If the user did not give a time and it cannot be safely inferred, ask for the exact time and timezone before calling task_create. " +
    "After task_create succeeds, report the returned task ID, runAt, and prompt exactly from the tool result. " +
    "task_create only writes the scheduled task to the workspace task store; it does not start a worker or execute the prompt immediately. A worker must be running for the task to execute at its due time. " +
    "For a request to respond every day or every week, use task_repeat_create rather than task_create when the schedule is clear. Its recurrence is daily { kind: 'daily', time: 'HH:mm', utcOffset: '+08:00' } or weekly { kind: 'weekly', weekday: 1..7 (Monday..Sunday), time: 'HH:mm', utcOffset: '+08:00' }; the numeric UTC offset must be explicit. If the time, weekday for a weekly schedule, or fixed UTC offset is unclear, ask before creating. A fixed UTC offset does not follow daylight saving time; do not promise the same local clock time across DST changes. " +
    "Put the user's requested response content in the recurring task prompt. For a daily work brief, include the requested evidence and observation time, one priority, a 15-minute first step, and unknowns in that task prompt; do not apply this format to other scheduled tasks. After task_repeat_create succeeds, report the returned series ID and nextRunAt. A successful creation only schedules future worker runs; do not claim the brief has run or a notification was delivered. If creation fails or is denied, do not claim the series exists. " +
    "Use task_list when the user asks what tasks are scheduled, pending, or finished, including a request to see task results or status. Use inbox: true for unacknowledged terminal results, use a status filter when the user names a status, and use task_get for one specific task's full status, result, or error. " +
    "If a phrase such as '刚才那个提醒' matches more than one task, show the candidates with task_list and ask the user which one before rescheduling, cancelling, or acknowledging. " +
    "For a change of time to one existing one-time reminder, use task_reschedule with its ID and a future timezone-aware ISO runAt. Never implement rescheduling as task_cancel followed by task_create, because that changes the task ID and can race with the worker. The old runAt shown at confirmation is only a preview; the store rechecks status under its lock. " +
    "After task_reschedule succeeds, report only the returned task ID and runAt as the committed scheduling result. Scheduled does not mean a worker is running or a desktop notification was delivered. " +
    "Use task_cancel only when the user explicitly asks to cancel a task, and use task_ack only when the user explicitly asks to acknowledge or confirm a terminal result; never acknowledge automatically after listing or showing a task. " +
    "A completed task means worker Run 正常结束; it does not prove business success or desktop notification delivery. Explain failed and interrupted separately: failed means the Run failed, while interrupted means the worker stopped before normal completion. Do not promise a desktop notification when creating a task."
  );
}

export function buildTaskContextMessage(
  context: TaskInstructionsContext,
): UIMessage {
  return {
    id: "runloom-task-instructions",
    role: "assistant",
    parts: [{ type: "text", text: buildTaskInstructions(context) }],
  };
}

/**
 * Add the task instructions to a TUI model prompt without changing the
 * persisted conversation. The caller supplies the current time so this stays
 * a per-Run decision rather than a process-start snapshot.
 */
export function injectTaskContext(
  messages: UIMessage[],
  options: TaskContextInjectionOptions,
): UIMessage[] {
  if (!options.taskEnabled || options.definitionId !== "calculator") {
    return messages;
  }
  return [
    buildTaskContextMessage({
      now: options.now,
      timeZone: options.timeZone,
    }),
    ...messages,
  ];
}
