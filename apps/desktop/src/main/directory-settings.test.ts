import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { changeDirectorySettings } from "./module-settings.js";

it("saves directory permissions with CAS, keeps the project base, and persists removal", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-directory-settings-")));
  try {
    const first = join(root, "first"), second = join(root, "second"); await mkdir(first); await mkdir(second);
    const path = join(root, "config.json"), original = [{ path: first, access: "readwrite" as const }];
    const before = JSON.stringify({ version: 2, projectDirectory: first, authorizedDirectories: original, modules: {} }); await writeFile(path, before);
    const directories = [...original, { path: second, access: "read" as const }];
    const undo = await changeDirectorySettings(path, { directories, expectedDirectories: original }, { cwd: root });
    const changed = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(changed.authorizedDirectories, directories); assert.equal(changed.projectDirectory, first); assert.equal("authorizedDirectory" in changed, false);
    await assert.rejects(changeDirectorySettings(path, { directories: [], expectedDirectories: original }, { cwd: root }), /目录授权已变化/);
    await undo(); assert.equal(await readFile(path, "utf8"), before);
    await changeDirectorySettings(path, { directories: [], expectedDirectories: original }, { cwd: root });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).authorizedDirectories, []);
    await assert.rejects(changeDirectorySettings(path, { directories: [{ path: "relative", access: "read" }], expectedDirectories: [] }, { cwd: root }), /绝对路径/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
