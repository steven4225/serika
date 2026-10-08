import assert from "node:assert/strict";
import { it } from "node:test";
import { SteeringMailbox } from "./steering.js";

it("steer mailbox is bounded, idempotent and rejects conflicting caller ids", async () => {
  const accepted: unknown[] = [];
  const mailbox = new SteeringMailbox(async (type, data) => { accepted.push({ type, data }); }, () => {});
  assert.equal((await mailbox.submit({ id: "bad id", text: "a" })).reason, "invalid");
  assert.equal((await mailbox.submit({ id: "long", text: "中".repeat(1366) })).reason, "invalid");
  await mailbox.submit({ id: "one", text: "a" }); await mailbox.submit({ id: "one", text: "a" });
  assert.equal((await mailbox.submit({ id: "one", text: "b" })).reason, "conflict");
  assert.equal(accepted.length, 1);
  for (let i = 1; i < 8; i++) await mailbox.submit({ id: `id-${i}`, text: "a" });
  assert.equal((await mailbox.submit({ id: "ninth", text: "a" })).reason, "limit");
  assert.equal(mailbox.sealIfEmpty(), false);
  const requests = await mailbox.drain(); assert.equal(requests.length, 8); assert.equal(mailbox.signal.aborted, false);
  for (const request of requests) await mailbox.applied(request, `message-${request.id}`);
  assert.equal(mailbox.sealIfEmpty(), true);
  assert.equal((await mailbox.submit({ id: "late", text: "a" })).reason, "closed");
});

it("admission reserves before persistence, acknowledgement waits and terminal close resolves accepted-only requests", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  const events: unknown[] = [];
  const mailbox = new SteeringMailbox(async (type, data) => {
    if (type === "run.steer.accepted") await barrier;
    events.push({ type, data });
  }, () => {});
  const oldSignal = mailbox.signal;
  let acknowledged = false;
  const accepted = mailbox.submit({ id: "one", text: "new" }).then(value => { acknowledged = true; return value; });
  assert.equal(mailbox.hasPending(), true); assert.equal(mailbox.sealIfEmpty(), false); assert.equal(oldSignal.aborted, true);
  await Promise.resolve(); assert.equal(acknowledged, false);
  const closed = mailbox.close("cancelled"); release(); await accepted; await closed;
  assert.deepEqual(events, [ { type: "run.steer.accepted", data: { id: "one", text: "new" } },
    { type: "run.steer.not_applied", data: { id: "one", reason: "cancelled" } } ]);
});

it("failure to persist acceptance fails the Run path and never acknowledges a lost request", async () => {
  let failed: unknown;
  const error = new Error("disk full");
  const mailbox = new SteeringMailbox(async () => { throw error; }, value => { failed = value; });
  await assert.rejects(mailbox.submit({ id: "one", text: "new" }), /disk full/);
  assert.equal(failed, error);
  await mailbox.close("run_failed");
  assert.equal((await mailbox.submit({ id: "two", text: "other" })).reason, "closed");
});
