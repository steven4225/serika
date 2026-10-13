import type { UIMessage } from "ai";

export type TaskInstructionsContext = {
  now: Date;
  timeZone: string;
};

export type TaskContextInjectionOptions = TaskInstructionsContext & {
  taskEnabled: boolean;
  definitionId: string;
};

/** Give the model one unambiguous local calendar date, including its UTC offset. */
export function formatLocalTaskTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
    hourCycle: "h23", timeZoneName: "longOffset",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  const zone = value("timeZoneName");
  const offset = zone === "GMT" ? "+00:00" : zone.replace("GMT", "");
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}.${value("fractionalSecond")}${offset}`;
}

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
    "When task tools are available, treat a request to be reminded as an instruction to call the existing task tool immediately. Do not add a separate intent router. " +
    "A natural-language reminder uses arrangement { kind: \"reminder\", source: \"none\", notification: \"always\", declarationVersion: 1 } so delivery is one deterministic desktop notification, not a model Run and not an automation Hook. " +
    "For one reminder, call task_create. For every day or every week, use task_repeat_create rather than task_create. " +
    "For example, '明早九点提醒我开会' and '一分钟后提醒我喝水' must call task_create; '每天九点提醒我喝水' must call task_repeat_create. Do not only explain the /task command and do not claim that a reminder was saved without a successful tool result. " +
    "task_create requires prompt and runAt. runAt must be an ISO 8601 timestamp with an explicit timezone (use Z or a numeric offset), never a date-only or timezone-less local time. Put only the reminder subject in prompt, such as 开会, not the whole user sentence. " +
    `The current local time is ${formatLocalTaskTime(now, timeZone)} and the local timezone is ${timeZone}. ` +
    "Resolve today/tomorrow (今天/明天) from this LOCAL calendar date, not the UTC date. Convert relative times from that context using the target date's offset in this timezone. " +
    "If the clock is incomplete, choose a default and call the tool anyway so the confirmation card shows it. A missing clock time defaults to 09:00 local. '过会儿' means 30 minutes after the current time above. '周末' means the next Saturday at 10:00 local, or Sunday at 10:00 if that Saturday has already passed, or today at 10:00 when it is Sunday before 10:00. Do not ask「你想几点」 before the tool call. " +
    "task_repeat_create recurrence is daily { kind: 'daily', time: 'HH:mm', utcOffset: '+08:00' } or weekly { kind: 'weekly', weekday: 1..7 (Monday..Sunday), time: 'HH:mm', utcOffset: '+08:00' }; the numeric UTC offset must be the local offset above. A fixed UTC offset does not follow daylight saving time; do not promise the same local clock time across DST changes. " +
    "Do not use the daily work-brief format for a reminder. For a daily work brief, include the requested evidence and observation time, one priority, a 15-minute first step, and unknowns in that task prompt; do not apply this format to other scheduled tasks. " +
    "After a reminder tool succeeds, the user-visible reply is exactly the COMPLETE readback string from the tool result, including any background-unavailable warning and remedy. taskSaved means the arrangement was saved; backgroundReady is a separate readiness observation, not delivery proof. Never shorten a warning-bearing readback to a bare '已定'. Only a ready background may yield '已定：明天 9:00 提醒开会'. Do not add the task id, ISO timestamp, JSON, series ID or nextRunAt. If the tool fails or is denied, do not claim the reminder exists. " +
    "task_create only writes the scheduled task to the workspace task store; it does not start a worker or deliver a notification immediately. A worker must be running for the reminder to notify at its due time. A successful save does not prove the notification was delivered. " +
    "Use task_list when the user asks what tasks are scheduled, pending, or finished, including a request to see task results or status. Use inbox: true for unacknowledged terminal results, use a status filter when the user names a status, and use task_get for one specific task's full status, result, or error. " +
    "If a phrase such as '刚才那个提醒' or '取消那个提醒' matches more than one task, show the candidates with task_list and ask the user which one before rescheduling, cancelling, or acknowledging. " +
    "For a change of time such as '改到十点' on one existing one-time reminder, use task_reschedule with its ID and a future timezone-aware ISO runAt. Never implement rescheduling as task_cancel followed by task_create, because that changes the task ID and can race with the worker. The old runAt shown at confirmation is only a preview; the store rechecks status under its lock. " +
    "After task_reschedule succeeds, the user-visible reply is exactly its readback. Scheduled does not mean a worker is running or a desktop notification was delivered. " +
    "Use task_cancel only when the user explicitly asks to cancel a one-time reminder. For a recurring reminder, task_repeat_pause and task_repeat_resume pause or resume later occurrences, and task_repeat_cancel cancels the series; do not use those tools unless the user asks. Use task_ack only when the user explicitly asks to acknowledge or confirm a terminal result; never acknowledge automatically after listing or showing a task. " +
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
