import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { MockLanguageModelV3 } from "ai/test";
import { createMemoryStore } from "./memory-store.js";
import { createTaskStore } from "./task-store.js";
import { createScheduledDemoModel, createTaskWorkerAgent } from "./task-worker-entry.js";
import { runTaskWorker } from "./task-worker.js";

it("no-new-user memory Demo: a due reminder creates no model Run and leaves saved memory unchanged", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-reminder-no-memory-"));
  let now = Date.parse("2026-10-13T01:00:00Z");
  let modelCalls = 0;
  let runs = 0;
  const agent = createTaskWorkerAgent({ modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => {
    modelCalls++;
    throw new Error("a typed reminder must not call the model or memory_add");
  } }), store: new JsonlAgentStore({ directory: join(root, ".runloom", "task-transcripts") }) });
  try {
    const memory = createMemoryStore(root);
    assert.ok((await memory.add({ text: "我喜欢喝美式。", source: {
      kind: "conversation", threadId: "ordinary-chat", messageId: "previous-user", quote: "记住我喜欢喝美式。",
    } })).ok);
    const before = await readFile(join(root, ".runloom", "memory.json"));
    const tasks = createTaskStore(root, { now: () => now });
    const created = await tasks.create({ prompt: "喝水。记住我喜欢喝美式。", runAt: new Date(now + 1_000).toISOString(),
      arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } });
    assert.ok(created.ok);
    now += 1_000;
    const stop = new AbortController();
    await runTaskWorker({ store: tasks, signal: stop.signal, now: () => now,
      runtime: { run: request => { runs++; return agent.runtime.run(request); } },
      onTaskFinished: () => stop.abort(),
    });
    const finished = await createTaskStore(root).get(created.value.id); assert.ok(finished.ok);
    assert.equal(finished.value.status, "completed");
    assert.equal(finished.value.resultText, created.value.prompt);
    assert.equal(finished.value.runId, null);
    assert.equal(runs, 0);
    assert.equal(modelCalls, 0);
    assert.deepEqual(await readFile(join(root, ".runloom", "memory.json")), before);
    const reopened = await createMemoryStore(root).list(); assert.ok(reopened.ok);
    assert.equal(reopened.entries.length, 1);
    assert.equal(reopened.entries[0]!.source?.kind, "conversation");
    assert.equal(reopened.entries[0]!.source?.messageId, "previous-user");
  } finally { agent.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("persisted terminal result survives worker restart and only notification is retried", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-delivery-chain-"));
  let now = Date.parse("2026-09-30T01:00:00Z");
  let modelRuns = 0;
  const agent = createTaskWorkerAgent({ modelAlias: "mock", model: createScheduledDemoModel(), store: new JsonlAgentStore({ directory: join(root, ".runloom", "task-transcripts") }) });
  const runtime = { run: (...args: Parameters<typeof agent.runtime.run>) => {
    modelRuns += 1;
    return agent.runtime.run(...args);
  } };
  try {
    const store = createTaskStore(root, { now: () => now });
    const created = await store.create({ prompt: "remind me to drink water", runAt: new Date(now + 1_000).toISOString() });
    assert(created.ok);
    now += 1_000;
    const stopAfterFinish = new AbortController();
    await runTaskWorker({ store, runtime, now: () => now, signal: stopAfterFinish.signal,
      notify: async () => { throw new Error("must not submit before restart"); },
      onTaskFinished: () => stopAfterFinish.abort(),
    });
    const finished = await createTaskStore(root).get(created.value.id);
    assert(finished.ok);
    assert.equal(finished.value.status, "completed");
    assert.equal(finished.value.notification?.status, "pending");
    assert.equal(finished.value.attempts.length, 1);
    const rejectSubmission = new AbortController();
    await runTaskWorker({ store: createTaskStore(root, { now: () => now }), runtime, now: () => now, signal: rejectSubmission.signal,
      notify: async () => { rejectSubmission.abort(); throw new Error("OS unavailable"); },
    });
    const failed = await createTaskStore(root).get(created.value.id);
    assert(failed.ok);
    assert.equal(failed.value.status, "completed");
    assert.equal(failed.value.notification?.status, "failed");
    now += 1_000;
    const acceptSubmission = new AbortController();
    await runTaskWorker({ store: createTaskStore(root, { now: () => now }), runtime, now: () => now, signal: acceptSubmission.signal,
      notify: async () => { acceptSubmission.abort(); },
    });
    const submitted = await createTaskStore(root).get(created.value.id);
    assert(submitted.ok);
    assert.equal(submitted.value.notification?.status, "submitted");
    assert.equal(submitted.value.notification?.attempts, 2);
    assert.equal(submitted.value.acknowledgedAt, null);
    assert.equal(modelRuns, 1);
    assert.equal(submitted.value.resultText, finished.value.resultText);
    assert((await store.acknowledge(created.value.id)).ok);
    const inbox = await store.list({ inbox: true });
    assert(inbox.ok);
    assert.equal(inbox.value.tasks.length, 0);
  } finally { agent.dispose(); await rm(root, { recursive: true, force: true }); }
});
