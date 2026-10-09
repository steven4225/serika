import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolExecutionOptions } from "ai";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import { createModuleHost } from "../module-host.js";
import {
  createPomodoroModule,
  createPomodoroService,
  type PomodoroModuleOptions,
  type PomodoroResult,
} from "./pomodoro-module.js";

type FakeTimer = { callback: () => void; at: number };

type FakeClock = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: unknown) => void;
  advance: (ms: number) => void;
  pending: () => number;
};

function fakeClock(start = 0): FakeClock {
  let current = start;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();

  const runDueTimers = (): void => {
    for (const [id, timer] of [...timers]) {
      if (timer.at > current) continue;
      timers.delete(id);
      timer.callback();
    }
  };

  return {
    now: () => current,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { callback, at: current + delayMs });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") timers.delete(handle);
    },
    advance(ms) {
      current += ms;
      runDueTimers();
    },
    pending: () => timers.size,
  };
}

function makeTest(
  options: Omit<PomodoroModuleOptions, "now" | "setTimeout" | "clearTimeout"> = {},
) {
  const clock = fakeClock();
  const notifications: string[] = [];
  const host = createModuleHost(
    [
      createPomodoroModule({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        desktopNotifier: () => undefined,
        ...options,
      }),
    ],
    { notify: (_moduleId, message) => notifications.push(message) },
  );
  return { clock, host, notifications };
}

function toolByName(
  tools: readonly RegisteredTool[],
  name: string,
): RegisteredTool["tool"] {
  const registered = tools.find((entry) => entry.metadata.name === name);
  assert.ok(registered);
  return registered.tool;
}

function toolOptions(
  signal = new AbortController().signal,
): ToolExecutionOptions<unknown> {
  return {
    toolCallId: "call-pomodoro",
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

function result(value: unknown): PomodoroResult {
  return value as PomodoroResult;
}

describe("createPomodoroModule", () => {
  it("keeps host-owned state across disposal and routes completion only to the new adapter", async () => {
    const clock = fakeClock();
    const desktopCalls: string[] = [];
    const service = createPomodoroService({ ...clock, desktopNotifier: message => desktopCalls.push(message) });
    const oldMessages: string[] = [];
    const oldHost = createModuleHost([createPomodoroModule({ service })], {
      notify: (_id, message) => oldMessages.push(message),
    });
    const started = result(await executeTool(toolByName(oldHost.tools, "pomodoro_start"), { minutes: 1 }, toolOptions()));
    oldHost.dispose();
    assert.equal(clock.pending(), 1);
    clock.advance(10_000);
    const newMessages: string[] = [];
    const newHost = createModuleHost([createPomodoroModule({ service })], {
      notify: (_id, message) => newMessages.push(message),
    });
    try {
      const current = result(await executeTool(toolByName(newHost.tools, "pomodoro_status"), {}, toolOptions()));
      assert.equal(current.status.state, "running");
      if (current.status.state === "running" && started.status.state === "running") {
        assert.equal(current.status.endsAt, started.status.endsAt);
        assert.equal(current.status.remainingSeconds, 50);
      }
      clock.advance(50_000);
      assert.deepEqual(oldMessages, []);
      assert.deepEqual(newMessages, ["番茄钟结束，已完成 1 分钟专注。"]);
      assert.deepEqual(desktopCalls, newMessages);
      assert.equal(clock.pending(), 0);
    } finally { newHost.dispose(); service.dispose(); }
  });

  it("notifies outside a module lifetime and lets the owner cancel or dispose explicitly", () => {
    const clock = fakeClock();
    const desktopCalls: string[] = [];
    const service = createPomodoroService({ ...clock, desktopNotifier: message => desktopCalls.push(message) });
    const host = createModuleHost([createPomodoroModule({ service })], { notify: () => undefined });
    service.start(1);
    host.dispose();
    clock.advance(60_000);
    assert.equal(desktopCalls.length, 1);
    assert.equal(service.status().status.state, "idle");
    service.start(1);
    assert.equal(service.cancel().outcome, "cancelled");
    clock.advance(60_000);
    assert.equal(desktopCalls.length, 1);
    service.start(1);
    service.dispose();
    service.dispose();
    clock.advance(60_000);
    assert.equal(desktopCalls.length, 1);
    assert.equal(clock.pending(), 0);
    assert.throws(() => service.start(), /disposed/);
  });

  it("registers the three tools and pomodoro command with required metadata", () => {
    const { host } = makeTest();

    assert.deepEqual(
      host.tools.map(({ metadata }) => metadata),
      [
        {
          name: "pomodoro_start",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: false,
        },
        {
          name: "pomodoro_status",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "pomodoro_cancel",
          version: "1",
          timeoutMs: 1_000,
          risk: "write",
          idempotent: false,
        },
      ],
    );
    assert.ok(host.commands.has("pomodoro"));
    host.dispose();
  });

  it("shares state between commands and tools and starts immediately", async () => {
    const { host, notifications } = makeTest();
    const startTool = toolByName(host.tools, "pomodoro_start");
    const statusTool = toolByName(host.tools, "pomodoro_status");
    const cancelTool = toolByName(host.tools, "pomodoro_cancel");
    const options = toolOptions();

    assert.deepEqual(
      result(await executeTool(startTool, { minutes: 40 }, options)),
      {
        outcome: "started",
        status: {
          state: "running",
          durationMinutes: 40,
          endsAt: new Date(40 * 60_000).toISOString(),
          remainingSeconds: 2_400,
        },
      },
    );
    assert.equal(
      result(await executeTool(statusTool, {}, options)).status.state,
      "running",
    );
    const command = host.commands.get("pomodoro");
    assert.ok(command);
    command.execute("status");
    assert.match(notifications[0] ?? "", /剩余 2400 秒/);
    assert.deepEqual(
      result(await executeTool(cancelTool, {}, options)),
      { outcome: "cancelled", status: { state: "idle" } },
    );
    assert.equal(notifications.length, 1);
    host.dispose();
  });

  it("uses the default duration and refuses a second start", async () => {
    const { host, clock } = makeTest();
    const startTool = toolByName(host.tools, "pomodoro_start");
    const options = toolOptions();

    const first = result(await executeTool(startTool, {}, options));
    assert.equal(first.outcome, "started");
    if (first.status.state === "running") {
      assert.equal(first.status.durationMinutes, 25);
      assert.equal(first.status.remainingSeconds, 1_500);
    }
    assert.equal(
      result(await executeTool(startTool, { minutes: 40 }, options)).outcome,
      "already_running",
    );
    assert.equal(clock.pending(), 1);
    host.dispose();
  });

  it("rounds remaining seconds up and notifies once when the timer fires", async () => {
    const { host, clock, notifications } = makeTest();
    const startTool = toolByName(host.tools, "pomodoro_start");
    const statusTool = toolByName(host.tools, "pomodoro_status");
    const options = toolOptions();

    await executeTool(startTool, { minutes: 1 }, options);
    clock.advance(59_001);
    const current = result(await executeTool(statusTool, {}, options));
    assert.equal(current.status.state, "running");
    if (current.status.state === "running") {
      assert.equal(current.status.remainingSeconds, 1);
    }
    assert.deepEqual(notifications, []);

    clock.advance(999);
    assert.deepEqual(notifications, ["番茄钟结束，已完成 1 分钟专注。"]);
    assert.deepEqual(result(await executeTool(statusTool, {}, options)), {
      outcome: "status",
      status: { state: "idle" },
    });
    assert.deepEqual(notifications, ["番茄钟结束，已完成 1 分钟专注。"]);
    host.dispose();
  });

  it("sends a desktop notification and sound request when the timer ends", async () => {
    const desktopCalls: string[] = [];
    const { host, clock } = makeTest({
      desktopNotifier: (message) => desktopCalls.push(message),
    });
    const startTool = toolByName(host.tools, "pomodoro_start");

    await executeTool(startTool, { minutes: 1 }, toolOptions());
    clock.advance(60_000);

    assert.deepEqual(desktopCalls, ["番茄钟结束，已完成 1 分钟专注。"]);
    host.dispose();
  });

  it("reports desktop failures after completion without keeping the timer running", async () => {
    const { host, clock, notifications } = makeTest({
      desktopNotifier: (_message, onFailure) => {
        onFailure("notification", new Error("notification unavailable"));
        onFailure("sound", new Error("sound unavailable"));
      },
    });
    const startTool = toolByName(host.tools, "pomodoro_start");
    const statusTool = toolByName(host.tools, "pomodoro_status");

    await executeTool(startTool, { minutes: 1 }, toolOptions());
    clock.advance(60_000);

    assert.deepEqual(notifications, [
      "番茄钟结束，已完成 1 分钟专注。",
      "桌面通知发送失败：notification unavailable",
      "提示音发送失败：sound unavailable",
    ]);
    assert.deepEqual(result(await executeTool(statusTool, {}, toolOptions())), {
      outcome: "status",
      status: { state: "idle" },
    });
    host.dispose();
  });

  it("cancels and disposes without a completion notification", async () => {
    const { host, clock, notifications } = makeTest();
    const startTool = toolByName(host.tools, "pomodoro_start");
    const cancelTool = toolByName(host.tools, "pomodoro_cancel");
    const options = toolOptions();

    await executeTool(startTool, {}, options);
    await executeTool(cancelTool, {}, options);
    clock.advance(25 * 60_000);
    assert.deepEqual(notifications, []);
    assert.deepEqual(result(await executeTool(cancelTool, {}, options)), {
      outcome: "not_running",
      status: { state: "idle" },
    });

    await executeTool(startTool, {}, options);
    host.dispose();
    clock.advance(25 * 60_000);
    assert.deepEqual(notifications, []);
    assert.equal(clock.pending(), 0);
  });

  it("does not start when the tool signal is already aborted", async () => {
    const { host, clock } = makeTest();
    const startTool = toolByName(host.tools, "pomodoro_start");
    const statusTool = toolByName(host.tools, "pomodoro_status");
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await assert.rejects(
      executeTool(startTool, {}, toolOptions(controller.signal)),
      /stop/,
    );
    assert.deepEqual(
      result(await executeTool(statusTool, {}, toolOptions())),
      { outcome: "status", status: { state: "idle" } },
    );
    assert.equal(clock.pending(), 0);
    host.dispose();
  });

  it("keeps invalid command input from changing state", () => {
    const { host, notifications, clock } = makeTest();
    const command = host.commands.get("pomodoro");
    assert.ok(command);

    command.execute("start 0");
    command.execute("start 1 2");
    command.execute("unknown");
    command.execute("");
    assert.deepEqual(notifications, [
      "Usage: /pomodoro start [minutes] | status | cancel",
      "Usage: /pomodoro start [minutes] | status | cancel",
      "Usage: /pomodoro start [minutes] | status | cancel",
      "Usage: /pomodoro start [minutes] | status | cancel",
    ]);
    assert.equal(clock.pending(), 0);
    host.dispose();
  });
});
