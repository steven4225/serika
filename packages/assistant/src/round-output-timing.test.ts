import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentEvent } from "@serika/core";
import { beginRoundOutputTiming } from "./round-output-timing.js";
import { ModelCallLog } from "./model-call-log.js";

test("round timing counts tool-only and no-output separately from visible-text median samples", async t => {
  const rows: Parameters<ModelCallLog["round"]>[0][] = [];
  const log = new ModelCallLog("unused");
  t.mock.method(log, "round", async (row: Parameters<ModelCallLog["round"]>[0]) => { rows.push(row); });
  const start = () => beginRoundOutputTiming({ log, threadId: "thread", message: {
    id: "message", role: "user", parts: [], metadata: { receivedAt: new Date(Date.now() - 5000).toISOString() },
  } });
  const event = (type: string, data: object) => ({ type, data, runId: "run" }) as AgentEvent;
  const tool = start(); tool.observe(event("tool.call.requested", {})); await tool.finish();
  const empty = start(); empty.observe(event("message.delta", { text: "" })); await empty.finish();
  const text = start(); text.observe(event("tool.call.requested", {}));
  text.observe(event("message.delta", { text: "visible" })); await text.finish();
  assert.deepEqual(rows.map(row => row.outcome), ["tool_only", "no_output", "text"]);
  assert.deepEqual(rows.slice(0, 2).map(row => row.firstVisibleTextMs), [null, null]);
  assert.ok(rows[2]!.firstVisibleTextMs! >= 5000);
});
