import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { availableInputTokens, defaultContextBudget, type ContextBudgetConfig } from "./context-budget.js";
import { createTaskStore } from "./task-store.js";
import { runTaskWorker } from "./task-worker.js";
import { createWorkTaskStore, workTaskPhase, WorkTaskStoreError } from "./work-task-store.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const human = { id: "human", description: "改动范围可接受", method: "human" as const, required: true, verification: { kind: "human" as const } };

function stream(tool?: { name: string; input: unknown; id: string }) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(tool ? [{ type: "tool-call" as const, toolCallId: tool.id, toolName: tool.name, input: JSON.stringify(tool.input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "停" }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
  ] }) };
}

async function desktop(root: string, workspace: string, budget: ContextBudgetConfig, model: MockLanguageModelV3) {
  const projectReal = await realpath(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({
    version: 2,
    projectDirectory: projectReal,
    authorizedDirectories: [{ path: projectReal, access: "readwrite" }],
    modules: { task: { enabled: true }, "read-file": { enabled: true }, shell: { enabled: true }, memory: { enabled: false } },
    contextCompaction: budget,
    modelContextWindows: [{ provider: "mock-provider", modelId: "mock-model-id", contextWindowTokens: budget.contextWindowTokens }],
  }));
  const output = new PassThrough();
  output.resume();
  const app = await createRuntimeApp({
    directory: join(root, "transcripts"),
    assistant: { dataDirectory: join(root, "data"), threadId: "thread", configPath },
    cwd: root, env: {}, modelAlias: "mock", model, output,
    project: { id: "project", directory: projectReal, name: "project", kind: "folder" },
  });
  return { app, controller: createAssistantController(app), projectReal };
}

it("dispatched write with an unconfirmed cleanup becomes 待核对 and stays blocked across reopen", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "serika-6c-unknown-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  const target = join(await realpath(workspace), "note.txt");
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls += 1;
    return stream(calls === 1 ? { name: "write_file", id: "write-1", input: { path: "note.txt", content: "payload" } } : undefined);
  } });
  const originalOpen = fs.promises.open;
  const originalUnlink = fs.promises.unlink;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === target) {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async () => { await write("p"); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    }
    return handle;
  });
  t.mock.method(fs.promises, "unlink", async (...args: Parameters<typeof originalUnlink>) => {
    if (args[0] === target) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    return originalUnlink(...args);
  });
  syncBuiltinESMExports();
  const host = await desktop(root, workspace, { ...defaultContextBudget(), contextWindowTokens: 1_000_000 }, model);
  const { controller } = host;
  try {
    controller.subscribe(event => {
      if (event.type === "approval" && event.approval.preview.trim()) controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    });
    const created = await controller.workTasks.create({ goal: "写入说明", acceptance: [human] });
    assert.ok(created.ok);
    const idle = () => new Promise<void>(resolve => {
      const off = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); } });
    });
    const started = idle();
    assert.ok((await controller.workTasks.run({ id: created.value.id, expectedRevision: created.value.revision })).ok);
    await started;
    const review = await controller.workTasks.get(created.value.id);
    assert.ok(review.ok);
    assert.equal(workTaskPhase(review.value), "needs_review");
    assert.equal((await controller.workTasks.run({ id: review.value.id, expectedRevision: review.value.revision })).ok, false);
    assert.equal((await controller.workTasks.cancel({ id: review.value.id, expectedRevision: review.value.revision })).ok, false);
    assert.equal((await controller.workTasks.submitDelivery({ id: review.value.id, expectedRevision: review.value.revision, summary: "完成", artifactRefs: [] })).ok, false);
    const run = await host.app.executionRecords.getRun("thread", review.value.runIds[0]!);
    assert.equal(run?.tools[0]?.status, "unknown");
    assert.equal(run?.tools[0]?.toolName, "write_file");
    const callsAtStop = calls;
    const toolsAtStop = run?.tools.length;
    await controller.shutdown();
    const reopened = createWorkTaskStore(createTaskStore(join(root, "data/tasks.json")), { workspace: await realpath(workspace) });
    const again = await reopened.get(created.value.id);
    assert.ok(again.ok);
    assert.equal(workTaskPhase(again.value), "needs_review");
    assert.equal(again.value.revision, review.value.revision);
    assert.equal(calls, callsAtStop);
    const persisted = await host.app.executionRecords.getRun("thread", again.value.runIds[0]!);
    assert.equal(persisted?.tools.length, toolsAtStop);
    assert.equal(persisted?.tools[0]?.status, "unknown");
    const continued = await reopened.reconcile(again.value.id, {
      expectedRevision: again.value.revision, observedOutcome: "applied", decision: "continue", note: "文件还在，我核对过了",
    });
    assert.ok(continued.ok);
    assert.equal(workTaskPhase(continued.value), "paused");
    const next = await reopened.beginRun(continued.value.id, { expectedRevision: continued.value.revision, runId: "new-run" });
    assert.ok(next.ok);
    assert.deepEqual(next.value.runIds, [review.value.runIds[0], "new-run"]);
    const history = await host.app.executionRecords.getRun("thread", review.value.runIds[0]!);
    assert.equal(history?.tools.length, 1);
    assert.equal(history?.tools[0]?.status, "unknown");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await controller.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("cancelling after an unknown write keeps that receipt", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "serika-6c-cancel-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  const target = join(await realpath(workspace), "note.txt");
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls += 1;
    return stream(calls === 1 ? { name: "write_file", id: "write-1", input: { path: "note.txt", content: "payload" } } : undefined);
  } });
  const originalOpen = fs.promises.open;
  const originalUnlink = fs.promises.unlink;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === target) {
      const write = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async () => { await write("p"); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
    }
    return handle;
  });
  t.mock.method(fs.promises, "unlink", async (...args: Parameters<typeof originalUnlink>) => {
    if (args[0] === target) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    return originalUnlink(...args);
  });
  syncBuiltinESMExports();
  const host = await desktop(root, workspace, { ...defaultContextBudget(), contextWindowTokens: 1_000_000 }, model);
  try {
    host.controller.subscribe(event => {
      if (event.type === "approval" && event.approval.preview.trim()) host.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    });
    const created = await host.controller.workTasks.create({ goal: "写入说明", acceptance: [human] });
    assert.ok(created.ok);
    const idle = new Promise<void>(resolve => {
      const off = host.controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); } });
    });
    assert.ok((await host.controller.workTasks.run({ id: created.value.id, expectedRevision: created.value.revision })).ok);
    await idle;
    const review = await host.controller.workTasks.get(created.value.id);
    assert.ok(review.ok && workTaskPhase(review.value) === "needs_review");
    const cancelled = await host.controller.workTasks.reconcile({
      id: review.value.id, expectedRevision: review.value.revision, observedOutcome: "still_unknown", decision: "cancel", note: "没法确认文件是否写上",
    });
    assert.ok(cancelled.ok);
    assert.equal(cancelled.value.status, "cancelled");
    assert.equal(cancelled.value.reconciliations[0]?.observedOutcome, "still_unknown");
    await host.controller.shutdown();
    const stored = await createWorkTaskStore(createTaskStore(join(root, "data/tasks.json")), { workspace: await realpath(workspace) }).get(created.value.id);
    assert.ok(stored.ok);
    assert.equal(stored.value.status, "cancelled");
    assert.equal(stored.value.reconciliations[0]?.observedOutcome, "still_unknown");
    const receipt = await host.app.executionRecords.getRun("thread", stored.value.runIds[0]!);
    assert.equal(receipt?.tools[0]?.status, "unknown");
    assert.equal(receipt?.tools[0]?.toolName, "write_file");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await host.controller.shutdown().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

it("worker recovery leaves a foreground running work task, its run, and its lease alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-6c-owner-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  let now = Date.parse("2026-11-01T00:00:00.000Z");
  const tasks = createTaskStore(join(root, "data/tasks.json"), { now: () => now });
  const work = createWorkTaskStore(tasks, { workspace, generateId: () => "foreground" });
  const created = await work.create({ threadId: "foreground-thread", goal: "前台仍在跑", acceptance: [human] });
  assert.ok(created.ok);
  assert.ok((await work.beginRun(created.value.id, { expectedRevision: created.value.revision, runId: "foreground-run" })).ok);
  const lease = await work.claimThread("foreground-thread");
  const reminder = await tasks.create({
    prompt: "隔离提醒", runAt: new Date(now + 1_000).toISOString(),
    arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 },
  });
  assert.ok(reminder.ok);
  now += 1_000;
  const claimed = await tasks.claimNextDue();
  assert.ok(claimed.ok && claimed.value?.id === reminder.value.id && claimed.value.status === "running");
  let modelRuns = 0;
  const stop = new AbortController();
  stop.abort();
  await runTaskWorker({
    store: createTaskStore(join(root, "data/tasks.json"), { now: () => now }),
    signal: stop.signal,
    now: () => now,
    runtime: { run: () => { modelRuns += 1; throw new Error("worker must not start a model run"); } },
  });
  const after = await createWorkTaskStore(createTaskStore(join(root, "data/tasks.json")), { workspace }).get(created.value.id);
  assert.ok(after.ok);
  assert.equal(after.value.status, "running");
  assert.deepEqual(after.value.runIds, ["foreground-run"]);
  assert.equal(after.value.revision, created.value.revision + 1);
  assert.equal(modelRuns, 0);
  const interrupted = await createTaskStore(join(root, "data/tasks.json")).get(reminder.value.id);
  assert.ok(interrupted.ok && interrupted.value.status === "pending" && interrupted.value.error?.code === "WORKER_INTERRUPTED");
  await assert.rejects(createWorkTaskStore(createTaskStore(join(root, "data/tasks.json")), { workspace }).claimThread("foreground-thread"), WorkTaskStoreError);
  await lease.release();
  await rm(root, { recursive: true, force: true });
});

it("a notification fault increases only notification attempts", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-6c-notify-"));
  let now = Date.parse("2026-11-01T00:00:00.000Z");
  let modelRuns = 0;
  const path = join(root, "tasks.json");
  const store = createTaskStore(path, { now: () => now });
  const created = await store.create({
    prompt: "复核这份改动", runAt: new Date(now + 1_000).toISOString(),
    arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 },
  });
  assert.ok(created.ok);
  now += 1_000;
  const finish = new AbortController();
  await runTaskWorker({
    store, signal: finish.signal, now: () => now,
    runtime: { run: () => { modelRuns += 1; throw new Error("reminder must not call the model"); } },
    notify: async () => { throw new Error("notification down"); },
    onTaskFinished: () => finish.abort(),
  });
  const saved = await createTaskStore(path, { now: () => now }).get(created.value.id);
  assert.ok(saved.ok);
  assert.equal(saved.value.status, "completed");
  assert.equal(saved.value.runId, null);
  assert.equal(saved.value.resultText, "复核这份改动");
  assert.equal(saved.value.notification?.status, "pending");
  const attempts = saved.value.attempts.length;
  const retry = new AbortController();
  await runTaskWorker({
    store: createTaskStore(path, { now: () => now }), signal: retry.signal, now: () => now,
    runtime: { run: () => { modelRuns += 1; throw new Error("reminder must not call the model"); } },
    notify: async () => { retry.abort(); throw new Error("notification down"); },
  });
  now += 60_000;
  const again = new AbortController();
  await runTaskWorker({
    store: createTaskStore(path, { now: () => now }), signal: again.signal, now: () => now,
    runtime: { run: () => { modelRuns += 1; throw new Error("reminder must not call the model"); } },
    notify: async () => { again.abort(); throw new Error("notification down"); },
  });
  const failed = await createTaskStore(path).get(created.value.id);
  assert.ok(failed.ok);
  assert.equal(failed.value.notification?.attempts, 2);
  assert.equal(failed.value.notification?.status, "failed");
  assert.equal(failed.value.attempts.length, attempts);
  assert.equal(failed.value.runId, null);
  assert.equal(failed.value.resultText, "复核这份改动");
  assert.equal(failed.value.acknowledgedAt, null);
  assert.equal(modelRuns, 0);
  await rm(root, { recursive: true, force: true });
});

it("scripted save fits the 32768 window and the daily large window", { timeout: 30_000 }, async () => {
  const small: ContextBudgetConfig = {
    enabled: true, contextWindowTokens: 32_768, maxOutputTokens: 4_096, safetyMarginTokens: 2_048,
    keepRecentTokens: 8_192, summaryMaxOutputTokens: 2_048,
  };
  const large = defaultContextBudget();
  for (const budget of [small, large]) {
    const root = await mkdtemp(join(tmpdir(), "serika-6c-window-"));
    const workspace = join(root, "project");
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "request.md"), "node --test test/slug.test.mjs\nsrc/slug.mjs\n");
    let step = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      step += 1;
      if (step === 1) return stream({ name: "read_file", id: "read-1", input: { path: "request.md" } });
      if (step === 2) return stream({ name: "work_task_create", id: "create-1", input: {
        goal: "修复 slug",
        acceptance: [
          { id: "test", description: "回归", method: "automatic", required: true, verification: { kind: "shell_exit_zero", command: "node --test test/slug.test.mjs", cwd: "." } },
          human,
        ],
      } });
      return stream();
    } });
    const host = await desktop(root, workspace, budget, model);
    try {
      host.controller.subscribe(event => {
        if (event.type === "approval" && event.approval.preview.trim()) host.controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
      });
      const idle = new Promise<void>(resolve => {
        const off = host.controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); } });
      });
      const started = await host.controller.run("记录一个任务：修复这个项目的 slug 空格处理");
      assert.ok(started.ok);
      await idle;
      const tasks = await host.controller.workTasks.list();
      assert.ok(tasks.ok && tasks.value.length === 1);
      assert.equal(workTaskPhase(tasks.value[0]!), "ready");
      assert.deepEqual(tasks.value[0]!.runIds, []);
      const diagnostics = await host.app.getContextDiagnostics();
      assert.ok(diagnostics.ok);
      assert.equal(diagnostics.value.budget.contextWindowTokens, budget.contextWindowTokens);
      const room = availableInputTokens(diagnostics.value.budget);
      if (budget.contextWindowTokens === 32_768) assert.equal(room, 26_624);
      else assert.equal(diagnostics.value.budget.inputBudgetTokens, 256_000);
      assert.ok((diagnostics.value.lastPreparation?.estimatedInputTokens ?? 0) <= room);
      assert.equal(diagnostics.value.modelCapacity?.source, "configuration");
    } finally {
      await host.controller.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  }
});
