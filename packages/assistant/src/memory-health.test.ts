import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readMemoryHealth } from "./memory-health.js";
import { type MemoryEntry, type WorkspaceMemoryStore } from "./memory-store.js";
import { memorySnapshot } from "./memory-snapshot.js";

const now = new Date("2026-09-27T00:00:00.000Z");
const active = (id: string, extras: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id, text: `memory ${id}`, enabled: true, status: "active", scope: { kind: "workspace" }, ...extras,
});
const storeWith = (entries: MemoryEntry[]): WorkspaceMemoryStore => ({
  async list() { return { ok: true, entries }; },
}) as WorkspaceMemoryStore;

describe("memory health", () => {
  it("does not read when disabled", async () => {
    assert.deepEqual(await readMemoryHealth(undefined, "current", now), { status: "disabled" });
  });

  it("reports the exact injectable set and exclusive exclusions", async () => {
    const entries = [
      active("current", { pinned: true }),
      active("other", { scope: { kind: "thread", threadId: "other" }, enabled: false, expiresAt: "2020-01-01T00:00:00.000Z" }),
      active("disabled", { enabled: false, expiresAt: "2020-01-01T00:00:00.000Z" }),
      active("expired", { expiresAt: "2020-01-01T00:00:00.000Z" }),
      active("thread", { scope: { kind: "thread", threadId: "current" } }),
    ];
    const health = await readMemoryHealth(storeWith(entries), "current", now);
    assert.equal(health.status, "ready");
    if (health.status !== "ready") return;
    assert.equal(health.totalEntries, 5);
    assert.deepEqual(health.excluded, { thread: 2, document: 0, disabled: 1, expired: 1 });
    const selected = memorySnapshot(entries, { now });
    assert.equal(health.eligibleEntries, 1);
    assert.equal(health.snapshotEntries, 1);
    assert.equal(health.snapshotBytes, selected.bytes);
    assert.equal(health.checkedAt, now.toISOString());
  });

  it("returns store errors without treating corrupt data as an empty store", async () => {
    const store = { async list() { return { ok: false, error: { code: "MEMORY_FILE_INVALID", message: "corrupt" } }; } } as WorkspaceMemoryStore;
    assert.deepEqual(await readMemoryHealth(store, "current", now), {
      status: "error", code: "MEMORY_FILE_INVALID", message: "corrupt",
    });
  });
});
