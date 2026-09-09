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
    assert.deepEqual(await store.update(first.entry.id, { text: "use pnpm 11" }), {
      ok: true,
      entry: { ...first.entry, text: "use pnpm 11" },
    });
    assert.deepEqual(await store.delete(second.entry.id), {
      ok: true,
      id: second.entry.id,
    });

    const reopened = createMemoryStore(directory);
    assert.deepEqual(await reopened.list(), {
      ok: true,
      entries: [{ ...first.entry, text: "use pnpm 11" }],
    });
  });

  it("enforces text, context, and entry-count limits without partial writes", async () => {
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
    assert.equal(errorCode(tooLarge), "MEMORY_CONTEXT_TOO_LARGE");
    const current = await store.list();
    assert.equal(current.ok, true);
    if (!current.ok) return;
    assert.equal(current.entries.length, 3);
    assert.equal(
      JSON.stringify(current.entries).includes("d".repeat(MEMORY_ENTRY_MAX_BYTES)),
      false,
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

    await writeFile(file, JSON.stringify({ version: 2, entries: [] }));
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
});
