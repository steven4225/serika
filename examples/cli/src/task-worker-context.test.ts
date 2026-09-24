import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createMemoryStore } from "./memory-store.js";
import { createCheckpointStore } from "./checkpoint-store.js";
import type { TaskRecordV3, TaskStore, TaskListInput, TaskSummaryV3 } from "./task-store.js";
import { TASK_LIST_MAX_LIMIT } from "./task-store.js";
import {
  createTaskWorkerContextLoader,
  selectAttentionInbox,
  TASK_WORKER_ATTENTION_INBOX_LIMIT,
} from "./task-worker-context.js";

function claimedTask(): TaskRecordV3 {
  return {
    id: "task-today",
    prompt: "Give me a brief",
    runAt: "2026-09-24T01:00:00.000Z",
    status: "running",
    createdAt: "2026-09-23T00:00:00.000Z",
    startedAt: "2026-09-24T01:00:00.000Z",
    finishedAt: null,
    threadId: "worker-new-thread",
    runId: null,
    resultText: null,
    error: null,
    acknowledgedAt: null,
    recurringTaskId: "series-1",
  };
}

function attentionSummary(id: string, recurringTaskId: string | null): TaskSummaryV3 {
  return {
    id,
    promptPreview: "Give me a brief",
    runAt: "2026-09-24T01:00:00.000Z",
    status: "failed",
    finishedAt: "2026-09-24T01:01:00.000Z",
    resultPreview: null,
    error: { code: "RUNTIME_ERROR", messagePreview: "failed" },
    recurringTaskId,
    acknowledgedAt: null,
  };
}

function attentionStore(
  onList: (input: TaskListInput | undefined) => void,
  listed: { tasks: TaskSummaryV3[]; truncated: boolean } = {
    tasks: [
      attentionSummary("yesterday-brief", "series-1"),
      attentionSummary("other-task", null),
    ],
    truncated: false,
  },
): TaskStore {
  return {
    async list(input: TaskListInput | undefined) {
      onList(input);
      return { ok: true, value: listed };
    },
  } as unknown as TaskStore;
}

function observationInbox(context: { referenceMessages: { parts: Array<{ type: string; text?: string }> }[] }) {
  const text = context.referenceMessages[0]?.parts.find((part) => part.type === "text")?.text;
  assert.ok(text);
  return JSON.parse(text.slice(text.indexOf("{"))) as {
    attentionInbox: { tasks: Array<{ id: string }>; truncated: boolean };
  };
}

describe("task-worker workspace snapshot", () => {
  it("treats absent Memory and checkpoint as an empty, valid snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-worker-context-empty-"));
    try {
      const listCalls: (TaskListInput | undefined)[] = [];
      const context = await createTaskWorkerContextLoader(root, attentionStore((input) => listCalls.push(input)))(
        claimedTask(), new AbortController().signal,
      );
      assert.deepEqual(listCalls, [{ inbox: true, status: "attention", limit: TASK_LIST_MAX_LIMIT }]);
      const text = JSON.stringify(context.referenceMessages);
      assert.match(text, /memory.*none/);
      assert.match(text, /checkpoint.*none/);
      const inbox = observationInbox(context);
      assert.deepEqual(inbox.attentionInbox.tasks.map((task) => task.id), ["other-task"]);
      assert.equal(inbox.attentionInbox.truncated, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes only active workspace Memory and the current checkpoint version", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-worker-context-populated-"));
    try {
      const memory = createMemoryStore(root);
      const workspaceEntry = await memory.add({ text: "Use the M10 plan", scope: { kind: "workspace" } });
      assert.equal(workspaceEntry.ok, true);
      assert.equal((await memory.add({ text: "private thread note", scope: { kind: "thread", threadId: "creator-thread" } })).ok, true);
      assert.equal((await memory.add({ text: "disabled fact", enabled: false })).ok, true);
      const checkpoint = await createCheckpointStore(root).saveNextVersion({
        expectedVersion: null,
        sourceThreadId: "creator-thread",
        draft: {
          status: "active",
          goal: "Ship M10",
          currentPhase: "Acceptance",
          summary: "Snapshot saved before today's worker run",
          completed: [],
          inProgress: [],
          nextActions: ["Check the result"],
          blockers: [],
          artifacts: [],
        },
      });
      assert.equal(checkpoint.ok, true);
      const context = await createTaskWorkerContextLoader(root, attentionStore(() => undefined))(
        claimedTask(), new AbortController().signal,
      );
      const text = JSON.stringify(context.referenceMessages);
      if (workspaceEntry.ok) assert.match(text, new RegExp(workspaceEntry.entry.id));
      assert.match(text, /Use the M10 plan/);
      assert.match(text, /saved version 1/);
      assert.match(text, /Ship M10/);
      assert.doesNotMatch(text, /private thread note|disabled fact/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a damaged Memory source instead of sending a partial snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-worker-context-bad-"));
    try {
      await mkdir(join(root, ".runloom"));
      await writeFile(join(root, ".runloom", "memory.json"), "not json");
      let inboxReads = 0;
      await assert.rejects(
        createTaskWorkerContextLoader(root, attentionStore(() => { inboxReads += 1; }))(
          claimedTask(), new AbortController().signal,
        ),
      );
      assert.equal(inboxReads, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops this series before applying the five-item cap and recomputes truncated", () => {
    const series = Array.from({ length: 5 }, (_, index) =>
      attentionSummary(`brief-${index}`, "series-1"));
    const others = Array.from({ length: 6 }, (_, index) =>
      attentionSummary(`other-${index}`, null));
    const selected = selectAttentionInbox(claimedTask(), {
      tasks: [...series, ...others],
      truncated: false,
    });
    assert.deepEqual(selected.tasks.map((task) => task.id), others.slice(0, TASK_WORKER_ATTENTION_INBOX_LIMIT).map((task) => task.id));
    assert.equal(selected.truncated, true);
    assert.equal(selected.tasks.some((task) => task.id.startsWith("brief-")), false);
  });
});
