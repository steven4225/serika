import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AcceptanceCaseResult } from "./acceptance/contracts.js";
import { deriveCaseStatus } from "./acceptance/contracts.js";
import {
  createPendingWorkTaskEvalChecks,
  getWorkTaskEvalCase,
  listWorkTaskEvalCases,
} from "./work-task-eval-cases.js";

describe("work task eval cases", () => {
  it("freezes six unique cases across the three promised task categories", () => {
    const cases = listWorkTaskEvalCases();

    assert.deepEqual(cases.map((item) => item.id), [
      "WT01", "WT02", "WT03", "WT04", "WT05", "WT06",
    ]);
    assert.equal(new Set(cases.map((item) => item.fixtureId)).size, cases.length);
    assert.deepEqual(
      cases.map((item) => item.category),
      [
        "repository_change",
        "repository_change",
        "artifact_delivery",
        "artifact_delivery",
        "grounded_research",
        "grounded_research",
      ],
    );
  });

  it("links every hard failure to one required check with evidence requirements", () => {
    for (const definition of listWorkTaskEvalCases()) {
      assert.ok(definition.constraints.length > 0, definition.id);
      assert.ok(definition.checks.length > 0, definition.id);
      assert.ok(definition.hardFailures.length > 0, definition.id);
      assert.equal(new Set(definition.checks.map((check) => check.id)).size, definition.checks.length);
      assert.equal(new Set(definition.hardFailures.map((failure) => failure.id)).size, definition.hardFailures.length);
      for (const check of definition.checks) {
        assert.equal(check.required, true, `${definition.id}/${check.id}`);
        assert.ok(check.evidenceKinds.length > 0, `${definition.id}/${check.id}`);
      }
      for (const failure of definition.hardFailures) {
        assert.ok(
          definition.checks.some((check) => check.id === failure.checkId && check.required),
          `${definition.id}/${failure.id}`,
        );
      }
    }
  });

  it("produces checks that fit AcceptanceCaseResult without claiming unobserved work", () => {
    const definition = getWorkTaskEvalCase("WT01");
    assert.ok(definition);
    const checks = createPendingWorkTaskEvalChecks(definition);
    const result: AcceptanceCaseResult = {
      schemaVersion: 1,
      caseId: definition.id,
      attemptId: "attempt-1",
      baseline: {
        commit: "0123456789abcdef",
        dirty: false,
        modelId: "test-model",
        configDigest: "none",
      },
      execution: definition.execution,
      startedAt: "2026-09-30T00:00:00.000Z",
      finishedAt: null,
      runIds: [],
      threadIds: [],
      status: deriveCaseStatus(checks),
      checks,
      evidence: [],
      durationMs: null,
      usage: null,
    };

    assert.equal(result.caseId, "WT01");
    assert.equal(result.status, "not_run");
    assert.ok(result.checks.every((check) => check.status === "not_run"));
    assert.ok(result.checks.every((check) => check.evidenceIds.length === 0));
  });
});
