import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForConsolidationHandoff } from "./consolidation-lifecycle.js";

test("background handoff times out without treating cancellation request as completion", async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  assert.equal(await waitForConsolidationHandoff(pending, 10), false);
  finish();
  assert.equal(await waitForConsolidationHandoff(pending, 10), true);
});
