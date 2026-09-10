import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type {
  RecurringTaskDetail,
  RecurringTaskList,
  RecurringTaskRecord,
  TaskList,
  TaskRecord,
  TaskStore,
  TaskStoreResult,
} from "../task-store.js";
import {
  createTaskModule,
  TASK_COMMAND_USAGE,
  TASK_REPEAT_COMMAND_USAGE,
} from "./task-module.js";

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    prompt: "prepare a plan",
    runAt: "2026-09-12T01:00:00.000Z",
    status: "scheduled",
    createdAt: "2026-09-11T01:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    threadId: null,
    runId: null,
    resultText: null,
    error: null,
    ...overrides,
  };
}

function list(): TaskList {
  return {
    tasks: [
      {
        id: "task-1",
        promptPreview: "prepare a plan",
        runAt: "2026-09-12T01:00:00.000Z",
        status: "scheduled",
        finishedAt: null,
        resultPreview: null,
        error: null,
      },
    ],
    truncated: false,
  };
}

function resultList(): TaskList {
  return {
    tasks: [
      {
        id: "task-completed",
        promptPreview: "summarize the release",
        runAt: "2026-09-12T01:00:00.000Z",
        status: "completed",
        finishedAt: "2026-09-12T01:01:00.000Z",
        resultPreview: "release summary",
        error: null,
      },
      {
        id: "task-failed",
        promptPreview: "publish the release",
        runAt: "2026-09-12T02:00:00.000Z",
        status: "failed",
        finishedAt: "2026-09-12T02:01:00.000Z",
        resultPreview: null,
        error: { code: "TOOL_FAILED", messagePreview: "upstream unavailable" },
      },
    ],
    truncated: true,
  };
}

function recurringRecord(
  overrides: Partial<RecurringTaskRecord> = {},
): RecurringTaskRecord {
  return {
    id: "repeat-1",
    prompt: "prepare a daily plan",
    recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
    status: "active",
    createdAt: "2026-09-11T01:00:00.000Z",
    nextRunAt: "2026-09-12T01:00:00.000Z",
    ...overrides,
  };
}

function recurringList(): RecurringTaskList {
  return {
    recurringTasks: [
      {
        id: "repeat-1",
        promptPreview: "prepare a daily plan",
        recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
        status: "active",
        nextRunAt: "2026-09-12T01:00:00.000Z",
      },
    ],
    truncated: false,
  };
}

function recurringDetail(): RecurringTaskDetail {
  return {
    recurringTask: recurringRecord(),
    latestTask: {
      ...record({
        id: "task-latest",
        status: "completed",
        startedAt: "2026-09-11T01:00:00.000Z",
        finishedAt: "2026-09-11T01:01:00.000Z",
        threadId: "thread-latest",
        runId: "run-latest",
        resultText: "daily plan",
      }),
      recurringTaskId: "repeat-1",
    },
  };
}

function setup(overrides: Partial<TaskStore> = {}): {
  tools: RegisteredTool[];
  commands: Map<string, { name: string; execute(args: string): void }>;
  notifications: string[];
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const callsFor = <T>(method: string, value: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      return value;
    };
  const store: TaskStore = {
    create: callsFor("create", { ok: true, value: record() }),
    list: callsFor("list", { ok: true, value: list() }),
    get: callsFor("get", { ok: true, value: record() }),
    cancel: callsFor("cancel", {
      ok: true,
      value: record({ status: "cancelled" }),
    }),
    claimNextDue: callsFor("claimNextDue", { ok: true, value: null }),
    finish: callsFor("finish", { ok: true, value: record() }),
    interruptRunning: callsFor("interruptRunning", { ok: true, value: 0 }),
    createRecurring: callsFor("createRecurring", {
      ok: true,
      value: recurringRecord(),
    }),
    listRecurring: callsFor("listRecurring", {
      ok: true,
      value: recurringList(),
    }),
    getRecurring: callsFor("getRecurring", {
      ok: true,
      value: recurringDetail(),
    }),
    pauseRecurring: callsFor("pauseRecurring", {
      ok: true,
      value: recurringRecord({ status: "paused", nextRunAt: null }),
    }),
    resumeRecurring: callsFor("resumeRecurring", {
      ok: true,
      value: recurringRecord(),
    }),
    cancelRecurring: callsFor("cancelRecurring", {
      ok: true,
      value: recurringRecord({ status: "cancelled", nextRunAt: null }),
    }),
    ...overrides,
  };
  const tools: RegisteredTool[] = [];
  const commands = new Map<string, { name: string; execute(args: string): void }>();
  const notifications: string[] = [];
  createTaskModule(store).setup({
    registerTool: (registered) => tools.push(registered),
    registerCommand: (command) => commands.set(command.name, command),
    notify: (message) => notifications.push(message),
  });
  return { tools, commands, notifications, calls };
}

function toolByName(tools: RegisteredTool[], name: string): RegisteredTool {
  const registered = tools.find(({ metadata }) => metadata.name === name);
  assert.ok(registered, `missing ${name}`);
  return registered;
}

function toolContext(signal?: AbortSignal): {
  toolCallId: string;
  messages: [];
  context: Record<string, never>;
  abortSignal?: AbortSignal;
} {
  return {
    toolCallId: "task-test",
    messages: [],
    context: {},
    ...(signal === undefined ? {} : { abortSignal: signal }),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createTaskModule", () => {
  it("registers task and recurring task tools with frozen metadata", () => {
    const { tools, commands } = setup();
    assert.deepEqual(
      tools.map(({ metadata }) => metadata),
      [
        {
          name: "task_create",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: false,
        },
        {
          name: "task_list",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_get",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_cancel",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_repeat_create",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: false,
        },
        {
          name: "task_repeat_list",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_repeat_get",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_repeat_pause",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_repeat_resume",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_repeat_cancel",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: true,
        },
      ],
    );
    assert.ok(commands.has("task"));
  });

  it("routes tool inputs through the same store and preserves the operation result", async () => {
    const { tools, calls } = setup();
    const context = toolContext(new AbortController().signal);
    const create = toolByName(tools, "task_create").tool;
    const listTool = toolByName(tools, "task_list").tool;
    const get = toolByName(tools, "task_get").tool;
    const cancel = toolByName(tools, "task_cancel").tool;

    assert.deepEqual(
      await create.execute!({ prompt: "p", runAt: "2026-09-12T01:00:00+00:00" }, context),
      { ok: true, value: record() },
    );
    assert.deepEqual(await listTool.execute!({ status: "pending", limit: 2 }, context), {
      ok: true,
      value: list(),
    });
    assert.deepEqual(await get.execute!({ id: "task-1" }, context), {
      ok: true,
      value: record(),
    });
    assert.deepEqual(await cancel.execute!({ id: "task-1" }, context), {
      ok: true,
      value: record({ status: "cancelled" }),
    });
    assert.deepEqual(calls.map(({ method, args }) => ({ method, args })), [
      {
        method: "create",
        args: [{ prompt: "p", runAt: "2026-09-12T01:00:00+00:00" }, context.abortSignal],
      },
      { method: "list", args: [{ status: "pending", limit: 2 }] },
      { method: "get", args: ["task-1"] },
      { method: "cancel", args: ["task-1", context.abortSignal] },
    ]);
  });

  it("routes recurring tools through the same store and passes operation signals", async () => {
    const { tools, calls } = setup();
    const signal = new AbortController().signal;
    const context = toolContext(signal);
    const create = toolByName(tools, "task_repeat_create").tool;
    const listTool = toolByName(tools, "task_repeat_list").tool;
    const get = toolByName(tools, "task_repeat_get").tool;
    const pause = toolByName(tools, "task_repeat_pause").tool;
    const resume = toolByName(tools, "task_repeat_resume").tool;
    const cancel = toolByName(tools, "task_repeat_cancel").tool;

    const createInput = {
      prompt: "prepare a daily plan",
      recurrence: { kind: "daily" as const, time: "09:00", utcOffset: "+08:00" },
    };
    assert.deepEqual(await create.execute!(createInput, context), {
      ok: true,
      value: recurringRecord(),
    });
    assert.deepEqual(await listTool.execute!({ status: "paused", limit: 5 }, context), {
      ok: true,
      value: recurringList(),
    });
    assert.deepEqual(await get.execute!({ id: "repeat-1" }, context), {
      ok: true,
      value: recurringDetail(),
    });
    assert.deepEqual(await pause.execute!({ id: "repeat-1" }, context), {
      ok: true,
      value: recurringRecord({ status: "paused", nextRunAt: null }),
    });
    assert.deepEqual(await resume.execute!({ id: "repeat-1" }, context), {
      ok: true,
      value: recurringRecord(),
    });
    assert.deepEqual(await cancel.execute!({ id: "repeat-1" }, context), {
      ok: true,
      value: recurringRecord({ status: "cancelled", nextRunAt: null }),
    });
    assert.deepEqual(calls.map(({ method, args }) => ({ method, args })), [
      { method: "createRecurring", args: [createInput, signal] },
      { method: "listRecurring", args: [{ status: "paused", limit: 5 }] },
      { method: "getRecurring", args: ["repeat-1"] },
      { method: "pauseRecurring", args: ["repeat-1", signal] },
      { method: "resumeRecurring", args: ["repeat-1", signal] },
      { method: "cancelRecurring", args: ["repeat-1", signal] },
    ]);
  });

  it("validates recurrence shape at the tool boundary", () => {
    const { tools } = setup();
    const create = toolByName(tools, "task_repeat_create").tool;
    const inputSchema = create.inputSchema as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(
      inputSchema.safeParse({
        prompt: "daily plan",
        recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
      }).success,
      true,
    );
    assert.equal(
      inputSchema.safeParse({
        prompt: "weekly plan",
        recurrence: { kind: "weekly", weekday: 1, time: "09:00", utcOffset: "+08:00" },
      }).success,
      true,
    );
    assert.equal(
      inputSchema.safeParse({
        prompt: "invalid weekday",
        recurrence: { kind: "weekly", weekday: 8, time: "09:00", utcOffset: "+08:00" },
      }).success,
      false,
    );
  });

  it("keeps ModuleCommand execution synchronous while notifying async outcomes", async () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    assert.equal(
      command.execute(
        "create 2026-09-12T09:00:00+08:00 prepare a detailed learning plan",
      ),
      undefined,
    );
    assert.deepEqual(notifications, []);
    await settle();
    assert.equal(calls[0]?.method, "create");
    assert.deepEqual(calls[0]?.args, [
      {
        runAt: "2026-09-12T09:00:00+08:00",
        prompt: "prepare a detailed learning plan",
      },
    ]);
    assert.match(notifications[0] ?? "", /^Task created:/);

    command.execute("list completed");
    command.execute("show task-1");
    command.execute("cancel task-1");
    await settle();
    assert.match(notifications[1] ?? "", /Tasks: 1/);
    assert.match(notifications[2] ?? "", /^Task: task-1/);
    assert.match(notifications[3] ?? "", /^Task cancelled:/);
  });

  it("supports repeat create/list/show/pause/resume/cancel commands", async () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    assert.equal(
      command.execute("repeat create daily 09:00 +08:00 prepare today"),
      undefined,
    );
    command.execute("repeat create weekly 1 10:30 -05:00 plan the week");
    command.execute("repeat list paused");
    command.execute("repeat show repeat-1");
    command.execute("repeat pause repeat-1");
    command.execute("repeat resume repeat-1");
    command.execute("repeat cancel repeat-1");
    assert.deepEqual(notifications, []);
    await settle();

    assert.deepEqual(calls.map(({ method, args }) => ({ method, args })), [
      {
        method: "createRecurring",
        args: [
          {
            prompt: "prepare today",
            recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" },
          },
        ],
      },
      {
        method: "createRecurring",
        args: [
          {
            prompt: "plan the week",
            recurrence: {
              kind: "weekly",
              weekday: 1,
              time: "10:30",
              utcOffset: "-05:00",
            },
          },
        ],
      },
      { method: "listRecurring", args: [{ status: "paused" }] },
      { method: "getRecurring", args: ["repeat-1"] },
      { method: "pauseRecurring", args: ["repeat-1"] },
      { method: "resumeRecurring", args: ["repeat-1"] },
      { method: "cancelRecurring", args: ["repeat-1"] },
    ]);
    assert.match(notifications[0] ?? "", /^Recurring task created:/);
    assert.match(notifications[1] ?? "", /^Recurring task created:/);
    assert.match(notifications[2] ?? "", /Recurring tasks: 1/);
    assert.match(notifications[2] ?? "", /Status: active/);
    assert.match(notifications[3] ?? "", /Recurring task: repeat-1/);
    assert.match(notifications[3] ?? "", /Latest task: task-latest/);
    assert.match(notifications[4] ?? "", /^Recurring task paused:/);
    assert.match(notifications[5] ?? "", /^Recurring task resumed:/);
    assert.match(notifications[6] ?? "", /^Recurring task cancelled:/);
  });

  it("rejects malformed repeat commands without touching the store", () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    command.execute("repeat");
    command.execute("repeat create daily 09:00 +08:00");
    command.execute("repeat create weekly x 10:00 +08:00 prompt");
    command.execute("repeat list unknown");
    command.execute("repeat show repeat-1 extra");
    command.execute("repeat pause");
    assert.deepEqual(notifications, [
      TASK_REPEAT_COMMAND_USAGE,
      TASK_REPEAT_COMMAND_USAGE,
      TASK_REPEAT_COMMAND_USAGE,
      TASK_REPEAT_COMMAND_USAGE,
      TASK_REPEAT_COMMAND_USAGE,
      TASK_REPEAT_COMMAND_USAGE,
    ]);
    assert.deepEqual(calls, []);
  });

  it("accepts pending and attention command filters and renders list summaries", async () => {
    const inputs: unknown[] = [];
    const { commands, notifications } = setup({
      list: async (input) => {
        inputs.push(input);
        return { ok: true, value: resultList() };
      },
    });
    const command = commands.get("task");
    assert.ok(command);

    command.execute("list pending");
    command.execute("list attention");
    await settle();

    assert.deepEqual(inputs, [{ status: "pending" }, { status: "attention" }]);
    assert.match(notifications[0] ?? "", /ID: task-completed/);
    assert.match(notifications[0] ?? "", /Finished at: 2026-09-12T01:01:00.000Z/);
    assert.match(notifications[0] ?? "", /Result: release summary/);
    assert.match(notifications[0] ?? "", /more available/);
    assert.match(notifications[0] ?? "", /Error: TOOL_FAILED: upstream unavailable/);
  });

  it("renders complete task details, including full result and execution identifiers", async () => {
    const completed = record({
      status: "completed",
      prompt: "prepare the complete report",
      startedAt: "2026-09-12T01:00:10.000Z",
      finishedAt: "2026-09-12T01:01:10.000Z",
      threadId: "thread-1",
      runId: "run-1",
      resultText: "first line\nsecond line",
    });
    const { commands, notifications } = setup({
      get: async () => ({ ok: true, value: completed }),
    });
    const command = commands.get("task");
    assert.ok(command);

    command.execute("show task-1");
    await settle();

    assert.match(notifications[0] ?? "", /Task: task-1/);
    assert.match(notifications[0] ?? "", /Prompt: prepare the complete report/);
    assert.match(notifications[0] ?? "", /Created at: 2026-09-11T01:00:00.000Z/);
    assert.match(notifications[0] ?? "", /Started at: 2026-09-12T01:00:10.000Z/);
    assert.match(notifications[0] ?? "", /Finished at: 2026-09-12T01:01:10.000Z/);
    assert.match(notifications[0] ?? "", /Thread ID: thread-1/);
    assert.match(notifications[0] ?? "", /Run ID: run-1/);
    assert.match(notifications[0] ?? "", /Result: first line\nsecond line/);
  });

  it("renders failed task details with the full error", async () => {
    const failed = record({
      status: "failed",
      startedAt: "2026-09-12T01:00:10.000Z",
      finishedAt: "2026-09-12T01:01:10.000Z",
      threadId: "thread-1",
      error: { code: "TOOL_FAILED", message: "full upstream failure" },
    });
    const { commands, notifications } = setup({
      get: async () => ({ ok: true, value: failed }),
    });
    const command = commands.get("task");
    assert.ok(command);

    command.execute("show task-1");
    await settle();

    assert.match(notifications[0] ?? "", /Error: TOOL_FAILED: full upstream failure/);
  });

  it("rejects malformed command syntax without touching the store", () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    command.execute("");
    command.execute("create 2026-09-12T09:00:00+08:00");
    command.execute("list nope");
    command.execute("show task-1 extra");
    command.execute("cancel");
    assert.deepEqual(notifications, [
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
    ]);
    assert.deepEqual(calls, []);
  });

  it("turns a rejected async command operation into a notification", async () => {
    const failure: TaskStoreResult<TaskRecord> = {
      ok: false,
      error: { code: "READ_FAILED", message: "disk unavailable" },
    };
    const { commands, notifications } = setup({
      get: async () => failure,
    });
    const command = commands.get("task");
    assert.ok(command);
    command.execute("show task-1");
    await settle();
    assert.deepEqual(notifications, ["READ_FAILED: disk unavailable"]);
  });
});
