import { tool } from "ai";
import type { TodoistPlanningFact } from "../module-facts.js";
import { toolCommitResult } from "../commit-outcome.js";
import { z } from "zod";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type { BeforeToolExecuteInput } from "@serika/core";
import type { AgentModule, ToolConfirmationCard } from "../module-host.js";
import { arrangementNeedsAttention } from "../task-lifecycle.js";
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
  TaskArrangement,
} from "../task-store.js";
import type { Recurrence } from "../recurrence.js";
import { readRecurrence, reminderConfirmation, reminderReadback, type ReminderSpeechAction } from "../reminder-speech.js";
import type { SkillResult } from "../automation-execution.js";
import { createWorkTaskCreateTool, WORK_TASK_CREATE_INSTRUCTIONS, workTaskCreateConfirmation, type WorkTaskCreateHost } from "../work-task-create.js";

export type { TaskStore } from "../task-store.js";

export type SavedTaskArrangement =
  | { kind: "once"; task: TaskRecordV3 }
  | { kind: "recurring"; task: RecurringTaskRecord };

const taskStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "cancelled",
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
  "pending",
  "running",
  "completed",
  "cancelled",
  "attention",
]);

const taskErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const reminderArrangementSchema = z.object({ kind: z.literal("reminder"), source: z.literal("none"), notification: z.literal("always"), declarationVersion: z.literal(1) }).strict();
const todoistArrangementSchema = z.object({ kind: z.literal("todoist-brief"), source: z.literal("todoist-planning"), notification: z.literal("always"), declarationVersion: z.literal(1) }).strict();
const skillArrangementSchema = z.object({ kind: z.literal("skill"), source: z.literal("none"), notification: z.literal("always"), declarationVersion: z.literal(1),
  skillId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), skillHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const inputArrangementSchema = z.discriminatedUnion("kind", [reminderArrangementSchema, todoistArrangementSchema, skillArrangementSchema]);
const arrangementSchema = z.discriminatedUnion("kind", [reminderArrangementSchema, todoistArrangementSchema, skillArrangementSchema,
  z.object({ kind: z.literal("rss-digest"), source: z.literal("existing-rss-binding"), notification: z.literal("new-items"), declarationVersion: z.literal(1) }).strict(),
]);
const serviceSchema = z.object({ enabled: z.boolean(), ready: z.boolean().optional(), message: z.string().optional() }).strict();

export interface TaskModuleOptions {
  /** Registry/source validation is supplied by the trusted host, not the model. */
  checkSkillArrangement?: (arrangement: Extract<TaskArrangement, { kind: "skill" }>, prompt: string) => Promise<SkillResult<null>>;
  /** Trusted availability for this process's configured background Todoist source (from the Todoist module). */
  todoistPlanning?: TodoistPlanningFact;
  /** Host-owned service setup, included in the existing arrangement confirmation. */
  afterArrangementSaved?: (saved: SavedTaskArrangement) => Promise<{ enabled: boolean; ready?: boolean; message?: string }>;
  /** Read-only readiness check for rescheduling/resuming; never enables a service. */
  backgroundStatus?: () => Promise<{ ready: boolean; message?: string }>;
  /** Display clock for reminder readback. Defaults to the process clock and timezone. */
  now?: () => Date;
  timeZone?: string;
  /** Trusted background-service status, shown on the arrangement confirmation card. */
  automationStatus?: () => Promise<TaskAutomationStatus>;
  /** Where arrangement results are delivered, shown on the confirmation card. */
  arrangementDestination?: () => string | null;
  /** Registered text Skills the primary agent may schedule, listed in its instructions. */
  schedulableSkills?: readonly { id: string; hash: string; description: string }[];
  /** Ordinary primary chat. Omitted for workers, background runs, and Skills. */
  workTaskCreate?: WorkTaskCreateHost;
}

export interface TaskAutomationStatus {
  available: boolean;
  registered: boolean;
  running: boolean;
  ready?: boolean;
  todoistPlanningAvailable: boolean;
  message?: string;
}

const TASK_INSTRUCTIONS = " For a user-requested reminder, call task_create once or task_repeat_create for daily or weekly, with arrangement {kind:\"reminder\",source:\"none\",notification:\"always\",declarationVersion:1}. Put the reminder subject in prompt. If the clock is incomplete, choose the default from the task instructions and call the tool so the confirmation card shows time, repeat, and text; do not ask「你想几点」 first. After success, the user-visible reply is exactly the tool result readback, such as「已定：明天 9:00 提醒开会」, with no task id or JSON. A daily or weekly Todoist briefing still uses todoist-brief and asks when the source is missing; never invent a Todoist source. The tool preview is the one arrangement confirmation including background activation where wired. Do not create arbitrary scheduled shell/file/computer jobs. RSS uses its existing bound subscription setup, never an arbitrary task prompt. A saved arrangement is not proof the worker ran or that a notification was delivered; report service.enabled false honestly when present. ";

function skillScheduleInstructions(skills: readonly { id: string; hash: string; description: string }[]): string {
  return ` For an explicitly requested registered Skill schedule, the arrangement is {kind:"skill",source:"none",notification:"always",declarationVersion:1,skillId,skillHash}. Use the exact registered hash and the user-provided input as prompt (at most 4 KiB). Never schedule memory consolidation, infer a new Skill, grant tools or include private conversation/Memory as input without an explicit user instruction. These text Skills receive only their declared input, not current/news/workspace data. Available schedule Skills: ${JSON.stringify(skills.map(skill => ({ id: skill.id, hash: skill.hash, description: skill.description.slice(0, 80) })))}`;
}
type TaskToolResult<T> = SkillResult<T> & {
  service?: { enabled: boolean; ready?: boolean; message?: string };
  taskSaved?: boolean;
  backgroundReady?: boolean;
  readback?: string;
};

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
  arrangement: arrangementSchema.optional(),
  execution: z.literal("deterministic").optional(),
});

const recurringTaskRecordSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  recurrence: recurrenceSchema,
  status: recurringTaskStatusSchema,
  createdAt: z.string(),
  nextRunAt: z.string().nullable(),
  arrangement: arrangementSchema.optional(),
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
  arrangement: arrangementSchema.optional(),
});

const recurringTaskSummarySchema = z.object({
  id: z.string(),
  promptPreview: z.string(),
  recurrence: recurrenceSchema,
  status: recurringTaskStatusSchema,
  nextRunAt: z.string().nullable(),
  arrangement: arrangementSchema.optional(),
});

const taskFailureSchema = z.object({
  ok: z.literal(false),
  error: taskErrorSchema,
});

const taskCreateInputSchema = z.object({
  prompt: z.string(),
  runAt: z.string(),
  arrangement: inputArrangementSchema.optional(),
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
  arrangement: inputArrangementSchema.optional(),
});
const recurringTaskListInputSchema = z.object({
  status: recurringTaskStatusSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const recurringTaskIdInputSchema = z.object({ id: z.string().min(1) });

const taskRecordOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    value: taskRecordSchema,
    service: serviceSchema.optional(),
    taskSaved: z.boolean().optional(),
    backgroundReady: z.boolean().optional(),
    readback: z.string().optional(),
  }),
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
  z.object({
    ok: z.literal(true),
    value: recurringTaskRecordSchema,
    service: serviceSchema.optional(),
    taskSaved: z.boolean().optional(),
    backgroundReady: z.boolean().optional(),
    readback: z.string().optional(),
  }),
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
    if (arrangementNeedsAttention(task) && task.error !== null) {
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
  if (arrangementNeedsAttention(record) && record.error !== null) {
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
    if (arrangementNeedsAttention(latestTask) && latestTask.error !== null) {
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
export function createTaskModule(store: TaskStore, options: TaskModuleOptions = {}): AgentModule {
  function executionReadback(readback: string, ready: boolean | undefined): string {
    return ready === true ? readback : readback.replace(/^已定：/, "已记下：") +
      "。但后台当前不可用或尚未就绪，到点不能保证执行；请在后台提醒中核对并启用服务，不要重复创建。";
  }
  function speechClock(): { now: Date; timeZone: string } {
    return {
      now: options.now?.() ?? new Date(),
      timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
  /** The y/n cards for arrangements and reminders; `undefined` keeps the generic card. Reminder cards carry their fields. */
  function confirmation(input: BeforeToolExecuteInput): ToolConfirmationCard | Promise<ToolConfirmationCard | undefined> | undefined {
    if (input.toolName === "work_task_create") return workTaskCreateConfirmation(input.input);
    if (input.toolName === "task_create" || input.toolName === "task_repeat_create") {
      const request = typeof input.input === "object" && input.input !== null ? input.input as { arrangement?: { kind?: unknown; source?: unknown; skillId?: unknown; skillHash?: unknown }; runAt?: unknown; recurrence?: unknown; prompt?: unknown } : {};
      if (request.arrangement !== undefined) {
        const render = (status?: TaskAutomationStatus) => {
          const destination = options.arrangementDestination?.();
          const delivery = destination
            ? `结果投递目的地：${destination.slice(0, 256)}。任务保存与投递登记并非原子；失败时不要重复创建，回桌面核对。`
            : "";
          if (request.arrangement?.kind === "reminder") {
            const recurrence = readRecurrence(request.recurrence);
            const service = status === undefined
              ? "本入口只保存提醒；需要自行运行 worker，到期才会提交通知。通知提交不等于已经送达。"
              : `${status.registered ? status.running ? "后台已注册且正在运行" : "后台已注册，当前未运行" : "后台尚未注册"}。确认后保存这条提醒，并按需启用该工作区后台服务；启用失败时提醒仍保存。到期通知只提交一次，这次确认不代表已经送达。${status.message ? ` ${status.message}` : ""}`;
            return reminderConfirmation({
              action: "save",
              prompt: typeof request.prompt === "string" ? request.prompt : "",
              ...(typeof request.runAt === "string" ? { runAt: request.runAt } : {}),
              ...(recurrence === undefined ? {} : { recurrence }),
              clock: speechClock(),
              footnote: delivery.length > 0 ? `${service} ${delivery}` : service,
            });
          }
          return (
          `\n自动安排确认\n内容：${JSON.stringify(request.prompt)}\n时间：${JSON.stringify(request.runAt ?? request.recurrence)}\n` +
          `用途：${JSON.stringify(request.arrangement?.kind)}；来源：${JSON.stringify(request.arrangement?.source)}\n` +
          (request.arrangement?.kind === "skill" ? `Skill：${JSON.stringify(request.arrangement.skillId)}；固定版本：${JSON.stringify(request.arrangement.skillHash)}\n仅处理本次输入；不读取对话、记忆或工作区文件。版本变化时拒绝执行，不自动换新版本。输入将发送给后台配置的模型服务，可能产生费用。\n` : "") +
          "周期采用固定 UTC offset，不自动跟随夏令时；休眠/离线不保证准点，恢复后仅处理最近一期。\n" +
          "提醒不用模型；Todoist 只读查询；本安排不授权 Shell、文件、电脑操作或工作区记忆读取。\n" +
          (destination ? `结果投递目的地：${destination.slice(0, 256)}。任务保存与投递登记并非原子；失败时不要重复创建，回桌面核对。\n` : "") +
          (request.arrangement?.kind === "todoist-brief" ? "Todoist 查询结果会发送给后台环境文件配置的模型服务，该服务可能不同于当前桌面模型。\n" : "") +
          (status ? `后台：${status.registered ? status.running ? "已注册且正在运行" : "已注册，当前未运行" : "尚未注册"}。${status.message ?? ""}\n确认将保存这条安排，并按需启用该工作区后台服务；启用失败时安排仍保存，结果会明确说明。\n` : "本入口没有后台服务接线；只保存安排，需要自行运行 worker 才会执行。\n") +
          "通知提交不等于你已收到；结果保存在任务收件箱。允许本次安排？ [y/n] ");
        };
        return options.automationStatus ? options.automationStatus().then(render, error => render({ available: false, registered: false, running: false, todoistPlanningAvailable: false, message: String(error) })) : render();
      }
    }
    if (input.toolName === "task_cancel" || input.toolName === "task_repeat_pause" || input.toolName === "task_repeat_resume" || input.toolName === "task_repeat_cancel") {
      const request = typeof input.input === "object" && input.input !== null ? input.input as { id?: unknown } : {};
      const id = typeof request.id === "string" ? request.id : "";
      if (input.toolName === "task_cancel") {
        return store.get(id).then((current) => {
          if (!current.ok || current.value.arrangement?.kind !== "reminder") return undefined;
          return reminderConfirmation({
            action: "cancel",
            prompt: current.value.prompt,
            runAt: current.value.runAt,
            clock: speechClock(),
            footnote: "取消后不会再为这条提醒提交通知。已经提交的通知不会撤回。",
          });
        });
      }
      const action = input.toolName === "task_repeat_pause" ? "pause" as const : input.toolName === "task_repeat_resume" ? "resume" as const : "cancel" as const;
      return store.getRecurring(id).then((current) => {
        const series = current.ok ? current.value.recurringTask : undefined;
        if (series?.arrangement?.kind !== "reminder") return undefined;
        return reminderConfirmation({
          action,
          prompt: series.prompt,
          recurrence: series.recurrence,
          clock: speechClock(),
          footnote: "只变更后续安排，不重放已经执行的结果，也不撤回已经提交的通知。",
        });
      });
    }
    if (input.toolName === "task_reschedule") {
      const request = typeof input.input === "object" && input.input !== null
        ? input.input as { id?: unknown; runAt?: unknown }
        : {};
      return store.get(typeof request.id === "string" ? request.id : "")
        .then((current) => {
          if (current.ok && current.value.arrangement?.kind === "reminder" && typeof request.runAt === "string") {
            return reminderConfirmation({
              action: "reschedule",
              prompt: current.value.prompt,
              runAt: request.runAt,
              previousRunAt: current.value.runAt,
              clock: speechClock(),
              footnote: "保存时会再次核对状态。改期不代表通知已经送达。",
            });
          }
          return formatTaskRescheduleConfirmation(request, current);
        });
    }
    return undefined;
  }
  function speakOnce(action: ReminderSpeechAction, result: TaskToolResult<TaskRecordV3>): TaskToolResult<TaskRecordV3> {
    if (!result.ok || result.value.arrangement?.kind !== "reminder") return result;
    return {
      ...result,
      readback: action === "schedule" || action === "reschedule"
        ? executionReadback(reminderReadback(action, { prompt: result.value.prompt, runAt: result.value.runAt, clock: speechClock() }), result.backgroundReady)
        : reminderReadback(action, { prompt: result.value.prompt, runAt: result.value.runAt, clock: speechClock() }),
    };
  }
  function speakRecurring(action: ReminderSpeechAction, result: TaskToolResult<RecurringTaskRecord>): TaskToolResult<RecurringTaskRecord> {
    if (!result.ok || result.value.arrangement?.kind !== "reminder") return result;
    return {
      ...result,
      readback: action === "schedule" || action === "resume"
        ? executionReadback(reminderReadback(action, { prompt: result.value.prompt, recurrence: result.value.recurrence, clock: speechClock() }), result.backgroundReady)
        : reminderReadback(action, { prompt: result.value.prompt, recurrence: result.value.recurrence, clock: speechClock() }),
    };
  }
  async function checkArrangement(arrangement: TaskArrangement | undefined, prompt: string): Promise<SkillResult<null>> {
    if (arrangement === undefined) return { ok: true, value: null };
    if (!inputArrangementSchema.safeParse(arrangement).success) return { ok: false, error: { code: "INVALID_INPUT", message: "Only complete reminder, Todoist planning or registered Skill arrangements are supported here; RSS requires the existing subscription binding" } };
    if (arrangement.kind === "skill") {
      if (!options.checkSkillArrangement) return { ok: false, error: { code: "SKILL_UNAVAILABLE", message: "No registered Skill schedule validator is configured; no arrangement was saved" } };
      if (Buffer.byteLength(prompt, "utf8") > 4096) return { ok: false, error: { code: "INVALID_INPUT", message: "Skill input exceeds 4 KiB" } };
      return options.checkSkillArrangement(arrangement, prompt);
    }
    if (arrangement.kind === "todoist-brief") {
      let available = options.todoistPlanning?.available === true;
      try { if (options.todoistPlanning?.check !== undefined) available = await options.todoistPlanning.check(); }
      catch { available = false; }
      if (!available) return { ok: false, error: { code: "INVALID_INPUT", message: "The background Todoist planning source is unavailable; no arrangement was saved" } };
    }
    return { ok: true, value: null };
  }
  async function serviceAfterSave<T extends TaskRecordV3 | RecurringTaskRecord>(result: TaskStoreResult<T>, kind: "once" | "recurring", arrangement?: TaskArrangement): Promise<TaskToolResult<T>> {
    if (!result.ok || arrangement === undefined) return result;
    // The arrangement is already committed. A service failure must not imply rollback,
    // and cancellation after that write must not be represented as zero effects.
    if (!options.afterArrangementSaved) return { ...result, taskSaved: true, backgroundReady: false };
    try {
      const service = await options.afterArrangementSaved({ kind, task: result.value } as SavedTaskArrangement);
      return { ...result, service, taskSaved: true, backgroundReady: service.enabled && service.ready === true };
    }
    catch (error) { return { ...result, taskSaved: true, backgroundReady: false, service: { enabled: false, message: `Arrangement saved, but background service setup failed: ${error instanceof Error ? error.message.slice(0, 512) : "unknown error"}` } }; }
  }
  async function backgroundAfterUpdate<T extends TaskRecordV3 | RecurringTaskRecord>(result: TaskStoreResult<T>): Promise<TaskToolResult<T>> {
    if (!result.ok || result.value.arrangement === undefined) return result;
    // Update approval is not permission to register/start a worker.
    try {
      const status = await options.backgroundStatus?.();
      return { ...result, taskSaved: true, backgroundReady: status?.ready === true };
    } catch { return { ...result, taskSaved: true, backgroundReady: false }; }
  }
  return {
    id: "task",
    instructionPlacement: { section: "body", rank: 900 },
    setup(ctx) {
      const taskCreateTool = tool({
        description:
          "Schedule one future response. A natural-language reminder must set arrangement {kind:\"reminder\", source:\"none\", notification:\"always\", declarationVersion:1}; that kind delivers once without a model Run. A complete arrangement may instead declare a read-only Todoist brief or a registered tool-free text Skill pinned by skillId/skillHash (source none, notification always). Skill input is prompt, at most 4 KiB, with no inherited Memory or tools. RSS requires its existing binding. Approval covers saving the displayed arrangement and host background setup; report service state separately from execution or delivery. When the result includes readback, that sentence is the entire user-visible reply.",
        inputSchema: taskCreateInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          input: z.infer<typeof taskCreateInputSchema>,
          { abortSignal },
        ): Promise<TaskToolResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const checked = await checkArrangement(input.arrangement, input.prompt); if (!checked.ok) return checked;
          throwIfAborted(signal);
          const normalized: CreateTaskInput = { prompt: input.prompt, runAt: input.runAt, ...(input.arrangement === undefined ? {} : { arrangement: input.arrangement }) };
          return speakOnce("schedule", await serviceAfterSave(await toolCommitResult(store.create(normalized, signal)), "once", input.arrangement));
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
        description: "Cancel a scheduled task before the worker claims it. For a reminder, the result readback is the entire user-visible reply.",
        inputSchema: taskCancelInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskToolResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return speakOnce("cancel", await toolCommitResult(store.cancel(id, signal)));
        },
      });
      const taskRescheduleTool = tool({
        description:
          "Change the future runAt of an existing one-time scheduled task without changing its ID. Running, terminal, and recurring occurrences cannot be rescheduled. For a reminder, the result readback is the entire user-visible reply.",
        inputSchema: taskRescheduleInputSchema,
        outputSchema: taskRecordOutputSchema,
        execute: async (
          { id, runAt }: { id: string; runAt: string },
          { abortSignal },
        ): Promise<TaskToolResult<TaskRecordV3>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return speakOnce("reschedule", await backgroundAfterUpdate(await toolCommitResult(store.reschedule(id, runAt, signal))));
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
          return toolCommitResult(store.acknowledge(id, signal));
        },
      });
      const taskRepeatCreateTool = tool({
        description:
          "Create an active daily or weekly response schedule with a fixed UTC offset. A natural-language reminder must set arrangement {kind:\"reminder\", source:\"none\", notification:\"always\", declarationVersion:1}. A complete arrangement may instead declare a read-only Todoist brief or a registered tool-free text Skill pinned by skillId/skillHash (none/always). Skill input is prompt, at most 4 KiB; no Memory or tools are inherited. RSS requires its existing bound subscription. Approval covers saving and host background setup; service state does not prove execution or receipt. When the result includes readback, that sentence is the entire user-visible reply.",
        inputSchema: createRecurringTaskInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          input: z.infer<typeof createRecurringTaskInputSchema>,
          { abortSignal },
        ): Promise<TaskToolResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const checked = await checkArrangement(input.arrangement, input.prompt); if (!checked.ok) return checked;
          throwIfAborted(signal);
          const normalized: CreateRecurringTaskInput = { prompt: input.prompt, recurrence: input.recurrence, ...(input.arrangement === undefined ? {} : { arrangement: input.arrangement }) };
          return speakRecurring("schedule", await serviceAfterSave(await toolCommitResult(store.createRecurring(normalized, signal)), "recurring", input.arrangement));
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
        description: "Pause a response schedule without cancelling its history. For a reminder, the result readback is the entire user-visible reply.",
        inputSchema: recurringTaskIdInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskToolResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return speakRecurring("pause", await toolCommitResult(store.pauseRecurring(id, signal)));
        },
      });
      const taskRepeatResumeTool = tool({
        description: "Resume a paused response schedule at its next occurrence. For a reminder, the result readback is the entire user-visible reply.",
        inputSchema: recurringTaskIdInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskToolResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return speakRecurring("resume", await backgroundAfterUpdate(await toolCommitResult(store.resumeRecurring(id, signal))));
        },
      });
      const taskRepeatCancelTool = tool({
        description: "Permanently cancel a response schedule and keep its history. For a reminder, the result readback is the entire user-visible reply.",
        inputSchema: recurringTaskIdInputSchema,
        outputSchema: recurringTaskRecordOutputSchema,
        execute: async (
          { id }: { id: string },
          { abortSignal },
        ): Promise<TaskToolResult<RecurringTaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return speakRecurring("cancel", await toolCommitResult(store.cancelRecurring(id, signal)));
        },
      });

      const permission = { confirmation };
      if (options.workTaskCreate) {
        ctx.registerTool(createWorkTaskCreateTool(options.workTaskCreate), { confirmation, defaults: { remember: "never" } });
        ctx.addInstructions(WORK_TASK_CREATE_INSTRUCTIONS);
      }
      ctx.registerTool({ metadata: options.afterArrangementSaved === undefined ? taskCreateMetadata : { ...taskCreateMetadata, timeoutMs: 30_000 }, tool: taskCreateTool }, permission);
      ctx.registerTool({ metadata: taskListMetadata, tool: taskListTool }, permission);
      ctx.registerTool({ metadata: taskGetMetadata, tool: taskGetTool }, permission);
      ctx.registerTool({ metadata: taskCancelMetadata, tool: taskCancelTool }, permission);
      ctx.registerTool({ metadata: taskRescheduleMetadata, tool: taskRescheduleTool }, permission);
      ctx.registerTool({ metadata: taskAckMetadata, tool: taskAckTool }, permission);
      ctx.registerTool({ metadata: options.afterArrangementSaved === undefined ? taskRepeatCreateMetadata : { ...taskRepeatCreateMetadata, timeoutMs: 30_000 }, tool: taskRepeatCreateTool }, permission);
      ctx.registerTool({ metadata: taskRepeatListMetadata, tool: taskRepeatListTool }, permission);
      ctx.registerTool({ metadata: taskRepeatGetMetadata, tool: taskRepeatGetTool }, permission);
      ctx.registerTool({ metadata: taskRepeatPauseMetadata, tool: taskRepeatPauseTool }, permission);
      ctx.registerTool({ metadata: taskRepeatResumeMetadata, tool: taskRepeatResumeTool }, permission);
      ctx.registerTool({ metadata: taskRepeatCancelMetadata, tool: taskRepeatCancelTool }, permission);
      ctx.addInstructions(TASK_INSTRUCTIONS);
      if (options.schedulableSkills !== undefined && options.schedulableSkills.length > 0) {
        ctx.addInstructions(skillScheduleInstructions(options.schedulableSkills));
      }

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
