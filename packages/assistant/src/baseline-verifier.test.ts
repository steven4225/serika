import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecutionRecordStore, ExecutionRunRecord, ExecutionToolRecord } from "./execution-record-store.js";
import type { AcceptanceCriterion, WorkTask } from "./work-task-store.js";
import { verifyAutomaticCriterion } from "./work-task-verification.js";

/**
 * v2 pilot step 1 lock tests (docs/v2-pilot/receipt-invariants.md). These pin
 * the CURRENT verifier decisions for the five receipt invariants, one row per
 * case, so a refactor that moves receipts or modules cannot change a verdict.
 * They describe existing behavior; they are not a specification change.
 */

const T0 = "2026-01-01T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const CONTENT = "# 计划\n";

function tool(overrides: Partial<ExecutionToolRecord> & Pick<ExecutionToolRecord, "toolCallId" | "toolName">): ExecutionToolRecord {
  return { status: "completed", requestedAt: T0, startedAt: T0, finishedAt: T0, inputPreview: "{}", inputTruncated: false,
    resultPreview: "{}", resultTruncated: false, errorPreview: null, shell: null, ...overrides };
}
const write = (id: string, path: string, content: string, extra: Partial<ExecutionToolRecord> = {}) => tool({
  toolCallId: id, toolName: "write_file", inputPreview: JSON.stringify({ path, content }),
  fileInput: { path, sha256: sha(content) }, fileWrite: { path, bytes: Buffer.byteLength(content), sha256: sha(content) },
  resultPreview: JSON.stringify({ ok: true, path, bytes: Buffer.byteLength(content), sha256: sha(content) }), ...extra });
function failedWrite(id: string, path: string, content: string): ExecutionToolRecord {
  const { fileWrite: _receipt, ...rest } = write(id, path, content, { status: "failed", resultPreview: null, errorPreview: "FILE_EXISTS" });
  return rest;
}
const read = (id: string, path: string, content: string, extra: Partial<ExecutionToolRecord> = {}) => tool({
  toolCallId: id, toolName: "read_file", inputPreview: JSON.stringify({ path }), fileInput: { path },
  fileRead: { path, bytes: Buffer.byteLength(content), sha256: sha(content) }, ...extra });
const shell = (id: string, command: string, exitCode: number | null, extra: Partial<ExecutionToolRecord> = {}) => tool({
  toolCallId: id, toolName: "shell_exec", inputPreview: JSON.stringify({ command, cwd: "." }),
  shell: { exitCode, timedOut: false, cancelled: false }, ...extra });

const artifact = (requireReadback = false): AcceptanceCriterion => ({ id: "c1", description: "plan", method: "automatic",
  verification: { kind: "artifact_exists", path: "plan.md", ...(requireReadback ? { requireReadback: true } : {}) } as AcceptanceCriterion["verification"],
  required: true, status: "pending", evidenceRefs: [], note: null } as unknown as AcceptanceCriterion);
const tests: AcceptanceCriterion = { id: "c2", description: "tests", method: "automatic",
  verification: { kind: "shell_exit_zero", command: "pnpm test", cwd: "." } as AcceptanceCriterion["verification"],
  required: true, status: "pending", evidenceRefs: [], note: null } as unknown as AcceptanceCriterion;

async function verdict(tools: ExecutionToolRecord[], criterion: AcceptanceCriterion, disk: string | null = CONTENT, runStatus: ExecutionRunRecord["status"] = "completed"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "serika-baseline-verifier-"));
  try {
    if (disk !== null) await writeFile(join(root, "plan.md"), disk);
    const run = { runId: "run-1", threadId: "thread", workTaskId: "task", phase: "primary", status: runStatus, startedAt: T0,
      finishedAt: T0, resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools } as ExecutionRunRecord;
    const records = { getRun: async (threadId: string, runId: string) => threadId === "thread" && runId === "run-1" ? run : null } as unknown as ExecutionRecordStore;
    const task = { id: "task", revision: 1, threadId: "thread", goal: "g", constraints: [], acceptance: [criterion], status: "running",
      runIds: ["run-1"], delivery: null, reconciliations: [], createdAt: T0, updatedAt: T0 } as unknown as WorkTask;
    return (await verifyAutomaticCriterion({ workspaceRoot: root, executionRecords: records }, task, criterion)).status;
  } finally { await rm(root, { recursive: true, force: true }); }
}

describe("v2 pilot baseline: receipt and verifier invariants (current behavior)", () => {
  it("I1 path consistency: only a receipt for the exact requested path counts", async () => {
    assert.equal(await verdict([write("w", "plan.md", CONTENT)], artifact()), "passed");
    assert.equal(await verdict([write("w", "other.md", CONTENT)], artifact()), "failed");
    assert.equal(await verdict([write("w", "plan.md", CONTENT, { fileWrite: { path: "other.md", bytes: 9, sha256: sha(CONTENT) } })], artifact()), "failed");
  });

  it("I2 content hash: current bytes must match the receipt's SHA-256 and length", async () => {
    assert.equal(await verdict([write("w", "plan.md", CONTENT)], artifact(), "# changed\n"), "failed");
    assert.equal(await verdict([write("w", "plan.md", CONTENT)], artifact(), null), "failed");
    assert.equal(await verdict([write("w", "plan.md", CONTENT, { fileInput: { path: "plan.md", sha256: sha("x") } })], artifact()), "failed");
  });

  it("I3 readback: a matching read_file must come after the latest write", async () => {
    assert.equal(await verdict([write("w", "plan.md", CONTENT), read("r", "plan.md", CONTENT)], artifact(true)), "passed");
    assert.equal(await verdict([read("r", "plan.md", CONTENT), write("w", "plan.md", CONTENT)], artifact(true)), "failed");
    assert.equal(await verdict([write("w", "plan.md", CONTENT)], artifact(true)), "failed");
    assert.equal(await verdict([write("w", "plan.md", CONTENT), read("r", "plan.md", "stale")], artifact(true)), "failed");
    assert.equal(await verdict([write("w", "plan.md", CONTENT), read("r", "plan.md", CONTENT, { status: "failed" })], artifact(true)), "failed");
  });

  it("I4 a later failure invalidates an earlier success", async () => {
    assert.equal(await verdict([write("w1", "plan.md", CONTENT), failedWrite("w2", "plan.md", CONTENT)], artifact()), "failed");
    assert.equal(await verdict([shell("s1", "pnpm test", 0), shell("s2", "rm -rf x", 1)], tests), "failed");
    assert.equal(await verdict([shell("s1", "pnpm test", 0), write("w", "plan.md", CONTENT)], tests), "failed");
    // A denied (never started) later call has no effect and does not invalidate.
    assert.equal(await verdict([shell("s1", "pnpm test", 0), shell("s2", "rm -rf x", null, { status: "not_started", startedAt: null })], tests), "passed");
  });

  it("I5 shell evidence: exit code 0, untruncated, no timeout or cancellation, exact command and cwd", async () => {
    assert.equal(await verdict([shell("s", "pnpm test", 0)], tests), "passed");
    assert.equal(await verdict([shell("s", "pnpm test", 1)], tests), "failed");
    assert.equal(await verdict([shell("s", "pnpm test", 0, { shell: { exitCode: 0, timedOut: true, cancelled: false } })], tests), "failed");
    assert.equal(await verdict([shell("s", "pnpm test", 0, { shell: { exitCode: 0, timedOut: false, cancelled: true } })], tests), "failed");
    assert.equal(await verdict([shell("s", "pnpm test", 0, { resultTruncated: true })], tests), "failed");
    assert.equal(await verdict([shell("s", "pnpm test && echo ok", 0)], tests), "failed");
  });

  it("unknown outcomes and interrupted Runs block instead of failing or passing", async () => {
    assert.equal(await verdict([shell("s", "pnpm test", 0), tool({ toolCallId: "u", toolName: "write_file", status: "unknown" })], tests), "blocked");
    assert.equal(await verdict([shell("s", "pnpm test", 0)], tests, CONTENT, "interrupted"), "blocked");
  });
});
