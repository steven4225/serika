import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type {
  RecurringTaskDetail,
  RecurringTaskList,
  RecurringTaskRecord,
  TaskListV3,
  TaskRecordV4,
  TaskStore,
  TaskStoreResult,
} from "../task-store.js";
import {
  createTaskModule,
  formatTaskRescheduleConfirmation,
  TASK_COMMAND_USAGE,
  TASK_REPEAT_COMMAND_USAGE,
  type TaskModuleOptions,
} from "./task-module.js";
import { reminderReadback } from "../reminder-speech.js";

function record(overrides: Partial<TaskRecordV4> = {}): TaskRecordV4 {
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
    acknowledgedAt: null,
    recurringTaskId: null,
    attempts: [],
    retryAt: null,
    notification: null,
    pendingOutcome: null,
    ...overrides,
  };
}

function list(): TaskListV3 {
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
        acknowledgedAt: null,
      },
    ],
    truncated: false,
  };
}

function resultList(): TaskListV3 {
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
        acknowledgedAt: null,
      },
      {
        id: "task-failed",
        promptPreview: "publish the release",
        runAt: "2026-09-12T02:00:00.000Z",
        status: "failed",
        finishedAt: "2026-09-12T02:01:00.000Z",
        resultPreview: null,
        error: { code: "TOOL_FAILED", messagePreview: "upstream unavailable" },
        acknowledgedAt: null,
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

function setup(overrides: Partial<TaskStore> = {}, options: TaskModuleOptions = {}): {
  tools: RegisteredTool[];
  commands: Map<string, { name: string; execute(args: string): void | Promise<void> }>;
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
    reschedule: callsFor("reschedule", {
      ok: true,
      value: record({ runAt: "2026-09-13T01:00:00.000Z" }),
    }),
    acknowledge: callsFor("acknowledge", {
      ok: true,
      value: record({ acknowledgedAt: "2026-09-12T02:00:00.000Z" }),
    }),
    claimNextDue: callsFor("claimNextDue", { ok: true, value: null }),
    finish: callsFor("finish", { ok: true, value: record() }),
    interruptRunning: callsFor("interruptRunning", { ok: true, value: 0 }),
    listRunning: callsFor("listRunning", { ok: true, value: [] }),
    getHealthCounts: callsFor("getHealthCounts", { ok: true, value: { unacknowledgedCount: 0, notificationFailureCount: 0 } }),
    recordRunId: callsFor("recordRunId", { ok: true, value: record() }),
    recordOutcome: callsFor("recordOutcome", { ok: true, value: record() }),
    retry: callsFor("retry", { ok: true, value: record() }),
    listNotifications: callsFor("listNotifications", { ok: true, value: [] }),
    recordNotification: callsFor("recordNotification", { ok: true, value: record() }),
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
  const commands = new Map<string, { name: string; execute(args: string): void | Promise<void> }>();
  const notifications: string[] = [];
  createTaskModule(store, options).setup({
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
  const reminder = { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } as const;
  const todoist = { kind: "todoist-brief", source: "todoist-planning", notification: "always", declarationVersion: 1 } as const;

  it("requires host-pinned Skill validation for model-created one-time and recurring schedules", async () => {
    const arrangement = { kind: "skill", source: "none", notification: "always", declarationVersion: 1,
      skillId: "brief", skillHash: "a".repeat(64) } as const;
    for (const name of ["task_create", "task_repeat_create"]) {
      const input = { prompt: "Use only this input", runAt: "2099-01-01T00:00:00Z",
        recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" } as const, arrangement };
      const unavailable = setup();
      const denied = await toolByName(unavailable.tools, name).tool.execute!(input, toolContext()) as { ok: boolean };
      assert.equal(denied.ok, false); assert.equal(unavailable.calls.length, 0);
      let checked = 0;
      const registered = setup({
        create: async value => ({ ok: true, value: record({ arrangement: value.arrangement! }) }),
        createRecurring: async value => ({ ok: true, value: recurringRecord({ arrangement: value.arrangement! }) }),
      }, { checkSkillArrangement: async (declaration, prompt) => {
        checked++; assert.deepEqual(declaration, arrangement); assert.equal(prompt, input.prompt);
        return { ok: true, value: null };
      } });
      const saved = await toolByName(registered.tools, name).tool.execute!(input, toolContext());
      assert.equal((saved as { ok: boolean }).ok, true); assert.equal(checked, 1);
      const schema = toolByName(registered.tools, name).tool.outputSchema as unknown as { safeParse(value: unknown): { success: boolean } };
      assert.equal(schema.safeParse(saved).success, true);
      const stale = setup({}, { checkSkillArrangement: async () => ({ ok: false, error: { code: "SKILL_CHANGED", message: "Reload the registered version" } }) });
      const failure = await toolByName(stale.tools, name).tool.execute!(input, toolContext());
      assert.equal((failure as { ok: boolean }).ok, false); assert.equal(stale.calls.length, 0);
    }
  });

  it("passes complete reminder arrangements through the existing create and recurring stores", async () => {
    const clock = { now: new Date("2026-09-11T01:00:00.000Z"), timeZone: "Asia/Shanghai" };
    const { tools, calls } = setup({
      create: async input => ({ ok: true, value: record({ prompt: input.prompt, arrangement: input.arrangement! }) }),
      createRecurring: async input => ({ ok: true, value: recurringRecord({ prompt: input.prompt, arrangement: input.arrangement! }) }),
    }, { now: () => clock.now, timeZone: clock.timeZone,
      afterArrangementSaved: async () => ({ enabled: true, ready: true }) });
    const one = { prompt: "喝水", runAt: "2026-09-12T01:00:00Z", arrangement: reminder };
    assert.deepEqual(await toolByName(tools, "task_create").tool.execute!(one, toolContext()), {
      ok: true,
      value: record({ prompt: "喝水", arrangement: reminder }),
      taskSaved: true, backgroundReady: true, service: { enabled: true, ready: true },
      readback: reminderReadback("schedule", { prompt: "喝水", runAt: "2026-09-12T01:00:00.000Z", clock }),
    });
    const repeated = { prompt: "喝水", recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" } as const, arrangement: reminder };
    assert.deepEqual(await toolByName(tools, "task_repeat_create").tool.execute!(repeated, toolContext()), {
      ok: true,
      value: recurringRecord({ prompt: "喝水", arrangement: reminder }),
      taskSaved: true, backgroundReady: true, service: { enabled: true, ready: true },
      readback: "已定：每天 9:00 提醒喝水",
    });
    assert.equal(calls.length, 0);
    const output = toolByName(tools, "task_create").tool.outputSchema as unknown as { parse(value: unknown): { value: { arrangement?: unknown } } };
    assert.deepEqual(output.parse({ ok: true, value: record({ arrangement: reminder }) }).value.arrangement, reminder);
  });

  it("rejects unavailable Todoist and rechecks host availability before saving", async () => {
    for (const options of [{}, { todoistPlanningAvailable: true, checkTodoistPlanningAvailable: async () => false }, { checkTodoistPlanningAvailable: async () => { throw new Error("status read failed"); } }]) {
      const { tools, calls } = setup({}, options);
      for (const name of ["task_create", "task_repeat_create"]) {
        const result = await toolByName(tools, name).tool.execute!({ prompt: "每日安排", runAt: "2026-09-12T01:00:00Z", recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" }, arrangement: todoist }, toolContext());
        assert.deepEqual(result, { ok: false, error: { code: "INVALID_INPUT", message: "The background Todoist planning source is unavailable; no arrangement was saved" } });
      }
      assert.equal(calls.length, 0);
    }
    const { tools, calls } = setup({}, { todoistPlanningAvailable: false, checkTodoistPlanningAvailable: async () => true });
    const input = { prompt: "每日安排", runAt: "2026-09-12T01:00:00Z", arrangement: todoist };
    assert.deepEqual(await toolByName(tools, "task_create").tool.execute!(input, toolContext()), { ok: true, value: record(), taskSaved: true, backgroundReady: false });
    assert.deepEqual(calls[0]?.args[0], input);
  });

  it("rejects RSS declarations and mismatched/extra source fields before any store write", async () => {
    const { tools, calls } = setup({}, { todoistPlanningAvailable: true });
    for (const arrangement of [{ kind: "rss-digest", source: "existing-rss-binding", notification: "new-items", declarationVersion: 1 }, { ...reminder, source: "todoist-planning" }, { ...reminder, allowShell: true }, { ...todoist, declarationVersion: 2 }]) {
      const tool = toolByName(tools, "task_create").tool;
      const schema = tool.inputSchema as unknown as { safeParse(value: unknown): { success: boolean } };
      const input = { prompt: "安排", runAt: "2026-09-12T01:00:00Z", arrangement };
      assert.equal(schema.safeParse(input).success, false);
      const result = await tool.execute!(input, toolContext()) as { ok: boolean };
      assert.equal(result.ok, false);
    }
    assert.equal(calls.length, 0);
  });

  it("runs service setup only after a typed arrangement commits, exposing failure without rollback", async () => {
    for (const fail of [false, true]) {
      let enabled = 0;
      const { tools, calls } = setup({}, { afterArrangementSaved: async saved => {
        enabled += 1; assert.equal(calls[0]?.method, "create");
        assert.deepEqual(saved, { kind: "once", task: record() }, "host receives the committed record, not model destination arguments");
        if (fail) throw new Error("launchd unavailable");
        return { enabled: true };
      } });
      const create = toolByName(tools, "task_create"); assert.equal(create.metadata.timeoutMs, 30_000);
      const result = await create.tool.execute!({ prompt: "喝水", runAt: "2026-09-12T01:00:00Z", arrangement: reminder }, toolContext()) as { ok: boolean; value: unknown; service: { enabled: boolean; message?: string } };
      assert.equal(result.ok, true); assert.deepEqual(result.value, record()); assert.equal(result.service.enabled, !fail);
      if (fail) assert.match(result.service.message!, /Arrangement saved.*launchd unavailable/);
      assert.equal(enabled, 1);
      const schema = create.tool.outputSchema as unknown as { safeParse(value: unknown): { success: boolean } };
      assert.equal(schema.safeParse(result).success, true);
      await create.tool.execute!({ prompt: "legacy", runAt: "2026-09-12T01:00:00Z" }, toolContext());
      assert.equal(enabled, 1);
    }
    let enabled = 0;
    const { tools } = setup({ create: async () => ({ ok: false, error: { code: "INVALID_INPUT", message: "invalid date" } }) }, { afterArrangementSaved: async () => { enabled += 1; return { enabled: true }; } });
    const result = await toolByName(tools, "task_create").tool.execute!({ prompt: "喝水", runAt: "bad", arrangement: reminder }, toolContext());
    assert.deepEqual(result, { ok: false, error: { code: "INVALID_INPUT", message: "invalid date" } }); assert.equal(enabled, 0);
  });

  it("Demo: saved reminder with unavailable background keeps the warning in its readback", async () => {
    const saved = record({ arrangement: reminder, prompt: "喝水" });
    const { tools } = setup({ create: async () => ({ ok: true, value: saved }) }, {
      afterArrangementSaved: async () => ({ enabled: false, message: "后台配置路径含符号链接" }),
    });
    const create = toolByName(tools, "task_create");
    const result = await create.tool.execute!({ prompt: "喝水", runAt: saved.runAt, arrangement: reminder }, toolContext()) as {
      ok: boolean; taskSaved?: boolean; backgroundReady?: boolean; readback?: string;
    };
    assert.equal(result.ok, true, "saving is not rolled back by service failure");
    assert.match(result.readback ?? "", /后台.*不可用|后台.*未就绪/);
    assert.equal(result.taskSaved, true);
    assert.equal(result.backgroundReady, false);
    assert.equal((create.tool.outputSchema as unknown as { safeParse(value: unknown): { success: boolean } }).safeParse(result).success, true);
  });

  it("Demo: rescheduling/resuming checks readiness without enabling or replaying a worker", async () => {
    const saved = record({ arrangement: reminder, prompt: "喝水" });
    let enables = 0, checks = 0;
    const { tools } = setup({ reschedule: async () => ({ ok: true, value: saved }),
      resumeRecurring: async () => ({ ok: true, value: recurringRecord({ arrangement: reminder }) }) }, {
      afterArrangementSaved: async () => { enables++; return { enabled: true, ready: true }; },
      backgroundStatus: async () => { checks++; return { ready: false }; },
    });
    for (const [name, input] of [["task_reschedule", { id: saved.id, runAt: saved.runAt }], ["task_repeat_resume", { id: "repeat-1" }]] as const) {
      const result = await toolByName(tools, name).tool.execute!(input, toolContext()) as { taskSaved: boolean; backgroundReady: boolean; readback: string };
      assert.equal(result.taskSaved, true); assert.equal(result.backgroundReady, false);
      assert.match(result.readback, /后台当前不可用或尚未就绪/);
    }
    assert.equal(checks, 2); assert.equal(enables, 0);
  });

  it("cancels before a save but settles service setup after an already committed arrangement", async () => {
    const before = new AbortController();
    const canceled = setup({}, { checkTodoistPlanningAvailable: async () => { before.abort(new Error("cancel before save")); return true; } });
    await assert.rejects(toolByName(canceled.tools, "task_create").tool.execute!({ prompt: "日报", runAt: "2026-09-12T01:00:00Z", arrangement: todoist }, toolContext(before.signal)) as Promise<unknown>, /cancel before save/);
    assert.equal(canceled.calls.length, 0);
    const after = new AbortController(); let serviceCalls = 0;
    const clock = { now: new Date("2026-09-11T01:00:00.000Z"), timeZone: "Asia/Shanghai" };
    const committed = setup({ create: async () => { after.abort(new Error("cancel after save")); return { ok: true, value: record({ arrangement: reminder }) }; } }, {
      afterArrangementSaved: async () => { serviceCalls += 1; return { enabled: true, ready: true }; },
      now: () => clock.now,
      timeZone: clock.timeZone,
    });
    const result = await toolByName(committed.tools, "task_create").tool.execute!({ prompt: "喝水", runAt: "2026-09-12T01:00:00Z", arrangement: reminder }, toolContext(after.signal));
    assert.deepEqual(result, {
      ok: true,
      value: record({ arrangement: reminder }),
      service: { enabled: true, ready: true }, taskSaved: true, backgroundReady: true,
      readback: reminderReadback("schedule", { prompt: record().prompt, runAt: record().runAt, clock }),
    });
    assert.equal(serviceCalls, 1);
  });

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
          name: "task_reschedule",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "task_ack",
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
    const reschedule = toolByName(tools, "task_reschedule").tool;
    const acknowledge = toolByName(tools, "task_ack").tool;

    assert.deepEqual(
      await create.execute!({ prompt: "p", runAt: "2026-09-12T01:00:00+00:00" }, context),
      { ok: true, value: record() },
    );
    assert.deepEqual(await listTool.execute!({ status: "pending", limit: 2 }, context), {
      ok: true,
      value: list(),
    });
    assert.deepEqual(await listTool.execute!({ inbox: true }, context), {
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
    assert.deepEqual(await reschedule.execute!({ id: "task-1", runAt: "2026-09-13T09:00:00+08:00" }, context), {
      ok: true,
      value: record({ runAt: "2026-09-13T01:00:00.000Z" }),
    });
    assert.deepEqual(await acknowledge.execute!({ id: "task-1" }, context), {
      ok: true,
      value: record({ acknowledgedAt: "2026-09-12T02:00:00.000Z" }),
    });
    assert.deepEqual(calls.map(({ method, args }) => ({ method, args })), [
      {
        method: "create",
        args: [{ prompt: "p", runAt: "2026-09-12T01:00:00+00:00" }, context.abortSignal],
      },
      { method: "list", args: [{ status: "pending", limit: 2 }] },
      { method: "list", args: [{ inbox: true }] },
      { method: "get", args: ["task-1"] },
      { method: "cancel", args: ["task-1", context.abortSignal] },
      { method: "reschedule", args: ["task-1", "2026-09-13T09:00:00+08:00", context.abortSignal] },
      { method: "acknowledge", args: ["task-1", context.abortSignal] },
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

  it("awaits task command results before returning to the TUI", async () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    const create = command.execute(
      "create 2026-09-12T09:00:00+08:00 prepare a detailed learning plan",
    );
    assert.deepEqual(notifications, []);
    await create;
    assert.equal(calls[0]?.method, "create");
    assert.deepEqual(calls[0]?.args, [
      {
        runAt: "2026-09-12T09:00:00+08:00",
        prompt: "prepare a detailed learning plan",
      },
    ]);
    assert.match(notifications[0] ?? "", /^Task created:/);

    await command.execute("list completed");
    await command.execute("show task-1");
    await command.execute("cancel task-1");
    assert.match(notifications[1] ?? "", /Tasks: 1/);
    assert.match(notifications[2] ?? "", /^Task: task-1/);
    assert.match(notifications[3] ?? "", /^Task cancelled:/);
  });

  it("supports inbox and ack commands through the same async notification path", async () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    const inbox = command.execute("inbox");
    const ack = command.execute("ack task-1");
    assert.deepEqual(notifications, []);
    await Promise.all([inbox, ack]);

    assert.deepEqual(calls, [
      { method: "list", args: [{ inbox: true }] },
      { method: "acknowledge", args: ["task-1"] },
    ]);
    assert.match(notifications[0] ?? "", /Tasks: 1/);
    assert.match(notifications[1] ?? "", /^Task acknowledged:/);
  });

  it("reschedules directly from the idle command and reports observed old and committed new time", async () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    const reschedule = command.execute("reschedule task-1 2026-09-13T09:00:00+08:00");
    assert.deepEqual(notifications, []);
    await reschedule;

    assert.deepEqual(calls, [
      { method: "get", args: ["task-1"] },
      { method: "reschedule", args: ["task-1", "2026-09-13T09:00:00+08:00"] },
    ]);
    assert.deepEqual(notifications, [
      "Task rescheduled: ID: task-1; previous runAt (observed): 2026-09-12T01:00:00.000Z; new runAt: 2026-09-13T01:00:00.000Z",
    ]);
  });

  it("does not reschedule when the idle command cannot read the task", async () => {
    const { commands, notifications, calls } = setup({
      get: async () => ({ ok: false, error: { code: "TASK_NOT_FOUND", message: "Missing task" } }),
    });
    const command = commands.get("task");
    assert.ok(command);
    command.execute("reschedule task-missing 2026-09-13T09:00:00+08:00");
    await settle();
    assert.deepEqual(calls, []);
    assert.deepEqual(notifications, ["TASK_NOT_FOUND: Missing task"]);
  });

  it("shows old and requested time in the run confirmation without claiming the preview reserves the task", () => {
    const prompt = formatTaskRescheduleConfirmation(
      { id: "task-1", runAt: "2026-09-13T09:00:00+08:00" },
      { ok: true, value: record() },
    );
    assert.match(prompt, /ID: "task-1"/);
    assert.match(prompt, /Current runAt \(preview\): "2026-09-12T01:00:00.000Z"/);
    assert.match(prompt, /Requested runAt: "2026-09-13T09:00:00\+08:00"/);
    assert.match(prompt, /store rechecks task status under its lock/);
    assert.match(prompt, /Allow this call\? \[y\/n\]/);
  });

  it("supports repeat create/list/show/pause/resume/cancel commands", async () => {
    const { commands, notifications, calls } = setup();
    const command = commands.get("task");
    assert.ok(command);

    const executions = [
      command.execute("repeat create daily 09:00 +08:00 prepare today"),
      command.execute("repeat create weekly 1 10:30 -05:00 plan the week"),
      command.execute("repeat list paused"),
      command.execute("repeat show repeat-1"),
      command.execute("repeat pause repeat-1"),
      command.execute("repeat resume repeat-1"),
      command.execute("repeat cancel repeat-1"),
    ];
    assert.deepEqual(notifications, []);
    await Promise.all(executions);

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
    assert.match(notifications[0] ?? "", /Acknowledged at: —/);
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
      acknowledgedAt: "2026-09-12T01:02:10.000Z",
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
    assert.match(notifications[0] ?? "", /Acknowledged at: 2026-09-12T01:02:10.000Z/);
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
    command.execute("inbox extra");
    command.execute("ack");
    command.execute("cancel");
    command.execute("reschedule task-1");
    command.execute("reschedule task-1 2026-09-13T09:00:00+08:00 extra");
    assert.deepEqual(notifications, [
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
      TASK_COMMAND_USAGE,
    ]);
    assert.deepEqual(calls, []);
  });

  it("turns a rejected async command operation into a notification", async () => {
    const failure: TaskStoreResult<TaskRecordV4> = {
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

  it("keeps /task show pending until its result has been printed", async () => {
    let finish!: (result: TaskStoreResult<TaskRecordV4>) => void;
    const pending = new Promise<TaskStoreResult<TaskRecordV4>>((resolve) => {
      finish = resolve;
    });
    const { commands, notifications } = setup({ get: async () => pending });
    const command = commands.get("task");
    assert.ok(command);

    const execution = command.execute("show task-1");
    assert.ok(execution instanceof Promise);
    await settle();
    assert.deepEqual(notifications, []);
    finish({ ok: true, value: record() });
    await execution;
    assert.match(notifications[0] ?? "", /Task: task-1/);
  });
});
