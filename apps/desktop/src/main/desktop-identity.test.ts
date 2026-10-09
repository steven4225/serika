import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDesktopThread, listDesktopThreads, registerDesktopThread, resolveDesktopIdentity, selectDesktopThread } from "./desktop-identity.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "runloom-desktop-identity-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function options(root: string) {
  return { userData: join(root, "userData"), configPath: join(root, "config.json"), workspaceRoot: join(root, "workspace"), cwd: root, env: {} };
}

describe("desktop startup identity", () => {
  it("persists one identity and reuses it across full process starts", async () => fixture(async (root) => {
    const first = await resolveDesktopIdentity(options(root));
    const second = await resolveDesktopIdentity(options(root));
    assert.deepEqual(second, first);
    assert.equal(first.identitySource, "saved");
    const stored = JSON.parse(await readFile(join(root, "userData", "desktop-identity.json"), "utf8"));
    assert.equal(stored.profiles[0].activeThreadId, first.threadId);
    assert.equal(stored.identitySource, undefined);
  }));

  it("uses a new thread on config/workspace changes and preserves old transcripts", async () => fixture(async (root) => {
    const first = await resolveDesktopIdentity(options(root));
    await mkdir(first.transcriptDirectory, { recursive: true });
    await writeFile(join(first.transcriptDirectory, "sentinel"), "old conversation");
    const changedWorkspace = await resolveDesktopIdentity({ ...options(root), workspaceRoot: join(root, "other") });
    assert.notEqual(changedWorkspace.threadId, first.threadId);
    const changedConfig = await resolveDesktopIdentity({ ...options(root), configPath: join(root, "other-config.json") });
    assert.notEqual(changedConfig.threadId, changedWorkspace.threadId);
    assert.equal(await readFile(join(first.transcriptDirectory, "sentinel"), "utf8"), "old conversation");
    assert.deepEqual(await resolveDesktopIdentity(options(root)), first);
  }));

  it("migrates the legacy preference without losing its Thread and retains new selections", async () => fixture(async root => {
    await mkdir(join(root, "userData"));
    const legacy = { version: 1, configPath: join(root, "config.json"), workspaceRoot: join(root, "workspace"), threadId: "personal", transcriptDirectory: join(root, "old-transcripts") };
    const path = join(root, "userData", "desktop-identity.json");
    await writeFile(path, JSON.stringify(legacy));
    assert.equal((await resolveDesktopIdentity(options(root))).threadId, "personal");
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1, "read-only reuse does not rewrite preferences");
    const next = await createDesktopThread(options(root));
    await selectDesktopThread(options(root), next.threadId);
    assert.equal((await resolveDesktopIdentity(options(root))).threadId, next.threadId);
    assert.deepEqual((await listDesktopThreads(options(root))).map(thread => thread.threadId), ["personal", next.threadId]);
    await assert.rejects(selectDesktopThread({ ...options(root), workspaceRoot: join(root, "other") }, "personal"), /not registered/);
    await assert.rejects(registerDesktopThread(options(root), { threadId: "personal", transcriptDirectory: join(root, "wrong-directory") }), /different directory/);
  }));

  it("honors explicit overrides without replacing the saved normal identity", async () => fixture(async (root) => {
    const normal = await resolveDesktopIdentity(options(root));
    const path = join(root, "userData", "desktop-identity.json");
    const before = await readFile(path, "utf8");
    const explicit = await resolveDesktopIdentity({ ...options(root), env: { RUNLOOM_THREAD: "acceptance", RUNLOOM_TRANSCRIPTS: "acceptance-transcripts" } });
    assert.equal(explicit.threadId, "acceptance");
    assert.equal(explicit.transcriptDirectory, join(root, "acceptance-transcripts"));
    assert.equal(explicit.identitySource, "explicit");
    const partial = await resolveDesktopIdentity({ ...options(root), env: { RUNLOOM_THREAD: "other" } });
    assert.equal(partial.transcriptDirectory, normal.transcriptDirectory);
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await resolveDesktopIdentity(options(root)), normal);
  }));

  it("keeps a partial explicit first launch stable without creating a saved profile", async () => fixture(async (root) => {
    const input = { ...options(root), env: { RUNLOOM_TRANSCRIPTS: "explicit" } };
    const first = await resolveDesktopIdentity(input);
    assert.deepEqual(await resolveDesktopIdentity(input), first);
    await assert.rejects(readFile(join(root, "userData", "desktop-identity.json")), { code: "ENOENT" });
    const normal = await resolveDesktopIdentity(options(root));
    assert.notEqual(normal.threadId, first.threadId);
  }));

  it("refuses invalid, unreadable, and malformed identity files rather than resetting", async () => fixture(async (root) => {
    await mkdir(join(root, "userData"));
    const path = join(root, "userData", "desktop-identity.json");
    for (const content of ["{", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, configPath: "relative", workspaceRoot: null, transcriptDirectory: "relative", threadId: "x" })]) {
      await writeFile(path, content);
      await assert.rejects(resolveDesktopIdentity(options(root)), /refusing to reset/);
      assert.equal(await readFile(path, "utf8"), content);
    }
    await rm(path);
    await mkdir(path);
    await assert.rejects(resolveDesktopIdentity(options(root)), /refusing to reset/);
  }));
});
