import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CheckpointSnapshot } from "./checkpoint-store.js";
import {
  RESUME_CONTEXT_MAX_BYTES,
  RESUME_CONTEXT_MESSAGE_ID,
  captureResumeObservation,
  createResumeContextMessage,
  formatResumeObservation,
  resumeMatchesCheckpoint,
} from "./resume-observation.js";

const checkpoint: CheckpointSnapshot = {
  id: "cp-1", version: 2, status: "active", goal: "Continue Runloom",
  summary: "Saved work", completed: [], inProgress: [], nextActions: [],
  blockers: [], artifacts: [], source: { threadId: "thread-a" },
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
};

describe("resume observation", () => {
  it("binds the printed and injected Git status to the inspected checkpoint version", () => {
    const observation = captureResumeObservation(checkpoint, {
      status: "stale",
      pin: { head: "a".repeat(40), branch: "main", dirty: false, observedAt: "2026-09-01T00:00:00.000Z" },
      current: { head: "b".repeat(40), branch: "main", dirty: false, observedAt: "2026-09-02T00:00:00.000Z" },
    });
    assert.equal(resumeMatchesCheckpoint(observation, checkpoint), true);
    assert.equal(resumeMatchesCheckpoint(observation, { ...checkpoint, version: 3 }), false);
    const printed = formatResumeObservation(observation);
    assert.match(printed, /Git reconciliation: stale/);
    assert.match(printed, /Checkpoint: cp-1 v2/);
    assert.match(printed, /a{40}/);
    assert.match(printed, /b{40}/);
    const message = createResumeContextMessage(observation)!;
    assert.equal(message.id, RESUME_CONTEXT_MESSAGE_ID);
    assert.match(JSON.stringify(message), /grants no tool permission/);
    assert.ok(Buffer.byteLength(JSON.stringify([message])) <= RESUME_CONTEXT_MAX_BYTES);
  });

  it("does not confuse no checkpoint with a later checkpoint", () => {
    const observation = captureResumeObservation(null, { status: "insufficient_evidence", reason: "missing_pin" });
    assert.equal(resumeMatchesCheckpoint(observation, null), true);
    assert.equal(resumeMatchesCheckpoint(observation, checkpoint), false);
  });
});
