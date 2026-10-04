import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExecutionRecordStore, ExecutionRunRecord, ExecutionToolRecord } from "./execution-record-store.js";
import { createWorkTaskStore, type AcceptanceCriterion, type WorkTask } from "./work-task-store.js";
import { invalidatesTaskTest, workTaskTestBatch } from "./work-task-shell-evidence.js";
import { verifyAutomaticCriterion } from "./work-task-verification.js";
import { executeShellCommand } from "./modules/shell-module.js";
import { createWorkTaskContextMessage } from "./work-task-context.js";

const time = "2026-10-04T00:00:00.000Z";
function criterion(id: string, command: string, cwd = "."): AcceptanceCriterion {
  return { id, description: id, required: true, method: "automatic", status: "not_run", evidenceRefs: [], note: null,
    verification: { kind: "shell_exit_zero", command, cwd } };
}
function shell(id: string, command: string): ExecutionToolRecord {
  return { toolCallId: id, toolName: "shell_exec", status: "completed", requestedAt: time, startedAt: time, finishedAt: time,
    inputPreview: JSON.stringify({ command, cwd: "." }), inputTruncated: false, resultPreview: "{}", resultTruncated: false,
    errorPreview: null, shell: { exitCode: 0, timedOut: false, cancelled: false } };
}
const task: WorkTask = { id: "task", revision: 1, threadId: "thread", goal: "verify", constraints: [], acceptance: [criterion("test", "node check.mjs")],
  status: "paused", runIds: ["run"], delivery: null, reconciliations: [], createdAt: time, updatedAt: time };
const run: ExecutionRunRecord = { runId: "run", threadId: "thread", workTaskId: "task", phase: "primary", status: "completed",
  startedAt: time, finishedAt: time, resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [] };

it("invalidates old test receipts after dispatched Shell, file or computer effects, even failed Shell", async () => {
  const record = { ...run, tools: [shell("test", "node check.mjs")] };
  const env = { executionRecords: { getRun: async () => record } as unknown as ExecutionRecordStore, workspaceRoot: undefined };
  for (const tool of [shell("edit", "node mutate.mjs"), { ...shell("failed", "node mutate.mjs"), status: "failed" as const },
    { ...shell("ui", ""), toolName: "computer_action" }, { ...shell("file", ""), toolName: "edit_file" }]) {
    record.tools = [shell("test", "node check.mjs"), tool];
    assert.equal((await verifyAutomaticCriterion(env, task, task.acceptance[0]!)).status, "failed");
  }
  for (const tool of [{ ...shell("denied", "node mutate.mjs"), status: "not_started" as const, startedAt: null },
    { ...shell("invalid", ""), status: "failed" as const, startedAt: null }, { ...shell("read", ""), toolName: "read_file" }]) {
    assert.equal(invalidatesTaskTest(tool), false);
    record.tools = [shell("test", "node check.mjs"), tool];
    assert.equal((await verifyAutomaticCriterion(env, task, task.acceptance[0]!)).status, "passed");
  }
});

it("checks real Shell mutations and rechecks direct store acceptance instead of trusting supplied evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-shell-freshness-"));
  try {
    await writeFile(join(root, "value.txt"), "good");
    await writeFile(join(root, "check.mjs"), "import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; assert.equal(readFileSync('value.txt','utf8'),'good');\n");
    assert.equal((await executeShellCommand(root, { command: "node check.mjs" })).ok, true);
    const record = { ...run, tools: [shell("test", "node check.mjs")] };
    const records = { getRun: async () => record } as unknown as ExecutionRecordStore;
    const env = { executionRecords: records, workspaceRoot: root };
    const evidence = await verifyAutomaticCriterion(env, task, task.acceptance[0]!);
    assert.equal(evidence.status, "passed");
    const mutate = "printf bad > value.txt";
    assert.equal((await executeShellCommand(root, { command: mutate })).ok, true);
    assert.equal(await readFile(join(root, "value.txt"), "utf8"), "bad");
    record.tools.push(shell("mutate", mutate));
    assert.equal((await verifyAutomaticCriterion(env, task, task.acceptance[0]!)).status, "failed");
    const store = createWorkTaskStore(root, { executionRecords: records, generateId: () => "task" });
    assert.ok((await store.create({ threadId: "thread", goal: "test", acceptance: task.acceptance.map(({ id, description, required, method, verification }) => ({ id, description, required, method, verification })) })).ok);
    assert.ok((await store.beginRun("task", { expectedRevision: 1, runId: "run" })).ok);
    assert.ok((await store.pause("task", 2)).ok);
    assert.ok((await store.submitDelivery("task", { expectedRevision: 3, delivery: { summary: "test", artifactRefs: [], evidence: [], unresolved: [] } })).ok);
    assert.equal((await store.recordAcceptance("task", { expectedRevision: 4, criterionId: "test", actor: "automatic", status: "passed", evidence: evidence.evidence })).ok, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("runs a fail-fast multi-test batch with literal quoting, persists matching evidence and restores both criteria", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-test-batch-"));
  try {
    const acceptance = [criterion("a", "printf '%s' \"it's literal\""), criterion("b", "node -e 'process.exit(0)'")];
    const both = { ...task, acceptance };
    const batch = workTaskTestBatch(both)!; assert.ok(batch);
    const executed = await executeShellCommand(root, batch);
    assert.ok(executed.ok); assert.equal(executed.exitCode, 0);
    const record = { ...run, tools: [shell("batch", batch.command)] };
    const records = { getRun: async () => record } as unknown as ExecutionRecordStore;
    const store = createWorkTaskStore(root, { executionRecords: records, generateId: () => "task" });
    assert.ok((await store.create({ threadId: "thread", goal: "two checks", acceptance: acceptance.map(({ id, description, required, method, verification }) => ({ id, description, required, method, verification })) })).ok);
    assert.ok((await store.beginRun("task", { expectedRevision: 1, runId: "run" })).ok);
    assert.ok((await store.pause("task", 2)).ok);
    assert.ok((await store.submitDelivery("task", { expectedRevision: 3, delivery: { summary: "both", artifactRefs: [], evidence: [], unresolved: [] } })).ok);
    for (const [index, item] of acceptance.entries()) {
      const result = await verifyAutomaticCriterion({ executionRecords: records, workspaceRoot: root }, both, item);
      assert.equal(result.status, "passed");
      assert.equal((result.evidence[0] as { command: string }).command, batch.command);
      assert.ok((await store.recordAcceptance("task", { expectedRevision: 4 + index, criterionId: item.id, actor: "automatic", status: "passed", evidence: result.evidence })).ok);
    }
    const reopened = await createWorkTaskStore(root).get("task"); assert.ok(reopened.ok);
    assert.equal(reopened.value.status, "completed");
    assert.deepEqual(reopened.value.acceptance.map(item => item.status), ["passed", "passed"]);
    assert.match(JSON.stringify(createWorkTaskContextMessage(both)), /testBatch/);
    const failed = workTaskTestBatch({ acceptance: [criterion("a", "exit 7"), criterion("b", "printf unexpected > should-not-exist")] })!;
    const failure = await executeShellCommand(root, failed); assert.ok(failure.ok); assert.equal(failure.exitCode, 7);
    await assert.rejects(readFile(join(root, "should-not-exist")), { code: "ENOENT" });
    for (const patch of [{ inputTruncated: true }, { resultTruncated: true }, { shell: { exitCode: 1, timedOut: false, cancelled: false } }]) {
      record.tools = [{ ...shell("batch", batch.command), ...patch }];
      assert.equal((await verifyAutomaticCriterion({ executionRecords: records, workspaceRoot: root }, both, acceptance[0]!)).status, "failed");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not invent a combined command across cwd boundaries or exceed the evidence size limit", () => {
  assert.equal(workTaskTestBatch({ acceptance: [criterion("a", "test", "a"), criterion("b", "test", "b")] }), null);
  assert.equal(workTaskTestBatch({ acceptance: [criterion("a", "a".repeat(900)), criterion("b", "b".repeat(900))] }), null);
  assert.equal(workTaskTestBatch({ acceptance: [criterion("a", "test"), criterion("duplicate", "test")] }), null);
});
