import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "@serika/example-cli";
import { createAssistantController } from "@serika/example-cli";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import { canSubmitComposer } from "../shared/composer.js";
import { IPC, type MainToRenderer } from "../shared/ui-contract.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function response() {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text" },
    { type: "text-delta" as const, id: "text", delta: "Skill result" },
    { type: "text-end" as const, id: "text" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
  ] }) };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for automation bridge");
    await delay(10);
  }
}

async function fixture(model: MockLanguageModelV3, options: {
  automatic?: boolean;
  memory?: boolean;
  memoryHookEnabled?: boolean;
  task?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "desktop-skill-bridge-"));
  const workspace = join(root, "workspace");
  const skillDirectory = join(root, "trusted-skill");
  await mkdir(workspace);
  await mkdir(skillDirectory);
  await writeFile(join(skillDirectory, "skill.json"), JSON.stringify({
    version: 1, id: "brief", description: "A bounded text Skill", kind: "text", tools: [],
  }));
  await writeFile(join(skillDirectory, "SKILL.md"), "Return a short text result; no tools are available.");
  await writeFile(join(root, "config.json"), JSON.stringify({
    version: 1, workspace, modules: { ...(options.memory ? { memory: { enabled: true, autoConsolidate: true } } : {}), ...(options.task ? { task: { enabled: true } } : {}) }, automation: {
      skills: [{ id: "brief", directory: skillDirectory }],
      hooks: options.memoryHookEnabled !== undefined ? [{ id: "startup-memory", event: "thread.ready",
        enabled: options.memoryHookEnabled, handler: { type: "skill", id: "memory-consolidate" } }]
        : options.automatic ? [{ id: "startup-brief", event: "thread.ready", handler: { type: "skill", id: "brief" } }] : [],
    },
  }));
  const messages: MainToRenderer[] = [];
  const output = new TeeOutput(message => { messages.push(message); });
  const app = await createRuntimeApp({
    args: ["--tui", join(root, "transcripts"), "--thread", "skills", "--config", join(root, "config.json")],
    modelAlias: "mock", model, output, cwd: root, env: {},
  });
  const controller = createAssistantController(app);
  output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, {
    modelAlias: "mock", temporaryThread: false, temporaryDirectory: false,
  }, output, message => { messages.push(message); });
  return { root, bridge, messages };
}

it("wires automation metadata and pinned invocation through both IPC endpoints", async () => {
  const preload = await readFile(new URL("../preload/index.ts", import.meta.url), "utf8");
  const main = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(preload, /getAutomationDiagnostics:.*ipcRenderer\.invoke\(IPC\.automationDiagnostics\)/);
  assert.match(preload, /runSkill:.*ipcRenderer\.invoke\(IPC\.runSkill, input\)/);
  assert.match(main, /ipcMain\.handle\(IPC\.automationDiagnostics,.*host\.current\.getAutomationDiagnostics\(\)/);
  assert.match(main, /ipcMain\.handle\(IPC\.runSkill,.*host\.current\.runSkill\(input\)/);
  assert.notEqual(IPC.automationDiagnostics, IPC.runSkill);
  assert.match(preload, /getAutomationOverview:.*ipcRenderer\.invoke\(IPC\.automationOverview\)/);
  assert.match(preload, /scheduleSkill:.*ipcRenderer\.invoke\(IPC\.scheduleSkill, input\)/);
  assert.match(preload, /changeAutomationSchedule:.*ipcRenderer\.invoke\(IPC\.automationScheduleChange, input\)/);
  assert.match(main, /ipcMain\.handle\(IPC\.automationOverview,.*host\.current\.getAutomationOverview\(\)/);
  assert.match(main, /ipcMain\.handle\(IPC\.scheduleSkill,.*host\.current\.scheduleSkill\(input\)/);
  assert.match(main, /ipcMain\.handle\(IPC\.automationScheduleChange,.*host\.current\.changeAutomationSchedule\(input\)/);
});

it("saves and manages pinned Skill schedules through the real controller without running a model", async () => {
  let calls = 0;
  const { root, bridge } = await fixture(new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), { task: true });
  try {
    const before = await bridge.getAutomationOverview();
    if (!before.ok) throw new Error(before.error.message);
    assert.equal(before.value.tasksEnabled, true);
    const skill = before.value.diagnostics.skills[0]!;
    const forgedInput = { id: skill.id, expectedHash: skill.hash, input: "Brief", runAt: "2099-01-01T00:00:00Z", permissions: ["shell_exec"] };
    const forged = await bridge.scheduleSkill(forgedInput);
    assert.equal(forged.ok, false);
    const once = await bridge.scheduleSkill({ id: skill.id, expectedHash: skill.hash, input: "Brief", runAt: "2099-01-01T00:00:00Z" });
    if (!once.ok) throw new Error(once.error.message);
    assert.equal(once.value.service.enabled, false, "saved intent is not a worker launch");
    assert.equal(once.value.task?.status, "scheduled");
    assert.equal(once.value.task?.arrangement?.kind, "skill");
    const recurring = await bridge.scheduleSkill({ id: skill.id, expectedHash: skill.hash, input: "Weekly", recurrence: { kind: "weekly", weekday: 7, time: "10:00", utcOffset: "+08:00" } });
    if (!recurring.ok) throw new Error(recurring.error.message);
    const recurringId = recurring.value.recurringTask!.id;
    assert.equal((await bridge.changeAutomationSchedule({ id: recurringId, kind: "recurring", action: "pause" })).ok, true);
    const paused = await bridge.getAutomationOverview();
    assert.equal(paused.ok && paused.value.recurring.find(task => task.id === recurringId)?.status, "paused");
    assert.equal((await bridge.changeAutomationSchedule({ id: recurringId, kind: "recurring", action: "resume" })).ok, true);
    assert.equal((await bridge.changeAutomationSchedule({ id: recurringId, kind: "recurring", action: "cancel" })).ok, true);
    const taskId = once.value.task!.id;
    assert.equal((await bridge.changeAutomationSchedule({ id: taskId, kind: "once", action: "cancel" })).ok, true);
    const task = await bridge.getScheduledTask(taskId);
    assert.equal(task.ok && task.value.status, "cancelled");
    const noReplay = await bridge.changeAutomationSchedule({ id: taskId, kind: "once", action: "resume" });
    assert.equal(noReplay.ok, false);
    assert.equal(calls, 0);
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it("reads safe metadata and starts a pinned text Skill without claiming primary completion", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls += 1;
    await gate;
    return response();
  } });
  const { root, bridge, messages } = await fixture(model);
  try {
    const diagnostics = bridge.getAutomationDiagnostics();
    assert.equal(calls, 0, "diagnostics must not start a Run");
    assert.equal(diagnostics.skills.length, 1);
    assert.deepEqual(diagnostics.hooks, []);
    assert.deepEqual(diagnostics.recent, []);
    const skill = diagnostics.skills[0]!;
    assert.equal("instructions" in skill, false);
    assert.equal("agentId" in skill, false);
    assert.equal("directory" in skill, false);
    assert.deepEqual(skill.tools, []);
    assert.equal(JSON.stringify(diagnostics).includes(root), false);
    assert.ok(["skills", "hooks", "skill"].every(command => bridge.info().commands.includes(command)));
    assert.equal((await bridge.command("/skills")).ok, true);
    assert.equal((await bridge.command("/hooks")).ok, true);
    assert.match(bridge.snapshot().recentOutput, /brief/);
    assert.equal(bridge.snapshot().recentOutput.includes(root), false);
    assert.equal(calls, 0, "listing commands are metadata reads, not Runs");

    for (const field of ["path", "threadId", "permissions"]) {
      const rejected = await bridge.runSkill({ id: skill.id, expectedHash: skill.hash, [field]: "forged" });
      assert.equal(rejected.ok, false);
      if (!rejected.ok) assert.equal(rejected.error.code, "SKILL_INVALID_INPUT");
      await until(() => bridge.snapshot().state.kind === "idle");
    }
    const stale = await bridge.runSkill({ id: skill.id, expectedHash: "0".repeat(64) });
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "SKILL_CHANGED");
    await until(() => bridge.snapshot().state.kind === "idle");
    assert.equal(calls, 0);

    const started = await bridge.runSkill({ id: skill.id, expectedHash: skill.hash, input: "My explicit input" });
    assert.equal(started.ok, true);
    if (!started.ok) throw new Error("Expected a started Skill Run");
    const state = bridge.snapshot().state;
    assert.equal(state.kind, "running");
    if (state.kind === "running") assert.equal(state.phase, "skill");
    assert.equal(bridge.snapshot().lastPrimaryResult, null);
    assert.equal(messages.some(message => message.type === "result"), false, "start response is not completion");
    const busy = await bridge.runSkill({ id: skill.id, expectedHash: skill.hash });
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.error.code, "BUSY");
    assert.equal(canSubmitComposer(state), false, "manual Skills retain idle-only admission");
    release();
    await until(() => bridge.snapshot().state.kind === "idle");
    assert.equal(bridge.snapshot().lastPrimaryResult, null);
    assert.equal(messages.some(message => message.type === "result" && message.phase === "skill" && message.result.runId === started.value.runId), true);
    assert.equal(messages.some(message => message.type === "result" && message.phase === "primary"), false);
    assert.equal(bridge.getAutomationDiagnostics().recent[0]?.status, "completed");
    const runs = await bridge.listRuns();
    assert.ok(runs.ok);
    if (runs.ok) assert.equal(runs.runs[0]?.phase, "skill");
    diagnostics.skills.splice(0);
    assert.equal(bridge.getAutomationDiagnostics().skills.length, 1, "read results do not mutate the registry");
  } finally {
    release();
    await bridge.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps background Skill phase distinct and settles cancellation before foreground chat", async () => {
  let calls = 0;
  let backgroundAborted = false;
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls += 1;
    if (calls === 1) {
      try { await delay(60_000, undefined, { signal: options.abortSignal }); }
      finally { backgroundAborted = options.abortSignal?.aborted === true; }
    } else assert.equal(backgroundAborted, true);
    return response();
  } });
  const { root, bridge, messages } = await fixture(model, { automatic: true });
  try {
    await until(() => calls === 1);
    const snapshot = bridge.snapshot();
    assert.equal(snapshot.canSubmit, true);
    assert.equal(canSubmitComposer(snapshot.state), true);
    assert.equal(snapshot.state.kind, "running");
    if (snapshot.state.kind === "running") {
      assert.equal(snapshot.state.phase, "skill");
      assert.equal(snapshot.state.background, true);
    }
    assert.equal(snapshot.lastPrimaryResult, null);
    assert.equal((await bridge.run("New ordinary chat")).ok, true);
    await until(() => bridge.snapshot().state.kind === "idle");
    assert.equal(calls, 2, "text Skills do not trigger their own startup hook recursively");
    assert.equal(messages.some(message => message.type === "result" && message.phase === "skill" && message.result.status === "cancelled"), true);
    assert.equal(bridge.snapshot().lastPrimaryResult?.status, "completed");
    assert.equal(bridge.getAutomationDiagnostics().recent[0]?.status, "cancelled");
  } finally {
    await bridge.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

it("reports automatic memory from enabled Hooks, not merely the available manual Skill", async () => {
  for (const enabled of [undefined, false, true]) {
    let calls = 0;
    const model = new MockLanguageModelV3({ doStream: async () => { calls += 1; return response(); } });
    const { root, bridge } = await fixture(model, {
      memory: true,
      ...(enabled === undefined ? {} : { memoryHookEnabled: enabled }),
    });
    try {
      const info = bridge.info();
      assert.equal(info.memory.enabled, true);
      assert.equal(info.memory.autoConsolidate, enabled === true);
      assert.equal(info.moduleOptions?.autoConsolidate, enabled === true);
      assert.equal(bridge.getAutomationDiagnostics().skills.some(skill => skill.kind === "memory-consolidate"), true,
        "manual Memory Skill remains registered even if automatic Hooks are off");
      assert.equal(info.commands.includes("skill"), true);
      assert.equal(calls, 0, "empty Memory backlog must not call a model");
    } finally {
      await bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }
});
