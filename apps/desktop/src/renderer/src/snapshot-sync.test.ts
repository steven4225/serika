import assert from "node:assert/strict";
import { it } from "node:test";
import type { UiSnapshot } from "../../shared/ui-contract.js";
import { createSnapshotSync } from "./snapshot-sync.js";

function deferred() {
  let resolve!: (value: UiSnapshot) => void;
  const promise = new Promise<UiSnapshot>(yes => { resolve = yes; });
  return { resolve, promise };
}
const idle = { state: { kind: "idle" }, canSubmit: true } as UiSnapshot;
const busy = { state: { kind: "running", phase: "primary", runId: "tg", source: "telegram" }, canSubmit: false } as UiSnapshot;

it("late bootstrap busy reads cannot overwrite a newer idle event; the next resume read restores idle", async () => {
  let request = deferred();
  const visible: UiSnapshot[] = [];
  const sync = createSnapshotSync(() => request.promise, snapshot => visible.push(snapshot));
  const initial = sync.refresh();
  sync.invalidate(); // The actual state event handler has just rendered idle.
  request.resolve(busy);
  assert.equal(await initial, null);
  assert.deepEqual(visible, []);
  request = deferred();
  const resumed = sync.refresh(); request.resolve(idle);
  assert.equal(await resumed, idle);
  assert.deepEqual(visible, [idle]);
});

it("coalesces slow focus/visibility/poll reads and discards reads after a Thread unmount", async () => {
  const request = deferred(); let calls = 0, applied = 0;
  const sync = createSnapshotSync(() => { calls++; return request.promise; }, () => { applied++; });
  const first = sync.refresh(), second = sync.refresh();
  assert.equal(first, second); assert.equal(calls, 1);
  sync.close(); request.resolve(busy);
  assert.equal(await first, null); assert.equal(applied, 0);
  assert.equal(await sync.refresh(), null); assert.equal(calls, 1);
});

it("failed resume reads can be retried without resubmitting a message", async () => {
  let calls = 0;
  const sync = createSnapshotSync(async () => { if (++calls === 1) throw new Error("offline"); return idle; }, () => {});
  await assert.rejects(sync.refresh(), /offline/);
  assert.equal(await sync.refresh(), idle);
});
