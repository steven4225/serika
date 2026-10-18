import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolExecutionOptions } from "ai";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { createModuleHost, type ToolPermissionFacts } from "../module-host.js";
import { todoistPlanSaveInstructions } from "../todoist-plan-save-instructions.js";
import { createReadFileModule } from "./read-file-module.js";
import type { TodoistListResult } from "../todoist.js";
import { assembleTodoist, createTodoistModule, resolveConfiguredTodoistTimeZone, resolveShorthandTodoistTimeZone, todoistModuleConfigSchema, todoistTimeZoneFromEnv } from "./todoist-module.js";

const fixedNow = () => new Date("2026-09-11T01:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function asFetch(
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): typeof globalThis.fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return handler(url, init);
  }) as typeof globalThis.fetch;
}

function oneTaskFetch(title = "准备周报"): typeof globalThis.fetch {
  return asFetch(async (url) => {
    if (url.endsWith("/api/v1/user")) {
      return jsonResponse({ id: "user-1", token: "must-not-leak" });
    }
    assert.match(url, /\/api\/v1\/tasks\?/);
    return jsonResponse({
      results: [
        {
          id: "task-1",
          project_id: "shared-project",
          responsible_uid: null,
          checked: false,
          is_deleted: false,
          content: title,
          priority: 4,
          due: {
            date: "2026-09-11",
            is_recurring: false,
            timezone: null,
          },
          deadline: { date: "2026-09-14" },
        },
      ],
      next_cursor: null,
    });
  });
}

function makeTest(fetch: typeof globalThis.fetch) {
  const notifications: string[] = [];
  const host = createModuleHost(
    [
      createTodoistModule({
        apiToken: "todoist-token",
        timeZone: "Asia/Shanghai",
        now: fixedNow,
        fetch,
      }),
    ],
    { notify: (_moduleId, message) => notifications.push(message) },
  );
  return { host, notifications };
}

function toolOptions(
  signal = new AbortController().signal,
): ToolExecutionOptions<unknown> {
  return {
    toolCallId: "call-todoist",
    messages: [],
    abortSignal: signal,
    context: {},
  };
}

function executeTool(
  registeredTool: RegisteredTool["tool"],
  input: unknown,
  options: unknown,
): Promise<unknown> {
  const execute = registeredTool.execute as unknown as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  return execute(input, options);
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("createTodoistModule", () => {
  it("registers one strict read-only tool and the todoist command", async () => {
    const { host } = makeTest(oneTaskFetch());
    assert.deepEqual(host.tools.map(({ metadata }) => metadata), [
      {
        name: "todoist_list_tasks",
        version: "1",
        risk: "read",
        timeoutMs: 20_000,
        idempotent: true,
      },
    ]);
    assert.ok(host.commands.has("todoist"));

    const registered = host.tools[0];
    assert.ok(registered);
    const schema = registered.tool.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    assert.equal(schema.safeParse({}).success, true);
    assert.equal(schema.safeParse({ view: "planning" }).success, true);
    assert.equal(schema.safeParse({ view: "tomorrow" }).success, false);
    assert.equal(
      schema.safeParse({ view: "today", token: "not-allowed" }).success,
      false,
    );

    const result = (await executeTool(
      registered.tool,
      { view: "today" },
      toolOptions(),
    )) as TodoistListResult;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.view, "today");
      assert.deepEqual(
        result.value.tasks.map((task) => [task.title, task.projectId]),
        [["准备周报", "shared-project"]],
      );
    }
    host.dispose();
  });

  it("declares the read card and adds the plan-save flow only beside the file tools", () => {
    const { host } = makeTest(oneTaskFetch());
    const declared = host.toolPermissions.get("todoist_list_tasks")!;
    assert.equal(declared.defaults, undefined);
    assert.equal(declared.confirmation!({ toolName: "todoist_list_tasks", input: { view: "planning" } } as Parameters<NonNullable<ToolPermissionFacts["confirmation"]>>[0]),
      '\nTool: todoist_list_tasks\nInput: {"view":"planning"}\nReading Todoist tasks will place their contents in the model context ' +
      "and the successful Run's committed transcript.\nAllow this call? [y/n] ");
    assert.match(host.instructions("todoist"), /^ When Todoist is available/);
    assert.doesNotMatch(host.instructions("todoist"), /Todoist-to-Markdown|explicit workspace-relative \.md path/);
    host.dispose();
    const withFiles = createModuleHost([createTodoistModule({ apiToken: "t", timeZone: "Asia/Shanghai" }), createReadFileModule("/tmp")], { notify() {} });
    assert.ok(withFiles.instructions("todoist").endsWith(` ${todoistPlanSaveInstructions}`));
    withFiles.dispose();
  });

  it("forwards the tool AbortSignal to the shared query", async () => {
    let calls = 0;
    const { host } = makeTest(
      asFetch(async () => {
        calls += 1;
        return jsonResponse({ id: "user-1" });
      }),
    );
    const registered = host.tools[0];
    assert.ok(registered);
    const controller = new AbortController();
    const reason = new Error("stop todoist query");
    controller.abort(reason);

    await assert.rejects(
      executeTool(registered.tool, { view: "planning" }, toolOptions(controller.signal)),
      reason,
    );
    assert.equal(calls, 0);
    host.dispose();
  });

  it("aborts an active tool query when the module is disposed", async () => {
    let requestSignal: AbortSignal | undefined;
    const { host } = makeTest(
      asFetch((_url, init) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      }),
    );
    const registered = host.tools[0];
    assert.ok(registered);

    const pending = executeTool(registered.tool, {}, toolOptions());
    assert.ok(requestSignal);
    host.dispose();

    assert.equal(requestSignal.aborted, true);
    await assert.rejects(pending, { name: "AbortError" });
  });

  it("waits for the direct command notification and escapes task control characters", async () => {
    const { host, notifications } = makeTest(
      oneTaskFetch("准备\n周报\u001b[31m"),
    );
    const command = host.commands.get("todoist");
    assert.ok(command);

    const completed = command.execute("list today");
    assert.deepEqual(notifications, []);
    await completed;

    assert.equal(notifications.length, 1);
    const output = notifications[0] ?? "";
    assert.match(output, /Todoist 视图: today/);
    assert.match(output, /规划时区: Asia\/Shanghai/);
    assert.match(output, /基准日期: 2026-09-11/);
    assert.match(output, /日期范围: \[2026-09-11, 2026-09-12\)/);
    assert.match(output, /返回任务数: 1/);
    assert.match(output, /完整性: 完整/);
    assert.match(output, /准备\\n周报\\u001b\[31m/);
    assert.match(output, /项目 ID: shared-project/);
    assert.match(output, /优先级: p1/);
    assert.match(output, /截止日期: 2026-09-14/);
    assert.match(output, /来源: https:\/\/app\.todoist\.com\/app\/task\/task-1/);
    assert.doesNotMatch(output, /must-not-leak/);
    assert.doesNotMatch(output, /\u001b/);
    host.dispose();
  });

  it("marks an empty page-limited result as incomplete instead of empty", async () => {
    let taskPage = 0;
    const { host, notifications } = makeTest(
      asFetch(async (url) => {
        if (url.endsWith("/api/v1/user")) return jsonResponse({ id: "user-1" });
        taskPage += 1;
        return jsonResponse({
          results: [],
          next_cursor: `cursor-${taskPage}`,
        });
      }),
    );
    const command = host.commands.get("todoist");
    assert.ok(command);

    command.execute("list");
    await flushAsyncWork();

    assert.equal(taskPage, 5);
    assert.equal(notifications.length, 1);
    const output = notifications[0] ?? "";
    assert.match(output, /Todoist 视图: planning/);
    assert.match(output, /返回任务数: 0/);
    assert.match(output, /完整性: 不完整/);
    assert.match(output, /不能据此判断没有任务/);
    assert.doesNotMatch(output, /此日期范围内没有匹配任务/);
    host.dispose();
  });

  it("shows usage for invalid command input without making a request", () => {
    let calls = 0;
    const { host, notifications } = makeTest(
      asFetch(async () => {
        calls += 1;
        return jsonResponse({ id: "user-1" });
      }),
    );
    const command = host.commands.get("todoist");
    assert.ok(command);

    command.execute("");
    command.execute("list tomorrow");
    command.execute("list today extra");
    command.execute("complete today");

    assert.equal(calls, 0);
    assert.deepEqual(notifications, [
      "Usage: /todoist list [planning|today|overdue|upcoming]",
      "Usage: /todoist list [planning|today|overdue|upcoming]",
      "Usage: /todoist list [planning|today|overdue|upcoming]",
      "Usage: /todoist list [planning|today|overdue|upcoming]",
    ]);
    host.dispose();
  });

  it("aborts an active command and suppresses its late notification on dispose", async () => {
    let resolveUser: ((response: Response) => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const { host, notifications } = makeTest(
      asFetch((_url, init) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((resolve) => {
          resolveUser = resolve;
        });
      }),
    );
    const command = host.commands.get("todoist");
    assert.ok(command);

    command.execute("list today");
    assert.ok(requestSignal);
    host.dispose();
    assert.equal(requestSignal.aborted, true);
    assert.ok(resolveUser);
    resolveUser(jsonResponse({ id: "user-1" }));
    await flushAsyncWork();

    assert.deepEqual(notifications, []);
  });

  it("enforces one 20 second timeout for a direct command", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let requestSignal: AbortSignal | undefined;
    const { host, notifications } = makeTest(
      asFetch((_url, init) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(requestSignal?.reason),
            { once: true },
          );
        });
      }),
    );
    const command = host.commands.get("todoist");
    assert.ok(command);

    command.execute("list today");
    assert.ok(requestSignal);
    context.mock.timers.tick(20_000);

    assert.equal(requestSignal.aborted, true);
    assert.deepEqual(notifications, ["Todoist 查询超时。"]);
    await Promise.resolve();
    host.dispose();
    context.mock.timers.reset();
  });
});

describe("assembleTodoist (architecture-v2 §4.4 step 2)", () => {
  it("reads the token only from the env the assembler passes", () => {
    const saved = process.env.TODOIST_API_TOKEN;
    process.env.TODOIST_API_TOKEN = "process-token";
    try {
      assert.throws(() => assembleTodoist({ enabled: true, timeZone: "Asia/Shanghai", env: {} }),
        /^Error: TODOIST_API_TOKEN is required when Todoist is enabled$/);
      assert.throws(() => assembleTodoist({ enabled: true, timeZone: "Asia/Shanghai", env: { TODOIST_API_TOKEN: "  " } }),
        /TODOIST_API_TOKEN is required/);
      const disabled = assembleTodoist({ enabled: false, timeZone: null, env: {} });
      assert.equal(disabled.module, undefined);
      assert.equal(disabled.statusLines.token, "Todoist token: missing");
    } finally {
      if (saved === undefined) delete process.env.TODOIST_API_TOKEN; else process.env.TODOIST_API_TOKEN = saved;
    }
  });

  it("owns the /modules lines, the planning fact and the capability entry", () => {
    const disabled = assembleTodoist({ enabled: false, timeZone: null, env: { TODOIST_API_TOKEN: "t" } });
    assert.deepEqual(disabled.statusLines, { module: "todoist: disabled", timeZone: "Todoist 规划时区: 未启用", token: "Todoist token: present" });
    assert.deepEqual(disabled.planning(), { available: false });
    assert.deepEqual(disabled.capability([]), { id: "todoist", enabled: false, registeredTools: [], state: "disabled" });
    const enabled = assembleTodoist({ enabled: true, timeZone: "Asia/Tokyo", env: { TODOIST_API_TOKEN: " t " } });
    assert.equal(enabled.module?.id, "todoist");
    assert.equal(enabled.planning().available, true);
    const check = async () => false;
    assert.deepEqual(enabled.planning(check), { available: true, check });
    assert.deepEqual(enabled.statusLines, { module: "todoist: enabled", timeZone: "Todoist 规划时区: Asia/Tokyo", token: "Todoist token: present" });
    assert.deepEqual(enabled.capability(["todoist_list_tasks"]), { id: "todoist", enabled: true, registeredTools: ["todoist_list_tasks"], state: "registered" });
    assert.equal(enabled.capability([]).state, "not_registered");
  });

  it("resolves the time zone exactly as the config format always did", () => {
    assert.equal(resolveConfiguredTodoistTimeZone(false, { enabled: false, timeZone: "Asia/Tokyo" }), null);
    assert.equal(resolveConfiguredTodoistTimeZone(true, { enabled: true }), "Asia/Shanghai");
    assert.equal(resolveConfiguredTodoistTimeZone(true, { enabled: true, timeZone: "UTC" }), "UTC");
    assert.throws(() => resolveConfiguredTodoistTimeZone(true, { enabled: true, timeZone: "No/Such_Zone" }), /^Error: Invalid Todoist time zone$/);
    assert.equal(resolveShorthandTodoistTimeZone(true, undefined), "Asia/Shanghai");
    assert.equal(resolveShorthandTodoistTimeZone(true, "  "), "Asia/Shanghai");
    assert.equal(resolveShorthandTodoistTimeZone(true, " Asia/Tokyo "), "Asia/Tokyo");
    assert.equal(todoistTimeZoneFromEnv({ RUNLOOM_TODOIST_TIMEZONE: "  " }), undefined);
    assert.equal(todoistTimeZoneFromEnv({ RUNLOOM_TODOIST_TIMEZONE: " UTC " }), "UTC");
    assert.equal(todoistModuleConfigSchema.safeParse({ enabled: true, timeZone: " " }).success, false);
    assert.equal(todoistModuleConfigSchema.safeParse({ enabled: true, extra: 1 }).success, false);
  });
});
