import { tool } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import type {
  CreateTaskInput,
  CreateRecurringTaskInput,
  RecurringTaskDetail,
  RecurringTaskList,
  RecurringTaskListInput,
  RecurringTaskRecord,
  TaskError,
  TaskListV3,
  TaskListInput,
  TaskListStatusFilter,
  TaskRecordV3,
  TaskStore,
  TaskStoreResult,
} from "../task-store.js";
import type { Recurrence } from "../recurrence.js";

export type { TaskStore } from "../task-store.js";

const taskStatusSchema = z.enum([
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const recurrenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("daily"),
    time: z.string(),
    utcOffset: z.string(),
  }),
  z.object({
    kind: z.literal("weekly"),
    weekday: z.number().int().min(1).max(7),
    time: z.string(),
    utcOffset: z.string(),
  }),
]);
const recurringTaskStatusSchema = z.enum(["active", "paused", "cancelled"]);
const taskListStatusSchema = z.enum([
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "pending",
  "attention",
]);

const taskErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const taskRecordSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  runAt: z.string(),
  status: taskStatusSchema,
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  threadId: z.string().nullable(),
  runId: z.string().nullable(),
  resultText: z.string().nullable(),
  error: taskErrorSchema.nullable(),
  acknowledgedAt: z.string().nullable(),
  // v2 task records add this association; keeping it optional lets the
  // module continue to render v1 records returned during read-only upgrades.
  recurringTaskId: z.string().nullable().optional(),
});

const recurringTaskRecordSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  recurrence: recurrenceSchema,
  status: recurringTaskStatusSchema,
  createdAt: z.string(),
  nextRunAt: z.string().nullable(),
});

const taskSummarySchema = z.object({
  id: z.string(),
  promptPreview: z.string(),
  runAt: z.string(),
  status: taskStatusSchema,
  finishedAt: z.string().nullable(),
  resultPreview: z.string().nullable(),
  error: z
    .object({
      code: z.string(),
      messagePreview: z.string(),
    })
    .nullable(),
  acknowledgedAt: z.string().nullable(),
  recurringTaskId: z.string().nullable().optional(),
});

const recurringTaskSummarySchema = z.object({
  id: z.string(),
  promptPreview: z.string(),
  recurrence: recurrenceSchema,
  status: recurringTaskStatusSchema,
  nextRunAt: z.string().nullable(),
});

const taskFailureSchema = z.object({
  ok: z.literal(false),
  error: taskErrorSchema,
});

const taskCreateInputSchema = z.object({
  prompt: z.string(),
  runAt: z.string(),
});
const taskListInputSchema = z.object({
  status: taskListStatusSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  recurringTaskId: z.string().min(1).optional(),
  inbox: z.boolean().optional(),
});
const taskGetInputSchema = z.object({ id: z.string().min(1) });
const taskCancelInputSchema = z.object({ id: z.string().min(1) });
const taskRescheduleInputSchema = z.object({
  id: z.string().min(1),
  runAt: z.string(),
});
const taskAckInputSchema = z.object({ id: z.string().min(1) });
const createRecurringTaskInputSchema = z.object({
  prompt: z.string(),
  recurrence: recurrenceSchema,
});
const recurringTaskListInputSchema = z.object({
  status: recurringTaskStatusSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const recurringTaskIdInputSchema = z.object({ id: z.string().min(1) });

const taskRecordOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: taskRecordSchema }),
  taskFailureSchema,
]);
const taskListOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      tasks: z.array(taskSummarySchema),
      truncated: z.boolean(),
    }),
  }),
  taskFailureSchema,
]);
const recurringTaskRecordOutputSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: recurringTaskRecordSchema }),
  taskFailureSchema,
]);
const recurringTaskListOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      recurringTasks: z.array(recurringTaskSummarySchema),
      truncated: z.boolean(),
    }),
  }),
  taskFailureSchema,
]);
const recurringTaskDetailOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: z.object({
      recurringTask: recurringTaskRecordSchema,
      latestTask: taskRecordSchema.nullable(),
    }),
  }),
  taskFailureSchema,
]);

const taskCreateMetadata: RegisteredTool["metadata"] = {
  name: "task_create",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};
const taskListMetadata: RegisteredTool["metadata"] = {
  name: "task_list",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskGetMetadata: RegisteredTool["metadata"] = {
  name: "task_get",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskCancelMetadata: RegisteredTool["metadata"] = {
  name: "task_cancel",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskRescheduleMetadata: RegisteredTool["metadata"] = {
  name: "task_reschedule",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskAckMetadata: RegisteredTool["metadata"] = {
  name: "task_ack",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskRepeatCreateMetadata: RegisteredTool["metadata"] = {
  name: "task_repeat_create",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};
const taskRepeatListMetadata: RegisteredTool["metadata"] = {
  name: "task_repeat_list",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskRepeatGetMetadata: RegisteredTool["metadata"] = {
  name: "task_repeat_get",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskRepeatPauseMetadata: RegisteredTool["metadata"] = {
  name: "task_repeat_pause",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskRepeatResumeMetadata: RegisteredTool["metadata"] = {
  name: "task_repeat_resume",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: true,
};
const taskRepeatCancelMetadata: RegisteredTool["metadata"] = {
  name: "task_repeat_cancel",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: true,
};

export const TASK_COMMAND_USAGE =
  "Usage: /task create <ISO-time-with-timezone> <prompt> | list [pending|attention|status] | inbox | show <id> | ack <id> | cancel <id> | reschedule <id> <ISO-time-with-timezone>";
export const TASK_REPEAT_COMMAND_USAGE =
  "Usage: /task repeat create daily <HH:mm> <+/-HH:mm> <prompt> | create weekly <1-7> <HH:mm> <+/-HH:mm> <prompt> | list [active|paused|cancelled] | show <id> | pause <id> | resume <id> | cancel <id>";

const neverAborted = new AbortController().signal;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatTaskRescheduleConfirmation(
  input: { id?: unknown; runAt?: unknown },
  current: TaskStoreResult<TaskRecordV3>,
): string {
  const previousRunAt = current.ok
    ? current.value.runAt
    : `unavailable (${current.error.code}: ${current.error.message})`;
  return (
    "\nTool: task_reschedule\n" +
    `ID: ${JSON.stringify(input.id)}\n` +
    `Current runAt (preview): ${JSON.stringify(previousRunAt)}\n` +
    `Requested runAt: ${JSON.stringify(input.runAt)}\n` +
    "The store rechecks task status under its lock; this preview does not reserve the task.\n" +
    "Allow this call? [y/n] "
  );
}

function notifyResult<T>(
  ctx: { notify(message: string): void },
  result: TaskStoreResult<T>,
  onSuccess: (value: T) => string,
): void {
  if (result.ok) {
    ctx.notify(onSuccess(result.value));
    return;
  }
  ctx.notify(`${result.error.code}: ${result.error.message}`);
}

function runCommand<T>(
  ctx: { notify(message: string): void },
  operation: () => Promise<TaskStoreResult<T>>,
  onSuccess: (value: T) => string,
): Promise<void> {
  // Return the operation so the TUI can print the result before restoring its
  // prompt and accepting the next input line.
  return Promise.resolve()
    .then(operation)
    .then(
      (result) => notifyResult(ctx, result, onSuccess),
      (error: unknown) => ctx.notify(`Task operation failed: ${errorText(error)}`),
    );
}

function renderRecord(record: TaskRecordV3): string {
  return JSON.stringify(record);
}

function displayValue(value: string | null): string {
  return value ?? "—";
}

function renderList(list: TaskListV3): string {
  if (list.tasks.length === 0) return "Tasks: 0";

  const lines = [`Tasks: ${list.tasks.length}${list.truncated ? " (more available)" : ""}`];
  for (const task of list.tasks) {
    lines.push(
      "",
      `ID: ${task.id}`,
      `Status: ${task.status}`,
      `Run at: ${task.runAt}`,
      `Finished at: ${displayValue(task.finishedAt)}`,
      `Acknowledged at: ${displayValue(task.acknowledgedAt)}`,
      `Prompt: ${task.promptPreview}`,
    );
    if (task.status === "completed" && task.resultPreview !== null) {
      lines.push(`Result: ${task.resultPreview || "任务完成，无文本输出"}`);
    }
    if (
      (task.status === "failed" || task.status === "interrupted") &&
      task.error !== null
    ) {
      lines.push(`Error: ${task.error.code}: ${task.error.messagePreview}`);
    }
  }
  return lines.join("\n");
}

function renderDetail(record: TaskRecordV3): string {
  const lines = [
    `Task: ${record.id}`,
    `Status: ${record.status}`,
    `Prompt: ${record.prompt}`,
    `Run at: ${record.runAt}`,
    `Created at: ${record.createdAt}`,
    `Started at: ${displayValue(record.startedAt)}`,
    `Finished at: ${displayValue(record.finishedAt)}`,
    `Acknowledged at: ${displayValue(record.acknowledgedAt)}`,
    `Thread ID: ${displayValue(record.threadId)}`,
    `Run ID: ${displayValue(record.runId)}`,
  ];
  if (record.status === "completed") {
    lines.push(`Result: ${record.resultText || "任务完成，无文本输出"}`);
  }
  if (
    (record.status === "failed" || record.status === "interrupted") &&
    record.error !== null
  ) {
    lines.push(`Error: ${record.error.code}: ${record.error.message}`);
  }
  return lines.join("\n");
}

function renderRecurrence(recurrence: Recurrence): string {
  if (recurrence.kind === "daily") {
    return `daily ${recurrence.time} ${recurrence.utcOffset}`;
  }
  return `weekly ${recurrence.weekday} ${recurrence.time} ${recurrence.utcOffset}`;
}

function renderRecurringList(list: RecurringTaskList): string {
  if (list.recurringTasks.length === 0) return "Recurring tasks: 0";

  const lines = [
    `Recurring tasks: ${list.recurringTasks.length}${list.truncated ? " (more available)" : ""}`,
  ];
  for (const task of list.recurringTasks) {
    lines.push(
      "",
      `ID: ${task.id}`,
      `Status: ${task.status}`,
      `Recurrence: ${renderRecurrence(task.recurrence)}`,
      `Next run at: ${displayValue(task.nextRunAt)}`,
      `Prompt: ${task.promptPreview}`,
    );
  }
  return lines.join("\n");
}

function renderRecurringDetail(detail: RecurringTaskDetail): string {
  const { recurringTask, latestTask } = detail;
  const lines = [
    `Recurring task: ${recurringTask.id}`,
    `Status: ${recurringTask.status}`,
    `Prompt: ${recurringTask.prompt}`,
    `Recurrence: ${renderRecurrence(recurringTask.recurrence)}`,
    `Created at: ${recurringTask.createdAt}`,
    `Next run at: ${displayValue(recurringTask.nextRunAt)}`,
  ];
  if (latestTask === null) {
    lines.push("Latest task: none");
  } else {
    lines.push(
      `Latest task: ${latestTask.id}`,
      `Latest task status: ${latestTask.status}`,
      `Latest task run at: ${latestTask.runAt}`,
      `Latest task finished at: ${displayValue(latestTask.finishedAt)}`,
    );
    if (latestTask.status === "completed") {
      lines.push(`Latest result: ${latestTask.resultText || "任务完成，无文本输出"}`);
    }
    if (
      (latestTask.status === "failed" || latestTask.status === "interrupted") &&
      latestTask.error !== null
    ) {
      lines.push(`Latest error: ${latestTask.error.code}: ${latestTask.error.message}`);
    }
  }
  return lines.join("\n");
}

function renderRecurringRecord(record: RecurringTaskRecord): string {
  return JSON.stringify(record);
}

function recurringActionLabel(action: "pause" | "resume" | "cancel"): string {
  if (action === "pause") return "paused";
  if (action === "resume") return "resumed";
  return "cancelled";
}

function parseCommandArgs(args: string): { action?: string; rest: string } {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { rest: "" };
  const whitespace = trimmed.search(/\s/);
  if (whitespace === -1) return { action: trimmed, rest: "" };
  return {
    action: trimmed.slice(0, whitespace),
    rest: trimmed.slice(whitespace).trimStart(),
  };
}

function statusFromCommand(value: string): TaskListStatusFilter | undefined {
  return taskListStatusSchema.safeParse(value).success
    ? (value as TaskListStatusFilter)
    : undefined;
}

function taskIdFromCommand(rest: string): string | undefined {
  const id = rest.trim();
  if (id.length === 0 || /\s/.test(id)) return undefined;
  return id;
}

function recurringStatusFromCommand(
  value: string,
): RecurringTaskRecord["status"] | undefined {
  return recurringTaskStatusSchema.safeParse(value).success
    ? (value as RecurringTaskRecord["status"])
    : undefined;
}

function parseRecurringCreate(
  rest: string,
): CreateRecurringTaskInput | undefined {
  const trimmed = rest.trim();
  const daily = /^daily\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (daily !== null) {
    const [, time, utcOffset, rawPrompt] = daily;
    if (time === undefined || utcOffset === undefined || rawPrompt === undefined) {
      return undefined;
    }
    const prompt = rawPrompt.trim();
    if (prompt.length === 0) return undefined;
    return {
      prompt,
      recurrence: {
        kind: "daily",
        time,
        utcOffset,
      },
    };
  }

  const weekly = /^weekly\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (weekly === null) return undefined;
  const [, weekdayText, time, utcOffset, rawPrompt] = weekly;
  if (
    weekdayText === undefined ||
    time === undefined ||
    utcOffset === undefined ||
    rawPrompt === undefined
  ) {
    return undefined;
  }
  const weekday = Number(weekdayText);
  const prompt = rawPrompt.trim();
  if (!Number.isInteger(weekday) || prompt.length === 0) return undefined;
  return {
    prompt,
    recurrence: {
      kind: "weekly",
      weekday,
      time,
      utcOffset,
    },
  };
}

/** Register the task tools and synchronous /task command adapter. */
export function createTaskModule(store: TaskStore): AgentModule {
  return {
    id: "task",
    setup(ctx) {
      const taskCreateTool = tool({
        description:
          "Schedule one future plain-text response in the configured workspace.",
        inputSchema: taskCreateInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          input: CreateTaskInput,
          { abortSignal },
        ): Promise<TaskStoreResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.create(input, signal);
        },
      });
      const taskListTool = tool({
        description: "List tasks in the configured workspace.",
        inputSchema: taskListInputSchema,
        outputSchema: taskListOutputSchema,
        execute: async (input, { abortSignal }): Promise<TaskStoreResult<TaskListV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const normalizedInput: TaskListInput = {
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
            ...(input.recurringTaskId === undefined
              ? {}
              : { recurringTaskId: input.recurringTaskId }),
            ...(input.inbox === undefined ? {} : { inbox: input.inbox }),
          };
          const result = await store.list(normalizedInput);
          throwIfAborted(signal);
          return result;
        },
      });
      const taskGetTool = tool({
        description: "Read one scheduled task and its result.",
        inputSchema: taskGetInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskStoreResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const result = await store.get(id);
          throwIfAborted(signal);
          return result;
        },
      });
      const taskCancelTool = tool({
        description: "Cancel a scheduled task before the worker claims it.",
        inputSchema: taskCancelInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskStoreResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.cancel(id, signal);
        },
      });
      const taskRescheduleTool = tool({
        description:
          "Change the future runAt of an existing one-time scheduled task without changing its ID. Running, terminal, and recurring occurrences cannot be rescheduled.",
        inputSchema: taskRescheduleInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          { id, runAt }: { id: string; runAt: string },
          { abortSignal },
        ): Promise<TaskStoreResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.reschedule(id, runAt, signal);
        },
      });
      const taskAckTool = tool({
        description:
          "Mark one completed, failed, or interrupted task as acknowledged after explicit user confirmation; reading or summarizing it is not acknowledgement.",
        inputSchema: taskAckInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskStoreResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.acknowledge(id, signal);
        },
      });
      const taskRepeatCreateTool = tool({
        description:
          "Create an active daily or weekly plain-text response schedule.",
        inputSchema: createRecurringTaskInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          input: CreateRecurringTaskInput,
          { abortSignal },
        ): Promise<TaskStoreResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.createRecurring(input, signal);
        },
      });
      const taskRepeatListTool = tool({
        description: "List daily and weekly response schedules.",
        inputSchema: recurringTaskListInputSchema,
        outputSchema: recurringTaskListOutputSchema,
        execute: async (input, { abortSignal }) => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const normalizedInput: RecurringTaskListInput = {
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          };
          const result = await store.listRecurring(normalizedInput);
          throwIfAborted(signal);
          return result;
        },
      });
      const taskRepeatGetTool = tool({
        description: "Read one response schedule and its latest task run.",
        inputSchema: recurringTaskIdInputSchema,
        outputSchema: recurringTaskDetailOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskStoreResult<RecurringTaskDetail>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const result = await store.getRecurring(id);
          throwIfAborted(signal);
          return result;
        },
      });
      const taskRepeatPauseTool = tool({
        description: "Pause a response schedule without cancelling its history.",
        inputSchema: recurringTaskIdInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskStoreResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.pauseRecurring(id, signal);
        },
      });
      const taskRepeatResumeTool = tool({
        description: "Resume a paused response schedule at its next occurrence.",
        inputSchema: recurringTaskIdInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskStoreResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.resumeRecurring(id, signal);
        },
      });
      const taskRepeatCancelTool = tool({
        description: "Permanently cancel a response schedule and keep its history.",
        inputSchema: recurringTaskIdInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskStoreResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.cancelRecurring(id, signal);
        },
      });

      ctx.registerTool({ metadata: taskCreateMetadata, tool: taskCreateTool });
      ctx.registerTool({ metadata: taskListMetadata, tool: taskListTool });
      ctx.registerTool({ metadata: taskGetMetadata, tool: taskGetTool });
      ctx.registerTool({ metadata: taskCancelMetadata, tool: taskCancelTool });
      ctx.registerTool({ metadata: taskRescheduleMetadata, tool: taskRescheduleTool });
      ctx.registerTool({ metadata: taskAckMetadata, tool: taskAckTool });
      ctx.registerTool({ metadata: taskRepeatCreateMetadata, tool: taskRepeatCreateTool });
      ctx.registerTool({ metadata: taskRepeatListMetadata, tool: taskRepeatListTool });
      ctx.registerTool({ metadata: taskRepeatGetMetadata, tool: taskRepeatGetTool });
      ctx.registerTool({ metadata: taskRepeatPauseMetadata, tool: taskRepeatPauseTool });
      ctx.registerTool({ metadata: taskRepeatResumeMetadata, tool: taskRepeatResumeTool });
      ctx.registerTool({ metadata: taskRepeatCancelMetadata, tool: taskRepeatCancelTool });

      ctx.registerCommand({
        name: "task",
        execute(args) {
          const { action, rest } = parseCommandArgs(args);

          if (action === "create") {
            const whitespace = rest.search(/\s/);
            if (whitespace === -1) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            const runAt = rest.slice(0, whitespace);
            const prompt = rest.slice(whitespace).trim();
            if (prompt.length === 0) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            return runCommand(
              ctx,
              () => store.create({ runAt, prompt }),
              (record) => `Task created: ${renderRecord(record)}`,
            );
          }

          if (action === "list") {
            const statusText = rest.trim();
            if (statusText !== "" && /\s/.test(statusText)) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            if (statusText !== "" && statusFromCommand(statusText) === undefined) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            const status =
              statusText === "" ? undefined : statusFromCommand(statusText);
            return runCommand(
              ctx,
              () => store.list(status === undefined ? {} : { status }),
              renderList,
            );
          }

          if (action === "inbox") {
            if (rest.trim() !== "") {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            return runCommand(ctx, () => store.list({ inbox: true }), renderList);
          }

          if (action === "show") {
            const id = taskIdFromCommand(rest);
            if (id === undefined) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            return runCommand(ctx, () => store.get(id), renderDetail);
          }

          if (action === "cancel") {
            const id = taskIdFromCommand(rest);
            if (id === undefined) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            return runCommand(
              ctx,
              () => store.cancel(id),
              (record) => `Task cancelled: ${renderRecord(record)}`,
            );
          }

          if (action === "reschedule") {
            const match = /^(\S+)\s+(\S+)$/.exec(rest.trim());
            if (match === null) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            const [, id, runAt] = match;
            if (id === undefined || runAt === undefined) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            return runCommand(
              ctx,
              async () => {
                const before = await store.get(id);
                if (!before.ok) return before;
                const after = await store.reschedule(id, runAt);
                if (!after.ok) return after;
                return { ok: true as const, value: { before: before.value, after: after.value } };
              },
              ({ before, after }) =>
                `Task rescheduled: ID: ${after.id}; previous runAt (observed): ${before.runAt}; new runAt: ${after.runAt}`,
            );
          }

          if (action === "ack") {
            const id = taskIdFromCommand(rest);
            if (id === undefined) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            return runCommand(
              ctx,
              () => store.acknowledge(id),
              (record) => `Task acknowledged: ${renderRecord(record)}`,
            );
          }

          if (action === "repeat") {
            const { action: repeatAction, rest: repeatRest } = parseCommandArgs(rest);

            if (repeatAction === "create") {
              const input = parseRecurringCreate(repeatRest);
              if (input === undefined) {
                ctx.notify(TASK_REPEAT_COMMAND_USAGE);
                return;
              }
              return runCommand(
                ctx,
                () => store.createRecurring(input),
                (record) => `Recurring task created: ${renderRecurringRecord(record)}`,
              );
            }

            if (repeatAction === "list") {
              const statusText = repeatRest.trim();
              if (
                statusText !== "" &&
                (/\s/.test(statusText) || recurringStatusFromCommand(statusText) === undefined)
              ) {
                ctx.notify(TASK_REPEAT_COMMAND_USAGE);
                return;
              }
              const status =
                statusText === "" ? undefined : recurringStatusFromCommand(statusText);
              return runCommand(
                ctx,
                () =>
                  store.listRecurring(
                    status === undefined ? {} : { status },
                  ),
                renderRecurringList,
              );
            }

            if (
              repeatAction === "show" ||
              repeatAction === "pause" ||
              repeatAction === "resume" ||
              repeatAction === "cancel"
            ) {
              const id = taskIdFromCommand(repeatRest);
              if (id === undefined) {
                ctx.notify(TASK_REPEAT_COMMAND_USAGE);
                return;
              }

              if (repeatAction === "show") {
                return runCommand(ctx, () => store.getRecurring(id), renderRecurringDetail);
              }

              const operation =
                repeatAction === "pause"
                  ? () => store.pauseRecurring(id)
                  : repeatAction === "resume"
                    ? () => store.resumeRecurring(id)
                    : () => store.cancelRecurring(id);
              return runCommand(
                ctx,
                operation,
                (record) =>
                  `Recurring task ${recurringActionLabel(repeatAction)}: ${renderRecurringRecord(record)}`,
              );
            }

            ctx.notify(TASK_REPEAT_COMMAND_USAGE);
            return;
          }

          ctx.notify(TASK_COMMAND_USAGE);
        },
      });
    },
  };
}

export type { TaskError };
