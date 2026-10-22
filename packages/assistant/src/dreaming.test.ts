import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDreamingService, type DreamingBatch, type DreamingResult } from "./dreaming.js";
import type { WorkTask, WorkTaskStore } from "./work-task-store.js";
import type { ExecutionRecordStore, ExecutionRunRecord } from "./execution-record-store.js";
import type { MemoryEntry, WorkspaceMemoryStore } from "./memory-types.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
function value<T>(r: DreamingResult<T>): T { assert.ok(r.ok, r.ok ? "" : r.error.message); return r.value; }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runloom-dreaming-")); directories.push(root);
  const tasks: WorkTask[] = [], runs = new Map<string, ExecutionRunRecord>();
  function add(id: string) {
    const runId = `run-${id}`, stamp = "2026-10-01T00:00:00.000Z";
    tasks.push({ id, revision: 5, threadId: `thread-${id}`, goal: "整理项目复盘，先结论再列可执行步骤", constraints: [], status: "completed", runIds: [runId], reconciliations: [], createdAt: stamp, updatedAt: stamp,
      acceptance: [{ id: "quality", description: "复盘简明且步骤能执行", method: "human", verification: { kind: "human" }, required: true, status: "passed", evidenceRefs: [`human-${id}`], note: "已核对结论与两条步骤，符合要求" }],
      delivery: { summary: "先写一行结论，再写两条可执行步骤", artifactRefs: [], unresolved: [], evidence: [{ id: `human-${id}`, kind: "human", criterionId: "quality", acceptedAt: stamp }] } });
    runs.set(runId, { runId, threadId: `thread-${id}`, workTaskId: id, phase: "primary", status: "completed", startedAt: stamp, finishedAt: stamp, resultTextPreview: "done", resultTextTruncated: false, errorPreview: null, tools: [] });
  }
  add("task-a"); add("task-b");
  const workTasks = { list: async () => ({ ok: true, value: structuredClone(tasks) }), get: async (id: string) => { const t = tasks.find(t => t.id === id); return t ? { ok: true, value: structuredClone(t) } : { ok: false, error: { code: "WORK_TASK_NOT_FOUND", message: "Not found" } }; } } as WorkTaskStore;
  const executionRecords: Pick<ExecutionRecordStore, "getRun"> = { getRun: async (_threadId, id) => structuredClone(runs.get(id) ?? null) };
  const service = createDreamingService({ filePath: join(root, ".runloom/dreaming.json"), workTasks, executionRecords });
  return { root, tasks, runs, add, service, workTasks, executionRecords, reopen: () => createDreamingService({ filePath: join(root, ".runloom/dreaming.json"), workTasks, executionRecords }) };
}
const response = (batch: DreamingBatch, extra: Record<string, unknown> = {}) => JSON.stringify({ skills: [{ key: "project-recap", title: "项目复盘", description: "整理项目复盘时使用", recallTerms: ["复盘", "总结"], instructions: "先给一行结论，再列两条可执行步骤；每条步骤写明可观察结果。", sourceTaskIds: batch.experiences.map(e => e.source.taskId), ...extra }] });

describe("host-managed dreaming experience skills", () => {
  it("reads without creating a store; learns, recalls across threads, replays and survives restart", async () => {
    const f = await fixture();
    assert.equal(value(await f.service.overview()).pendingExperiences, 2);
    await assert.rejects(readFile(join(f.root, ".runloom/dreaming.json")), { code: "ENOENT" });
    const batch = value(await f.service.prepare()); assert.ok(batch);
    assert.deepEqual(batch.message.metadata, { source: "dreaming", memoryConsolidation: "exclude" });
    const committed = value(await f.service.commit(batch, response(batch))); assert.equal(committed.replayed, false);
    const before = await readFile(join(f.root, ".runloom/dreaming.json"), "utf8");
    assert.deepEqual(value(await f.service.commit(batch, response(batch))), { ...committed, replayed: true });
    assert.equal(await readFile(join(f.root, ".runloom/dreaming.json"), "utf8"), before);
    const reopened = f.reopen(); assert.equal(value(await reopened.prepare()), null);
    const selected = value(await reopened.index("new-thread"));
    assert.equal(selected.length, 1); assert.equal(selected[0]!.id, `method:${committed.skillIds[0]}`);
    assert.equal(value(await reopened.read(committed.skillIds[0]!, "new-thread")).sources.length, 2);
    assert.equal("instructions" in selected[0]!, false);
  });

  it("invalid, cancelled, changed or fabricated batches never consume experience", async () => {
    const f = await fixture(), batch = value(await f.service.prepare()); assert.ok(batch);
    assert.equal((await f.service.commit(batch, "bad json")).ok, false);
    assert.equal((await f.service.commit(batch, response(batch, { sourceTaskIds: ["task-a", "invented"] }))).ok, false);
    assert.equal((await f.service.commit(structuredClone(batch), response(batch))).ok, false);
    const cancelled = new AbortController(); cancelled.abort(new Error("yield"));
    await assert.rejects(f.service.commit(batch, response(batch), cancelled.signal), /yield/);
    assert.equal(value(await f.service.overview()).processedExperiences, 0);
    f.tasks[0]!.revision += 1;
    const changed = await f.service.commit(batch, response(batch)); assert.ok(!changed.ok); assert.equal(changed.error.code, "DREAMING_SOURCE_INVALID");
    assert.equal(value(await f.service.overview()).processedExperiences, 0);
  });

  it("preserves uncertain commit acknowledgement when foreground cancellation follows rename", async () => {
    const f = await fixture(), batch = value(await f.service.prepare()); assert.ok(batch);
    const probe = await open(join(f.root, "file-handle-probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    const originalSync = prototype.sync;
    const foreground = new AbortController();
    let faultInjected = false;
    prototype.sync = async function () {
      // save() synchronizes the temporary file before rename, then synchronizes
      // the directory. The latter failure cannot prove the write did not happen.
      if ((await (this as typeof probe).stat()).isDirectory()) {
        faultInjected = true;
        foreground.abort(new Error("Foreground chat has priority"));
        throw new Error("Injected post-rename directory sync failure");
      }
      return originalSync.call(this);
    };
    try {
      const committed = await f.service.commit(batch, response(batch), foreground.signal);
      assert.ok(!committed.ok);
      assert.equal(committed.error.code, "DREAMING_COMMIT_UNCERTAIN");
      assert.equal(faultInjected, true);
      const document = JSON.parse(await readFile(join(f.root, ".runloom/dreaming.json"), "utf8"));
      assert.equal(document.processed.length, 2);
      assert.equal(document.skills.length, 1);
    } finally {
      prototype.sync = originalSync;
      await probe.close();
    }
    // Retrying the exact prepared batch uses its durable receipt, not another
    // skill write, even though the prior foreground operation was cancelled.
    const replay = value(await f.service.commit(batch, response(batch)));
    assert.equal(replay.replayed, true);
    assert.equal(value(await f.service.overview()).processedExperiences, 2);
    assert.equal(value(await f.service.overview()).skills.length, 1);
  });

  it("requires explicit required human acceptance, latest owned completed Run and no unknown effects", async () => {
    for (const defect of ["automatic", "missing-human", "missing-run", "wrong-owner", "interrupted", "unknown", "unresolved"] as const) {
      const f = await fixture(), task = f.tasks[0]!, run = f.runs.get(task.runIds[0]!)!;
      if (defect === "automatic") { task.acceptance[0]!.method = "automatic"; task.acceptance[0]!.verification = { kind: "artifact_exists", path: "file.md" }; }
      if (defect === "missing-human") task.delivery!.evidence = [];
      if (defect === "missing-run") task.runIds.push("missing");
      if (defect === "wrong-owner") run.workTaskId = "foreign";
      if (defect === "interrupted") run.status = "interrupted";
      if (defect === "unknown") run.tools.push({ toolCallId: "unknown", toolName: "write_file", status: "unknown", requestedAt: run.startedAt, startedAt: run.startedAt, finishedAt: null, inputPreview: "{}", inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: null, shell: null });
      if (defect === "unresolved") task.delivery!.unresolved.push("unverified");
      assert.equal(value(await f.service.overview()).pendingExperiences, 1, defect);
      assert.equal(value(await f.service.prepare()), null, defect);
    }
  });

  it("CAS disable prevents selection; new learned versions do not undo disable; restore creates a new revision", async () => {
    const f = await fixture(), batch = value(await f.service.prepare()); assert.ok(batch);
    const { skillIds } = value(await f.service.commit(batch, response(batch))), id = skillIds[0]!;
    const disabled = value(await f.service.change({ id, expectedRevision: 1, action: "disable" })); assert.equal(disabled.revision, 2);
    assert.deepEqual(value(await f.service.index("new")), []);
    assert.equal((await f.service.change({ id, expectedRevision: 1, action: "enable" })).ok, false);
    f.add("task-c"); f.add("task-d"); const second = value(await f.service.prepare()); assert.ok(second);
    value(await f.service.commit(second, response(second, { instructions: "先结论，再给两条含验收方法的步骤。" })));
    const current = value(await f.service.overview()).skills[0]!; assert.equal(current.revision, 3); assert.equal(current.enabled, false);
    const restored = value(await f.service.change({ id, expectedRevision: 3, action: "restore", restoreRevision: 1 }));
    assert.equal(restored.revision, 4); assert.equal(restored.enabled, false); assert.match(restored.instructions, /可观察结果/);
    value(await f.service.change({ id, expectedRevision: 4, action: "enable" })); assert.equal(value(await f.service.index("new")).length, 1);
  });

  it("still lets the user disable a selected method when content history is full", async () => {
    const f = await fixture(), first = value(await f.service.prepare()); assert.ok(first);
    const id = value(await f.service.commit(first, response(first))).skillIds[0]!;
    for (let index = 1; index <= 8; index++) {
      f.add(`version-${index}-a`); f.add(`version-${index}-b`);
      const batch = value(await f.service.prepare()); assert.ok(batch);
      value(await f.service.commit(batch, response(batch, { instructions: `第 ${index} 版复盘：先结论，再列两条明确行动。` })));
    }
    const current = value(await f.service.overview()).skills[0]!;
    assert.equal(current.revision, 9); assert.equal(current.versions.length, 8);
    assert.equal(value(await f.service.index("new-thread")).length, 1);
    const disabled = value(await f.service.change({ id, expectedRevision: 9, action: "disable" }));
    assert.equal(disabled.enabled, false); assert.equal(disabled.revision, 10);
    assert.deepEqual(disabled.versions, current.versions, "disable preserves bounded history without pruning");
    assert.deepEqual(value(await f.service.index("new-thread")), []);
    const enabled = value(await f.service.change({ id, expectedRevision: 10, action: "enable" }));
    assert.equal(enabled.enabled, true); assert.equal(enabled.revision, 11);
    assert.deepEqual(enabled.versions, current.versions);
    const stale = await f.service.change({ id, expectedRevision: 9, action: "disable" });
    assert.ok(!stale.ok); assert.equal(stale.error.code, "DREAMING_REVISION_CONFLICT");
  });

  it("rechecks source receipts on each selection and never silently treats a corrupt file as empty", async () => {
    const f = await fixture(), batch = value(await f.service.prepare()); assert.ok(batch);
    value(await f.service.commit(batch, response(batch))); f.runs.get("run-task-a")!.status = "interrupted";
    assert.deepEqual(value(await f.service.index("new")), []);
    assert.equal(value(await f.service.overview()).skills[0]!.needsReview, true);
    assert.equal((await f.service.change({ id: value(await f.service.overview()).skills[0]!.id, expectedRevision: 1, action: "enable" })).ok, false);
    await writeFile(join(f.root, ".runloom/dreaming.json"), "{bad");
    assert.equal((await f.reopen().overview()).ok, false); assert.equal((await f.reopen().index("new")).ok, false);
  });

  it("archives accepted evidence atomically and survives receipt retention plus service restart", async () => {
    const f = await fixture(), batch = value(await f.service.prepare()); assert.ok(batch);
    const id = value(await f.service.commit(batch, response(batch))).skillIds[0]!;
    const stored = JSON.parse(await readFile(join(f.root, ".runloom/dreaming.json"), "utf8"));
    assert.equal(stored.version, 2); assert.equal(stored.archive.length, 2);
    assert.equal(stored.processed.length, 2);
    f.runs.clear();
    const reopened = f.reopen();
    assert.equal(value(await reopened.index("another-thread"))[0]?.id, `method:${id}`);
    assert.equal(value(await reopened.overview()).skills[0]!.needsReview, false);
    const disabled = value(await reopened.change({ id, expectedRevision: 1, action: "disable" }));
    assert.deepEqual(value(await reopened.index("another-thread")), []);
    value(await reopened.change({ id, expectedRevision: disabled.revision, action: "enable" }));
    assert.equal(value(await reopened.index("another-thread")).length, 1);
    f.tasks[0]!.revision++;
    f.tasks[0]!.acceptance[0]!.status = "not_run";
    assert.deepEqual(value(await reopened.index("another-thread")), [], "archive never revives withdrawn live acceptance");
    assert.equal(value(await reopened.overview()).skills[0]!.needsReview, true);
  });

  it("refuses corrupt archives and does not repair missing live tasks or failed receipt reads", async () => {
    const f = await fixture(), batch = value(await f.service.prepare()); assert.ok(batch);
    value(await f.service.commit(batch, response(batch))); f.runs.clear();
    const bytes = await readFile(join(f.root, ".runloom/dreaming.json"), "utf8");
    const doc = JSON.parse(bytes); doc.archive[0].run.status = "interrupted";
    await writeFile(join(f.root, ".runloom/dreaming.json"), JSON.stringify(doc));
    assert.equal((await f.reopen().index("new")).ok, false);
    await writeFile(join(f.root, ".runloom/dreaming.json"), bytes);
    f.tasks.shift();
    assert.deepEqual(value(await f.reopen().index("new")), []);
    const broken = createDreamingService({ filePath: join(f.root, ".runloom/dreaming.json"), workTasks: f.workTasks,
      executionRecords: { getRun: async () => { throw new Error("corrupt journal"); } } });
    // Restore the removed task so the live receipt read is actually reached.
    f.add("task-a");
    assert.equal((await broken.index("new")).ok, false);
    assert.equal(await readFile(join(f.root, ".runloom/dreaming.json"), "utf8"), bytes);
  });

  it("reads v1 without writing or inventing evidence and archives a live legacy source on explicit enable", async () => {
    const f = await fixture(), batch = value(await f.service.prepare()); assert.ok(batch);
    const id = value(await f.service.commit(batch, response(batch))).skillIds[0]!;
    const path = join(f.root, ".runloom/dreaming.json"), old = JSON.parse(await readFile(path, "utf8"));
    delete old.archive; old.version = 1;
    await writeFile(path, JSON.stringify(old)); const before = await readFile(path, "utf8");
    assert.equal(value(await f.reopen().index("new")).length, 1);
    assert.equal(await readFile(path, "utf8"), before, "read does not migrate");
    const run = f.runs.get("run-task-a")!; f.runs.delete(run.runId);
    assert.deepEqual(value(await f.reopen().index("new")), [], "legacy absent receipts cannot be invented");
    f.runs.set(run.runId, run);
    value(await f.reopen().change({ id, expectedRevision: 1, action: "enable" }));
    const current = JSON.parse(await readFile(path, "utf8"));
    assert.equal(current.version, 2); assert.equal(current.archive.length, 2);
    f.runs.clear(); assert.equal(value(await f.reopen().index("new")).length, 1);
  });

  it("bounds experience input, skill instructions and strict fields without exposing full tool inputs", async () => {
    const f = await fixture(); for (let i = 0; i < 12; i++) f.add(`extra-${i}`);
    const batch = value(await f.service.prepare()); assert.ok(batch); assert.ok(batch.experiences.length <= 8);
    assert.ok(Buffer.byteLength(JSON.stringify(batch.message.parts)) < 13 * 1024);
    assert.ok(batch.experiences.every(e => e.tools.every(t => !Object.hasOwn(t, "inputPreview"))));
    assert.equal((await f.service.commit(batch, response(batch, { instructions: "x".repeat(3073) }))).ok, false);
    assert.equal((await f.service.commit(batch, response(batch, { tools: ["shell_exec"] }))).ok, false);
    assert.equal(value(await f.service.overview()).processedExperiences, 0);
  });

  it("binds actual injected Memory revisions and suppresses a skill after memory changes or withdrawal", async () => {
    const f = await fixture();
    let memory: MemoryEntry = { id: "memory-a", revision: 1, text: "复盘偏好", enabled: true, status: "active" };
    for (const run of f.runs.values()) run.memoryReferences = [{ id: memory.id, revision: 1 }];
    const memoryStore = { get: async () => ({ ok: true, entry: structuredClone(memory) }) } as unknown as WorkspaceMemoryStore;
    const service = createDreamingService({ filePath: join(f.root, ".runloom/dreaming.json"), workTasks: f.workTasks, executionRecords: f.executionRecords, memoryStore });
    const batch = value(await service.prepare()); assert.ok(batch);
    const committed = value(await service.commit(batch, response(batch)));
    assert.deepEqual(value(await service.overview()).skills[0]!.memoryDependencies, [{ id: memory.id, revision: 1 }]);
    assert.equal(value(await service.index("new-thread")).length, 1);
    memory = { ...memory, revision: 2, enabled: false };
    assert.deepEqual(value(await service.index("new-thread")), []);
    assert.equal(value(await service.overview()).skills[0]!.needsReview, true);
    assert.equal((await service.change({ id: committed.skillIds[0]!, expectedRevision: 1, action: "enable" })).ok, false);
  });

  it("suppresses disabled Memory-dependent methods consistently in overview, selection and restoration", async () => {
    const f = await fixture();
    let memory: MemoryEntry = { id: "legacy-dependency", revision: 1, text: "复盘方法", enabled: true, status: "active" };
    for (const run of f.runs.values()) run.memoryReferences = [{ id: memory.id, revision: 1 }];
    const memoryStore = { get: async () => ({ ok: true, entry: structuredClone(memory) }) } as unknown as WorkspaceMemoryStore;
    const service = createDreamingService({ filePath: join(f.root, ".runloom/dreaming.json"), workTasks: f.workTasks, executionRecords: f.executionRecords, memoryStore });
    const batch = value(await service.prepare()); assert.ok(batch);
    const learned = value(await service.commit(batch, response(batch))), id = learned.skillIds[0]!;
    // A method cannot revive a disabled dependency.
    memory = { ...memory, enabled: false };
    assert.equal(value(await service.overview()).skills[0]!.needsReview, true);
    assert.deepEqual(value(await service.index("thread-task-a")), []);
    assert.deepEqual(value(await service.index("other-thread")), []);
    value(await service.change({ id, expectedRevision: 1, action: "disable" }));
    const enabled = await service.change({ id, expectedRevision: 2, action: "enable" });
    assert.ok(!enabled.ok); assert.equal(enabled.error.code, "DREAMING_SOURCE_INVALID");
    const restored = await service.change({ id, expectedRevision: 2, action: "restore", restoreRevision: 1 });
    assert.ok(!restored.ok); assert.equal(restored.error.code, "DREAMING_SOURCE_INVALID");
  });

  it("rejects mixed Memory revisions and excludes truncated reference coverage", async () => {
    const f = await fixture();
    f.runs.get("run-task-a")!.memoryReferences = [{ id: "memory-a", revision: 1 }];
    f.runs.get("run-task-b")!.memoryReferences = [{ id: "memory-a", revision: 2 }];
    let memoryReads = 0;
    // The current Memory version may change between the bounded per-task reads.
    // Individually eligible experiences must still fail if one learned method
    // would combine different versions of the same logical Memory.
    const memoryStore = { get: async () => ({ ok: true, entry: { id: "memory-a", revision: ++memoryReads % 2 ? 1 : 2,
      text: "复盘偏好", enabled: true, status: "active" } }) } as unknown as WorkspaceMemoryStore;
    const service = createDreamingService({ filePath: join(f.root, ".runloom/dreaming.json"), workTasks: f.workTasks, executionRecords: f.executionRecords, memoryStore });
    const batch = value(await service.prepare()); assert.ok(batch);
    const mixed = await service.commit(batch, response(batch)); assert.ok(!mixed.ok); assert.equal(mixed.error.code, "DREAMING_SOURCE_INVALID");
    assert.equal(value(await service.overview()).processedExperiences, 0);
    f.runs.get("run-task-b")!.memoryReferencesTruncated = true;
    assert.equal(value(await service.overview()).pendingExperiences, 1);
    assert.equal(value(await service.prepare()), null);
  });

  it("serializes independent reflection commits and strict-loads old versions instead of dropping corruption", async () => {
    const f = await fixture(), other = f.reopen();
    const a = value(await f.service.prepare()), b = value(await other.prepare()); assert.ok(a && b);
    const both = await Promise.all([f.service.commit(a, response(a)), other.commit(b, response(b))]);
    assert.ok(both.every(r => r.ok)); assert.equal(both.filter(r => r.ok && r.value.replayed).length, 1);
    const overview = value(await f.service.overview()); assert.equal(overview.skills.length, 1); assert.equal(overview.processedExperiences, 2);
    value(await f.service.change({ id: overview.skills[0]!.id, expectedRevision: 1, action: "disable" }));
    const file = join(f.root, ".runloom/dreaming.json"), raw = JSON.parse(await readFile(file, "utf8"));
    raw.skills[0].versions[0].instructions = "x".repeat(3073); await writeFile(file, JSON.stringify(raw));
    const corrupt = await f.reopen().overview(); assert.ok(!corrupt.ok); assert.equal(corrupt.error.code, "DREAMING_INVALID");
  });
});
