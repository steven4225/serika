import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type {
  TaskList,
  TaskRecord,
  TaskStore,
  TaskStoreResult,
} from "../task-store.js";
import {
  createTaskModule,
  TASK_COMMAND_USAGE,
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
      },
    ],
    truncated: false,
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
  it("registers the four task tools and command with frozen metadata", () => {
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
    assert.deepEqual(await listTool.execute!({ status: "scheduled", limit: 2 }, context), {
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
      { method: "list", args: [{ status: "scheduled", limit: 2 }] },
      { method: "get", args: ["task-1"] },
      { method: "cancel", args: ["task-1", context.abortSignal] },
    ]);
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
    assert.match(notifications[1] ?? "", /truncated/);
    assert.match(notifications[2] ?? "", /^\{"id":"task-1"/);
    assert.match(notifications[3] ?? "", /^Task cancelled:/);
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
