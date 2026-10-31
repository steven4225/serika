import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createTaskStore } from "./task-store.js";
import { createWorkTaskStore } from "./work-task-store.js";

test("reminder creation replay survives restart and due time; changed payload never reuses a key", async () => {
  const root = await mkdtemp(join(tmpdir(), "reminder-idem-"));
  try {
    const input = { prompt: "drink water", runAt: "2026-10-17T01:00:00Z", operationId: "reminder-1" };
    const a = createTaskStore(join(root, ".runloom/tasks.json"), { now: () => Date.parse("2026-10-16T00:00:00Z") });
    const b = createTaskStore(join(root, ".runloom/tasks.json"), { now: () => Date.parse("2026-10-16T00:00:00Z") });
    const [first, duplicate] = await Promise.all([a.create(input), b.create(input)]);
    assert.ok(first.ok && duplicate.ok); assert.equal(first.value.id, duplicate.value.id);
    const before = await readFile(join(root, ".runloom/tasks.json"), "utf8");
    const restarted = createTaskStore(join(root, ".runloom/tasks.json"), { now: () => Date.parse("2026-10-18T00:00:00Z") });
    const replay = await restarted.create(input); assert.ok(replay.ok); assert.equal(replay.value.id, first.value.id);
    assert.equal(await readFile(join(root, ".runloom/tasks.json"), "utf8"), before);
    assert.equal((await restarted.create({ ...input, prompt: "changed" })).ok, false);
    assert.equal((await restarted.create(Object.assign({}, input, { operationId: "new-operation" }))).ok, false, "new past reminder rejected");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recurring and once share a key namespace; a new operation can intentionally duplicate content", async () => {
  const root = await mkdtemp(join(tmpdir(), "recurring-idem-"));
  try {
    const store = createTaskStore(join(root, ".runloom/tasks.json"), { now: () => Date.parse("2026-10-16T00:00:00Z") });
    const input = { prompt: "review", recurrence: { kind: "daily" as const, time: "09:00", utcOffset: "+08:00" }, operationId: "schedule-1" };
    const first = await store.createRecurring(input), replay = await createTaskStore(join(root, ".runloom/tasks.json")).createRecurring(input);
    assert.ok(first.ok && replay.ok); assert.equal(first.value.id, replay.value.id);
    const once = { prompt: "review", runAt: "2026-10-17T00:00:00Z", operationId: input.operationId };
    assert.equal((await store.create(once)).ok, false);
    const another = await store.createRecurring(Object.assign({}, input, { operationId: "schedule-2" })); assert.ok(another.ok); assert.notEqual(another.value.id, first.value.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("work task create is atomic and replayable across Store instances, Thread and payload are bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-idem-"));
  try {
    const input = { threadId: "t", goal: "report", operationId: "work-1", acceptance: [{ id: "human", description: "review", method: "human" as const, verification: { kind: "human" as const }, required: true }] };
    const [a, b] = await Promise.all([createWorkTaskStore(createTaskStore(join(dirname(join(root, ".runloom/work-tasks.json")), "tasks.json")), { workspace: root, }).create(input), createWorkTaskStore(createTaskStore(join(dirname(join(root, ".runloom/work-tasks.json")), "tasks.json")), { workspace: root, }).create(input)]);
    assert.ok(a.ok && b.ok); assert.equal(a.value.id, b.value.id);
    const before = await readFile(join(root, ".runloom/tasks.json"), "utf8");
    const restarted = createWorkTaskStore(createTaskStore(join(dirname(join(root, ".runloom/work-tasks.json")), "tasks.json")), { workspace: root, });
    const replay = await restarted.create(input); assert.ok(replay.ok); assert.equal(replay.value.id, a.value.id);
    assert.equal(await readFile(join(root, ".runloom/tasks.json"), "utf8"), before);
    assert.equal((await restarted.create({ ...input, threadId: "another-thread" })).ok, false);
    assert.equal((await restarted.create({ ...input, goal: "different" })).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
