import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import { createTaskStore } from "@serika/assistant";
import {} from "@serika/assistant/testing";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import { readSavedTaskNotice } from "../shared/saved-task-result.js";

test("desktop unified inbox reads real task results, preserves notification distinction and acknowledges without model Runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-unified-inbox-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { task: { enabled: true } } }));
  const output = new TeeOutput(() => undefined);
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "inbox-thread", configPath: join(root, "config.json") },
    modelAlias: "mock", model: createDemoModel(), output, env: {}, cwd: root });
  const controller = createAssistantController(app); output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => undefined);
  try {
    let clock = Date.now();
    const tasks = createTaskStore(join(workspace, ".runloom/tasks.json"), { now: () => clock });
    const created = await tasks.create({ prompt: "喝水", runAt: new Date(clock + 1_000).toISOString(), arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } });
    assert.ok(created.ok); if (!created.ok) return;
    clock += 2_000;
    assert.ok((await tasks.claimNextDue()).ok);
    assert.ok((await tasks.finish(created.value.id, { status: "completed", runId: null, resultText: "提醒：喝水", execution: "deterministic", notification: true })).ok);
    assert.ok((await tasks.recordNotification(created.value.id, { ok: true })).ok);
    const inbox = await bridge.getTaskInbox();
    assert.ok(inbox.ok); if (!inbox.ok) return;
    assert.deepEqual(inbox.value.tasks.map(t => t.id), [created.value.id]);
    const detail = await bridge.getScheduledTask(created.value.id);
    assert.ok(detail.ok); if (!detail.ok) return;
    assert.equal(detail.value.resultText, "提醒：喝水");
    assert.equal(detail.value.notification?.status, "submitted");
    assert.equal(detail.value.acknowledgedAt, null);
    const beforeBannerRead = await readFile(join(workspace, ".runloom/tasks.json"));
    const banner = await readSavedTaskNotice(bridge);
    assert.equal(banner?.resultText, "提醒：喝水", "banner must read persisted current-workspace detail");
    assert.equal(banner?.acknowledgedAt, null);
    assert.deepEqual(await readFile(join(workspace, ".runloom/tasks.json")), beforeBannerRead, "banner reads never acknowledge or change storage");
    assert.ok(!(await bridge.getScheduledTask(null as never)).ok);
    assert.ok(!(await bridge.acknowledgeTaskResult(123 as never)).ok);
    const acknowledged = await bridge.acknowledgeTaskResult(created.value.id);
    assert.ok(acknowledged.ok && acknowledged.value.acknowledgedAt !== null);
    const after = await bridge.getTaskInbox(); assert.ok(after.ok && after.value.tasks.length === 0);
    assert.equal((await controller.runs.list()).length, 0);
    await writeFile(join(workspace, ".runloom/tasks.json"), "{bad");
    const corrupt = await bridge.getTaskInbox();
    assert.ok(!corrupt.ok && corrupt.error.code === "TASK_FILE_INVALID", "corrupt storage is not an empty inbox");
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test("saved reminder banner stays readable with task tools disabled and grants no acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-saved-reminder-disabled-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { task: { enabled: false } } }));
  const output = new TeeOutput(() => undefined);
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "disabled-tools", configPath: join(root, "config.json") },
    modelAlias: "mock", model: createDemoModel(), output, env: {}, cwd: root });
  const controller = createAssistantController(app); output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => undefined);
  try {
    let clock = Date.now();
    const tasks = createTaskStore(join(workspace, ".runloom/tasks.json"), { now: () => clock });
    const created = await tasks.create({ prompt: "喝水", runAt: new Date(clock + 1_000).toISOString(), arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } });
    assert.ok(created.ok); if (!created.ok) return;
    clock += 2_000;
    assert.ok((await tasks.claimNextDue()).ok);
    assert.ok((await tasks.finish(created.value.id, { status: "completed", runId: null, resultText: "喝水", execution: "deterministic", notification: true })).ok);
    const before = await readFile(join(workspace, ".runloom/tasks.json"));
    const notice = await readSavedTaskNotice(bridge);
    assert.equal(notice?.resultText, "喝水");
    assert.equal(notice?.acknowledgedAt, null);
    assert.deepEqual(await readFile(join(workspace, ".runloom/tasks.json")), before);
    assert.equal((await controller.runs.list()).length, 0);
    assert.equal((await bridge.acknowledgeTaskResult(created.value.id)).ok, false);
  } finally { await bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});
