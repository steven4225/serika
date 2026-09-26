import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { AcceptanceCaseResult } from "./contracts.js";
import { recordAcceptanceAttempt, startAcceptanceAttempt } from "./record.js";

it("records one reviewed attempt with automatic evidence and keeps later attempts separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-acceptance-record-"));
  try {
    const attempt = await startAcceptanceAttempt({
      outputDirectory: root,
      caseId: "A01",
      attemptId: "first",
      modelId: "test-model",
      entry: "runtime_test",
      model: "mock",
      network: "unused",
    });
    const evidenceDirectory = join(attempt, "evidence");
    await mkdir(evidenceDirectory);
    const content = "requested edit\n";
    await writeFile(join(evidenceDirectory, "output.md"), content);
    await writeFile(join(attempt, "verification.json"), JSON.stringify({
      schemaVersion: 1,
      caseId: "A01",
      assertions: [{
        checkId: "artifact_hash",
        kind: "file_sha256",
        path: "evidence/output.md",
        sha256: createHash("sha256").update(content).digest("hex"),
      }],
    }));
    const review = JSON.parse(await readFile(join(attempt, "review.json"), "utf8")) as Record<string, unknown>;
    review.humanChecks = [{
      id: "file_content_and_scope",
      status: "passed",
      evidenceIds: ["reviewed-artifact"],
      note: "Reviewed the requested edit and isolated workspace diff.",
    }];
    review.evidence = [{ id: "reviewed-artifact", kind: "artifact", path: "evidence/output.md" }];
    await writeFile(join(attempt, "review.json"), JSON.stringify(review));

    const result = await recordAcceptanceAttempt(attempt);
    assert.equal(result.status, "passed");
    assert.equal(result.checks.length, 2);
    assert.equal(result.evidence.length, 3);
    const saved = JSON.parse(await readFile(join(attempt, "result.json"), "utf8")) as AcceptanceCaseResult;
    assert.equal(saved.baseline.commit, result.baseline.commit);
    assert.equal(saved.baseline.configDigest, "none");
    assert.equal(saved.usage, null);
    await assert.rejects(recordAcceptanceAttempt(attempt), { code: "EEXIST" });

    const second = await startAcceptanceAttempt({
      outputDirectory: root,
      caseId: "A01",
      attemptId: "second",
      modelId: "test-model",
      entry: "runtime_test",
      model: "mock",
      network: "unused",
    });
    const unreviewed = await recordAcceptanceAttempt(second);
    assert.equal(unreviewed.status, "not_run");
    assert.equal((await readFile(join(attempt, "result.json"), "utf8")).includes('"status": "passed"'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("redacts configured secrets before computing an acceptance config digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-acceptance-config-"));
  try {
    const paths = [join(root, "a.json"), join(root, "b.json")];
    await writeFile(paths[0]!, JSON.stringify({ version: 1, modules: {}, API_KEY: "first-secret" }));
    await writeFile(paths[1]!, JSON.stringify({ version: 1, modules: {}, API_KEY: "second-secret" }));
    const attempts = [];
    for (const [index, path] of paths.entries()) {
      attempts.push(await startAcceptanceAttempt({
        outputDirectory: root,
        caseId: "A09",
        attemptId: `config-${index}`,
        modelId: null,
        entry: "tui",
        model: "mock",
        network: "unused",
        configPath: path,
      }));
    }
    const first = JSON.parse(await readFile(join(attempts[0]!, "review.json"), "utf8")) as {
      baseline: { configDigest: string };
    };
    const second = JSON.parse(await readFile(join(attempts[1]!, "review.json"), "utf8")) as {
      baseline: { configDigest: string };
    };
    assert.equal(first.baseline.configDigest, second.baseline.configDigest);
    assert.match(first.baseline.configDigest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
