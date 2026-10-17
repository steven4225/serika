import assert from "node:assert/strict";
import { test } from "node:test";
import { automaticConsolidationSkip, waitForConsolidationHandoff } from "./consolidation-lifecycle.js";

test("automatic lifecycle triggers only after an eligible completed primary", () => {
  const eligible = { enabled: true, status: "completed", requestedMemoryTool: false, cancelled: false };
  assert.equal(automaticConsolidationSkip(eligible), undefined);
  for (const override of [{ enabled: false }, { status: "failed" }, { status: "cancelled" }, { requestedMemoryTool: true }, { cancelled: true }, { excluded: true }]) {
    assert.equal(typeof automaticConsolidationSkip({ ...eligible, ...override }), "string");
  }
});

test("background handoff times out without treating cancellation request as completion", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  assert.equal(await waitForConsolidationHandoff(pending, 10), false);
  finish();
  assert.equal(await waitForConsolidationHandoff(pending, 10), true);
});
