import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { JsonlAgentStore } from "@serika/core";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { createCheckpointStore } from "./checkpoint-store.js";
import { createMemoryStore } from "./memory-store.js";
import { loadScheduledSkillAutomation, prepareScheduledSkillTask } from "./scheduled-skill.js";
import { createTaskStore } from "./task-store.js";
import { createTaskWorkerAgent } from "./task-worker-entry.js";
import { runTaskWorker } from "./task-worker.js";

const INSTRUCTIONS = "SCHEDULED_BRIEF: Return a short sentence using only the supplied input. Never invent facts.";
type ModelOptions = Parameters<MockLanguageModelV3["doStream"]>[0];
function response(text = "测试简报已完成。") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "answer" },
    { type: "text-delta" as const, id: "answer", delta: text },
    { type: "text-end" as const, id: "answer" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
async function settle(controller: AssistantController) {
  const deadline = Date.now() + 5_000;
  while (controller.getSnapshot().state.kind !== "idle") {
    assert.equal(controller.getSnapshot().pendingApproval, null);
    assert.ok(Date.now() < deadline, "Controller must settle");
    await delay(1);
  }
}
async function fixture(model: MockLanguageModelV3) {
  const root = await mkdtemp(join(tmpdir(), "runloom-scheduled-skill-"));
  const workspace = join(root, "workspace");
  const directory = join(root, "trusted-brief");
  await Promise.all([mkdir(workspace), mkdir(directory)]);
  await writeFile(join(directory, "skill.json"), JSON.stringify({ version: 1, id: "brief", description: "A registered brief",
    kind: "text", tools: [], limits: { maxSteps: 1 } }));
  await writeFile(join(directory, "SKILL.md"), INSTRUCTIONS);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: {
    task: { enabled: true }, memory: { enabled: true, autoConsolidate: true }, checkpoint: { enabled: true },
  }, automation: { skills: [{ id: "brief", directory }], hooks: [] } }));
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "origin", configPath },
    modelAlias: "scripted", model, output, env: {}, cwd: root });
  const controller = createAssistantController(app);
  await controller.listRuns();
  const skill = controller.getAutomationDiagnostics().skills.find(item => item.id === "brief"); assert.ok(skill);
  return { root, workspace, directory, configPath, app, controller, skill, cleanup: async () => {
    await controller.shutdown(); await rm(root, { recursive: true, force: true });
  } };
}
async function worker(f: Awaited<ReturnType<typeof fixture>>, model: MockLanguageModelV3, now: number, stopAfterTask = true) {
  const automation = await loadScheduledSkillAutomation({ configPath: f.configPath, workspaceRoot: f.workspace });
  const store = createTaskStore(f.workspace, { now: () => now });
  const transcripts = new JsonlAgentStore({ directory: join(f.workspace, ".runloom", "task-transcripts") });
  const agent = createTaskWorkerAgent({ modelAlias: "scripted", model, store: transcripts, skills: automation.skills, workspaceContext: true });
  const abort = new AbortController();
  const finished: string[] = [];
  try {
    await runTaskWorker({ store, runtime: agent.runtime, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5_000)]), pollIntervalMs: 1,
      now: () => now, prepareSkillTask: task => prepareScheduledSkillTask(automation, task),
      // A global switch must never widen a declared text Skill's data access.
      loadWorkspaceContext: async () => { throw new Error("Declared text Skills must not load global workspace context"); },
      onTaskFinished: task => { finished.push(task.id); if (stopAfterTask) abort.abort(); },
      ...(stopAfterTask ? {} : { onTaskStarted: () => abort.abort() }),
    });
    return { store, transcripts, finished };
  } finally { abort.abort(); agent.dispose(); }
}

test("Controller saves a pinned Skill schedule; the existing worker delivers once into inbox and JSONL without global data/tools", { timeout: 15_000 }, async () => {
  const observed: ModelOptions[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => { observed.push(options); return response(); } });
  const f = await fixture(model);
  try {
    assert.ok((await createMemoryStore(f.workspace).add({ text: "GLOBAL_MEMORY_PRIVATE", pinned: true })).ok);
    assert.ok((await createCheckpointStore(f.workspace).saveNextVersion({ expectedVersion: null, sourceThreadId: "origin",
      draft: { status: "active", goal: "GLOBAL_CHECKPOINT_PRIVATE", summary: "GLOBAL_CHECKPOINT_PRIVATE", completed: [], inProgress: [], nextActions: [], blockers: [], artifacts: [] } })).ok);
    await f.app.store.save("origin", [{ id: "old", role: "user", parts: [{ type: "text", text: "GLOBAL_HISTORY_PRIVATE" }] }]);
    const input = "今天只整理我提供的两件事：读书、散步。";
    const manual = await f.controller.runSkill({ id: "brief", expectedHash: f.skill.hash, input }); assert.ok(manual.ok);
    await settle(f.controller);
    const due = Date.now() + 10_000;
    const saved = await f.controller.scheduleSkill({ id: "brief", expectedHash: f.skill.hash, input, runAt: new Date(due).toISOString() });
    assert.ok(saved.ok && saved.value.task);
    const task = saved.value.task;
    assert.equal(task.arrangement?.kind, "skill");
    if (task.arrangement?.kind !== "skill") throw new Error("Missing frozen Skill declaration");
    assert.equal(task.arrangement.skillHash, f.skill.hash);
    assert.equal(observed.length, 1, "Saving must not invoke the model immediately");
    const preDue = await createTaskStore(f.workspace, { now: () => due - 1 }).claimNextDue();
    assert.ok(preDue.ok && preDue.value === null);
    const ran = await worker(f, model, due + 1);
    const complete = await ran.store.get(task.id); assert.ok(complete.ok);
    assert.equal(complete.value.status, "completed");
    assert.equal(complete.value.resultText, "测试简报已完成。");
    assert.ok(complete.value.runId && complete.value.threadId);
    const transcript = await ran.transcripts.getMessages(complete.value.threadId);
    assert.ok(transcript.some(message => message.role === "assistant"));
    const inbox = await f.controller.getTaskInbox(); assert.ok(inbox.ok);
    assert.ok(inbox.value.tasks.some(item => item.id === task.id));
    assert.equal(observed.length, 2);
    for (const request of observed) {
      assert.match(JSON.stringify(request.prompt), /SCHEDULED_BRIEF/);
      assert.ok(JSON.stringify(request.prompt).includes(input));
      assert.doesNotMatch(JSON.stringify(request.prompt), /GLOBAL_(MEMORY|CHECKPOINT|HISTORY)_PRIVATE/);
      assert.deepEqual(request.tools ?? [], [], "No shell, Memory, Todoist or other inherited tools");
    }
    const stopped = new AbortController(); stopped.abort();
    await runTaskWorker({ store: createTaskStore(f.workspace, { now: () => due + 2 }), runtime: { run: async () => { throw new Error("Terminal task must not replay"); } }, signal: stopped.signal });
    assert.equal(observed.length, 2);
    const reopened = await createTaskStore(f.workspace).get(task.id); assert.ok(reopened.ok);
    assert.equal(reopened.value.status, "completed");
    assert.equal(reopened.value.runId, complete.value.runId);
  } finally { await f.cleanup(); }
});

test("A saved Skill rejects changed pinned source before model startup and preserves a failed inbox result", { timeout: 15_000 }, async () => {
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => { calls += 1; return response(); } });
  const f = await fixture(model);
  try {
    const due = Date.now() + 10_000;
    const saved = await f.controller.scheduleSkill({ id: "brief", expectedHash: f.skill.hash, input: "A bounded brief", runAt: new Date(due).toISOString() });
    assert.ok(saved.ok && saved.value.task);
    await writeFile(join(f.directory, "SKILL.md"), INSTRUCTIONS + "\nChanged instructions.");
    const ran = await worker(f, model, due + 1);
    const task = await ran.store.get(saved.value.task.id); assert.ok(task.ok);
    assert.equal(task.value.status, "failed");
    assert.equal(task.value.runId, null);
    assert.equal(calls, 0);
    assert.match(task.value.error?.code ?? "", /SKILL_CHANGED/);
    const inbox = await ran.store.list({ inbox: true }); assert.ok(inbox.ok);
    assert.ok(inbox.value.tasks.some(item => item.id === task.value.id));
  } finally { await f.cleanup(); }
});

test("Scheduling rejects unknown/hash-mismatched/memory Skills and oversized or forged input without a Run or task", async () => {
  let calls = 0;
  const f = await fixture(new MockLanguageModelV3({ doStream: async () => { calls += 1; return response(); } }));
  try {
    const runAt = new Date(Date.now() + 10_000).toISOString();
    const base = { id: "brief", expectedHash: f.skill.hash, input: "A brief", runAt };
    const memory = f.controller.getAutomationDiagnostics().skills.find(item => item.id === "memory-consolidate"); assert.ok(memory);
    for (const input of [
      { ...base, id: "not-registered" }, { ...base, expectedHash: "0".repeat(64) },
      { ...base, id: memory.id, expectedHash: memory.hash }, { ...base, input: "x".repeat(4097) },
      { ...base, authority: { shell: true } }, { ...base, recurrence: { kind: "daily" as const, time: "09:00", utcOffset: "+08:00" } },
    ]) assert.equal((await f.controller.scheduleSkill(input)).ok, false);
    assert.equal(calls, 0);
    assert.deepEqual(await f.controller.listRuns(), []);
    const tasks = await createTaskStore(f.workspace).list(); assert.ok(tasks.ok); assert.deepEqual(tasks.value.tasks, []);
  } finally { await f.cleanup(); }
});

test("Recurring Skill pause/resume/cancel only changes scheduling; a cancelled occurrence never executes", async () => {
  let calls = 0;
  const f = await fixture(new MockLanguageModelV3({ doStream: async () => { calls += 1; return response(); } }));
  try {
    const saved = await f.controller.scheduleSkill({ id: "brief", expectedHash: f.skill.hash, input: "Daily supplied-input brief",
      recurrence: { kind: "daily", time: "09:00", utcOffset: "+08:00" } });
    assert.ok(saved.ok && saved.value.recurringTask);
    const id = saved.value.recurringTask.id;
    const changes = (action: "pause" | "resume" | "cancel") => f.controller.changeAutomationSchedule({ id, kind: "recurring", action });
    assert.ok((await changes("pause")).ok);
    const paused = await createTaskStore(f.workspace).getRecurring(id); assert.ok(paused.ok); assert.equal(paused.value.recurringTask.status, "paused");
    assert.ok(saved.value.recurringTask.nextRunAt);
    const nextRunAt = saved.value.recurringTask.nextRunAt;
    const dueStore = createTaskStore(f.workspace, { now: () => Date.parse(nextRunAt) + 1 });
    const whilePaused = await dueStore.claimNextDue(); assert.ok(whilePaused.ok && whilePaused.value === null);
    assert.ok((await changes("resume")).ok);
    const resumed = await createTaskStore(f.workspace).getRecurring(id); assert.ok(resumed.ok); assert.equal(resumed.value.recurringTask.status, "active");
    assert.ok((await changes("cancel")).ok);
    const cancelled = await createTaskStore(f.workspace).getRecurring(id); assert.ok(cancelled.ok); assert.equal(cancelled.value.recurringTask.status, "cancelled");
    const afterCancel = await dueStore.claimNextDue(); assert.ok(afterCancel.ok && afterCancel.value === null);
    assert.equal(calls, 0);
    assert.deepEqual(await f.controller.listRuns(), []);
  } finally { await f.cleanup(); }
});

test("Worker recovery installs a matching saved outcome but interrupts an unaccounted Skill attempt without model replay", async () => {
  const f = await fixture(new MockLanguageModelV3({ doStream: async () => { throw new Error("Recovery must not invoke model"); } }));
  try {
    const due = Date.now() + 10_000;
    const create = async (input: string) => {
      const value = await f.controller.scheduleSkill({ id: "brief", expectedHash: f.skill.hash, input, runAt: new Date(due).toISOString() });
      assert.ok(value.ok && value.value.task); return value.value.task;
    };
    const terminal = await create("Saved completed result");
    const unknown = await create("Unaccounted attempt");
    const store = createTaskStore(f.workspace, { now: () => due + 1 });
    const first = await store.claimNextDue(); assert.ok(first.ok && first.value);
    assert.ok((await store.recordRunId(first.value.id, "persisted-run")).ok);
    assert.ok((await store.recordOutcome(first.value.id, { status: "completed", runId: "persisted-run", resultText: "Persisted result" })).ok);
    const second = await store.claimNextDue(); assert.ok(second.ok && second.value);
    assert.ok((await store.recordRunId(second.value.id, "unaccounted-run")).ok);
    const stopped = new AbortController(); stopped.abort();
    for (let restart = 0; restart < 2; restart += 1) await runTaskWorker({ store, runtime: { run: async () => { throw new Error("Recovery cannot open a Run"); } }, signal: stopped.signal });
    const restored = await store.get(first.value.id); assert.ok(restored.ok); assert.equal(restored.value.status, "completed");
    assert.equal(restored.value.resultText, "Persisted result");
    const interrupted = await store.get(second.value.id); assert.ok(interrupted.ok); assert.equal(interrupted.value.status, "interrupted");
    assert.equal(interrupted.value.runId, "unaccounted-run");
    assert.ok([terminal.id, unknown.id].includes(first.value.id));
    const doc = JSON.parse(await readFile(join(f.workspace, ".runloom", "tasks.json"), "utf8"));
    assert.equal(doc.version, 4);
  } finally { await f.cleanup(); }
});

test("Production worker process loads trusted config, owns the workspace lock, and preserves the Skill result after process restart", { timeout: 20_000 }, async () => {
  const f = await fixture(new MockLanguageModelV3({ doStream: async () => { throw new Error("Saving a schedule must not run a model"); } }));
  const children: ChildProcess[] = [];
  const launch = () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./task-worker-entry.js", import.meta.url)), "--workspace", f.workspace, "--config", f.configPath], {
      env: { PATH: process.env.PATH, RUNLOOM_MODEL: "mock" }, stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    return child;
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const close = once(child, "close", { signal: AbortSignal.timeout(3_000) });
    child.kill("SIGTERM");
    try { await close; } catch {
      const killed = once(child, "close", { signal: AbortSignal.timeout(3_000) });
      child.kill("SIGKILL"); await killed;
    }
  };
  try {
    const saved = await f.controller.scheduleSkill({ id: "brief", expectedHash: f.skill.hash, input: "Process acceptance input", runAt: new Date(Date.now() + 500).toISOString() });
    assert.ok(saved.ok && saved.value.task);
    const first = launch();
    let stderr = "";
    first.stderr?.setEncoding("utf8"); first.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
    const store = createTaskStore(f.workspace);
    const deadline = Date.now() + 8_000;
    let result = await store.get(saved.value.task.id); assert.ok(result.ok);
    while (result.value.status === "scheduled" || result.value.status === "running") {
      assert.equal(first.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, "Production worker process failed to deliver");
      await delay(20);
      result = await store.get(saved.value.task.id); assert.ok(result.ok);
    }
    assert.equal(result.value.status, "completed", stderr);
    assert.equal(result.value.resultText, "Scheduled task completed.", "This process case uses the explicitly scripted provider, not a paid-model claim");
    assert.equal(result.value.attempts.length, 1);
    const contender = launch();
    let contenderError = "";
    contender.stderr?.setEncoding("utf8"); contender.stderr?.on("data", chunk => { contenderError += String(chunk); });
    const [code] = await once(contender, "close", { signal: AbortSignal.timeout(5_000) });
    assert.equal(code, 1);
    assert.match(contenderError, /WORKER_ALREADY_RUNNING/);
    await stop(first);
    const restarted = launch();
    const restartedDeadline = Date.now() + 5_000;
    // Wait for this PID's post-lock heartbeat. Do not repeatedly acquire the
    // lock during launch: that diagnostic can race the worker's own admission.
    let restartReady = false;
    while (Date.now() < restartedDeadline) {
      assert.equal(restarted.exitCode, null, "Restarted worker must remain alive");
      const heartbeat = JSON.parse(await readFile(join(f.workspace, ".runloom", "task-worker-health.json"), "utf8"));
      if (heartbeat.pid === restarted.pid && heartbeat.stoppedAt === null) { restartReady = true; break; }
      await delay(20);
    }
    assert.ok(restartReady, "Restarted worker must publish its own post-lock heartbeat");
    const acquired = await import("./flock.js").then(module => module.tryAcquireFlock(join(f.workspace, ".runloom", "task-worker.lock")));
    if (acquired) await acquired.release();
    assert.equal(acquired, null, "Restarted live process must own the actual lock, not only a heartbeat");
    await stop(restarted);
    const reopened = await store.get(saved.value.task.id); assert.ok(reopened.ok);
    assert.equal(reopened.value.status, "completed");
    assert.equal(reopened.value.runId, result.value.runId);
    assert.equal(reopened.value.attempts.length, 1, "Restart must not append another model attempt");
    assert.ok(reopened.value.threadId);
    const history = await new JsonlAgentStore({ directory: join(f.workspace, ".runloom", "task-transcripts") }).getMessages(reopened.value.threadId);
    assert.equal(history.filter(message => message.role === "user").length, 1);
  } finally { for (const child of children) await stop(child); await f.cleanup(); }
});
