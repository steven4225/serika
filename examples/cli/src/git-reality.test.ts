import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inspectGitReality, reconcileGitReality, type GitRealityPin } from "./git-reality.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runloom-git-reality-"));
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Serika Test");
  await writeFile(join(root, "note.txt"), "initial\n");
  git(root, "add", "note.txt");
  git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

async function commit(root: string, text: string): Promise<void> {
  await writeFile(join(root, "note.txt"), `${text}\n`);
  git(root, "add", "note.txt");
  git(root, "commit", "--quiet", "-m", text);
}

async function pinAt(root: string): Promise<GitRealityPin> {
  const result = await inspectGitReality(root);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Git inspection failed");
  return result.pin;
}

describe("Git reality inspection", () => {
  it("captures HEAD, branch and dirty state only for the workspace's own repository", async () => {
    const root = await repository();
    try {
      const clean = await pinAt(root);
      assert.equal(clean.head, git(root, "rev-parse", "HEAD"));
      assert.equal(clean.branch, "main");
      assert.equal(clean.dirty, false);
      assert.ok(Number.isFinite(Date.parse(clean.observedAt)));

      await writeFile(join(root, "untracked.txt"), "new\n");
      assert.equal((await pinAt(root)).dirty, true);
      const nested = join(root, "nested");
      await mkdir(nested);
      assert.deepEqual(await inspectGitReality(nested), { ok: false, reason: "not_git_repository" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores only untracked Serika checkpoint bookkeeping, not tracked changes", async () => {
    const root = await repository();
    try {
      await mkdir(join(root, ".runloom"));
      await writeFile(join(root, ".runloom", "checkpoint.json"), "v1\n");
      await writeFile(join(root, ".runloom", "checkpoint.json.lock"), "");
      assert.equal((await pinAt(root)).dirty, false);
      await writeFile(join(root, ".runloom", "other.json"), "other\n");
      assert.equal((await pinAt(root)).dirty, true);
      await rm(join(root, ".runloom", "other.json"));
      git(root, "add", ".runloom/checkpoint.json");
      git(root, "commit", "--quiet", "-m", "track checkpoint");
      assert.equal((await pinAt(root)).dirty, false);
      await writeFile(join(root, ".runloom", "checkpoint.json"), "v2\n");
      assert.equal((await pinAt(root)).dirty, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects symlinked Git metadata but accepts an ordinary linked-worktree .git file", async () => {
    const root = await repository();
    const linked = await mkdtemp(join(tmpdir(), "runloom-git-worktree-"));
    const symlinkRoot = await mkdtemp(join(tmpdir(), "runloom-git-symlink-"));
    try {
      git(root, "worktree", "add", "--detach", linked);
      assert.equal((await inspectGitReality(linked)).ok, true);
      await symlink(join(root, ".git"), join(symlinkRoot, ".git"));
      assert.deepEqual(await inspectGitReality(symlinkRoot), { ok: false, reason: "symlink" });
    } finally {
      git(root, "worktree", "remove", "--force", linked);
      await rm(root, { recursive: true, force: true });
      await rm(linked, { recursive: true, force: true });
      await rm(symlinkRoot, { recursive: true, force: true });
    }
  });

  it("treats an equal clean HEAD as consistent, but does not equate dirty booleans with identical files", async () => {
    const root = await repository();
    try {
      const pin = await pinAt(root);
      assert.equal((await reconcileGitReality(root, pin)).status, "consistent");
      await writeFile(join(root, "untracked.txt"), "first\n");
      assert.equal((await reconcileGitReality(root, pin)).status, "diverged");
      const dirtyPin = await pinAt(root);
      await writeFile(join(root, "untracked.txt"), "second\n");
      assert.deepEqual(
        {
          status: (await reconcileGitReality(root, dirtyPin)).status,
          reason: (await reconcileGitReality(root, dirtyPin)).reason,
        },
        { status: "insufficient_evidence", reason: "dirty_unverifiable" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies branch-only changes, descendant commits, non-ancestor commits and unknown pins", async () => {
    const root = await repository();
    try {
      const pin = await pinAt(root);
      git(root, "switch", "--quiet", "-c", "same-head");
      assert.equal((await reconcileGitReality(root, pin)).status, "diverged");

      await commit(root, "descendant");
      const stale = await reconcileGitReality(root, pin);
      assert.equal(stale.status, "stale");
      assert.equal(stale.pin?.head, pin.head);
      assert.equal(stale.current?.head, git(root, "rev-parse", "HEAD"));

      git(root, "switch", "--quiet", "main");
      await commit(root, "sibling");
      assert.equal((await reconcileGitReality(root, { ...pin, head: stale.current?.head ?? "" })).status, "diverged");
      assert.deepEqual(
        {
          status: (await reconcileGitReality(root, { ...pin, head: "0".repeat(40) })).status,
          reason: (await reconcileGitReality(root, { ...pin, head: "0".repeat(40) })).reason,
        },
        { status: "insufficient_evidence", reason: "unknown_pin" },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing pin and cancellation without inventing a comparison", async () => {
    const root = await repository();
    try {
      const missing = await reconcileGitReality(root);
      assert.equal(missing.status, "insufficient_evidence");
      assert.equal(missing.reason, "missing_pin");
      assert.equal(missing.current?.head, git(root, "rev-parse", "HEAD"));

      const controller = new AbortController();
      controller.abort();
      assert.deepEqual(await inspectGitReality(root, controller.signal), { ok: false, reason: "cancelled" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
