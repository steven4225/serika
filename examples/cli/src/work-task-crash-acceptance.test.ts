import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crashFixtureAllows, runWorkTaskCrashAcceptance, verifyCrashArtifactAbsent } from "./work-task-crash-acceptance.js";

test("post-recovery absence check fails on a created file or dangling symlink", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "runloom-crash-absence-"));
  const path = join(workspace, "notes/crash-note.md");
  try {
    await mkdir(join(workspace, "notes"));
    assert.deepEqual(await verifyCrashArtifactAbsent(workspace),
      { path: "notes/crash-note.md", exists: false, checkedWith: "lstat" });
    await writeFile(path, "unexpected side effect");
    await assert.rejects(verifyCrashArtifactAbsent(workspace), { name: "AssertionError" });
    await rm(path);
    await symlink("missing-target.md", path);
    await assert.rejects(verifyCrashArtifactAbsent(workspace), { name: "AssertionError" });
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("crash fixture never grants Shell, foreign paths or replayed write on continuation", () => {
  assert.equal(crashFixtureAllows("write_file", { path: "notes/crash-note.md" }, false), true);
  assert.equal(crashFixtureAllows("write_file", { path: "notes/crash-note.md" }, true), false);
  for (const tool of ["read_file", "edit_file"]) assert.equal(crashFixtureAllows(tool, { path: "notes/crash-note.md" }, true), true);
  for (const path of ["protected/sentinel.txt", "../notes/crash-note.md", "/tmp/crash-note.md", "notes/other.md"])
    assert.equal(crashFixtureAllows("write_file", { path }, false), false);
  assert.equal(crashFixtureAllows("shell_exec", { path: "notes/crash-note.md" }, true), false);
});

test("real process kills preserve not_started/unknown/completed and never replay during recovery (scripted model)",
  { timeout: 30_000, skip: !["darwin", "linux"].includes(process.platform) }, async () => {
    const report = await runWorkTaskCrashAcceptance({ model: "scripted" });
    try {
      assert.equal(report.passed, true, JSON.stringify(report));
      for (const { scenario } of report.results) {
        const root = join(report.root, scenario);
        const recovered = JSON.parse(await readFile(join(root, "recovered-state.json"), "utf8"));
        const exit = JSON.parse(await readFile(join(root, "process-exit.json"), "utf8"));
        assert.equal(exit.signal, "SIGKILL"); assert.equal(recovered.modelRequests, 0);
        const after = JSON.parse(await readFile(join(root, "after-report.json"), "utf8"));
        assert.equal(after.task.acceptance.find((c: { id: string }) => c.id === "quality").status, "not_run");
        if (scenario === "before-dispatch") {
          const absence = { path: "notes/crash-note.md", exists: false, checkedWith: "lstat" };
          assert.deepEqual(recovered.artifactAbsence, absence); assert.deepEqual(after.artifactAbsence, absence);
          await verifyCrashArtifactAbsent(join(root, "workspace"));
        }
        if (scenario === "unrecorded-write") {
          assert.equal(after.oldReceipt.tools[0].status, "unknown");
          assert.equal(after.task.status, "awaiting_acceptance"); assert.equal(after.task.runIds.length, 2);
        } else assert.equal(after.modelRequests, 0);
      }
    } finally { await rm(report.root, { recursive: true, force: true }); }
  });
