import assert from "node:assert/strict";
import { symlink, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deriveCaseStatus, type AcceptanceCaseResult } from "./contracts.js";
import { writeAcceptanceReport } from "./report.js";

function result(overrides: Partial<AcceptanceCaseResult> = {}): AcceptanceCaseResult {
  return {
    schemaVersion: 1,
    caseId: "A01",
    attemptId: "attempt-1",
    baseline: {
      commit: "abc1234",
      dirty: false,
      modelId: "test-model",
      configDigest: "sha256:test",
    },
    execution: { entry: "runtime_test", model: "mock", network: "unused" },
    startedAt: "2026-09-26T00:00:00.000Z",
    finishedAt: "2026-09-26T00:00:01.000Z",
    runIds: ["run-1"],
    threadIds: ["thread-1"],
    status: "passed",
    checks: [{
      id: "artifact-exists",
      method: "automatic",
      required: true,
      status: "passed",
      evidenceIds: ["artifact"],
      note: "The expected file exists.",
    }],
    evidence: [{ id: "artifact", kind: "artifact", path: "evidence/output.md" }],
    durationMs: 1_000,
    usage: null,
    ...overrides,
  };
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "runloom-acceptance-report-"));
}

describe("acceptance report", () => {
  it("keeps the first failed required check even if later work is blocked", () => {
    const checks = [
      { ...result().checks[0]!, status: "failed" as const },
      { ...result().checks[0]!, id: "later", status: "blocked" as const },
    ];
    assert.equal(deriveCaseStatus(checks), "failed");
    assert.equal(deriveCaseStatus([]), "not_run");
  });

  it("writes JSON and Markdown once and keeps separate attempts", async () => {
    const root = await directory();
    try {
      for (const attemptId of ["attempt-1", "attempt-2"]) {
        const evidenceDirectory = join(root, "A01", attemptId, "evidence");
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(join(evidenceDirectory, "output.md"), `result for ${attemptId}\n`);
        const paths = await writeAcceptanceReport(result({ attemptId }), root);
        const saved = JSON.parse(await readFile(paths.resultPath, "utf8")) as AcceptanceCaseResult;
        assert.equal(saved.attemptId, attemptId);
        assert.match(await readFile(paths.reportPath, "utf8"), /Status: \*\*passed\*\*/);
      }
      await assert.rejects(writeAcceptanceReport(result(), root), { code: "EEXIST" });
      assert.equal(
        (JSON.parse(await readFile(join(root, "A01", "attempt-1", "result.json"), "utf8")) as AcceptanceCaseResult).attemptId,
        "attempt-1",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not record passed when a required check failed or lacks evidence", async () => {
    const root = await directory();
    try {
      const failed = result({
        checks: [{ ...result().checks[0]!, status: "failed" }],
      });
      await assert.rejects(writeAcceptanceReport(failed, root), /disagrees with required checks/);
      const unsupported = result({
        checks: [{ ...result().checks[0]!, evidenceIds: [] }],
      });
      await assert.rejects(writeAcceptanceReport(unsupported, root), /has no evidence/);
      const unknown = result({
        checks: [{ ...result().checks[0]!, evidenceIds: ["missing"] }],
      });
      await assert.rejects(writeAcceptanceReport(unknown, root), /Unknown evidence id/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires a classified failure before saving a failed attempt", async () => {
    const root = await directory();
    try {
      const failed = result({
        status: "failed",
        checks: [{ ...result().checks[0]!, status: "failed" }],
      });
      await assert.rejects(writeAcceptanceReport(failed, root), /requires a failure layer/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and symlinked evidence", async () => {
    const root = await directory();
    try {
      await assert.rejects(
        writeAcceptanceReport(result({ evidence: [{ id: "artifact", kind: "artifact", path: "../outside" }] }), root),
        /must not traverse/,
      );
      const attemptDirectory = join(root, "A01", "attempt-1");
      await mkdir(attemptDirectory, { recursive: true });
      const outside = join(root, "outside.md");
      await writeFile(outside, "secret\n");
      await symlink(outside, join(attemptDirectory, "output.md"));
      await assert.rejects(
        writeAcceptanceReport(result({ evidence: [{ id: "artifact", kind: "artifact", path: "output.md" }] }), root),
        /contains a symlink/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
