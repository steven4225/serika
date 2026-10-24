import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { HerdrTargets } from "./herdr-target.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ResidentClient, createResidentPaths, startResidentServer } from "./resident-transport.js";
import { createDemoModel } from "@serika/assistant";

async function fixture() {
  const root = await realpath(await mkdtemp("/private/tmp/serika-herdr-target-"));
  const directory = join(root, "directory"), bin = join(root, "bin"), home = join(root, "home"), log = join(root, "calls.jsonl"), state = join(root, "state.json"), configPath = join(root, "config.json");
  await Promise.all([mkdir(directory), mkdir(bin), mkdir(home)]);
  await writeFile(state, JSON.stringify({ terminal: "terminal-1" }));
  const script = `#!${process.execPath}
import {appendFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify({args,home:process.env.HOME,inherited:process.env.HERDR_SESSION,secret:process.env.TEST_API_KEY})+'\\n');
if(args.join(' ')==='session list --json') console.log(JSON.stringify({sessions:[{name:'test-session',running:true},{name:'stopped',running:false}]}));
else if(args.join(' ')==='--session test-session pane list') console.log(JSON.stringify({result:{panes:[{pane_id:JSON.parse(readFileSync(${JSON.stringify(state)},'utf8')).pane??'pane-1',terminal_id:JSON.parse(readFileSync(${JSON.stringify(state)},'utf8')).terminal,terminal_title_stripped:'Pi'}]}}));
else { console.error('unexpected argv');process.exit(3); }
`;
  await writeFile(join(bin, "herdr"), script); await chmod(join(bin, "herdr"), 0o700);
  await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectories: [{ path: directory, access: "readwrite" }], modules: { terminal: { enabled: true } }, automation: { hooks: [] } }));
  const env = { HOME: home, PATH: bin, SERIKA_HOME: home, RUNLOOM_HOME: home, HERDR_SESSION: "foreign", TEST_API_KEY: "fixture-secret" };
  const service = new HerdrTargets({ env, cwd: root, authorizedDirectory: directory });
  const selected = { session: "test-session", paneId: "pane-1", terminalId: "terminal-1" };
  return { root, directory, bin, home, log, state, configPath, env, service, selected, cleanup: () => rm(root, { recursive: true, force: true }) };
}

it("lists fixed-argv metadata without inherited target or credentials and CAS-binds the exact terminal", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.service.sessions(), [{ name: "test-session", running: true }, { name: "stopped", running: false }]);
    assert.deepEqual(await f.service.panes("test-session"), [{ paneId: "pane-1", terminalId: "terminal-1", title: "Pi" }]);
    const undo = await f.service.bind(f.configPath, { target: f.selected, expected: null });
    const target = { authorizedDirectory: f.directory, ...f.selected };
    assert.deepEqual(JSON.parse(await readFile(f.configPath, "utf8")).modules.terminal.target, target);
    await assert.rejects(f.service.bind(f.configPath, { target: null, expected: null }), /目标已变化/);
    await undo(); assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).modules.terminal.target, undefined);
    const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.home === f.home && call.inherited === undefined && call.secret === undefined));
    assert.deepEqual(calls[0].args, ["session", "list", "--json"]);
    assert.ok(calls.slice(1).every(call => JSON.stringify(call.args) === JSON.stringify(["--session", "test-session", "pane", "list"])));
  } finally { await f.cleanup(); }
});

it("rejects replaced panes, stale directory, disabled capability, unsafe executable and forged fields", async () => {
  const f = await fixture();
  try {
    await writeFile(f.state, JSON.stringify({ terminal: "replacement" }));
    await assert.rejects(f.service.bind(f.configPath, { target: f.selected, expected: null }), /已关闭或替换/);
    await assert.rejects(f.service.panes("x; rm -rf /"), /会话名称无效/);
    await assert.rejects(f.service.bind(f.configPath, { target: null, expected: null, authorizedDirectory: f.directory } as never), /绑定参数无效/);
    await writeFile(f.configPath, JSON.stringify({ version: 1, authorizedDirectories: [{ path: f.directory, access: "readwrite" }], modules: { terminal: { enabled: false } } }));
    await assert.rejects(f.service.bind(f.configPath, { target: null, expected: null }), /先开启本地终端/);
    const other = join(f.root, "other"); await mkdir(other);
    await writeFile(f.configPath, JSON.stringify({ version: 1, authorizedDirectories: [{ path: other, access: "readwrite" }], modules: { terminal: { enabled: true } } }));
    await assert.rejects(f.service.bind(f.configPath, { target: null, expected: null }), /授权目录已变化/);
    await writeFile(join(f.directory, "herdr"), "#!/bin/sh\nexit 99\n"); await chmod(join(f.directory, "herdr"), 0o700);
    const unsafe = new HerdrTargets({ env: { HOME: f.home, PATH: f.directory }, cwd: f.root, authorizedDirectory: f.directory });
    await assert.rejects(unsafe.sessions(), /授权目录之外/);
  } finally { await f.cleanup(); }
});

it("parses pane identities with the same target schema used by configuration", async () => {
  const f = await fixture();
  try {
    const pane = "p".repeat(256);
    await writeFile(f.state, JSON.stringify({ terminal: "terminal-1", pane }));
    assert.equal((await f.service.panes("test-session"))[0]?.paneId, pane);
    await writeFile(f.state, JSON.stringify({ terminal: "terminal-1", pane: pane + "x" }));
    await assert.rejects(f.service.panes("test-session"));
    await writeFile(f.state, JSON.stringify({ terminal: "terminal-1", pane: "pane\u007f" }));
    await assert.rejects(f.service.panes("test-session"));
  } finally { await f.cleanup(); }
});

it("changes the target through the resident socket and publishes reload state without a model Run", async () => {
  const f = await fixture();
  const applicationHome = join(f.root, "profile"), paths = createResidentPaths(applicationHome, join(f.root, "socket", "host.sock"));
  const scope = { applicationHome, configPath: f.configPath };
  const server = await startResidentServer({ paths, scope, createRuntime: send => DesktopRuntime.create({ applicationHome, cwd: f.root,
    env: { ...f.env, RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model: createDemoModel(), send }) });
  const client = await ResidentClient.connect({ paths, scope, send: () => {} });
  try {
    assert.equal(client.info().terminalTarget, undefined);
    assert.equal((await client.listHerdrSessions())[0]?.name, "test-session");
    assert.equal((await client.listHerdrPanes("test-session"))[0]?.terminalId, "terminal-1");
    await client.setHerdrTarget({ target: f.selected, expected: null });
    const target = { authorizedDirectory: f.directory, ...f.selected };
    assert.deepEqual(client.info().terminalTarget, target);
    const runs = await client.current.listRuns(); assert.equal(runs.ok, true);
    if (runs.ok) assert.equal(runs.runs.length, 0);
    await client.setHerdrTarget({ target: null, expected: target });
    assert.equal(client.info().terminalTarget, undefined);
  } finally { client.detach(); await server.runtime.shutdown(); await server.close(); await f.cleanup(); }
});
