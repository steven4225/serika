import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CHECKPOINT_FILE_MAX_BYTES,
  CHECKPOINT_FILE_NAME,
  CHECKPOINT_HISTORY_MAX_ENTRIES,
  CHECKPOINT_SNAPSHOT_MAX_BYTES,
  createCheckpointStore,
  type CheckpointDraft,
  type CheckpointGitPin,
} from "./checkpoint-store.js";

const gitPin: CheckpointGitPin = {
  head: "a".repeat(40),
  branch: "main",
  dirty: false,
  observedAt: "2026-09-23T00:00:00.000Z",
};

function draft(overrides: Partial<CheckpointDraft> = {}): CheckpointDraft {
  return {
    status: "active",
    goal: "Complete Serika M5",
    currentPhase: "Store integration",
    summary: "The checkpoint store is being implemented.",
    completed: ["Freeze the contract"],
    inProgress: ["Implement the TUI module"],
    nextActions: ["Run focused tests"],
    blockers: [],
    artifacts: [{ label: "Implementation plan", path: "docs/m5-plan.md" }],
    ...overrides,
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "runloom-checkpoint-store-"));
}

describe("WorkspaceCheckpointStore", () => {
  it("creates v1, advances versions, and retrieves retained history with a stable id", async () => {
    const root = await workspace();
    let tick = 0;
    const store = createCheckpointStore(root, {
      now: () => new Date(Date.UTC(2026, 0, 1, 0, tick++)),
      generateId: () => "checkpoint-1",
    });

    assert.deepEqual(await store.getCurrent(), { ok: true, current: null });
    const first = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.checkpoint.version, 1);
    assert.equal(first.checkpoint.id, "checkpoint-1");
    assert.deepEqual(first.checkpoint.source, { threadId: "thread-a" });

    const second = await store.saveNextVersion({
      expectedVersion: 1,
      draft: draft({ status: "paused", nextActions: ["Resume implementation"] }),
      sourceThreadId: "thread-b",
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.checkpoint.version, 2);
    assert.equal(second.checkpoint.id, first.checkpoint.id);
    assert.equal(second.checkpoint.createdAt, first.checkpoint.createdAt);
    assert.notEqual(second.checkpoint.updatedAt, first.checkpoint.updatedAt);
    assert.deepEqual(second.checkpoint.source, { threadId: "thread-b" });

    assert.deepEqual(await store.getVersion(1), { ok: true, checkpoint: first.checkpoint });
    const current = await store.getCurrent();
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.current?.version, 2);
  });

  it("persists a program-supplied Git pin but never inherits it on the next version", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root);
    const first = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
      realityPins: { git: gitPin },
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.checkpoint.realityPins, { git: gitPin });
    const second = await store.saveNextVersion({
      expectedVersion: 1,
      draft: draft({ summary: "A new snapshot without a Git observation." }),
      sourceThreadId: "thread-b",
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.checkpoint.realityPins, undefined);
    assert.deepEqual(await store.getVersion(1), { ok: true, checkpoint: first.checkpoint });
    const file = JSON.parse(await readFile(join(root, CHECKPOINT_FILE_NAME), "utf8")) as { schemaVersion: number };
    assert.equal(file.schemaVersion, 1);
  });

  it("omits invalid or oversized program pins without rejecting a valid draft", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root);
    const invalid = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
      realityPins: { git: { ...gitPin, head: "not-a-sha" } },
    });
    assert.equal(invalid.ok, true);
    if (!invalid.ok) return;
    assert.equal(invalid.checkpoint.realityPins, undefined);

    const oversized = await store.saveNextVersion({
      expectedVersion: 1,
      draft: draft(),
      sourceThreadId: "thread-a",
      realityPins: { git: { ...gitPin, branch: "x".repeat(257) } },
    });
    assert.equal(oversized.ok, true);
    if (oversized.ok) assert.equal(oversized.checkpoint.realityPins, undefined);
  });

  it("fails closed on a malformed stored Git pin", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root);
    const saved = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
      realityPins: { git: gitPin },
    });
    assert.equal(saved.ok, true);
    const file = join(root, CHECKPOINT_FILE_NAME);
    const document = JSON.parse(await readFile(file, "utf8")) as {
      current: { realityPins: { git: CheckpointGitPin } };
    };
    document.current.realityPins.git.head = "unknown";
    const corrupt = `${JSON.stringify(document)}\n`;
    await writeFile(file, corrupt, "utf8");
    const current = await store.getCurrent();
    assert.equal(current.ok, false);
    if (!current.ok) assert.equal(current.error.code, "CHECKPOINT_FILE_INVALID");
    const resave = await store.saveNextVersion({ expectedVersion: 1, draft: draft(), sourceThreadId: "thread-b" });
    assert.equal(resave.ok, false);
    assert.equal(await readFile(file, "utf8"), corrupt);
  });

  it("drops the oldest retained version once history is full", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root, { generateId: () => "checkpoint-history" });
    const created = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft({ summary: "version 1" }),
      sourceThreadId: "thread-a",
    });
    assert.equal(created.ok, true);

    for (let version = 1; version <= CHECKPOINT_HISTORY_MAX_ENTRIES + 1; version += 1) {
      const saved = await store.saveNextVersion({
        expectedVersion: version,
        draft: draft({ summary: `version ${version + 1}` }),
        sourceThreadId: "thread-a",
      });
      assert.equal(saved.ok, true);
    }

    assert.deepEqual(await store.getVersion(1), {
      ok: false,
      error: {
        code: "CHECKPOINT_VERSION_NOT_FOUND",
        message: "Checkpoint version 1 is not available",
      },
    });
    const retained = await store.getVersion(2);
    assert.equal(retained.ok, true);
    if (retained.ok) assert.equal(retained.checkpoint.version, 2);
    const current = await store.getCurrent();
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.current?.version, CHECKPOINT_HISTORY_MAX_ENTRIES + 2);
  });

  it("allows only one concurrent write using the same expected version", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root, { generateId: () => "checkpoint-race" });
    const created = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
    });
    assert.equal(created.ok, true);

    const outcomes = await Promise.all([
      store.saveNextVersion({ expectedVersion: 1, draft: draft({ summary: "writer A" }), sourceThreadId: "thread-a" }),
      store.saveNextVersion({ expectedVersion: 1, draft: draft({ summary: "writer B" }), sourceThreadId: "thread-b" }),
    ]);
    assert.equal(outcomes.filter((item) => item.ok).length, 1);
    assert.equal(outcomes.filter((item) => !item.ok && item.error.code === "CHECKPOINT_VERSION_CONFLICT").length, 1);
    const current = await store.getCurrent();
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.current?.version, 2);
  });

  it("rejects oversized content without changing the current version", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root);
    const created = await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
    });
    assert.equal(created.ok, true);

    const tooLarge = await store.saveNextVersion({
      expectedVersion: 1,
      draft: draft({ summary: "界".repeat(Math.ceil(2_048 / 3) + 1) }),
      sourceThreadId: "thread-a",
    });
    assert.deepEqual(tooLarge, {
      ok: false,
      error: {
        code: "CHECKPOINT_TOO_LARGE",
        message: "summary exceeds the 2048-byte limit",
      },
    });
    const current = await store.getCurrent();
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.current?.version, 1);
    assert.ok(CHECKPOINT_SNAPSHOT_MAX_BYTES < CHECKPOINT_FILE_MAX_BYTES);
  });

  it("rejects a snapshot whose serialized model-context message exceeds the injection limit", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root);
    const oversizedForContext = draft({
      summary: "\"".repeat(512),
      completed: Array(10).fill("\"".repeat(256)),
      inProgress: [],
      nextActions: [],
    });

    const saved = await store.saveNextVersion({
      expectedVersion: null,
      draft: oversizedForContext,
      sourceThreadId: "thread-a",
    });

    assert.equal(saved.ok, false);
    if (!saved.ok) {
      assert.equal(saved.error.code, "CHECKPOINT_TOO_LARGE");
      assert.match(saved.error.message, /injection limit/);
    }
    assert.deepEqual(await store.getCurrent(), { ok: true, current: null });
  });

  it("fails closed on corrupt data and never overwrites it", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root);
    await store.saveNextVersion({
      expectedVersion: null,
      draft: draft(),
      sourceThreadId: "thread-a",
    });
    const file = join(root, CHECKPOINT_FILE_NAME);
    const corrupt = "{not-json\n";
    await writeFile(file, corrupt, "utf8");

    assert.deepEqual(await store.getCurrent(), {
      ok: false,
      error: { code: "CHECKPOINT_FILE_INVALID", message: "Checkpoint file must contain valid JSON" },
    });
    const save = await store.saveNextVersion({
      expectedVersion: 1,
      draft: draft({ summary: "must not replace damaged file" }),
      sourceThreadId: "thread-b",
    });
    assert.equal(save.ok, false);
    if (!save.ok) assert.equal(save.error.code, "CHECKPOINT_FILE_INVALID");
    assert.equal(await readFile(file, "utf8"), corrupt);
  });

  it("rejects files above the read limit without parsing or rewriting them", async () => {
    const root = await workspace();
    const directory = join(root, ".runloom");
    await mkdir(directory);
    const file = join(root, CHECKPOINT_FILE_NAME);
    const oversized = "x".repeat(CHECKPOINT_FILE_MAX_BYTES + 1);
    await writeFile(file, oversized, "utf8");
    const store = createCheckpointStore(root);

    const result = await store.getCurrent();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "CHECKPOINT_TOO_LARGE");
    assert.equal((await readFile(file, "utf8")).length, oversized.length);
  });

  it("does not create a checkpoint when the save is already cancelled", async () => {
    const root = await workspace();
    const store = createCheckpointStore(root);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await assert.rejects(
      store.saveNextVersion({ expectedVersion: null, draft: draft(), sourceThreadId: "thread-a" }, controller.signal),
      /cancelled/,
    );
    const current = await store.getCurrent();
    assert.deepEqual(current, { ok: true, current: null });
    await rm(root, { recursive: true, force: true });
  });
});
