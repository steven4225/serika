import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskStore } from "@serika/assistant";
import { taskResultLink } from "@serika/assistant/testing";
import { openTaskNotificationResult } from "./task-notification-route.js";

test("notification clicks read the exact record without acknowledgement, execution or cross-workspace reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-notification-route-"));
  try {
    const store = createTaskStore(root);
    const created = await store.create({ prompt: "isolated reminder", runAt: new Date(Date.now() + 60_000).toISOString() });
    assert.ok(created.ok);
    const path = join(root, ".runloom/tasks.json");
    const before = await readFile(path, "utf8");
    let reads = 0;
    const read = async (id: string) => { reads++; return store.get(id); };
    const result = await openTaskNotificationResult(taskResultLink(root, created.value.id), root, read);
    assert.equal(result.taskId, created.value.id);
    assert.equal(reads, 1);
    assert.equal(await readFile(path, "utf8"), before, "opening a notification cannot write or ack a task");
    await assert.rejects(openTaskNotificationResult(taskResultLink("/other-workspace", created.value.id), root, read), /另一个工作区/);
    await assert.rejects(openTaskNotificationResult(taskResultLink(root, created.value.id) + "&execute=1", root, read), /链接无效/);
    assert.equal(reads, 1, "foreign or invalid navigation is rejected before any read");
    await assert.rejects(openTaskNotificationResult(taskResultLink(root, "missing"), root, read), /通知结果不可用/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
