import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createWorkTaskStore, type WorkTaskResult } from "./work-task-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-work-task-"));
  directories.push(directory);
  return directory;
}

function code<T>(result: WorkTaskResult<T>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function input() {
  return {
    threadId: "thread-1",
    goal: "Create a verified report",
    constraints: ["Do not edit source files"],
    acceptance: [
      { id: "artifact", description: "Report exists", method: "automatic" as const, required: true, verification: { kind: "artifact_exists" as const, path: "report.md" } },
      { id: "quality", description: "User accepts quality", method: "human" as const, required: true, verification: { kind: "human" as const } },
    ],
  };
}

describe("WorkTaskStore", () => {
  it("returns delivery for changes once under CAS, preserves the last delivery but invalidates acceptance", async () => {
    const directory = await workspace();
    const store = createWorkTaskStore(directory, { generateId: () => "rework" });
    assert.ok((await store.create(input())).ok);
    assert.equal(code(await store.requestChanges("rework", 1)), "WORK_TASK_INVALID_STATE");
    assert.ok((await store.beginRun("rework", { expectedRevision: 1, runId: "first" })).ok);
    assert.equal(code(await store.requestChanges("rework", 2)), "WORK_TASK_INVALID_STATE");
    assert.ok((await store.pause("rework", 2)).ok);
    assert.ok((await store.submitDelivery("rework", { expectedRevision: 3, delivery: { summary: "First draft", artifactRefs: [], evidence: [], unresolved: ["revise"] } })).ok);
    const accepted = await store.recordAcceptance("rework", { expectedRevision: 4, criterionId: "quality", actor: "human", status: "passed", note: "old approval", evidence: [{ id: "old", kind: "human", criterionId: "quality", acceptedAt: new Date().toISOString() }] });
    assert.ok(accepted.ok); if (!accepted.ok) return;
    const results = await Promise.all([store.requestChanges("rework", accepted.value.revision), store.requestChanges("rework", accepted.value.revision)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => code(result) === "WORK_TASK_REVISION_CONFLICT").length, 1);
    const paused = await createWorkTaskStore(directory).get("rework");
    assert.ok(paused.ok); if (!paused.ok) return;
    assert.equal(paused.value.status, "paused");
    assert.deepEqual(paused.value.delivery, accepted.value.delivery);
    assert.deepEqual(paused.value.runIds, ["first"]);
    assert.ok(paused.value.acceptance.every(item => item.status === "not_run" && item.evidenceRefs.length === 0 && item.note === null));
    assert.equal(code(await store.recordAcceptance("rework", { expectedRevision: paused.value.revision, criterionId: "quality", actor: "human", status: "failed" })), "WORK_TASK_INVALID_STATE");
    assert.ok((await store.beginRun("rework", { expectedRevision: paused.value.revision, runId: "second" })).ok);
    const running = await store.get("rework");
    assert.ok(running.ok); if (!running.ok) return;
    assert.equal(code(await store.recordAcceptance("rework", { expectedRevision: running.value.revision, criterionId: "quality", actor: "human", status: "failed" })), "WORK_TASK_INVALID_STATE");
    assert.ok((await store.markNeedsReview("rework", running.value.revision)).ok);
    assert.equal(code(await store.requestChanges("rework", running.value.revision + 1)), "WORK_TASK_INVALID_STATE");
  });

  it("does not reopen a completed or cancelled task for changes", async () => {
    const store = createWorkTaskStore(await workspace());
    const created = await store.create({ ...input(), acceptance: [input().acceptance[1]!] });
    assert.ok(created.ok); if (!created.ok) return;
    const id = created.value.id;
    assert.ok((await store.beginRun(id, { expectedRevision: 1, runId: "run" })).ok);
    assert.ok((await store.pause(id, 2)).ok);
    assert.ok((await store.submitDelivery(id, { expectedRevision: 3, delivery: { summary: "done", artifactRefs: [], evidence: [], unresolved: [] } })).ok);
    const completed = await store.recordAcceptance(id, { expectedRevision: 4, criterionId: "quality", actor: "human", status: "passed", evidence: [{ id: "proof", kind: "human", criterionId: "quality", acceptedAt: new Date().toISOString() }] });
    assert.ok(completed.ok); if (!completed.ok) return;
    assert.equal(code(await store.requestChanges(id, completed.value.revision)), "WORK_TASK_INVALID_STATE");
    const other = await store.create(input());
    assert.ok(other.ok); if (!other.ok) return;
    assert.ok((await store.cancel(other.value.id, 1)).ok);
    assert.equal(code(await store.requestChanges(other.value.id, 2)), "WORK_TASK_INVALID_STATE");
  });

  it("persists a task lifecycle and completes only after delivery and required evidence", async () => {
    const directory = await workspace();
    let tick = 0;
    const store = createWorkTaskStore(directory, {
      generateId: () => "task-1",
      now: () => new Date(`2026-09-30T00:00:0${tick++}.000Z`),
      executionRecords: {
        getRun: async () => ({
          runId: "run-1", threadId: "thread-1", workTaskId: "task-1", phase: "primary",
          status: "completed", startedAt: "2026-09-30T00:00:00.000Z",
          finishedAt: "2026-09-30T00:00:01.000Z", resultTextPreview: "", resultTextTruncated: false,
          errorPreview: null, tools: [{
            toolCallId: "write-1", toolName: "write_file", status: "completed",
            requestedAt: "2026-09-30T00:00:00.000Z", startedAt: "2026-09-30T00:00:00.000Z",
            finishedAt: "2026-09-30T00:00:01.000Z", inputPreview: JSON.stringify({ path: "report.md" }),
            inputTruncated: false, resultPreview: JSON.stringify({ ok: true, path: "report.md" }),
            resultTruncated: false, errorPreview: null, shell: null,
          }],
        }),
      },
    });
    await writeFile(join(directory, "report.md"), "report\n");
    const created = await store.create(input());
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.status, "ready");

    const running = await store.beginRun("task-1", { expectedRevision: 1, runId: "run-1" });
    assert.equal(running.ok && running.value.status, "running");
    assert.equal(code(await store.cancel("task-1", 2)), "WORK_TASK_INVALID_STATE");

    const paused = await store.pause("task-1", 2);
    assert.equal(paused.ok && paused.value.status, "paused");
    const delivered = await store.submitDelivery("task-1", {
      expectedRevision: 3,
      delivery: { summary: "Report ready", artifactRefs: ["report.md"], evidence: [], unresolved: [] },
    });
    assert.equal(delivered.ok && delivered.value.status, "awaiting_acceptance");

    const artifact = await store.recordAcceptance("task-1", {
      expectedRevision: 4, criterionId: "artifact", actor: "automatic", status: "passed",
      evidence: [{ id: "e-artifact", kind: "artifact", runId: "run-1", toolCallId: "write-1", path: "report.md", sha256: "331d26d6d8f862e46ba900811be8a7a1e4dbaa229b14c99becfd5e5151490d95", verifiedAt: "2026-09-30T00:00:10.000Z" }],
    });
    assert.equal(artifact.ok && artifact.value.status, "awaiting_acceptance");
    const completed = await store.recordAcceptance("task-1", {
      expectedRevision: 5, criterionId: "quality", actor: "human", status: "passed",
      evidence: [{ id: "e-human", kind: "human", criterionId: "quality", acceptedAt: "2026-09-30T00:00:11.000Z" }],
    });
    assert.equal(completed.ok && completed.value.status, "completed");
    if (!completed.ok) return;
    assert.deepEqual(completed.value.acceptance.map((criterion) => criterion.evidenceRefs), [["e-artifact"], ["e-human"]]);
    assert.equal(completed.value.delivery?.evidence.length, 2);

    // A replacement delivery is not allowed to inherit already-passed evidence.
    assert.equal(code(await store.submitDelivery("task-1", {
      expectedRevision: completed.value.revision,
      delivery: { summary: "replacement", artifactRefs: ["report.md"], evidence: [], unresolved: [] },
    })), "WORK_TASK_INVALID_STATE");

    const reopened = createWorkTaskStore(directory);
    assert.deepEqual(await reopened.get("task-1"), { ok: true, value: completed.value });
    assert.equal((await readFile(join(directory, ".runloom", "work-tasks.json"), "utf8")).endsWith("\n"), true);
  });

  it("enforces revision, state, verification, evidence, and Run ownership contracts", async () => {
    const directory = await workspace();
    let nextId = 0;
    const store = createWorkTaskStore(directory, { generateId: () => `task-${++nextId}` });
    assert.equal(code(await store.create({ ...input(), acceptance: [{ ...input().acceptance[0]!, required: false }] })), "WORK_TASK_INVALID_INPUT");
    assert.equal(code(await store.create({ ...input(), acceptance: [{ ...input().acceptance[0]!, method: "human", verification: { kind: "artifact_exists", path: "x" } }] })), "WORK_TASK_INVALID_INPUT");

    const first = await store.create(input());
    const second = await store.create({ ...input(), threadId: "thread-2" });
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.equal(code(await store.beginRun(first.value.id, { expectedRevision: 99, runId: "shared" })), "WORK_TASK_REVISION_CONFLICT");
    assert.equal((await store.beginRun(first.value.id, { expectedRevision: 1, runId: "shared" })).ok, true);
    assert.equal(code(await store.beginRun(second.value.id, { expectedRevision: 1, runId: "shared" })), "WORK_TASK_INVALID_INPUT");
    assert.equal(code(await store.recordAcceptance(second.value.id, { expectedRevision: 1, criterionId: "artifact", actor: "automatic", status: "passed", evidence: [] })), "WORK_TASK_INVALID_STATE");

    const secondRunning = await store.beginRun(second.value.id, { expectedRevision: 1, runId: "run-2" });
    assert.equal(secondRunning.ok, true);
    const needsReview = await store.markNeedsReview(second.value.id, 2);
    assert.equal(needsReview.ok, true);
    assert.equal(code(await store.submitDelivery(second.value.id, {
      expectedRevision: 3,
      delivery: { summary: "must reconcile first", artifactRefs: [], evidence: [], unresolved: [] },
    })), "WORK_TASK_INVALID_STATE");
    const third = await store.create({ ...input(), threadId: "thread-3" });
    assert.equal(third.ok, true);
    if (!third.ok) return;
    assert.equal((await store.beginRun(third.value.id, { expectedRevision: 1, runId: "run-3" })).ok, true);
    const secondPaused = await store.pause(third.value.id, 2);
    assert.equal(secondPaused.ok, true);
    const delivery = await store.submitDelivery(third.value.id, { expectedRevision: 3, delivery: { summary: "ready", artifactRefs: [], evidence: [], unresolved: ["quality"] } });
    assert.equal(delivery.ok, true);
    assert.equal(code(await store.recordAcceptance(third.value.id, {
      expectedRevision: 4, criterionId: "artifact", actor: "automatic", status: "passed",
      evidence: [{ id: "wrong", kind: "human", criterionId: "artifact", acceptedAt: "2026-09-30T00:00:00.000Z" }],
    })), "WORK_TASK_INVALID_INPUT");
    const unchanged = await store.get(third.value.id);
    assert.equal(unchanged.ok && unchanged.value.revision, 4);
  });

  it("fails closed for malformed and symlinked storage without replacing it", async () => {
    const malformedRoot = await workspace();
    await mkdir(join(malformedRoot, ".runloom"));
    const malformedFile = join(malformedRoot, ".runloom", "work-tasks.json");
    await writeFile(malformedFile, "not-json");
    const malformed = createWorkTaskStore(malformedRoot);
    assert.equal(code(await malformed.list()), "WORK_TASK_FILE_INVALID");
    assert.equal(code(await malformed.create(input())), "WORK_TASK_FILE_INVALID");
    assert.equal(await readFile(malformedFile, "utf8"), "not-json");

    const symlinkRoot = await workspace();
    const target = await workspace();
    await mkdir(join(target, ".runloom"));
    await symlink(join(target, ".runloom"), join(symlinkRoot, ".runloom"));
    const symlinked = createWorkTaskStore(symlinkRoot);
    assert.equal(code(await symlinked.list()), "WORK_TASK_SYMLINK_NOT_ALLOWED");
    assert.equal(code(await symlinked.create(input())), "WORK_TASK_SYMLINK_NOT_ALLOWED");
  });

  it("rejects aggregate limits before writing and clears prior acceptance on replacement delivery", async () => {
    const directory = await workspace();
    let nextId = 0;
    const store = createWorkTaskStore(directory, { generateId: () => `bounded-${++nextId}` });
    const oversized = await store.create({
      threadId: "thread-1", goal: "bounded",
      constraints: Array.from({ length: 24 }, () => "x".repeat(1_024)),
      acceptance: Array.from({ length: 24 }, (_, index) => ({
        id: `criterion-${index}`, description: "y".repeat(1_024), method: "human" as const,
        verification: { kind: "human" as const }, required: index === 0,
      })),
    });
    assert.equal(code(oversized), "WORK_TASK_LIMIT_EXCEEDED");
    assert.deepEqual(await store.list(), { ok: true, value: [] });

    const created = await store.create({
      threadId: "thread-1", goal: "replace delivery",
      acceptance: [
        { id: "first", description: "First review", method: "human", verification: { kind: "human" }, required: true },
        { id: "second", description: "Second review", method: "human", verification: { kind: "human" }, required: true },
      ],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal((await store.beginRun(created.value.id, { expectedRevision: 1, runId: "replace-run" })).ok, true);
    assert.equal((await store.pause(created.value.id, 2)).ok, true);
    assert.equal((await store.submitDelivery(created.value.id, {
      expectedRevision: 3,
      delivery: { summary: "first delivery", artifactRefs: [], evidence: [], unresolved: [] },
    })).ok, true);
    const accepted = await store.recordAcceptance(created.value.id, {
      expectedRevision: 4, criterionId: "first", actor: "human", status: "passed",
      evidence: [{ id: "first-proof", kind: "human", criterionId: "first", acceptedAt: "2026-09-30T00:00:00.000Z" }],
    });
    assert.equal(accepted.ok && accepted.value.status, "awaiting_acceptance");
    const replaced = await store.submitDelivery(created.value.id, {
      expectedRevision: 5,
      delivery: { summary: "replacement", artifactRefs: [], evidence: [], unresolved: ["review again"] },
    });
    assert.equal(replaced.ok, true);
    if (!replaced.ok) return;
    assert.deepEqual(replaced.value.acceptance.map((criterion) => ({
      status: criterion.status, refs: criterion.evidenceRefs, note: criterion.note,
    })), [
      { status: "not_run", refs: [], note: null },
      { status: "not_run", refs: [], note: null },
    ]);
    assert.deepEqual(replaced.value.delivery?.evidence, []);
  });

  it("rejects caller-supplied evidence instead of trusting an unverified delivery snapshot", async () => {
    const directory = await workspace();
    let nextId = 0;
    const store = createWorkTaskStore(directory, {
      generateId: () => `evidence-${++nextId}`,
      executionRecords: { getRun: async (_threadId, runId) => ({
        runId, threadId: "thread-1", workTaskId: "evidence-2", phase: "primary", status: "completed",
        startedAt: "2026-09-30T00:00:00.000Z", finishedAt: "2026-09-30T00:00:01.000Z",
        resultTextPreview: "", resultTextTruncated: false, errorPreview: null, tools: [],
      }) },
    });
    const created = await store.create({
      threadId: "thread-1", goal: "bounded evidence",
      acceptance: [{ id: "review", description: "Review", method: "human", verification: { kind: "human" }, required: true }],
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal((await store.beginRun(created.value.id, { expectedRevision: 1, runId: "evidence-run" })).ok, true);
    assert.equal((await store.pause(created.value.id, 2)).ok, true);
    const untrusted = await store.submitDelivery(created.value.id, {
      expectedRevision: 3,
      delivery: { summary: "ready", artifactRefs: [], evidence: [{
        id: "fabricated", kind: "human", criterionId: "review",
        acceptedAt: "2026-09-30T00:00:00.000Z",
      }], unresolved: [] },
    });
    assert.equal(code(untrusted), "WORK_TASK_INVALID_INPUT");
    const reopened = await createWorkTaskStore(directory).get(created.value.id);
    assert.equal(reopened.ok && reopened.value.revision, 3);
    assert.equal(reopened.ok && reopened.value.delivery, null);

    const automatic = await store.create({
      threadId: "thread-1", goal: "verify receipt",
      acceptance: [{ id: "shell", description: "Check passes", method: "automatic",
        verification: { kind: "shell_exit_zero", command: "pnpm test", cwd: "." }, required: true }],
    });
    assert.equal(automatic.ok, true);
    if (!automatic.ok) return;
    assert.equal((await store.beginRun(automatic.value.id, { expectedRevision: 1, runId: "receipt-run" })).ok, true);
    assert.equal((await store.pause(automatic.value.id, 2)).ok, true);
    assert.equal((await store.submitDelivery(automatic.value.id, {
      expectedRevision: 3,
      delivery: { summary: "ready", artifactRefs: [], evidence: [], unresolved: [] },
    })).ok, true);
    const fabricated = await store.recordAcceptance(automatic.value.id, {
      expectedRevision: 4, criterionId: "shell", actor: "automatic", status: "passed",
      evidence: [{ id: "claimed-real", kind: "tool", runId: "receipt-run", toolCallId: "claimed-real",
        toolName: "shell_exec", command: "pnpm test", cwd: ".",
        verifiedAt: "2026-09-30T00:00:02.000Z", outcome: "succeeded" },
      { id: "fake-tool", kind: "tool", runId: "receipt-run", toolCallId: "does-not-exist",
        toolName: "shell_exec", command: "pnpm test", cwd: ".",
        verifiedAt: "2026-09-30T00:00:02.000Z", outcome: "succeeded" }],
    });
    assert.equal(code(fabricated), "WORK_TASK_INVALID_INPUT");
    const unchangedAutomatic = await store.get(automatic.value.id);
    assert.equal(unchangedAutomatic.ok && unchangedAutomatic.value.revision, 4);
    assert.deepEqual(unchangedAutomatic.ok && unchangedAutomatic.value.delivery?.evidence, []);
  });

  it("reads version-one tasks written before reconciliation history existed", async () => {
    const directory = await workspace();
    const store = createWorkTaskStore(directory, { generateId: () => "legacy-task" });
    const created = await store.create(input());
    assert.equal(created.ok, true);
    const file = join(directory, ".runloom", "work-tasks.json");
    const document = JSON.parse(await readFile(file, "utf8")) as { tasks: Array<Record<string, unknown>> };
    delete document.tasks[0]?.reconciliations;
    await writeFile(file, `${JSON.stringify(document)}\n`);
    const reopened = await createWorkTaskStore(directory).get("legacy-task");
    assert.equal(reopened.ok, true);
    assert.deepEqual(reopened.ok ? reopened.value.reconciliations : undefined, []);
  });
});
