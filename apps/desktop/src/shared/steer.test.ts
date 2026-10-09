import assert from "node:assert/strict";
import { it } from "node:test";
import type { AssistantSteerRecord } from "./ui-contract.js";
import { mergeSteerRecords, steerFailureLabel, steerStatusLabel } from "./steer.js";

const accepted: AssistantSteerRecord = { id: "request-1", runId: "primary-1", text: "保留原文，只追加两条行动", status: "accepted", receivedAt: "2026-10-08T00:00:00Z" };

it("upserts authoritative statuses without accepting stale Run messages or regressing applied to accepted", () => {
  const first = mergeSteerRecords([], accepted, "primary-1");
  const applied = { ...accepted, status: "applied" as const, messageId: "message-1" };
  const second = mergeSteerRecords(first, applied, "primary-1");
  assert.equal(second.length, 1);
  assert.equal(second[0]?.status, "applied");
  assert.equal(mergeSteerRecords(second, accepted, "primary-1"), second);
  assert.equal(mergeSteerRecords(second, { ...accepted, runId: "old" }, "primary-1"), second);
  assert.equal(mergeSteerRecords(second, accepted, null), second);
  const unApplied = mergeSteerRecords(second, { ...accepted, id: "request-2", status: "not_applied", reason: "cancelled" }, "primary-1");
  assert.equal(unApplied.length, 2);
  assert.match(steerStatusLabel(unApplied[1]!), /未应用/);
  assert.doesNotMatch(steerStatusLabel(applied), /完成|已执行|成功/);
  assert.match(steerFailureLabel("stale"), /草稿已保留/);
});
