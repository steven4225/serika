import assert from "node:assert/strict";
import { it } from "node:test";
import { runTemporalMemoryAcceptance } from "./memory-temporal-acceptance.js";

it("requires explicit live opt-in before creating acceptance data or calling a model", async () => {
  const saved = process.env.RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE;
  delete process.env.RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE;
  try { await assert.rejects(runTemporalMemoryAcceptance(), /Live opt-in required/); }
  finally {
    if (saved === undefined) delete process.env.RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE;
    else process.env.RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE = saved;
  }
});

it("runs live temporal controls with two independent child processes", {
  skip: process.env.RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE !== "1",
}, async () => {
  const report = await runTemporalMemoryAcceptance();
  assert.equal(report.passed, true, report.failure ?? report.root);
  assert.equal(report.electronAcceptance, "not_run");
  assert.equal(report.wholePhaseAccepted, false);
});
