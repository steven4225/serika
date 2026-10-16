import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { createPomodoroService } from "@aisdk-agent/example-cli/dist/modules/pomodoro-module.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

test("host timer survives capability reassembly and Thread switching; only explicit disable and host shutdown end it", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-desktop-timer-lifetime-"));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { pomodoro: { enabled: true }, web: { enabled: false } } }));
  let time = 0, timerId = 0, modelCalls = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const notifications: string[] = [];
  const service = createPomodoroService({
    now: () => time,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimeout(handle) { timers.delete(handle as number); },
    desktopNotifier: message => notifications.push(message),
  });
  const advance = (milliseconds: number) => {
    time += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= time) { timers.delete(id); timer.callback(); }
    }
  };
  const events: MainToRenderer[] = [];
  const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root,
    env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock",
    model: new MockLanguageModelV3({ doStream: async () => { modelCalls++; throw new Error("Commands must not call a model"); } }),
    send: event => { events.push(event); }, pomodoroService: service,
  });
  try {
    assert.throws(() => host.pomodoro("start", 0), /1|180/);
    assert.throws(() => host.pomodoro("unknown"), /无效|操作/);
    assert.equal(host.pomodoro("status").status.state, "idle");
    assert.equal(host.pomodoro("start", 3).status.state, "running");
    const started = service.status().status;
    assert.equal(started.state, "running");
    assert.deepEqual(host.getLifecycleStatus(), { pomodoroRunning: true });
    await host.setModuleEnabled({ id: "web", enabled: true, expectedEnabled: false });
    advance(10_000);
    assert.equal(timers.size, 1);
    const firstThread = host.info().threadId;
    await host.createThread({ preserveDraft: true });
    assert.notEqual(host.info().threadId, firstThread);
    await host.selectThread(firstThread);
    assert.equal((await host.current.command("/pomodoro status")).ok, true);
    const resumed = service.status().status;
    assert.ok(started.state === "running" && resumed.state === "running");
    assert.equal(resumed.endsAt, started.endsAt);
    assert.equal(resumed.remainingSeconds, 170);
    assert.equal(timers.size, 1);

    // Assembly fails on missing credentials, then restores the original
    // controller. A failed operation must not cancel the running timer.
    await assert.rejects(host.setModuleEnabled({ id: "todoist", enabled: true, expectedEnabled: false }), /TODOIST|Todoist|token|TOKEN/);
    assert.deepEqual(host.getLifecycleStatus(), { pomodoroRunning: true });
    assert.equal(timers.size, 1);
    await assert.rejects(host.setModuleEnabled({ id: "pomodoro", enabled: false, expectedEnabled: false }), /变化|修改|刷新|加载/);
    assert.deepEqual(host.getLifecycleStatus(), { pomodoroRunning: true });

    await host.setModuleEnabled({ id: "pomodoro", enabled: false, expectedEnabled: true });
    assert.deepEqual(host.getLifecycleStatus(), { pomodoroRunning: false });
    assert.equal(timers.size, 0);
    assert.equal(host.info().commands.includes("pomodoro"), false);
    advance(180_000);
    assert.deepEqual(notifications, []);
    assert.throws(() => host.pomodoro("start", 1), /尚未就绪/);

    await host.setModuleEnabled({ id: "pomodoro", enabled: true, expectedEnabled: false });
    assert.equal(host.pomodoro("start", 1).status.state, "running");
    advance(60_000);
    assert.equal(host.pomodoro("status").status.state, "idle");
    assert.equal(notifications.length, 1);
    assert.equal(host.pomodoro("start", 1).status.state, "running");
    assert.equal(host.pomodoro("cancel").status.state, "idle");
    assert.equal(host.pomodoro("start", 1).status.state, "running");
    assert.equal(timers.size, 1);
    await host.shutdown();
    assert.equal(timers.size, 0);
    advance(60_000);
    assert.equal(notifications.length, 1);
    assert.throws(() => service.start(), /disposed/);
    assert.equal(modelCalls, 0);
    assert.ok(events.some(event => event.type === "identity-changed"));
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
