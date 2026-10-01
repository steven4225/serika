import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  MEMORY_CONTEXT_MAX_BYTES,
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_MAX_ENTRIES,
  createMemoryStore,
  isMemoryEntryActive,
  isMemoryEntryExpired,
  type MemoryEntryResult,
} from "./memory-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "runloom-memory-"));
  directories.push(directory);
  return directory;
}

function errorCode(result: MemoryEntryResult | { ok: true; entries: unknown[] }): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("WorkspaceMemoryStore", () => {
  it("does not create the memory file on read, then persists ordered CRUD across reopen", async () => {
    const directory = await workspace();
    const file = join(directory, ".runloom", "memory.json");
    const store = createMemoryStore(directory);

    assert.deepEqual(await store.list(), { ok: true, entries: [] });
    await assert.rejects(readFile(file), { code: "ENOENT" });

    const first = await store.add({ text: "use pnpm" });
    const second = await store.add({ text: "check tests", enabled: false });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.deepEqual(await store.list(), {
      ok: true,
      entries: [first.entry, second.entry],
    });
    const updated = await store.update(first.entry.id, { text: "use pnpm 11", expectedRevision: 1 });
    assert.equal(updated.ok, true);
    if (updated.ok) {
      assert.equal(updated.entry.text, "use pnpm 11");
      assert.equal(updated.entry.revision, 2);
      assert.equal(updated.entry.history?.length, 1);
    }
    assert.deepEqual(await store.delete(second.entry.id), {
      ok: true,
      id: second.entry.id,
    });

    const reopened = createMemoryStore(directory);
    const reopenedList = await reopened.list();
    assert.equal(reopenedList.ok, true);
    if (reopenedList.ok) {
      assert.equal(reopenedList.entries.length, 1);
      assert.equal(reopenedList.entries[0]?.text, "use pnpm 11");
      assert.equal(reopenedList.entries[0]?.revision, 2);
    }
  });

  it("enforces text and entry-count limits independently of injection budget", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);

    assert.equal(errorCode(await store.add({ text: "  " })), "MEMORY_TEXT_EMPTY");
    assert.equal(
      errorCode(await store.add({ text: "x".repeat(MEMORY_ENTRY_MAX_BYTES + 1) })),
      "MEMORY_TEXT_TOO_LARGE",
    );

    const first = await store.add({ text: "a".repeat(MEMORY_ENTRY_MAX_BYTES) });
    const second = await store.add({ text: "b".repeat(MEMORY_ENTRY_MAX_BYTES) });
    const third = await store.add({ text: "c".repeat(MEMORY_ENTRY_MAX_BYTES) });
    assert.equal(first.ok && second.ok && third.ok, true);
    const tooLarge = await store.add({ text: "d".repeat(MEMORY_ENTRY_MAX_BYTES) });
    assert.equal(tooLarge.ok, true);
    const current = await store.list();
    assert.equal(current.ok, true);
    if (!current.ok) return;
    assert.equal(current.entries.length, 4);
    assert.equal(
      JSON.stringify(current.entries).includes("d".repeat(MEMORY_ENTRY_MAX_BYTES)),
      true,
    );
    assert.equal(MEMORY_CONTEXT_MAX_BYTES, 8_192);

    const cappedDirectory = await workspace();
    await mkdir(join(cappedDirectory, ".runloom"));
    await writeFile(
      join(cappedDirectory, ".runloom", "memory.json"),
      JSON.stringify({
        version: 1,
        entries: Array.from({ length: MEMORY_MAX_ENTRIES }, (_, index) => ({
          id: `entry-${index}`,
          text: "x",
          enabled: false,
        })),
      }),
    );
    const capped = createMemoryStore(cappedDirectory);
    assert.equal(errorCode(await capped.add({ text: "one too many" })), "MEMORY_LIMIT_EXCEEDED");
    const unchanged = await capped.list();
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) assert.equal(unchanged.entries.length, MEMORY_MAX_ENTRIES);
  });

  it("reports malformed, unsupported, duplicate, and symlinked storage instead of treating it as empty", async () => {
    const directory = await workspace();
    const runloom = join(directory, ".runloom");
    await mkdir(runloom);
    const file = join(runloom, "memory.json");
    const store = createMemoryStore(directory);

    await writeFile(file, "not-json");
    const malformed = await store.list();
    assert.equal(malformed.ok ? undefined : malformed.error.code, "MEMORY_FILE_INVALID");

    await writeFile(file, JSON.stringify({ version: 4, entries: [] }));
    const unsupported = await store.list();
    assert.equal(unsupported.ok ? undefined : unsupported.error.code, "MEMORY_VERSION_UNSUPPORTED");

    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { id: "same", text: "one", enabled: true },
          { id: "same", text: "two", enabled: true },
        ],
      }),
    );
    const duplicate = await store.list();
    assert.equal(duplicate.ok ? undefined : duplicate.error.code, "MEMORY_ENTRY_INVALID");

    const symlinked = await workspace();
    const target = await workspace();
    await symlink(join(target, ".runloom"), join(symlinked, ".runloom"));
    const symlinkStore = createMemoryStore(symlinked);
    const symlinkResult = await symlinkStore.list();
    assert.equal(symlinkResult.ok ? undefined : symlinkResult.error.code, "SYMLINK_NOT_ALLOWED");
    const symlinkWrite = await symlinkStore.add({ text: "must not write" });
    assert.equal(symlinkWrite.ok ? undefined : symlinkWrite.error.code, "SYMLINK_NOT_ALLOWED");
  });

  it("normalizes v1 on read and upgrades the file on the first mutation", async () => {
    const directory = await workspace();
    const runloom = join(directory, ".runloom");
    await mkdir(runloom);
    const file = join(runloom, "memory.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      entries: [{ id: "legacy", text: "keep pnpm", enabled: true }],
    }));
    const store = createMemoryStore(directory);

    const listed = await store.list();
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.deepEqual(listed.entries[0], {
      id: "legacy",
      pinned: false,
      text: "keep pnpm",
      enabled: true,
      status: "active",
      scope: { kind: "workspace" },
      source: { kind: "legacy" },
      createdAt: null,
      updatedAt: null,
      expiresAt: null,
      revision: 1,
      history: [],
    });
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);

    const added = await store.add({ text: "run tests" });
    assert.equal(added.ok, true);
    assert.equal(JSON.parse(await readFile(file, "utf8")).version, 3);
    const reopened = await createMemoryStore(directory).list();
    assert.equal(reopened.ok, true);
    if (reopened.ok) assert.equal(reopened.entries.find((entry) => entry.id === "legacy")?.source?.kind, "legacy");
  });

  it("stores scope, lifecycle fields, expiry, and bounded revision history", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const added = await store.add({
      text: "thread preference",
      scope: { kind: "thread", threadId: "thread-a" },
      expiresAt,
    });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.entry.status, "active");
    assert.equal(added.entry.source?.kind, "manual");
    assert.equal(added.entry.revision, 1);
    assert.equal(isMemoryEntryExpired(added.entry), false);
    assert.equal(isMemoryEntryActive(added.entry), true);

    const disabled = await store.update(added.entry.id, { status: "disabled", expectedRevision: 1 });
    assert.equal(disabled.ok, true);
    if (!disabled.ok) return;
    assert.equal(disabled.entry.enabled, false);
    assert.equal(disabled.entry.revision, 2);
    assert.equal(isMemoryEntryActive(disabled.entry), false);

    const conflict = await store.update(added.entry.id, { text: "stale", expectedRevision: 1 });
    assert.equal(errorCode(conflict), "MEMORY_REVISION_CONFLICT");
    const reenabled = await store.update(added.entry.id, { status: "active", expiresAt: null, expectedRevision: 2 });
    assert.equal(reenabled.ok, true);
    if (reenabled.ok) {
      assert.equal(reenabled.entry.revision, 3);
      assert.equal(reenabled.entry.history?.length, 2);
      assert.equal(reenabled.entry.expiresAt, null);
    }

    const expired = await store.update(added.entry.id, { expiresAt: new Date(Date.now() - 1_000).toISOString(), expectedRevision: 3 });
    assert.equal(expired.ok, true);
    if (!expired.ok) return;
    assert.equal(isMemoryEntryExpired(expired.entry), true);
    const invalidEnable = await store.update(added.entry.id, { status: "active", expectedRevision: 4 });
    assert.equal(errorCode(invalidEnable), "MEMORY_EXPIRED");
  });

  it("round-trips verified conversation provenance through updates and revision history", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const firstSource = { kind: "conversation" as const, threadId: "thread-a", messageId: "user-1", quote: "single-agent" };
    const nextSource = { kind: "conversation" as const, threadId: "thread-a", messageId: "user-2", quote: "multi-agent" };
    const added = await store.add({ text: "Prefer single-agent design", source: firstSource });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.deepEqual(added.entry.source, firstSource);

    const preserved = await store.update(added.entry.id, { status: "disabled", expectedRevision: 1 });
    assert.equal(preserved.ok, true);
    if (!preserved.ok) return;
    assert.deepEqual(preserved.entry.source, firstSource);

    const manualCorrection = await store.update(added.entry.id, { text: "Prefer one agent", expectedRevision: 2 });
    assert.equal(manualCorrection.ok, true);
    if (!manualCorrection.ok) return;
    assert.deepEqual(manualCorrection.entry.source, { kind: "manual" });

    const revised = await store.update(added.entry.id, {
      text: "Multi-agent is now allowed",
      source: nextSource,
      expectedRevision: 3,
    });
    assert.equal(revised.ok, true);
    if (!revised.ok) return;
    assert.deepEqual(revised.entry.source, nextSource);
    assert.deepEqual(revised.entry.history?.map((revision) => revision.source), [firstSource, firstSource, { kind: "manual" }]);

    const reopened = await createMemoryStore(directory).get(added.entry.id);
    assert.equal(reopened.ok, true);
    if (!reopened.ok) return;
    assert.deepEqual(reopened.entry.source, nextSource);
    assert.deepEqual(reopened.entry.history?.map((revision) => revision.source), [firstSource, firstSource, { kind: "manual" }]);
    assert.equal(JSON.parse(await readFile(join(directory, ".runloom", "memory.json"), "utf8")).version, 3);
  });

  it("rejects malformed or forged conversation source without changing stored memory", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = await store.add({ text: "stable memory" });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    assert.equal(errorCode(await store.add({
      text: "unattributed",
      source: { kind: "conversation", threadId: "thread-a", messageId: "user-1", quote: " " },
    })), "MEMORY_SOURCE_INVALID");
    assert.equal(errorCode(await store.add({ text: "not legacy", source: { kind: "legacy" } })), "MEMORY_SOURCE_INVALID");
    assert.equal(errorCode(await store.update(added.entry.id, {
      expectedRevision: 1,
      source: { kind: "legacy" },
    })), "MEMORY_SOURCE_INVALID");
    const unchanged = await store.get(added.entry.id);
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) assert.equal(unchanged.entry.revision, 1);

    const file = join(directory, ".runloom", "memory.json");
    const document = JSON.parse(await readFile(file, "utf8"));
    document.entries[0].source = { kind: "conversation", threadId: "thread-a" };
    await writeFile(file, JSON.stringify(document));
    const malformed = await store.list();
    assert.equal(malformed.ok ? undefined : malformed.error.code, "MEMORY_SOURCE_INVALID");
  });

  it("serializes concurrent updates and rejects the stale revision", async () => {
    const directory = await workspace();
    const storeA = createMemoryStore(directory);
    const storeB = createMemoryStore(directory);
    const added = await storeA.add({ text: "initial" });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    const results = await Promise.all([
      storeA.update(added.entry.id, { text: "from a", expectedRevision: 1 }),
      storeB.update(added.entry.id, { text: "from b", expectedRevision: 1 }),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok && result.error.code === "MEMORY_REVISION_CONFLICT").length, 1);
    const final = await storeA.get(added.entry.id);
    assert.equal(final.ok, true);
    if (final.ok) assert.equal(final.entry.revision, 2);
  });

  it("does not let other threads or expired entries consume the injection budget", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    for (const text of ["a", "b", "c"]) {
      const added = await store.add({
        text: text.repeat(MEMORY_ENTRY_MAX_BYTES),
        scope: { kind: "thread", threadId: "thread-b" },
      });
      assert.equal(added.ok, true);
    }
    const expired = await store.add({
      text: "d".repeat(MEMORY_ENTRY_MAX_BYTES),
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    assert.equal(expired.ok, true);

    const workspaceAdd = await store.add(
      { text: "current workspace rule" },
      undefined,
      { boundThreadId: "thread-a" },
    );
    assert.equal(workspaceAdd.ok, true);

    const sameView = await store.add(
      { text: "e".repeat(MEMORY_ENTRY_MAX_BYTES), scope: { kind: "thread", threadId: "thread-b" } },
      undefined,
      { boundThreadId: "thread-b" },
    );
    assert.equal(sameView.ok, true);
  });

  it("rejects changes to another thread and uses the caller clock for expiry", async () => {
    const directory = await workspace();
    const store = createMemoryStore(directory);
    const added = await store.add({
      text: "thread preference",
      scope: { kind: "thread", threadId: "thread-b" },
      status: "disabled",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal(added.ok, true);
    if (!added.ok) return;

    const crossThread = await store.update(
      added.entry.id,
      { text: "rewritten", expectedRevision: 1 },
      undefined,
      { boundThreadId: "thread-a" },
    );
    assert.equal(errorCode(crossThread), "MEMORY_ENTRY_INVALID");
    const crossDelete = await store.delete(added.entry.id, undefined, { boundThreadId: "thread-a" });
    assert.equal(crossDelete.ok, false);
    if (!crossDelete.ok) assert.equal(crossDelete.error.code, "MEMORY_ENTRY_INVALID");

    const later = new Date("2099-06-01T00:00:00.000Z");
    const expiredEnable = await store.update(
      added.entry.id,
      { status: "active", expectedRevision: 1 },
      undefined,
      { boundThreadId: "thread-b", now: later },
    );
    assert.equal(errorCode(expiredEnable), "MEMORY_EXPIRED");
    const unchanged = await store.get(added.entry.id);
    assert.equal(unchanged.ok, true);
    if (unchanged.ok) assert.equal(unchanged.entry.revision, 1);
  });
});
