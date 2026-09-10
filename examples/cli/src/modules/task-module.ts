import { tool } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import type {
  CreateTaskInput,
  TaskError,
  TaskList,
  TaskListInput,
  TaskRecord,
  TaskStatus,
  TaskStore,
  TaskStoreResult,
} from "../task-store.js";

export type { TaskStore } from "../task-store.js";

const taskStatusSchema = z.enum([
  "scheduled",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
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
});

const taskSummarySchema = z.object({
  id: z.string(),
  promptPreview: z.string(),
  runAt: z.string(),
  status: taskStatusSchema,
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
  status: taskStatusSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
const taskGetInputSchema = z.object({ id: z.string().min(1) });
const taskCancelInputSchema = z.object({ id: z.string().min(1) });

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

export const TASK_COMMAND_USAGE =
  "Usage: /task create <ISO-time-with-timezone> <prompt> | list [status] | show <id> | cancel <id>";

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
): void {
  // ModuleCommand is intentionally synchronous. Starting the promise in a
  // microtask also catches a store method that throws before returning one.
  void Promise.resolve()
    .then(operation)
    .then(
      (result) => notifyResult(ctx, result, onSuccess),
      (error: unknown) => ctx.notify(`Task operation failed: ${errorText(error)}`),
    );
}

function renderRecord(record: TaskRecord): string {
  return JSON.stringify(record);
}

function renderList(list: TaskList): string {
  return JSON.stringify(list);
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

function statusFromCommand(value: string): TaskStatus | undefined {
  return taskStatusSchema.safeParse(value).success
    ? (value as TaskStatus)
    : undefined;
}

function taskIdFromCommand(rest: string): string | undefined {
  const id = rest.trim();
  if (id.length === 0 || /\s/.test(id)) return undefined;
  return id;
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
        ): Promise<TaskStoreResult<TaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.create(input, signal);
        },
      });
      const taskListTool = tool({
        description: "List scheduled tasks in the configured workspace.",
        inputSchema: taskListInputSchema,
        outputSchema: taskListOutputSchema,
        execute: async (input, { abortSignal }): Promise<TaskStoreResult<TaskList>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          const normalizedInput: TaskListInput = {
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
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
        ): Promise<TaskStoreResult<TaskRecord>> => {
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
        ): Promise<TaskStoreResult<TaskRecord>> => {
          const signal = abortSignal ?? neverAborted;
          throwIfAborted(signal);
          return store.cancel(id, signal);
        },
      });

      ctx.registerTool({ metadata: taskCreateMetadata, tool: taskCreateTool });
      ctx.registerTool({ metadata: taskListMetadata, tool: taskListTool });
      ctx.registerTool({ metadata: taskGetMetadata, tool: taskGetTool });
      ctx.registerTool({ metadata: taskCancelMetadata, tool: taskCancelTool });

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
            runCommand(
              ctx,
              () => store.create({ runAt, prompt }),
              (record) => `Task created: ${renderRecord(record)}`,
            );
            return;
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
            runCommand(
              ctx,
              () => store.list(status === undefined ? {} : { status }),
              renderList,
            );
            return;
          }

          if (action === "show") {
            const id = taskIdFromCommand(rest);
            if (id === undefined) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            runCommand(ctx, () => store.get(id), renderRecord);
            return;
          }

          if (action === "cancel") {
            const id = taskIdFromCommand(rest);
            if (id === undefined) {
              ctx.notify(TASK_COMMAND_USAGE);
              return;
            }
            runCommand(
              ctx,
              () => store.cancel(id),
              (record) => `Task cancelled: ${renderRecord(record)}`,
            );
            return;
          }

          ctx.notify(TASK_COMMAND_USAGE);
        },
      });
    },
  };
}

export type { TaskError };
