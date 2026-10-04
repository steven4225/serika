import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireFlock } from "./flock.js";
import { createMemoryStore, type MemoryDocument, type MemoryEntryResult } from "./memory-store.js";
import type { MemoryResult } from "./memory-candidates.js";

const directories: string[] = [];
const privateAt = "2026-10-01T00:00:00.000Z";
const publicAt = "2026-10-02T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-memory-temporal-boundary-"));
  directories.push(directory);
  return directory;
}

function entry(result: MemoryEntryResult) {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.entry;
}

function value<T>(result: MemoryResult<T>): T {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("Memory v4 timestamp and scoped-history boundaries", () => {
  it("uses one real commit timestamp after an update waits for the existing flock", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const saved = entry(await store.add({ text: "before the lock wait" }));
    const held = await acquireFlock(join(directory, ".runloom", "memory.json.lock"));
    let settled = false;
    const update = store.update(saved.id, { expectedRevision: 1, text: "after the lock wait" })
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(settled, false, "the update must actually wait for the held production flock");
    } finally {
      await held.release();
    }
    const updated = entry(await update);
    const document = JSON.parse(await readFile(join(directory, ".runloom", "memory.json"), "utf8")) as MemoryDocument;
    const record = document.entries[0]!;
    const latest = record.assertions.find((assertion) => assertion.assertionId === record.versions.at(-1)!.assertionId)!;
    assert.equal(document.lastWrittenAt, record.updatedAt);
    assert.equal(latest.systemTime.from, record.updatedAt);
    assert.equal(updated.updatedAt, record.updatedAt);
    assert.equal(entry(await createMemoryStore(directory).get(saved.id)).text, "after the lock wait");
  });

  for (const format of ["native", "legacy"] as const) {
    it(`keeps ${format} private Thread history out of explicit scoped temporal reads after publication`, async () => {
      const directory = await workspace();
      const store = createMemoryStore(directory);
      const source = { kind: "conversation" as const, threadId: "thread-a", messageId: "private-source", quote: "PRIVATE_THREAD_A_QUOTE" };
      let id: string;
      if (format === "native") {
        const saved = entry(await store.add({ text: "PRIVATE_THREAD_A_BODY", scope: { kind: "thread", threadId: "thread-a" }, source }, undefined, { boundThreadId: "thread-a", now: new Date(privateAt) }));
        id = saved.id;
        entry(await store.update(id, { expectedRevision: 1, text: "public current body", scope: { kind: "workspace" } }, undefined, { boundThreadId: "thread-a", now: new Date(publicAt) }));
      } else {
        id = "legacy-publication";
        await mkdir(join(directory, ".runloom"));
        await writeFile(join(directory, ".runloom", "memory.json"), JSON.stringify({
          version: 3, candidates: [], consolidationCursors: [], entries: [{
            id, text: "public current body", enabled: true, status: "active", pinned: false,
            scope: { kind: "workspace" }, source: { kind: "manual" }, createdAt: privateAt,
            updatedAt: publicAt, expiresAt: null, revision: 2,
            history: [{ revision: 1, text: "PRIVATE_THREAD_A_BODY", scope: { kind: "thread", threadId: "thread-a" }, source, status: "active", pinned: false, expiresAt: null, changedAt: privateAt }],
          }],
        }));
      }
      const options = { boundThreadId: "thread-b", now: new Date(publicAt) };
      const current = entry(await store.get(id, undefined, options));
      assert.equal(current.text, "public current body");
      assert.equal(current.history?.[0]?.scope.kind, "thread", "legacy-compatible get retains scoped history for its module filter");
      const inspected = value(await store.inspectMemory(id, undefined, options));
      const latest = value(await store.queryMemory(id, {}, undefined, options));
      const past = value(await store.queryMemory(id, { knownAt: privateAt }, undefined, options));
      assert.deepEqual(latest.assertions.map((assertion) => assertion.text), ["public current body"]);
      assert.deepEqual(past.assertions, []);
      assert.equal(inspected.historyCoverage, "legacy_partial");
      for (const result of [inspected, latest, past]) {
        assert.doesNotMatch(JSON.stringify(result), /PRIVATE_THREAD_A_BODY|PRIVATE_THREAD_A_QUOTE|private-source/);
      }
    });
  }

  it("rejects a retracted latest revision that illegally leaves an older assertion open without modifying the file", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const saved = entry(await store.add({ text: "withdraw this old fact", kind: "fact" }, undefined, { now: new Date(privateAt) }));
    entry(await store.reviseMemory({ id: saved.id, expectedRevision: 1, operation: "retract" }, undefined, { now: new Date(publicAt) }));
    const file = join(directory, ".runloom", "memory.json");
    const document = JSON.parse(await readFile(file, "utf8")) as MemoryDocument;
    document.entries[0]!.assertions[0]!.systemTime.to = null;
    const damaged = JSON.stringify(document);
    await writeFile(file, damaged);
    for (const operation of [
      () => store.list(),
      () => store.get(saved.id),
      () => store.inspectMemory(saved.id),
      () => store.queryMemory(saved.id),
      () => store.add({ text: "must not overwrite corrupted memory" }),
      () => store.update(saved.id, { expectedRevision: 2, pinned: true }),
    ]) {
      const result = await operation();
      assert.equal(result.ok, false, "corrupted retraction cannot revive the old fact or permit a mutation");
      assert.equal(await readFile(file, "utf8"), damaged);
    }
  });
});
