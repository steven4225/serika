import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { ComputerConnection } from "./computer-connection.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ResidentClient, createResidentPaths, startResidentServer } from "./resident-transport.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "computer-connection-")));
  const workspaceRoot = join(root, "workspace"), configPath = join(root, "config.json"), driver = join(root, "driver.cjs"), calls = join(root, "calls.jsonl");
  await mkdir(workspaceRoot);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace: workspaceRoot, modules: { "read-file": { enabled: true } } }));
  await writeFile(driver, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n'); console.log(JSON.stringify({apps:[{pid:1,bundle_id:'com.apple.TextEdit',running:true},{pid:2,bundle_id:'com.example.Other',running:true},{pid:3,bundle_id:'com.example.Stopped',running:false}]}));\n`);
  await chmod(driver, 0o700);
  const options = { configPath, workspaceRoot, cwd: root, userData: join(root, "profile"), env: {} };
  return { root, workspaceRoot, configPath, driver, calls, options, connection: new ComputerConnection(options) };
}

it("onboarding needs explicit discovery and selection, saves only selected apps and persists historical checks", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.connection.view()).lastCheck, null);
    const selection = await f.connection.select(f.driver);
    await assert.rejects(readFile(f.calls), { code: "ENOENT" });
    await assert.rejects(f.connection.save({ token: selection.token, allowedBundleIds: ["com.apple.TextEdit"] }), /本次查找/);
    assert.deepEqual(await f.connection.discover(selection.token), ["com.apple.TextEdit", "com.example.Other"]);
    await assert.rejects(f.connection.save({ token: selection.token, allowedBundleIds: ["com.example.Forged"] }), /本次查找/);
    await f.connection.save({ token: selection.token, allowedBundleIds: ["com.apple.TextEdit"] });
    assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).modules["read-file"].enabled, true);
    assert.equal((await f.connection.view()).lastCheck, null);
    const checked = await f.connection.check();
    assert.equal(checked.lastCheck?.ok, true);
    assert.ok(checked.lastCheck?.checkedAt);
    assert.deepEqual((await new ComputerConnection(f.options).view()).lastCheck, checked.lastCheck);
    assert.deepEqual((await readFile(f.calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)), [["call", "list_apps"], ["call", "list_apps"]]);
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    config.modules.computer.allowedBundleIds = ["com.example.Other"];
    await writeFile(f.configPath, JSON.stringify(config));
    assert.equal((await f.connection.view()).lastCheck, null);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("rejects forged, replaced and conflicting drafts and never overwrites concurrent configuration", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.connection.select(f.workspaceRoot), /工作区外/);
    await assert.rejects(f.connection.discover("forged"), /失效/);
    const old = await f.connection.select(f.driver);
    const current = await f.connection.select(f.driver);
    await assert.rejects(f.connection.discover(old.token), /失效/);
    await f.connection.discover(current.token);
    const changed = await readFile(f.configPath, "utf8") + "\n";
    await writeFile(f.configPath, changed);
    await assert.rejects(f.connection.save({ token: current.token, allowedBundleIds: ["com.apple.TextEdit"] }), /配置已变化/);
    assert.equal(await readFile(f.configPath, "utf8"), changed);
    await assert.rejects(f.connection.discover(current.token), /配置已变化/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("records safe failed checks without treating them as permission diagnosis or exposing driver output", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  try {
    const selection = await f.connection.select(f.driver);
    await f.connection.discover(selection.token);
    await f.connection.save({ token: selection.token, allowedBundleIds: ["com.apple.TextEdit"] });
    await writeFile(f.driver, `#!${process.execPath}\nconsole.error('PRIVATE-DRIVER-DATA');process.exit(1);\n`);
    const view = await f.connection.check();
    assert.equal(view.lastCheck?.ok, false);
    assert.equal(view.lastCheck?.errorCode, "DRIVER_REQUEST_FAILED");
    assert.ok(!JSON.stringify(view).includes("PRIVATE-DRIVER-DATA"));
    assert.deepEqual((await new ComputerConnection(f.options).view()).lastCheck, view.lastCheck);
    await rm(f.driver);
    assert.equal((await f.connection.check()).lastCheck?.errorCode, "DRIVER_EXECUTABLE_UNAVAILABLE");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("driver setup preserves a config without a workspace instead of resolving a null path", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  try {
    await writeFile(f.configPath, JSON.stringify({ version: 1, modules: { pomodoro: { enabled: true } } }));
    const connection = new ComputerConnection({ ...f.options, workspaceRoot: null });
    const selection = await connection.select(f.driver);
    await connection.discover(selection.token);
    await connection.save({ token: selection.token, allowedBundleIds: ["com.apple.TextEdit"] });
    assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).workspace, undefined);
    assert.equal((await connection.check()).lastCheck?.ok, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("desktop saves/reloads the same Thread without a model Run; idle operations do not remount settings and resident forwards them", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  let host: DesktopRuntime | undefined;
  try {
    let modelCalls = 0;
    const messages: { type: string; reason?: string }[] = [];
    const options = { cwd: f.root, userData: f.options.userData, env: { RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { modelCalls++; throw new Error("No model expected"); } }), send: (message: { type: string; reason?: string }) => { messages.push(message); } };
    host = await DesktopRuntime.create(options);
    const threadId = host.info().threadId;
    await host.getComputerConnection();
    const selection = await host.selectComputerDriver(f.driver);
    const discovery = host.discoverComputerApps(selection.token);
    await assert.rejects(host.checkComputerConnection(), /等待/);
    await discovery;
    assert.equal(messages.filter(message => message.type === "identity-changed").length, 0);
    await host.saveComputerConnection({ token: selection.token, allowedBundleIds: ["com.apple.TextEdit"] });
    assert.equal(host.info().threadId, threadId);
    assert.equal(host.info().computer.enabled, true);
    assert.ok(host.info().capabilities?.tools.includes("computer_check"));
    assert.ok(host.info().capabilities?.tools.includes("read_file"));
    assert.equal(messages.find(message => message.type === "identity-changed")?.reason, "computer");
    const check = await host.checkComputerConnection();
    await host.shutdown();
    host = await DesktopRuntime.create(options);
    assert.deepEqual((await host.getComputerConnection()).lastCheck, check.lastCheck);
    assert.equal(host.info().threadId, threadId);
    assert.equal(host.current.snapshot().state.kind, "idle");
    assert.equal(modelCalls, 0);

  } finally { await host?.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

it("resident client runs the approved onboarding through the owning host and reconnects to its saved check", { skip: process.platform !== "darwin" }, async () => {
  const f = await fixture();
  const paths = createResidentPaths(f.options.userData, join(f.root, "host.sock"));
  const scope = { userData: f.options.userData, configPath: f.configPath, workspaceRoot: f.workspaceRoot };
  let server: Awaited<ReturnType<typeof startResidentServer>> | undefined;
  let client: Awaited<ReturnType<typeof ResidentClient.connect>> | undefined;
  try {
    server = await startResidentServer({ paths, scope, createRuntime: send => DesktopRuntime.create({ cwd: f.root, userData: f.options.userData, env: { RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { throw new Error("No model expected"); } }), send }) });
    client = await ResidentClient.connect({ paths, scope, send: () => {} });
    const thread = client.info().threadId;
    assert.equal((await client.getComputerConnection()).enabled, false);
    const selection = await client.selectComputerDriver(f.driver);
    await client.discoverComputerApps(selection.token);
    await client.saveComputerConnection({ token: selection.token, allowedBundleIds: ["com.apple.TextEdit"] });
    const view = await client.checkComputerConnection();
    assert.equal(view.lastCheck?.ok, true);
    client.detach(); await client.reconnect();
    assert.deepEqual(await client.getComputerConnection(), view);
    assert.equal(client.info().threadId, thread);
    assert.equal(client.current.snapshot().state.kind, "idle");
  } finally { client?.detach(); await server?.runtime.shutdown(); await server?.close(); await rm(f.root, { recursive: true, force: true }); }
});
