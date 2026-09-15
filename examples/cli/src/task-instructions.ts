import type { UIMessage } from "ai";

export type TaskInstructionsContext = {
  now: Date;
  timeZone: string;
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
    "Use task_list when the user asks what tasks are scheduled or pending, and task_cancel when the user asks to cancel a task; identify the task from the tool result and do not claim cancellation without a successful result."
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
