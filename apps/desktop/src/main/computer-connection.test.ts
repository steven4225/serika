import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { createDemoModel, ComputerDriverUnavailableError, resolveTuiModuleConfig } from "@serika/assistant";
import { ComputerConnection, disableUnavailableComputer } from "./computer-connection.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { changeModuleSetting } from "./module-settings.js";
import { ResidentClient, createResidentPaths, startResidentServer } from "./resident-transport.js";

async function fixture() {
  const root = await realpath(await mkdtemp("/private/tmp/serika-computer-connection-"));
  const directory = join(root, "directory"), home = join(root, "home"), bin = join(root, "bin"), log = join(root, "calls.jsonl"), configPath = join(root, "config.json");
  await Promise.all([mkdir(directory), mkdir(home), mkdir(bin)]);
  const executable = join(bin, "cua-driver");
  await writeFile(executable, `#!${process.execPath}
import {appendFileSync} from 'node:fs';
let data='';for await(const c of process.stdin)data+=c;
appendFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),input:JSON.parse(data),home:process.env.HOME,secret:process.env.TEST_API_KEY,bypass:process.env.CUA_DRIVER_AUTO_APPROVE})+'\\n');
console.log(JSON.stringify({apps:[{pid:1,bundle_id:'com.apple.TextEdit',running:true},{pid:2,bundle_id:'com.other.App',running:false}]}));
`);
  await chmod(executable, 0o700);
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: directory, access: "readwrite" }], modules: { computer: { enabled: false } }, automation: { hooks: [] } }));
  const env = { HOME: home, PATH: bin, TEST_API_KEY: "fixture-secret", CUA_DRIVER_AUTO_APPROVE: "1" };
  const options = { configPath, cwd: root, env, directory, dataDirectory: join(home, "data") };
  return { root, directory, home, bin, log, configPath, executable, env, options, connection: new ComputerConnection(options), cleanup: () => rm(root, { force: true, recursive: true }) };
}

it("discovers without executing, explicitly checks with a safe environment, and CAS-saves exact application grants", async () => {
  const f = await fixture();
  try {
    const view = await f.connection.view();
    assert.deepEqual(await f.connection.find(), [f.executable]);
    await assert.rejects(readFile(f.log), { code: "ENOENT" });
    const checked = await f.connection.check(f.executable);
    assert.deepEqual(checked, { ok: true, apps: ["com.apple.TextEdit"], executable: f.executable, permissions: "not_checked" });
    const call = JSON.parse((await readFile(f.log, "utf8")).trim());
    assert.deepEqual(call, { argv: ["call", "list_apps"], input: {}, home: f.home });
    const input = { enabled: true, executable: f.executable, allowedBundleIds: ["com.apple.TextEdit"], expectedRevision: view.revision };
    const rollback = await f.connection.save(input);
    assert.equal((await f.connection.view()).enabled, true);
    await assert.rejects(f.connection.save(input), /配置已变化/);
    await rollback!(); assert.equal((await f.connection.view()).enabled, false);
    const unsafe = join(f.directory, "driver"); await writeFile(unsafe, "#!/bin/sh\nexit 1"); await chmod(unsafe, 0o700);
    await assert.rejects(f.connection.check(unsafe), /授权目录之外/);
    await assert.rejects(f.connection.save({ ...input, allowedBundleIds: ["*"] }));
    await writeFile(f.executable, `#!${process.execPath}\nconsole.error('unrelated private data');process.exit(1);\n`);
    const failed = await f.connection.check(f.executable);
    assert.equal(failed.ok, false); assert.doesNotMatch(JSON.stringify(failed), /unrelated private data/);
  } finally { await f.cleanup(); }
});

it("revokes a missing driver without executing it and requires explicit startup confirmation plus exact config CAS", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  try {
    const view = await f.connection.view();
    await f.connection.save({ enabled: true, executable: f.executable, allowedBundleIds: ["com.apple.TextEdit"], expectedRevision: view.revision });
    await unlink(f.executable);
    await assert.rejects(resolveTuiModuleConfig({ configPath: f.configPath }, { cwd: f.root }), ComputerDriverUnavailableError);
    const before = await readFile(f.configPath, "utf8");
    assert.equal(await disableUnavailableComputer({ configPath: f.configPath, cwd: f.root, confirm: async () => false }), false);
    assert.equal(await readFile(f.configPath, "utf8"), before);
    await assert.rejects(disableUnavailableComputer({ configPath: f.configPath, cwd: f.root, confirm: async () => { await writeFile(f.configPath, before + "\n"); return true; } }), /配置已变化/);
    await writeFile(f.configPath, before);
    assert.equal(await disableUnavailableComputer({ configPath: f.configPath, cwd: f.root, confirm: async () => true }), true);
    assert.equal((await resolveTuiModuleConfig({ configPath: f.configPath }, { cwd: f.root })).enabled.computer, false);
    await writeFile(f.configPath, before);
    await changeModuleSetting(f.configPath, { id: "computer", enabled: false, expectedEnabled: true }, { cwd: f.root });
    assert.equal((await f.connection.view()).enabled, false);
    await assert.rejects(readFile(f.log), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

it("uses the resident socket for connection setup, reload and driver-loss disable without creating a Run", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  const applicationHome = join(f.root, "profile"), paths = createResidentPaths(applicationHome, join(f.root, "socket", "host.sock"));
  const scope = { applicationHome, configPath: f.configPath };
  const server = await startResidentServer({ paths, scope, createRuntime: send => DesktopRuntime.create({ applicationHome, cwd: f.root, env: { ...f.env, RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model: createDemoModel(), send }) });
  const client = await ResidentClient.connect({ paths, scope, send: () => {} });
  try {
    const view = await client.getComputerConnection();
    assert.deepEqual(await client.findComputerDrivers(), [f.executable]);
    assert.equal((await client.checkComputerConnection(f.executable)).ok, true);
    await client.saveComputerConnection({ enabled: true, executable: f.executable, allowedBundleIds: ["com.apple.TextEdit"], expectedRevision: view.revision });
    assert.equal(client.info().computer.enabled, true);
    assert.deepEqual(client.info().computer.allowedBundleIds, ["com.apple.TextEdit"]);
    await unlink(f.executable);
    await client.setModuleEnabled({ id: "computer", enabled: false, expectedEnabled: true });
    assert.equal(client.info().computer.enabled, false);
    const runs = await client.current.listRuns(); assert.equal(runs.ok, true); if (runs.ok) assert.equal(runs.runs.length, 0);
  } finally { client.detach(); await server.runtime.shutdown(); await server.close(); await f.cleanup(); }
});
