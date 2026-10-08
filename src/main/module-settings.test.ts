import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { changeModuleSetting, changeDreamingSetting } from "./module-settings.js";

it("opts into dreaming only on explicit CAS setting, preserves trusted rules, and refuses forged authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-dreaming-setting-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const path = join(root, "config.json");
    const config = { version: 1, workspace, modules: { memory: { enabled: true, writePolicy: "review" } }, automation: { hooks: [] } };
    const before = JSON.stringify(config); await writeFile(path, before);
    await assert.rejects(changeDreamingSetting(path, { enabled: true, expectedEnabled: false, workspace: "/other" } as never, root), /参数无效/);
    assert.equal(await readFile(path, "utf8"), before);
    const undo = await changeDreamingSetting(path, { enabled: true, expectedEnabled: false }, root);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...config, automation: { ...config.automation, dreaming: { enabled: true } } });
    await assert.rejects(changeDreamingSetting(path, { enabled: false, expectedEnabled: false }, root), /配置已变化/);
    await undo(); assert.equal(await readFile(path, "utf8"), before);
    const undoAgain = await changeDreamingSetting(path, { enabled: true, expectedEnabled: false }, root);
    const external = await readFile(path, "utf8") + " "; await writeFile(path, external);
    await assert.rejects(undoAgain(), /其他程序修改/);
    assert.equal(await readFile(path, "utf8"), external);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("changes only the requested switch, detects stale state, and does not overwrite concurrent edits during rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-module-setting-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const path = join(root, "config.json");
    const config = { version: 1, workspace, modules: { shell: { enabled: true, timeoutMs: 45000 }, memory: { enabled: true, autoConsolidate: true, writePolicy: "review" }, pomodoro: { enabled: true } } };
    const before = JSON.stringify(config); await writeFile(path, before);
    const undo = await changeModuleSetting(path, { id: "shell", enabled: false, expectedEnabled: true }, root);
    const changed = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(changed.modules.shell, { enabled: false, timeoutMs: 45000 });
    assert.deepEqual(changed.modules.memory, config.modules.memory);
    await assert.rejects(changeModuleSetting(path, { id: "shell", enabled: true, expectedEnabled: true }, root), /配置已变化/);
    await undo(); assert.equal(await readFile(path, "utf8"), before);
    const undoAgain = await changeModuleSetting(path, { id: "pomodoro", enabled: false, expectedEnabled: true }, root);
    const external = await readFile(path, "utf8") + " "; await writeFile(path, external);
    await assert.rejects(undoAgain(), /其他程序修改/);
    assert.equal(await readFile(path, "utf8"), external);
    await assert.rejects(changeModuleSetting(path, { id: "computer", enabled: true, expectedEnabled: false }, root), /驱动路径和允许控制的应用/);
    await assert.rejects(changeModuleSetting(path, { id: "arbitrary", enabled: true, expectedEnabled: false } as never, root), /参数无效/);
    assert.equal(await readFile(path, "utf8"), external);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("enables undeclared built-ins without adding authorization or automatic memory writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-module-defaults-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const path = join(root, "config.json");
    const before = JSON.stringify({ version: 1, workspace, modules: {} });
    await writeFile(path, before);
    for (const id of ["pomodoro", "read-file", "memory", "checkpoint", "task", "shell", "web", "todoist"] as const) {
      const undo = await changeModuleSetting(path, { id, enabled: true, expectedEnabled: false }, root);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, workspace, modules: { [id]: { enabled: true } } });
      await undo(); assert.equal(await readFile(path, "utf8"), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
