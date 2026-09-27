import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkTuiStartup, readinessExitCode } from "./startup-check.js";

describe("static TUI startup check", () => {
  it("reports temporary identity and unknown external state without creating files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runloom-check-"));
    const before = await import("node:fs/promises").then(({ readdir }) => readdir(cwd));
    const snapshot = await checkTuiStartup([], { cwd, env: {}, now: new Date("2026-01-01T00:00:00Z") });
    const after = await import("node:fs/promises").then(({ readdir }) => readdir(cwd));
    assert.deepEqual(after, before);
    assert.equal(readinessExitCode(snapshot), 0);
    assert.equal(snapshot.checkedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(snapshot.model.connectivity, "not_checked");
    assert.equal(snapshot.worker.state, "unknown");
    assert.equal(snapshot.identity.transcriptDirectory, null);
    assert.equal(snapshot.identity.temporaryThreadOnLaunch, true);
    assert.ok(snapshot.checks.some((check) => check.id === "thread" && check.level === "warning"));
  });

  it("blocks missing model credential and invalid configuration without leaking secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runloom-check-"));
    const invalid = join(cwd, "invalid.json");
    await writeFile(invalid, "{not json}");
    const snapshot = await checkTuiStartup(["--config", invalid], {
      cwd, env: { RUNLOOM_MODEL: "deepseek", DEEPSEEK_API_KEY: " " },
    });
    assert.equal(readinessExitCode(snapshot), 1);
    assert.equal(snapshot.model.credential, "missing");
    assert.ok(snapshot.checks.some((check) => check.id === "config" && check.blocking));
    assert.ok(!JSON.stringify(snapshot).includes("{not json}"));
    assert.equal(await readFile(invalid, "utf8"), "{not json}");
  });

  it("preserves stable explicit identity and rejects a file as transcript directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runloom-check-"));
    await writeFile(join(cwd, "transcript"), "untouched");
    const snapshot = await checkTuiStartup(["transcript", "--thread", "thread-a"], { cwd, env: {} });
    assert.equal(readinessExitCode(snapshot), 1);
    assert.equal(snapshot.identity.threadId, "thread-a");
    assert.equal(snapshot.identity.temporaryDirectoryOnLaunch, false);
    assert.ok(snapshot.checks.some((check) => check.id === "transcript-directory" && check.blocking));
  });

  it("shows configured data locations without creating a store or transcript directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runloom-check-"));
    await mkdir(join(cwd, "workspace"));
    const config = join(cwd, "config.json");
    await writeFile(config, JSON.stringify({
      version: 1,
      workspace: "./workspace",
      modules: { memory: { enabled: true }, checkpoint: { enabled: true }, task: { enabled: true } },
    }));
    const snapshot = await checkTuiStartup(["transcripts", "--thread", "personal", "--config", config], { cwd, env: {} });
    assert.equal(readinessExitCode(snapshot), 0);
    const locations = snapshot.checks.find((check) => check.id === "data-locations")?.message ?? "";
    assert.match(locations, /memory\.json/);
    assert.match(locations, /checkpoint\.json/);
    assert.match(locations, /tasks\.json/);
    assert.ok(snapshot.checks.some((check) => check.id === "transcript-directory" && check.level === "warning"));
    assert.deepEqual(await readdir(join(cwd, "workspace")), []);
    assert.deepEqual((await readdir(cwd)).sort(), ["config.json", "workspace"]);
  });
});
