import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";

it("switches only project context and restores selection without modifying configured authority", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-desktop-project-")));
  const personal = join(root, "personal"), project = join(root, "serika-v2"), configPath = join(root, "config.json");
  await mkdir(personal); await mkdir(project); await mkdir(join(project, ".git"));
  const config = JSON.stringify({ version: 2, projectDirectory: personal, authorizedDirectories: [{ path: personal, access: "readwrite" }], modules: { memory: { enabled: false }, shell: { enabled: false } } });
  await writeFile(configPath, config);
  let calls = 0;
  const options = { applicationHome: join(root, "home"), cwd: project, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { calls++; throw new Error("unexpected model call"); } }), send() {} };
  let host: DesktopRuntime | undefined;
  try {
    host = await DesktopRuntime.create(options);
    const original = host.info();
    assert.equal(original.project?.directory, personal);
    await host.shutdown(); host = await DesktopRuntime.create(options);
    assert.equal(host.info().project?.directory, personal);
    await host.selectProject(project);
    const selected = host.info();
    assert.equal(selected.project?.directory, project);
    assert.equal(selected.projectDirectory, personal);
    assert.equal(selected.threadId, original.threadId);
    assert.deepEqual(selected.authorizedDirectories, original.authorizedDirectories);
    await host.shutdown(); host = await DesktopRuntime.create(options);
    assert.equal(host.info().project?.directory, project);
    assert.deepEqual(host.info().authorizedDirectories, original.authorizedDirectories);
    await host.selectProject(null);
    assert.equal(host.info().project, null);
    assert.equal(await readFile(configPath, "utf8"), config);
    await host.selectProject(project);
    const registry = join(root, "home/data/projects.json"), saved = await readFile(registry, "utf8");
    await rename(project, join(root, "moved"));
    await assert.rejects(host.selectProject(personal), /项目 serika-v2 在 .*serika-v2 找不到了；如已移动，运行 .*project-rebind.mjs/);
    assert.equal(await readFile(registry, "utf8"), saved);
    await host.shutdown(); host = undefined;
    await assert.rejects(DesktopRuntime.create(options), /项目 serika-v2 在 .*找不到了/);
    assert.equal(await readFile(registry, "utf8"), saved);
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.equal(calls, 0);
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it("starts without a project when configuration has none and preserves an explicit null across restart", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-desktop-default-project-")));
  const personal = join(root, "personal"), release = join(root, "release"), configPath = join(root, "config.json");
  await mkdir(personal); await mkdir(join(release, ".git"), { recursive: true });
  const options = { applicationHome: join(root, "home"), cwd: release, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { throw new Error("unexpected model call"); } }), send() {} };
  let host: DesktopRuntime | undefined;
  try {
    await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: personal, access: "readwrite" }], modules: { memory: { enabled: false }, shell: { enabled: false } } }));
    host = await DesktopRuntime.create(options);
    assert.equal(host.info().project, null);
    await host.shutdown(); host = undefined;
    const config = JSON.parse(await readFile(configPath, "utf8")); config.projectDirectory = personal;
    await writeFile(configPath, JSON.stringify(config));
    host = await DesktopRuntime.create(options);
    assert.equal(host.info().project, null);
    await host.shutdown(); host = undefined;
    const registry = join(options.applicationHome, "data/projects.json");
    await writeFile(registry, JSON.stringify({ version: 1, projects: [], selected: "missing-project" }));
    host = await DesktopRuntime.create(options);
    assert.equal(host.info().project?.directory, personal);
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
