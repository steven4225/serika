import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { changeModuleSetting } from "./module-settings.js";
import { acquireFlock } from "@serika/assistant";

it("serializes real competing processes so unrelated capability writes both survive", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-config-process-lock-"));
  const children: ReturnType<typeof spawn>[] = [];
  let lock: Awaited<ReturnType<typeof acquireFlock>> | undefined;
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const path = join(root, "config.json");
    await writeFile(path, JSON.stringify({ version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { shell: { enabled: true, timeoutMs: 45000 }, pomodoro: { enabled: true } } }));
    lock = await acquireFlock(`${path}.lock`);
    const operation = (id: "shell" | "pomodoro") => {
      const script = `import { changeModuleSetting } from ${JSON.stringify(new URL("./module-settings.ts", import.meta.url).href)}; process.stdout.write("ready\\n"); await changeModuleSetting(${JSON.stringify(path)}, {id:${JSON.stringify(id)},enabled:false,expectedEnabled:true},{cwd:${JSON.stringify(root)}}); process.stdout.write("done\\n");`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let output = "", errors = "";
      const ready = new Promise<void>(resolve => child.stdout!.on("data", data => { output += String(data); if (output.includes("ready\n")) resolve(); }));
      child.stderr!.on("data", data => { errors += String(data); });
      const finished = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error(errors || `config child exited ${code}`)));
      });
      return { ready, finished, output: () => output };
    };
    const first = operation("shell"), second = operation("pomodoro");
    await Promise.all([first.ready, second.ready]);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(first.output().includes("done"), false); assert.equal(second.output().includes("done"), false);
    await lock.release(); lock = undefined;
    await Promise.all([first.finished, second.finished]);
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(config.modules.shell, { enabled: false, timeoutMs: 45000 });
    assert.deepEqual(config.modules.pomodoro, { enabled: false });
  } finally {
    await lock?.release();
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

it("rechecks state after taking the configuration lock, preserves mode, and rejects aliased unsafe lock files", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-config-recheck-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const path = join(root, "config.json");
    const config = { version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { shell: { enabled: true } } };
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const lock = await acquireFlock(`${path}.lock`);
    const pending = changeModuleSetting(path, { id: "shell", enabled: false, expectedEnabled: true }, { cwd: root });
    const result = assert.rejects(pending, /配置已变化/);
    const changed = JSON.stringify({ ...config, modules: { shell: { enabled: false } } });
    await writeFile(path, changed);
    await lock.release(); await result;
    assert.equal(await readFile(path, "utf8"), changed);
    const undo = await changeModuleSetting(path, { id: "shell", enabled: true, expectedEnabled: false }, { cwd: root });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await undo(); assert.equal((await stat(path)).mode & 0o777, 0o600);
    await rm(`${path}.lock`);
    const sentinel = join(root, "sentinel"); await writeFile(sentinel, "unchanged");
    await symlink(sentinel, `${path}.lock`);
    await assert.rejects(changeModuleSetting(path, { id: "shell", enabled: true, expectedEnabled: false }, { cwd: root }));
    assert.equal(await readFile(sentinel, "utf8"), "unchanged");
    assert.equal(await readFile(path, "utf8"), changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("changes only the requested switch, detects stale state, and does not overwrite concurrent edits during rollback", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-module-setting-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const path = join(root, "config.json");
    const config = { version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { shell: { enabled: true, timeoutMs: 45000 }, memory: { enabled: true, autoConsolidate: true }, pomodoro: { enabled: true } } };
    const before = JSON.stringify(config); await writeFile(path, before);
    const undo = await changeModuleSetting(path, { id: "shell", enabled: false, expectedEnabled: true }, { cwd: root });
    const changed = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(changed.modules.shell, { enabled: false, timeoutMs: 45000 });
    assert.deepEqual(changed.modules.memory, config.modules.memory);
    await assert.rejects(changeModuleSetting(path, { id: "shell", enabled: true, expectedEnabled: true }, { cwd: root }), /配置已变化/);
    await undo(); assert.equal(await readFile(path, "utf8"), before);
    const undoAgain = await changeModuleSetting(path, { id: "pomodoro", enabled: false, expectedEnabled: true }, { cwd: root });
    const external = await readFile(path, "utf8") + " "; await writeFile(path, external);
    await assert.rejects(undoAgain(), /其他程序修改/);
    assert.equal(await readFile(path, "utf8"), external);
    await assert.rejects(changeModuleSetting(path, { id: "computer", enabled: true, expectedEnabled: false }, { cwd: root }), /驱动路径和允许控制的应用/);
    await assert.rejects(changeModuleSetting(path, { id: "arbitrary", enabled: true, expectedEnabled: false } as never, { cwd: root }), /参数无效/);
    assert.equal(await readFile(path, "utf8"), external);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("enables undeclared built-ins without adding authorization or automatic memory writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-module-defaults-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const path = join(root, "config.json");
    const before = JSON.stringify({ version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: {} });
    await writeFile(path, before);
    for (const id of ["pomodoro", "read-file", "memory", "checkpoint", "task", "shell", "web", "todoist"] as const) {
      const undo = await changeModuleSetting(path, { id, enabled: true, expectedEnabled: false }, { cwd: root });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { [id]: { enabled: true } } });
      await undo(); assert.equal(await readFile(path, "utf8"), before);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
