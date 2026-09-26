import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { listAcceptanceCases } from "./acceptance/cases.js";
import { evidenceIdForPath, verifyCase } from "./acceptance/verify.js";

async function withAttempt(fn: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-acceptance-verifier-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function manifest(directory: string, value: unknown): Promise<void> {
  await writeFile(join(directory, "verification.json"), JSON.stringify(value), "utf8");
}

it("registers nine distinct cases with a required human outcome", () => {
  const cases = listAcceptanceCases();
  assert.deepEqual(cases.map((item) => item.id), ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09"]);
  assert.ok(cases.every((item) => item.checks.some((check) => check.required && check.method === "human")));
});

it("verifies a captured artifact without passing its human quality check", async () => {
  await withAttempt(async (directory) => {
    await mkdir(join(directory, "evidence"));
    const content = "verified output\n";
    await writeFile(join(directory, "evidence", "output.md"), content);
    const digest = createHash("sha256").update(content).digest("hex");
    await manifest(directory, {
      schemaVersion: 1,
      caseId: "A01",
      assertions: [{ checkId: "artifact_hash", kind: "file_sha256", path: "evidence/output.md", sha256: digest }],
    });

    const checks = await verifyCase("A01", directory);
    assert.equal(checks[0]?.status, "passed");
    assert.deepEqual(checks[0]?.evidenceIds, [
      evidenceIdForPath("verification.json"),
      evidenceIdForPath("evidence/output.md"),
    ]);
    assert.equal(checks[1]?.status, "not_run");

    await writeFile(join(directory, "evidence", "output.md"), "changed");
    assert.equal((await verifyCase("A01", directory))[0]?.status, "failed");
  });
});

it("keeps an unprovided assertion unrun and checks a denied target snapshot", async () => {
  await withAttempt(async (directory) => {
    assert.equal((await verifyCase("A02", directory))[0]?.status, "not_run");
    await manifest(directory, {
      schemaVersion: 1,
      caseId: "A02",
      assertions: [{ checkId: "denied_target_state", kind: "file_absent", path: "evidence/new.md" }],
    });
    assert.equal((await verifyCase("A02", directory))[0]?.status, "passed");
    await mkdir(join(directory, "evidence"));
    await writeFile(join(directory, "evidence", "new.md"), "unexpected");
    assert.equal((await verifyCase("A02", directory))[0]?.status, "failed");
  });
});

it("compares captured pre/post task fields without accepting missing fields", async () => {
  await withAttempt(async (directory) => {
    await writeFile(join(directory, "before.json"), JSON.stringify({ task: { id: "same", runAt: "old" } }));
    await writeFile(join(directory, "after.json"), JSON.stringify({ task: { id: "same", runAt: "new" } }));
    await manifest(directory, {
      schemaVersion: 1,
      caseId: "A06",
      assertions: [
        { checkId: "task_id_stable", kind: "json_compare", left: { path: "before.json", pointer: "/task/id" }, right: { path: "after.json", pointer: "/task/id" }, operator: "equal" },
        { checkId: "run_at_changed", kind: "json_compare", left: { path: "before.json", pointer: "/task/runAt" }, right: { path: "after.json", pointer: "/task/runAt" }, operator: "not_equal" },
      ],
    });
    assert.deepEqual((await verifyCase("A06", directory)).map((check) => check.status), ["passed", "passed", "not_run"]);
    await writeFile(join(directory, "after.json"), JSON.stringify({ task: { id: "same" } }));
    assert.equal((await verifyCase("A06", directory))[1]?.status, "failed");
  });
});

it("does not let operator expectations invert fixed refusal or reschedule criteria", async () => {
  await withAttempt(async (directory) => {
    await writeFile(join(directory, "counter.json"), JSON.stringify({ requests: 1 }));
    await manifest(directory, {
      schemaVersion: 1,
      caseId: "A07",
      assertions: [{ checkId: "denied_request_count", kind: "json_equals", path: "counter.json", pointer: "/requests", expected: 1 }],
    });
    assert.equal((await verifyCase("A07", directory))[0]?.status, "blocked");

    await writeFile(join(directory, "before.json"), JSON.stringify({ task: { id: "old" } }));
    await writeFile(join(directory, "after.json"), JSON.stringify({ task: { id: "new" } }));
    await manifest(directory, {
      schemaVersion: 1,
      caseId: "A06",
      assertions: [{ checkId: "task_id_stable", kind: "json_compare", left: { path: "before.json", pointer: "/task/id" }, right: { path: "after.json", pointer: "/task/id" }, operator: "not_equal" }],
    });
    assert.equal((await verifyCase("A06", directory))[0]?.status, "blocked");
  });
});

it("blocks unsafe or malformed evidence rather than reading outside the attempt", async () => {
  await withAttempt(async (directory) => {
    await manifest(directory, {
      schemaVersion: 1,
      caseId: "A03",
      assertions: [{ checkId: "completed_side_effect", kind: "file_present", path: "../outside.txt" }],
    });
    assert.equal((await verifyCase("A03", directory))[0]?.status, "blocked");

    await mkdir(join(directory, "evidence"));
    await symlink(tmpdir(), join(directory, "evidence", "link"));
    await manifest(directory, {
      schemaVersion: 1,
      caseId: "A03",
      assertions: [{ checkId: "completed_side_effect", kind: "file_present", path: "evidence/link/secret" }],
    });
    assert.equal((await verifyCase("A03", directory))[0]?.status, "blocked");

    await manifest(directory, { schemaVersion: 1, caseId: "A01", assertions: [] });
    assert.equal((await verifyCase("A03", directory))[0]?.status, "blocked");
  });
});
