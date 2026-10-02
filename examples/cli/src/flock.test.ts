import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireFlock, tryAcquireFlock } from "./flock.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("tryAcquireFlock", () => {
  it("starts the holder in Node mode when embedded in Electron", async () => {
    const previous = Object.getOwnPropertyDescriptor(process.versions, "electron");
    Object.defineProperty(process.versions, "electron", { value: "test", configurable: true });
    const directory = await mkdtemp(join(tmpdir(), "runloom-electron-flock-"));
    directories.push(directory);
    try {
      const held = await acquireFlock(join(directory, "lock"));
      try { assert.equal(await tryAcquireFlock(join(directory, "lock")), null); }
      finally { await held.release(); }
    } finally {
      if (previous) Object.defineProperty(process.versions, "electron", previous);
      else delete (process.versions as Record<string, string | undefined>).electron;
    }
  });

  it("returns null when the lock is already held", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-flock-"));
    directories.push(directory);
    const path = join(directory, "lock");
    const held = await acquireFlock(path);
    try {
      assert.equal(await tryAcquireFlock(path), null);
    } finally {
      await held.release();
    }
  });
});
