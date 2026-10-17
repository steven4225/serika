import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readinessExitCode } from "@serika/assistant";
import { createBuiltinSkill } from "@serika/assistant/testing";
import { checkTuiStartup } from "./startup-check.js";

async function automationFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "runloom-automation-check-"));
  const workspace = join(cwd, "workspace");
  const directory = join(cwd, "trusted-skill");
  const config = join(cwd, "config.json");
  const instructions = "Summarize only the supplied input.";
  const manifest = { version: 1, id: "brief", description: "Text brief", kind: "text" as const };
  await Promise.all([mkdir(workspace), mkdir(directory)]);
  await writeFile(join(directory, "skill.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "SKILL.md"), instructions);
  await writeFile(join(workspace, "sentinel.txt"), "existing workspace data");
  const hash = createBuiltinSkill({ ...manifest, instructions }).hash;
  const registration = { id: manifest.id, directory, expectedHash: hash };
  const writeConfig = async (automation: unknown) => writeFile(config, JSON.stringify({ version: 1, workspace,
    modules: { memory: { enabled: true, autoConsolidate: true }, checkpoint: { enabled: true }, task: { enabled: true } },
    automation }));
  return { cwd, workspace, directory, config, registration, writeConfig,
    cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

/** Directory membership, exact bytes and write timestamps detect static-check mutations. */
async function directorySnapshot(root: string) {
  const entries = (await readdir(root, { recursive: true })).sort();
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry);
    const info = await stat(path);
    if (info.isFile()) files.push({ path: entry, bytes: (await readFile(path)).toString("hex"), modifiedAt: info.mtimeMs });
  }
  return { entries, files };
}

describe("static TUI startup check", () => {
  for (const scenario of ["unknown-hook", "missing-package", "wrong-hash"] as const) {
    it(`rejects ${scenario} during static automation validation without writing files`, async () => {
      const f = await automationFixture();
      try {
        const registration = scenario === "missing-package"
          ? { ...f.registration, directory: join(f.cwd, "missing-package") }
          : scenario === "wrong-hash"
            ? { ...f.registration, expectedHash: (f.registration.expectedHash[0] === "0" ? "1" : "0") + f.registration.expectedHash.slice(1) }
            : f.registration;
        await f.writeConfig({ skills: [registration], hooks: scenario === "unknown-hook" ? [{
          id: "unregistered-handler", event: "primary.completed", handler: { type: "skill", id: "not-registered" },
        }] : [] });
        const before = await directorySnapshot(f.cwd);
        const snapshot = await checkTuiStartup(["transcripts", "--thread", "personal", "--config", f.config], { cwd: f.cwd, env: {} });
        assert.equal(readinessExitCode(snapshot), 1);
        const failure = snapshot.checks.find(check => check.id === "config" && check.blocking);
        assert.ok(failure);
        assert.match(failure.message, scenario === "unknown-hook" ? /Unknown hook skill not-registered/
          : scenario === "missing-package" ? /Cannot load Skill brief.*ENOENT/ : /Skill hash mismatch/);
        assert.equal(snapshot.checks.some(check => check.id === "config" && check.level === "ok"), false);
        assert.deepEqual(await directorySnapshot(f.cwd), before);
      } finally { await f.cleanup(); }
    });
  }

  it("validates a pinned package and explicit hooks: [] without writing workspace, transcripts or package files", async () => {
    const f = await automationFixture();
    try {
      await f.writeConfig({ skills: [f.registration], hooks: [] });
      const existingTranscripts = join(f.cwd, "existing-transcripts");
      await mkdir(existingTranscripts);
      await writeFile(join(existingTranscripts, "personal.jsonl"), "existing transcript sentinel\n");
      for (const transcriptDirectory of ["missing-transcripts", "existing-transcripts"]) {
        const before = await directorySnapshot(f.cwd);
        const snapshot = await checkTuiStartup([transcriptDirectory, "--thread", "personal", "--config", f.config], { cwd: f.cwd, env: {} });
        assert.equal(readinessExitCode(snapshot), 0);
        const automation = snapshot.checks.find(check => check.id === "automation");
        assert.equal(automation?.level, "ok");
        assert.match(automation!.message, /2 registered Skills; 0 enabled Hook rules/);
        assert.match(automation!.message, /nothing executed/);
        assert.equal(snapshot.identity.threadId, "personal");
        assert.equal(snapshot.model.connectivity, "not_checked");
        assert.deepEqual(await directorySnapshot(f.cwd), before);
      }
    } finally { await f.cleanup(); }
  });

  it("checks Computer config without launching the configured executable", { skip: process.platform !== "darwin" }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "runloom-computer-check-"));
    const executable = join(cwd, "driver");
    await writeFile(executable, "not even an executable; must never be launched by --check");
    const config = join(cwd, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, modules: { computer: { enabled: true, executable, allowedBundleIds: ["com.apple.TextEdit"] } } }));
    const snapshot = await checkTuiStartup(["--config", config], { cwd, env: {} });
    assert.equal(readinessExitCode(snapshot), 0);
    assert.match(snapshot.checks.find((c) => c.id === "computer")!.message, /does not launch/);
    assert.deepEqual((await readdir(cwd)).sort(), ["config.json", "driver"]);
  });
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
