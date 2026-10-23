import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { createDemoModel } from "./demo-model.js";
import { createTaskStore } from "./task-store.js";

test("unified controller inbox reads actual deterministic reminders and explicit ack removes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-task-inbox-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, authorizedDirectory: workspace, modules: { task: { enabled: true } } }));
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "inbox", configPath: config },
    model: createDemoModel(), modelAlias: "mock/default", output, env: {}, cwd: root });
  const controller = createAssistantController(app);
  let now = Date.now();
  const store = createTaskStore(join(workspace, ".runloom/tasks.json"), { now: () => now });
  try {
    const created = await store.create({ prompt: "喝水", runAt: new Date(now + 1_000).toISOString(),
      arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } });
    assert.ok(created.ok); now += 2_000;
    const claim = await store.claimNextDue(); assert.ok(claim.ok && claim.value);
    const outcome = { status: "completed" as const, runId: null, execution: "deterministic" as const, resultText: "喝水", notification: true };
    assert.ok((await store.recordOutcome(created.value.id, outcome)).ok);
    assert.ok((await store.finish(created.value.id, outcome)).ok);
    const inbox = await controller.automation.getTaskInbox(); assert.ok(inbox.ok);
    assert.equal(inbox.value.tasks[0]?.id, created.value.id);
    const detail = await controller.automation.getScheduledTask(created.value.id); assert.ok(detail.ok);
    assert.equal(detail.value.execution, "deterministic");
    assert.equal(detail.value.runId, null);
    assert.equal(detail.value.notification?.status, "pending");
    assert.equal(detail.value.resultText, "喝水");
    assert.ok((await controller.automation.acknowledgeTaskResult(created.value.id)).ok);
    const empty = await controller.automation.getTaskInbox(); assert.ok(empty.ok);
    assert.equal(empty.value.tasks.length, 0);
    assert.equal(controller.getSnapshot().lastPrimaryResult, null, "reading/ack must not create a model Run");
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});
