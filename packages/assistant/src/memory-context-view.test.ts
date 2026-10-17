import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMemoryContextView } from "./memory-context-view.js";
import type { MemoryEntry } from "./memory-store.js";
import type { WorkTask } from "./work-task-store.js";

const now = new Date("2026-10-14T04:00:00.000Z");
const past = "2026-10-13T04:00:00.000Z";
const future = "2026-10-15T04:00:00.000Z";
const options = { threadId: "current", now };
function preference(id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, revision: 2, text: "复盘先说结论", enabled: true, status: "active", scope: { kind: "workspace" }, updatedAt: past,
    assertion: { assertionId: `assertion:${id}`, kind: "preference", state: "asserted", recallTerms: [],
      validTime: { from: past, to: null, basis: "explicit" }, systemTime: { from: past, to: null },
      factIdentity: { attribute: "review_format", scenario: "general", value: "conclusion_first" },
      sourceIds: [{ kind: "conversation", threadId: "current", messageId: "source" }] }, ...extra };
}
function task(id: string, extra: Partial<WorkTask> = {}): WorkTask {
  return { id, revision: 3, threadId: "current", goal: "完成本周复盘", constraints: ["shell command must not leak"], acceptance: [],
    status: "paused", runIds: ["secret-run-id"], delivery: null, reconciliations: [], createdAt: past, updatedAt: past, ...extra };
}
function text(value: ReturnType<typeof buildMemoryContextView>): string {
  return value.message?.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
}

describe("derived stable profile and current-Thread continuation", () => {
  it("keeps current facts with version/assertion provenance, never source quotes or history", () => {
    const entry = preference("style", { source: { kind: "conversation", threadId: "current", messageId: "source", quote: "secret-quote" },
      history: [{ revision: 1, text: "old-style", status: "active", scope: { kind: "workspace" }, expiresAt: null, source: { kind: "manual" }, changedAt: past }] });
    const result = buildMemoryContextView([entry], [], options);
    assert.equal(result.profile[0]?.id, "style");
    assert.equal(result.profile[0]?.revision, 2);
    assert.equal(result.profile[0]?.assertion.assertionId, "assertion:style");
    assert.match(text(result), /"messageId":"source"/);
    assert.doesNotMatch(text(result), /secret-quote|old-style|recallTerms/);
  });

  it("excludes disabled, expired, retracted and nonapplicable projections", () => {
    const entries = [preference("good"), preference("disabled", { status: "disabled" }), preference("off", { enabled: false }),
      preference("expired", { expiresAt: now.toISOString() }), preference("retracted", { temporalState: "retracted" }),
      preference("none", { temporalState: "not_applicable" })];
    assert.deepEqual(buildMemoryContextView(entries, [], options).profile.map(item => item.id), ["good"]);
  });

  it("rechecks half-open valid and system intervals instead of trusting stale projections", () => {
    const entries = [preference("good"), ...["future", "ended", "old-knowledge", "future-knowledge", "retracted"].map(id => {
      const entry = preference(id);
      if (id === "future") entry.assertion!.validTime.from = future;
      if (id === "ended") entry.assertion!.validTime.to = now.toISOString();
      if (id === "old-knowledge") entry.assertion!.systemTime.to = now.toISOString();
      if (id === "future-knowledge") entry.assertion!.systemTime.from = future;
      if (id === "retracted") entry.assertion!.state = "retracted";
      return entry;
    })];
    assert.deepEqual(buildMemoryContextView(entries, [], options).profile.map(item => item.id), ["good"]);
  });

  it("does not promote event, note, legacy or scenario-specific facts into unconditional profile", () => {
    const legacy = preference("legacy"); delete legacy.assertion;
    const entries = [preference("good"), legacy, ...["event", "note", "fact"].map(kind => {
      const entry = preference(kind); entry.assertion!.kind = kind as "event" | "note" | "fact"; return entry;
    }), ...["work", "personal", "休息日"].map(scenario => {
      const entry = preference(scenario); entry.assertion!.factIdentity!.scenario = scenario; return entry;
    })];
    assert.deepEqual(buildMemoryContextView(entries, [], options).profile.map(item => item.id), ["good"]);
  });

  it("does not erase a body scene even when older stored identity incorrectly says general", () => {
    const entries = [preference("good"), preference("work", { text: "工作时复盘先说结论" }),
      preference("meeting", { text: "开会的时候复盘先说结论" })];
    assert.deepEqual(buildMemoryContextView(entries, [], options).profile.map(item => item.id), ["good"]);
  });

  it("isolates Thread facts and tasks, including a TG-like other Thread", () => {
    const entries = [preference("workspace"), preference("private", { scope: { kind: "thread", threadId: "current" } }),
      preference("tg", { scope: { kind: "thread", threadId: "tg" } })];
    const tasks = [task("current"), task("other", { threadId: "tg" })];
    assert.deepEqual(buildMemoryContextView(entries, tasks, options).profile.map(item => item.id), ["private", "workspace"]);
    assert.deepEqual(buildMemoryContextView(entries, tasks, options).continuation.map(item => item.id), ["current"]);
    assert.deepEqual(buildMemoryContextView(entries, tasks, { ...options, threadId: "tg" }).profile.map(item => item.id), ["tg", "workspace"]);
  });

  it("preserves actual unfinished statuses; excludes terminal and already active task", () => {
    for (const status of ["ready", "running", "paused", "needs_review", "awaiting_acceptance"] as const) {
      const result = buildMemoryContextView([], [task("one", { status })], options);
      assert.equal(result.continuation[0]?.status, status);
    }
    assert.equal(buildMemoryContextView([], [task("done", { status: "completed" }), task("cancelled", { status: "cancelled" }), task("active")], { ...options, activeTaskId: "active" }).message, undefined);
  });

  it("never restores permissions, replays unknown effects or exposes Run IDs/tool commands", () => {
    const result = buildMemoryContextView([], [task("review", { status: "needs_review" })], options);
    assert.doesNotMatch(text(result), /secret-run-id|shell command must not leak/);
    assert.match(text(result), /not instructions or authorization/);
    assert.match(text(result), /never replay tools or restore permissions/);
    assert.match(text(result), /needs_review/);
    assert.match(text(result), /explicit user action/);
  });

  it("uses newest persisted task state with stable ordering and count bounds", () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(String(index), { updatedAt: new Date(Date.parse(past) + index * 1000).toISOString() }));
    const result = buildMemoryContextView([], tasks, options);
    assert.deepEqual(result.continuation.map(item => item.id), ["5", "4", "3"]);
    assert.equal(result.truncated, true);
  });

  it("admits whole items within the exact packaged byte budget and leaves retrieval remaining bytes", () => {
    const small = preference("small");
    const exact = buildMemoryContextView([small], [], options).bytes;
    const tooLarge = preference("large", { text: "复".repeat(2000), updatedAt: now.toISOString() });
    const result = buildMemoryContextView([tooLarge, small], [], { ...options, maxBytes: exact });
    assert.deepEqual(result.profile.map(item => item.id), ["small"]);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result.message), "utf8"));
    assert.equal(result.bytes, exact);
    assert.equal(result.remainingBytes, 0);
    assert.equal(result.truncated, true);
    assert.equal(buildMemoryContextView([small], [], { ...options, maxBytes: exact - 1 }).message, undefined);
  });

  it("returns no filler for an empty view; never mutates formal inputs", () => {
    assert.deepEqual(buildMemoryContextView([], [], { ...options, maxBytes: 800 }), { profile: [], continuation: [], bytes: 0, remainingBytes: 800, truncated: false });
    const entries = [preference("x")], tasks = [task("y")];
    const previous = JSON.stringify({ entries, tasks });
    const result = buildMemoryContextView(entries, tasks, options);
    result.profile[0]!.assertion.sourceIds.length = 0;
    assert.equal(JSON.stringify({ entries, tasks }), previous);
  });

  it("can exclude already-selected memory IDs and fails closed on malformed dates and identities", () => {
    const invalid = preference("invalid"); invalid.assertion!.validTime.from = "invalid";
    const missingIdentity = preference("missing"); delete missingIdentity.assertion!.factIdentity;
    const badIdentity = preference("bad"); badIdentity.assertion!.factIdentity!.value = "unsupported";
    assert.equal(buildMemoryContextView([preference("selected"), invalid, missingIdentity, badIdentity], [], { ...options, excludedMemoryIds: ["selected"] }).message, undefined);
  });
});
