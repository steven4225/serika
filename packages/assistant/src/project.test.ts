import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { identifyProject, selectProject } from "./project.js";
import { createTaskTimeSource } from "./context-sources.js";

it("identifies nearest Git/worktree root, explicit folder and no project using metadata", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-project-")));
  try {
    const git = join(root, "repo"), nested = join(git, "src/deep"), worktree = join(root, "worktree");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", "-q", git]);
    execFileSync("git", ["-C", git, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]);
    execFileSync("git", ["-C", git, "worktree", "add", "-q", "-b", "fixture", worktree]);
    await mkdir(join(worktree, "nested"));
    assert.deepEqual(await identifyProject(nested), await identifyProject(git));
    assert.equal((await identifyProject(join(worktree, "nested")))?.directory, worktree);
    assert.notEqual((await identifyProject(git))?.id, (await identifyProject(worktree))?.id);
    const folder = join(root, "plain"); await mkdir(folder);
    assert.equal((await identifyProject(folder))?.kind, "folder");
    assert.equal(await identifyProject(null), null);
    await assert.rejects(identifyProject("relative"), /绝对路径/);
    const sameName = join(root, "other/plain"); await mkdir(sameName, { recursive: true });
    assert.notEqual((await identifyProject(folder))?.id, (await identifyProject(sameName))?.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("restores selection without authorizations and reports a moved or changed selected root before replacing it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-project-selection-")));
  try {
    const dataDirectory = join(root, "home/data"), first = join(root, "first"), second = join(root, "second");
    await mkdir(first); await mkdir(second);
    const config = join(root, "config.json"), before = '{"authorizedDirectories":[]}';
    await writeFile(config, before);
    const chosen = await selectProject({ dataDirectory, directory: first, cwd: second });
    assert.deepEqual(await selectProject({ dataDirectory, cwd: second }), chosen);
    const registry = JSON.parse(await readFile(join(dataDirectory, "projects.json"), "utf8"));
    assert.deepEqual(Object.keys(registry).sort(), ["projects", "selected", "version"]);
    assert.deepEqual(Object.keys(registry.projects[0]).sort(), ["directory", "id", "kind", "name"]);
    await rename(first, join(root, "moved"));
    const beforeMoveRegistry = await readFile(join(dataDirectory, "projects.json"), "utf8");
    for (const directory of [undefined, second, null]) {
      await assert.rejects(selectProject({ dataDirectory, cwd: second, ...(directory !== undefined ? { directory } : {}) }), /项目 first 在 .*first 找不到了；如已移动，运行 .*project-rebind.mjs/);
    }
    assert.equal(await readFile(join(dataDirectory, "projects.json"), "utf8"), beforeMoveRegistry);
    await rename(join(root, "moved"), first);
    const rebound = await selectProject({ dataDirectory, directory: second, cwd: second });
    assert.notEqual(rebound?.id, chosen?.id);
    await selectProject({ dataDirectory, directory: null, cwd: second });
    assert.equal(await selectProject({ dataDirectory, cwd: second }), null);
    assert.equal(await readFile(config, "utf8"), before);
    await selectProject({ dataDirectory, directory: first, cwd: second });
    await mkdir(join(root, ".git"));
    await assert.rejects(selectProject({ dataDirectory, cwd: second }), /找不到了/);

    const context = createTaskTimeSource(rebound).collect({ messages: [], signal: new AbortController().signal, primary: true, now: new Date(), timeZone: "Asia/Shanghai", user: undefined, query: "" });
    assert.match(JSON.stringify(await context), /Host-selected project/);
    assert.match(JSON.stringify(await context), /second/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
