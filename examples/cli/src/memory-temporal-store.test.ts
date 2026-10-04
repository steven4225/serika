import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { MemoryResult, CandidateDraft } from "./memory-candidates.js";
import {
  createMemoryStore,
  type MemoryDocument,
  type MemoryEntryResult,
} from "./memory-store.js";

const directories: string[] = [];
const learnedAt = "2026-10-04T12:00:00.000Z";
const initialAt = "2026-08-01T12:00:00.000Z";
const movedAt = "2026-09-01T00:00:00.000Z";
const beforeMove = "2026-08-20T00:00:00.000Z";
const afterMove = "2026-09-20T00:00:00.000Z";
const threadId = "temporal-thread";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-temporal-memory-"));
  directories.push(directory);
  return directory;
}

function value<T>(result: MemoryResult<T>): T {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function entry(result: MemoryEntryResult) {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.entry;
}

function options(at = learnedAt) {
  return { boundThreadId: threadId, now: new Date(at) };
}

async function saved(directory: string): Promise<string> {
  return readFile(join(directory, ".runloom", "memory.json"), "utf8");
}

function addDraft(text: string, messageId: string): CandidateDraft {
  return {
    change: { operation: "add", text, scope: { kind: "workspace" }, expiresAt: null },
    source: { kind: "conversation", threadId, messageId, quote: text },
    reason: "explicit user preference",
  };
}

describe("WorkspaceMemoryStore v4 temporal contract", () => {
  it("permanent deletion rechecks revision and never deletes a newer edit", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({ text: "delete only the version I reviewed" }, undefined, options(initialAt)));
    entry(await store.update(added.id, { expectedRevision: 1, text: "newer user edit" }, undefined, options()));
    const before = await saved(directory);
    const stale = await store.deleteMemory({ id: added.id, expectedRevision: 1 }, undefined, options());
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "MEMORY_REVISION_CONFLICT");
    assert.equal(await saved(directory), before);
    assert.equal(entry(await store.get(added.id, undefined, options())).text, "newer user edit");
    assert.deepEqual(await store.deleteMemory({ id: added.id, expectedRevision: 2 }, undefined, options()), { ok: true, id: added.id });
    assert.equal((await store.inspectMemory(added.id)).ok, false);
    assert.equal((await store.restoreMemory({ id: added.id, expectedRevision: 2, targetAssertionId: "erased" }, undefined, options())).ok, false);
  });

  it("normalizes legacy timezone stamps without inventing new historical times on migration", async () => {
    const directory = await workspace();
    await mkdir(join(directory, ".runloom"));
    const legacy = JSON.stringify({ version: 3, candidates: [], consolidationCursors: [], entries: [{
      id: "zone-legacy", text: "current text", enabled: true, status: "active", scope: { kind: "workspace" }, pinned: false,
      source: { kind: "manual" }, createdAt: "2026-08-01T20:00:00+08:00", updatedAt: "2026-09-01T00:00:00Z", expiresAt: null, revision: 2,
      history: [{ revision: 1, text: "old text", status: "active", scope: { kind: "workspace" }, source: { kind: "manual" }, pinned: false, expiresAt: null, changedAt: "2026-08-01T20:00:00+08:00" }],
    }] });
    await writeFile(join(directory, ".runloom", "memory.json"), legacy);
    const store = createMemoryStore(directory);
    value(await store.inspectMemory("zone-legacy"));
    assert.equal(await saved(directory), legacy);
    entry(await store.add({ text: "trigger actual migration" }, undefined, options()));
    const record = value(await createMemoryStore(directory).inspectMemory("zone-legacy"));
    assert.equal(record.createdAt, initialAt);
    assert.equal(record.assertions[0]?.systemTime.from, initialAt);
    assert.equal(record.assertions[1]?.systemTime.from, movedAt);
    assert.equal(record.assertions[0]?.validTime.from, null);
    assert.equal(record.historyCoverage, "legacy_partial");
  });

  for (const version of [1, 2, 3] as const) {
    it(`reads v${version} without writing and migrates only on a successful actual mutation`, async () => {
      const directory = await workspace();
      await mkdir(join(directory, ".runloom"));
      const legacy = version === 1
        ? { id: "legacy", text: "keep the old preference", enabled: true }
        : {
          id: "legacy", text: "keep the old preference", enabled: true,
          status: "active", scope: { kind: "workspace" }, pinned: false,
          source: { kind: "manual" }, createdAt: initialAt, updatedAt: initialAt,
          expiresAt: null, revision: 1, history: [],
        };
      const original = JSON.stringify({
        version, entries: [legacy],
        ...(version === 3 ? { candidates: [], consolidationCursors: [] } : {}),
      }, null, 3);
      await writeFile(join(directory, ".runloom", "memory.json"), original);
      const store = createMemoryStore(directory);

      assert.equal(entry(await store.get("legacy", undefined, options())).text, "keep the old preference");
      const record = value(await store.inspectMemory("legacy"));
      assert.equal(record.historyCoverage, "legacy_partial");
      assert.equal(record.assertions.length, 1);
      assert.equal(record.assertions[0]?.validTime.from, null);
      if (version === 1) {
        assert.equal(record.createdAt, null);
        assert.equal(record.updatedAt, null);
        assert.equal(record.assertions[0]?.systemTime.from, null);
      }
      await store.list();
      await store.queryMemory("legacy", { validAt: beforeMove, knownAt: learnedAt });
      assert.equal(await saved(directory), original);

      const invalid = await store.update("legacy", { text: " ", expectedRevision: 1 }, undefined, options());
      assert.equal(invalid.ok, false);
      assert.equal(await saved(directory), original, "a failed edit must not migrate an old file");

      entry(await store.add({ text: "new memory" }, undefined, options()));
      const migrated = JSON.parse(await saved(directory));
      assert.equal(migrated.version, 4);
      const persisted = migrated.entries.find((item: { id: string }) => item.id === "legacy");
      assert.equal(persisted.historyCoverage, "legacy_partial");
      assert.equal(persisted.assertions[0].text, "keep the old preference");
      for (const field of ["text", "source", "enabled", "history"]) {
        assert.equal(Object.hasOwn(persisted, field), false, `${field} must be a derived projection, not another stored authority`);
      }
      assert.equal(value(await createMemoryStore(directory).inspectMemory("legacy")).historyCoverage, "legacy_partial");
    });
  }

  it("preserves only available legacy revisions and marks pruned historical coverage incomplete", async () => {
    const directory = await workspace();
    await mkdir(join(directory, ".runloom"));
    const history = Array.from({ length: 8 }, (_, index) => ({
      revision: index + 7, text: `retained revision ${index + 7}`,
      status: "active", scope: { kind: "workspace" }, pinned: false,
      expiresAt: null, source: { kind: "manual" },
      changedAt: new Date(Date.parse("2026-07-07T00:00:00Z") + index * 86_400_000).toISOString(),
    }));
    const original = JSON.stringify({
      version: 3, entries: [{
        id: "previously-pruned", text: "retained revision 15", revision: 15,
        enabled: true, status: "active", scope: { kind: "workspace" }, pinned: false,
        source: { kind: "conversation", threadId, messageId: "legacy-source", quote: "Original quoted preference." },
        createdAt: "2026-01-01T00:00:00Z", updatedAt: initialAt, expiresAt: null, history,
      }], candidates: [], consolidationCursors: [],
    });
    await writeFile(join(directory, ".runloom", "memory.json"), original);
    const store = createMemoryStore(directory);
    const inspected = value(await store.inspectMemory("previously-pruned"));
    assert.equal(inspected.historyCoverage, "legacy_partial");
    assert.equal(inspected.revision, 15);
    assert.deepEqual(inspected.assertions.map((assertion) => assertion.text), [
      ...history.map((revision) => revision.text), "retained revision 15",
    ]);
    assert.deepEqual(inspected.assertions.at(-1)?.sources, [{
      kind: "conversation", threadId, messageId: "legacy-source", quote: "Original quoted preference.",
    }]);
    assert.equal(await saved(directory), original);
    entry(await store.add({ text: "an unrelated new memory" }, undefined, options()));
    const migrated = value(await createMemoryStore(directory).inspectMemory("previously-pruned"));
    assert.equal(migrated.historyCoverage, "legacy_partial");
    assert.equal(migrated.assertions.length, 9, "migration cannot recreate six already-pruned revisions");
    assert.equal(migrated.revision, 15);
  });

  it("separates a real-world change from when the workspace learned it", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({
      text: "home city is Shanghai", kind: "fact",
      validTime: { from: "2026-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options(initialAt)));
    const changed = entry(await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "change",
      text: "home city is Hangzhou", effectiveAt: movedAt,
    }, undefined, options()));
    assert.equal(changed.id, added.id);
    assert.equal(changed.revision, 2);

    const record = value(await store.inspectMemory(added.id));
    assert.equal(record.assertions.length, 3);
    assert.equal(new Set(record.assertions.map((assertion) => assertion.assertionId)).size, 3);
    assert.equal(record.historyCoverage, "complete");
    const beforeLearning = value(await store.queryMemory(added.id, {
      validAt: afterMove, knownAt: "2026-10-03T12:00:00Z",
    }));
    assert.deepEqual(beforeLearning.assertions.map((assertion) => assertion.text), ["home city is Shanghai"]);
    const oldCity = value(await store.queryMemory(added.id, { validAt: beforeMove, knownAt: learnedAt }));
    assert.deepEqual(oldCity.assertions.map((assertion) => assertion.text), ["home city is Shanghai"]);
    assert.equal(oldCity.assertions[0]?.validTime.to, movedAt);
    const newCity = value(await store.queryMemory(added.id, { validAt: movedAt, knownAt: learnedAt }));
    assert.deepEqual(newCity.assertions.map((assertion) => assertion.text), ["home city is Hangzhou"]);
    assert.equal(newCity.validTimeUncertain, false);
    assert.equal(newCity.systemTimeUncertain, false);

    const beforeSaved = value(await store.queryMemory(added.id, { validAt: beforeMove, knownAt: "2026-07-01T00:00:00Z" }));
    assert.deepEqual(beforeSaved.assertions, [], "the system must not claim knowledge before the assertion was saved");
    const current = entry(await store.get(added.id, undefined, options()));
    assert.equal(current.text, "home city is Hangzhou");
    assert.equal(Object.hasOwn(current, "assertions"), false);
    assert.equal(Object.hasOwn(current, "versions"), false);
  });

  it("does not convert a corrected false claim into a real past fact", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({
      text: "home city is Shanghai", kind: "fact",
      validTime: { from: "2020-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options(initialAt)));
    entry(await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "home city is Hangzhou",
      validTime: { from: "2020-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options()));

    const correctedPast = value(await store.queryMemory(added.id, { validAt: beforeMove, knownAt: learnedAt }));
    assert.deepEqual(correctedPast.assertions.map((assertion) => assertion.text), ["home city is Hangzhou"]);
    const previousBelief = value(await store.queryMemory(added.id, { validAt: beforeMove, knownAt: initialAt }));
    assert.deepEqual(previousBelief.assertions.map((assertion) => assertion.text), ["home city is Shanghai"]);
    const record = value(await store.inspectMemory(added.id));
    assert.equal(record.assertions.length, 2, "correction must not create an artificial valid-time Shanghai period");
    assert.equal(record.assertions[0]?.validTime.to, null);
    assert.equal(record.assertions[0]?.systemTime.to, learnedAt);
  });

  it("keeps a future-effective change from prematurely replacing the current fact", async () => {
    const store = createMemoryStore(await workspace());
    const added = entry(await store.add({
      text: "home city is Shanghai", kind: "fact",
      validTime: { from: "2020-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options(initialAt)));
    entry(await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "change",
      text: "home city is Hangzhou", effectiveAt: "2100-01-01T00:00:00Z",
    }, undefined, options()));
    assert.equal(entry(await store.get(added.id, undefined, options())).text, "home city is Shanghai");
    const before = value(await store.queryMemory(added.id, {
      validAt: "2099-12-31T23:59:59Z", knownAt: learnedAt,
    }));
    const after = value(await store.queryMemory(added.id, {
      validAt: "2100-01-01T00:00:00Z", knownAt: learnedAt,
    }));
    assert.deepEqual(before.assertions.map((assertion) => assertion.text), ["home city is Shanghai"]);
    assert.deepEqual(after.assertions.map((assertion) => assertion.text), ["home city is Hangzhou"]);
  });

  it("retracts current applicability without reviving an older assertion", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({ text: "prefer concise answers", kind: "preference" }, undefined, options(initialAt)));
    const retractedAt = "2026-08-02T12:00:00.000Z";
    const retracted = entry(await store.reviseMemory({ id: added.id, expectedRevision: 1, operation: "retract" }, undefined, options(retractedAt)));
    assert.equal(retracted.id, added.id);
    assert.equal(retracted.revision, 2);
    assert.equal(retracted.text, "");
    assert.equal(retracted.enabled, false);
    assert.deepEqual(value(await store.queryMemory(added.id, {}, undefined, options())).assertions, []);
    assert.equal(entry(await createMemoryStore(directory).get(added.id, undefined, options())).text, "");
    const past = value(await store.queryMemory(added.id, { knownAt: initialAt }, undefined, options()));
    assert.deepEqual(past.assertions.map((assertion) => assertion.text), ["prefer concise answers"]);
  });

  it("marks unknown temporal coverage rather than claiming certainty about the distant past", async () => {
    const store = createMemoryStore(await workspace());
    const added = entry(await store.add({ text: "home city is Shanghai", kind: "fact" }, undefined, options(initialAt)));
    const record = value(await store.inspectMemory(added.id));
    assert.equal(record.assertions[0]?.validTime.from, null);
    const past = value(await store.queryMemory(added.id, {
      validAt: "2000-01-01T00:00:00Z", knownAt: learnedAt,
    }));
    assert.equal(past.validTimeUncertain, true);
    assert.equal(past.systemTimeUncertain, false);
  });

  it("retains dated events and notes without treating a past occurrence as expired current state", async () => {
    const store = createMemoryStore(await workspace());
    for (const kind of ["event", "note"] as const) {
      const added = entry(await store.add({
        text: `saved ${kind}`, kind,
        validTime: { from: "2025-01-01T00:00:00Z", to: "2025-01-02T00:00:00Z", basis: "explicit" },
      }, undefined, options(initialAt)));
      const current = value(await store.queryMemory(added.id, {}, undefined, options()));
      assert.deepEqual(current.assertions.map((assertion) => assertion.text), [`saved ${kind}`]);
      const outsideDate = value(await store.queryMemory(added.id, { validAt: learnedAt }, undefined, options()));
      assert.deepEqual(outsideDate.assertions, [], "an explicit historical question still uses the valid-time interval");
    }
  });

  it("uses expiresAt only as a usage TTL, never as a substitute for validTime.to", async () => {
    const store = createMemoryStore(await workspace());
    const added = entry(await store.add({
      text: "a known fact", kind: "fact", expiresAt: movedAt,
      validTime: { from: "2025-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options(initialAt)));
    const inspected = value(await store.inspectMemory(added.id));
    assert.equal(inspected.expiresAt, movedAt);
    assert.equal(inspected.assertions[0]?.validTime.to, null);
    assert.deepEqual(value(await store.queryMemory(added.id, {}, undefined, options())).assertions, []);
    const audited = value(await store.queryMemory(added.id, {
      validAt: afterMove, knownAt: learnedAt, includeDisabled: true,
    }, undefined, options()));
    assert.deepEqual(audited.assertions.map((assertion) => assertion.text), ["a known fact"]);
  });

  it("restores selected contents as a new assertion effective now, not a timeline rewind", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({
      text: "prefer short answers", kind: "preference", recallTerms: ["answer format"],
      validTime: { from: "2026-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options(initialAt)));
    const original = value(await store.inspectMemory(added.id)).assertions[0]!;
    entry(await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "prefer detailed answers",
      validTime: { from: "2026-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options()));
    const restoredAt = "2026-10-05T12:00:00.000Z";
    const restored = entry(await store.restoreMemory({
      id: added.id, expectedRevision: 2, targetAssertionId: original.assertionId,
    }, undefined, options(restoredAt)));
    assert.equal(restored.id, added.id);
    assert.equal(restored.revision, 3);
    const record = value(await store.inspectMemory(added.id));
    const latest = record.assertions.filter((assertion) => assertion.systemTime.to === null && assertion.state === "asserted").at(-1);
    assert.ok(latest);
    assert.notEqual(latest.assertionId, original.assertionId);
    assert.equal(latest.text, original.text);
    assert.deepEqual(latest.recallTerms, original.recallTerms);
    assert.equal(latest.validTime.from, restoredAt);
    assert.equal(latest.systemTime.from, restoredAt);
    const previousKnowledge = value(await store.queryMemory(added.id, { validAt: learnedAt, knownAt: learnedAt }));
    assert.deepEqual(previousKnowledge.assertions.map((assertion) => assertion.text), ["prefer detailed answers"]);
    const before = await saved(directory);
    const stale = await store.restoreMemory({
      id: added.id, expectedRevision: 2, targetAssertionId: original.assertionId,
    }, undefined, options("2026-10-06T00:00:00Z"));
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "MEMORY_REVISION_CONFLICT");
    assert.equal(await saved(directory), before);
  });

  it("restores a fact after a note correction without leaving the old note as the current projection", async () => {
    const store = createMemoryStore(await workspace());
    const added = entry(await store.add({
      text: "home city is Shanghai", kind: "fact",
      validTime: { from: "2026-01-01T00:00:00Z", to: null, basis: "explicit" },
    }, undefined, options(initialAt)));
    const original = value(await store.inspectMemory(added.id)).assertions[0]!;
    entry(await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "a saved note about a possible move", kind: "note",
    }, undefined, options()));
    const restoredAt = "2026-10-05T12:00:00.000Z";
    const restored = entry(await store.restoreMemory({
      id: added.id, expectedRevision: 2, targetAssertionId: original.assertionId,
    }, undefined, options(restoredAt)));
    assert.equal(restored.text, "home city is Shanghai");
    assert.equal(entry(await store.get(added.id, undefined, options(restoredAt))).text, "home city is Shanghai");
    const current = value(await store.queryMemory(added.id, {}, undefined, options(restoredAt)));
    assert.deepEqual(current.assertions.map((assertion) => [assertion.kind, assertion.text]), [["fact", "home city is Shanghai"]]);
    const previous = value(await store.queryMemory(added.id, { knownAt: learnedAt }, undefined, options(restoredAt)));
    assert.deepEqual(previous.assertions.map((assertion) => [assertion.kind, assertion.text]), [["note", "a saved note about a possible move"]]);
  });

  for (const corruption of [
    {
      name: "the latest version references a closed assertion",
      apply(document: MemoryDocument) {
        const record = document.entries[0]!;
        record.versions.at(-1)!.assertionId = record.assertions[0]!.assertionId;
      },
    },
    {
      name: "lastWrittenAt precedes an assertion's system boundary",
      apply(document: MemoryDocument) {
        document.lastWrittenAt = initialAt;
      },
    },
    {
      name: "historical controls reference an assertion from another version's system time",
      apply(document: MemoryDocument) {
        const record = document.entries[0]!;
        record.versions[0]!.assertionId = record.assertions[1]!.assertionId;
      },
    },
  ]) {
    it(`fails closed on corrupt v4 storage when ${corruption.name}`, async () => {
      const directory = await workspace();
      const store = createMemoryStore(directory);
      const added = entry(await store.add({ text: "original fact", kind: "fact" }, undefined, options(initialAt)));
      entry(await store.reviseMemory({
        id: added.id, expectedRevision: 1, operation: "correct", text: "corrected fact",
      }, undefined, options()));
      const malformed: MemoryDocument = JSON.parse(await saved(directory));
      corruption.apply(malformed);
      const original = JSON.stringify(malformed);
      await writeFile(join(directory, ".runloom", "memory.json"), original);

      assert.equal((await store.list(undefined, options())).ok, false);
      assert.equal((await store.get(added.id, undefined, options())).ok, false);
      assert.equal((await store.inspectMemory(added.id, undefined, options())).ok, false);
      assert.equal((await store.queryMemory(added.id, {}, undefined, options())).ok, false);
      assert.equal(await saved(directory), original, "corrupt reads must not repair or replace the file");
      assert.equal((await store.add({ text: "must not replace corrupt storage" }, undefined, options("2026-10-06T12:00:00Z"))).ok, false);
      assert.equal((await store.reviseMemory({
        id: added.id, expectedRevision: 2, operation: "correct", text: "must not normalize corruption away",
      }, undefined, options("2026-10-06T12:00:00Z"))).ok, false);
      assert.equal(await saved(directory), original, "a failed mutation must preserve the original corrupt bytes");
    });
  }

  it("requires explicit lifecycle choices when restoring a disabled and expired record", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({
      text: "a temporary preference", status: "disabled", expiresAt: "2026-09-01T00:00:00Z",
    }, undefined, options(initialAt)));
    const assertion = value(await store.inspectMemory(added.id)).assertions[0]!;
    const before = await saved(directory);
    const implicit = await store.restoreMemory({
      id: added.id, expectedRevision: 1, targetAssertionId: assertion.assertionId,
    }, undefined, options());
    assert.equal(implicit.ok, false);
    assert.equal(await saved(directory), before);
    const noExpiryChoice = await store.restoreMemory({
      id: added.id, expectedRevision: 1, targetAssertionId: assertion.assertionId, status: "active",
    }, undefined, options());
    assert.equal(noExpiryChoice.ok, false);
    assert.equal(await saved(directory), before);
    const restored = entry(await store.restoreMemory({
      id: added.id, expectedRevision: 1, targetAssertionId: assertion.assertionId,
      status: "active", expiresAt: null,
    }, undefined, options()));
    assert.equal(restored.status, "active");
    assert.equal(restored.enabled, true);
    assert.equal(restored.expiresAt, null);
  });

  it("keeps administrative disable separate from retraction and explicit historical reads", async () => {
    const store = createMemoryStore(await workspace());
    const added = entry(await store.add({ text: "prefer concise answers", kind: "preference" }, undefined, options(initialAt)));
    entry(await store.update(added.id, { status: "disabled", expectedRevision: 1 }, undefined, options()));
    assert.deepEqual(value(await store.queryMemory(added.id, {}, undefined, options())).assertions, []);
    const explicit = value(await store.queryMemory(added.id, { includeDisabled: true }, undefined, options()));
    assert.deepEqual(explicit.assertions.map((assertion) => assertion.text), ["prefer concise answers"]);
    const inspected = value(await store.inspectMemory(added.id));
    assert.equal(inspected.assertions.filter((assertion) => assertion.state === "retracted").length, 0);
  });

  it("checks Thread scope before temporal reads and writes", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({
      text: "only this Thread", scope: { kind: "thread", threadId },
    }, undefined, options(initialAt)));
    const other = { now: new Date(learnedAt), boundThreadId: "another-thread" };
    const before = await saved(directory);
    assert.equal((await store.inspectMemory(added.id, undefined, other)).ok, false);
    assert.equal((await store.queryMemory(added.id, { includeDisabled: true }, undefined, other)).ok, false);
    assert.equal((await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "must not change",
    }, undefined, other)).ok, false);
    assert.equal(await saved(directory), before);
  });

  it("allows exactly one concurrent CAS winner across independent store instances", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({ text: "original" }, undefined, options(initialAt)));
    const results = await Promise.all(["one", "two"].map((text) => createMemoryStore(directory).reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text,
    }, undefined, options())));
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.error.code === "MEMORY_REVISION_CONFLICT").length, 1);
    const inspected = value(await store.inspectMemory(added.id));
    assert.equal(inspected.revision, 2);
    assert.equal(inspected.assertions.length, 2);
  });

  it("rejects malformed intervals, forged legacy sources and backwards clocks without writes", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({ text: "original", kind: "fact" }, undefined, options(initialAt)));
    const before = await saved(directory);
    for (const validTime of [
      { from: "2026-10-04T12:00:00", to: null, basis: "explicit" as const },
      { from: "2026-10-05T12:00:00Z", to: learnedAt, basis: "explicit" as const },
      { from: learnedAt, to: learnedAt, basis: "explicit" as const },
    ]) {
      assert.equal((await store.reviseMemory({
        id: added.id, expectedRevision: 1, operation: "correct", text: "invalid interval", validTime,
      }, undefined, options())).ok, false);
      assert.equal(await saved(directory), before);
    }
    assert.equal((await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "forged provenance", sources: [{ kind: "legacy" }],
    }, undefined, options())).ok, false);
    assert.equal((await store.add({ text: "forged provenance", source: { kind: "legacy" } }, undefined, options())).ok, false);
    assert.equal((await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "too many sources",
      sources: Array.from({ length: 5 }, () => ({ kind: "manual" as const })),
    }, undefined, options())).ok, false);
    for (const recallTerms of [["one", "two", "three", "four"], ["字".repeat(33)]]) {
      assert.equal((await store.reviseMemory({
        id: added.id, expectedRevision: 1, operation: "correct", text: "oversize recall metadata", recallTerms,
      }, undefined, options())).ok, false);
    }
    assert.equal((await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "backwards clock",
    }, undefined, options("2026-07-01T00:00:00Z"))).ok, false);
    assert.equal(await saved(directory), before);
    for (const query of [
      { validAt: "2026-10-04T12:00:00" },
      { knownAt: "not-a-timestamp" },
    ]) assert.equal((await store.queryMemory(added.id, query)).ok, false);
    assert.equal(await saved(directory), before);
  });

  it("rejects a 65th assertion instead of silently pruning temporal history", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const initial = entry(await store.add({ text: "revision 1" }, undefined, options(initialAt)));
    for (let revision = 1; revision < 64; revision += 1) {
      entry(await store.reviseMemory({
        id: initial.id, expectedRevision: revision, operation: "correct", text: `revision ${revision + 1}`,
      }, undefined, { now: new Date(Date.parse(initialAt) + revision * 1_000) }));
    }
    const record = value(await store.inspectMemory(initial.id));
    assert.equal(record.assertions.length, 64);
    assert.equal(record.assertions[0]?.text, "revision 1");
    const before = await saved(directory);
    const exceeded = await store.reviseMemory({
      id: initial.id, expectedRevision: 64, operation: "correct", text: "revision 65",
    }, undefined, options());
    assert.equal(exceeded.ok, false);
    assert.equal(await saved(directory), before);
    assert.equal(value(await createMemoryStore(directory).inspectMemory(initial.id)).assertions.length, 64);
  });

  it("invalidates pending updates atomically and replays accepted receipts without extra assertions", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = entry(await store.add({ text: "old preference" }, undefined, options(initialAt)));
    const update: CandidateDraft = {
      change: { operation: "update", memoryId: added.id, expectedRevision: 1, text: "candidate preference", expiresAt: null },
      source: { kind: "conversation", threadId, messageId: "update-source", quote: "candidate preference" },
      reason: "explicit preference update",
    };
    const batch = value(await store.commitCandidateBatch({
      batchId: "updates", originThreadId: threadId, candidates: [update], expectedCursor: null, nextCursor: null,
    }, undefined, options()));
    entry(await store.reviseMemory({
      id: added.id, expectedRevision: 1, operation: "correct", text: "user corrected preference",
    }, undefined, options("2026-10-05T12:00:00Z")));
    const persisted = JSON.parse(await saved(directory));
    const stale = persisted.candidates.find((candidate: { id: string }) => candidate.id === batch.candidateIds[0]);
    assert.equal(stale.status, "stale");
    assert.equal(stale.staleReason, "target_changed");
    assert.equal(persisted.entries.find((item: { id: string }) => item.id === added.id).revision, 2);

    const addBatch = value(await store.commitCandidateBatch({
      batchId: "new-preference", originThreadId: threadId,
      candidates: [addDraft("a different preference", "add-source")], expectedCursor: null, nextCursor: null,
    }, undefined, options("2026-10-06T12:00:00Z")));
    const request = { candidateId: addBatch.candidateIds[0]!, expectedCandidateRevision: 1, decision: "accept" as const };
    const accepted = value(await store.resolveCandidate(request, undefined, options("2026-10-06T12:00:01Z")));
    assert.ok(accepted.memoryId);
    const original = await saved(directory);
    const originalRecord = value(await store.inspectMemory(accepted.memoryId));
    const replay = value(await createMemoryStore(directory).resolveCandidate(request, undefined, options("2026-10-07T12:00:00Z")));
    assert.equal(replay.replayed, true);
    assert.equal(replay.memoryId, accepted.memoryId);
    assert.equal(replay.memoryRevision, accepted.memoryRevision);
    assert.equal(await saved(directory), original);
    assert.deepEqual(value(await store.inspectMemory(accepted.memoryId)).assertions, originalRecord.assertions);
  });

  it("physical deletion purges related candidate contents while preserving unrelated candidates", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const secret = "private original memory text";
    const batch = value(await store.commitCandidateBatch({
      batchId: "accepted", originThreadId: threadId,
      candidates: [addDraft(secret, "private-source")], expectedCursor: null, nextCursor: null,
    }, undefined, options(initialAt)));
    const accepted = value(await store.resolveCandidate({
      candidateId: batch.candidateIds[0]!, expectedCandidateRevision: 1, decision: "accept",
    }, undefined, options(initialAt)));
    assert.ok(accepted.memoryId);
    const privateUpdate = "private proposed update text";
    const updates = value(await store.commitCandidateBatch({
      batchId: "pending", originThreadId: threadId,
      candidates: [{
        change: { operation: "update", memoryId: accepted.memoryId, expectedRevision: 1, text: privateUpdate, expiresAt: null },
        source: { kind: "conversation", threadId, messageId: "private-update", quote: privateUpdate },
        reason: "private proposed change",
      }, addDraft("unrelated text survives", "unrelated-source")],
      expectedCursor: null, nextCursor: null,
    }, undefined, options()));
    const deleted = await store.delete(accepted.memoryId, undefined, options());
    assert.equal(deleted.ok, true);
    const bytes = await saved(directory);
    assert.equal(bytes.includes(secret), false);
    assert.equal(bytes.includes(privateUpdate), false);
    assert.equal((await store.inspectMemory(accepted.memoryId)).ok, false);
    const remaining = value(await store.listCandidates({}, undefined, options()));
    assert.deepEqual(remaining.candidates.map((candidate) => candidate.id), [updates.candidateIds[1]]);
    assert.equal((await store.getCandidate(batch.candidateIds[0]!, undefined, options())).ok, false);
    assert.equal((await store.getCandidate(updates.candidateIds[0]!, undefined, options())).ok, false);
  });
});
