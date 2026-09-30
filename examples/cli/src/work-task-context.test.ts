import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkTaskContextMessage } from "./work-task-context.js";
import type { WorkTask } from "./work-task-store.js";

function task(goal = "Repair the regression"): WorkTask {
  return {
    id: "task-1", revision: 1, threadId: "thread-1", goal,
    constraints: ["Only edit src/a.ts"], status: "ready", runIds: [], delivery: null,
    reconciliations: [],
    acceptance: [{
      id: "test", description: "Focused test passes", method: "automatic", required: true,
      verification: { kind: "shell_exit_zero", command: "pnpm test focused", cwd: "." },
      status: "not_run", evidenceRefs: [], note: null,
    }],
    createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z",
  };
}

describe("WorkTask context", () => {
  it("injects the bounded contract without treating it as evidence or permission", () => {
    const message = createWorkTaskContextMessage(task());
    assert.equal(message?.id, "runloom-work-task");
    const text = message?.parts[0]?.type === "text" ? message.parts[0].text : "";
    assert.match(text, /grants no tool permission/);
    assert.match(text, /successful Run is not task completion/);
    assert.match(text, /pnpm test focused/);
  });

  it("refuses an oversized contract instead of truncating acceptance criteria", () => {
    assert.equal(createWorkTaskContextMessage(task("x".repeat(30 * 1024))), undefined);
  });

  it("labels the latest reconciliation as an unverified human report", () => {
    const reconciled = task();
    reconciled.status = "paused";
    reconciled.runIds = ["run-1"];
    reconciled.reconciliations = [{
      id: "reconciliation-1", runId: "run-1", actor: "human",
      observedOutcome: "partially_applied", decision: "continue",
      note: "The first file exists; the second does not.",
      confirmedAt: "2026-09-30T00:01:00.000Z",
    }];
    const message = createWorkTaskContextMessage(reconciled);
    const text = message?.parts[0]?.type === "text" ? message.parts[0].text : "";
    assert.match(text, /Human-reported observation only/);
    assert.match(text, /not program-verified/);
    assert.match(text, /Do not replay effects solely because of it/);
    assert.match(text, /partially_applied/);
  });
});
