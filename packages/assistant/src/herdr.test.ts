import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentError } from "@serika/core";
import { HerdrClient, herdrControlSchema, herdrReadSchema } from "./herdr.js";

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-herdr-client-")));
  const directory = join(root, "directory"), bin = join(root, "bin"), home = join(root, "H");
  await Promise.all([directory, bin, home].map(path => mkdir(path)));
  const secret = randomUUID(), stateFile = join(root, "state.json"), log = join(root, "calls.jsonl");
  const set = (mode: string) => writeFile(stateFile, JSON.stringify(mode));
  await set("normal");
  await writeFile(join(bin, "herdr"), `#!${process.execPath}
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
const argv=process.argv.slice(2), mode=JSON.parse(readFileSync(${JSON.stringify(stateFile)},'utf8'));
if (Object.keys(process.env).some(k=>k.startsWith('HERDR_') || k==='API_KEY')) { console.error('unexpected environment'); process.exit(1); }
appendFileSync(${JSON.stringify(log)},JSON.stringify(argv)+'\\n');
if(mode==='server-not-running' || mode==='discovery' && argv[1]==='broken') { console.error(JSON.stringify({error:{code:'server_not_running',message:'password='+${JSON.stringify(secret)}}})); process.exit(1); }
if(mode==='invalid-json') { console.log('password='+${JSON.stringify(secret)}); process.exit(0); }
if(mode==='invalid-metadata') { console.log('{}'); process.exit(0); }
if(argv[3]==='prompt' && (argv[0]!=='--session'||argv[1]!=='offline'||argv[2]!=='agent'||argv[4]!=='w1:p1'||argv.length!==6)) { console.error('unknown option: '+argv[6]); process.exit(2); }
const identity={pane_id:argv[4]==='w1:p2'?'w1:p2':'w1:p1',terminal_id:argv[4]==='w1:p2'?'terminal-2':mode==='replaced'?'replacement':'terminal-1'};
const agent={...identity,agent:mode==='wrong-kind'||argv[4]==='w1:p2'?'codex':'pi',agent_status:mode==='busy'?'working':mode==='state-unknown'?'unknown':'idle',state_change_seq:3};
if(argv[0]==='session') console.log(JSON.stringify({sessions:[{name:'offline',running:true},...(mode==='discovery'?[{name:'broken',running:true},{name:'stopped',running:false}]:[])]}));
else if(argv[2]==='pane') console.log(JSON.stringify({result:argv[3]==='list'?{type:'pane_list',panes:[{...identity,terminal_title_stripped:'password='+${JSON.stringify(secret)}},...(mode==='discovery'?[{pane_id:'w1:p2',terminal_id:'terminal-2',terminal_title_stripped:'Other agent'}]:[])]}:{type:'pane_info',pane:identity}}));
else if(argv[3]==='read') { process.stdout.write('answer\\npassword='+${JSON.stringify(secret)}+'\\nAuthorization: Bearer '+${JSON.stringify(secret)}); if(mode==='replace-after-read') writeFileSync(${JSON.stringify(stateFile)},JSON.stringify('replaced')); }
else if(argv[3]==='prompt' && mode==='unknown') { console.error('password='+${JSON.stringify(secret)}); process.exit(1); }
else if(argv[3]==='prompt' && mode==='cancel') setTimeout(()=>console.log(JSON.stringify({result:{type:'agent_prompted',agent}})),60000);
else console.log(JSON.stringify({result:argv[3]==='send-keys'?{type:'ok'}:{type:argv[3]==='prompt'?'agent_prompted':'agent_info',agent}}));
`);
  await chmod(join(bin, "herdr"), 0o755);
  const client = new HerdrClient({ cwd: root, authorizedDirectory: directory,
    env: { HOME: home, PATH: bin, HERDR_ENV: "1", HERDR_SESSION: "wrong-session", API_KEY: secret } });
  const target = { authorizedDirectory: directory, session: "offline", paneId: "w1:p1", terminalId: "terminal-1" };
  const calls = async (): Promise<string[][]> => (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, directory, client, target, secret, set, calls };
}

it("Herdr fixed actions verify the selected Pi identity, strip credentials and use only explicit argv", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.client.sessions(), [{ name: "offline", running: true }]);
    const panes = await f.client.panes("offline");
    assert.equal(panes[0]?.paneId, "w1:p1");
    assert.ok(!JSON.stringify(panes).includes(f.secret));
    const text = "--help; $(touch cannot-run)\n中文 \"双引号\" '单引号'";
    for (const action of [{ action: "get" }, { action: "read" }, { action: "wait" },
      { action: "prompt", text }, { action: "input", key: "enter" }, { action: "stop" }] as const) {
      const result = await f.client.execute(f.target, action);
      assert.equal(result.ok, true);
      assert.ok(!JSON.stringify(result).includes(f.secret));
    }
    const calls = await f.calls();
    assert.ok(calls.slice(2).every(argv => argv[0] === "--session" && argv[1] === "offline" && argv[4] === "w1:p1"));
    assert.deepEqual(calls.filter(argv => argv[3] === "prompt"), [["--session", "offline", "agent", "prompt", "w1:p1", text]]);
    assert.deepEqual(calls.filter(argv => argv[3] === "send-keys").map(argv => argv[5]), ["enter", "ctrl+c"]);
    assert.equal(calls.filter(argv => argv[2] === "pane" && argv[3] === "get").length, 7);
    await assert.rejects(f.client.panes("--current"), /会话名称无效/);
    assert.equal(herdrReadSchema.safeParse({ action: "read", session: "another" }).success, false);
    assert.equal(herdrControlSchema.safeParse({ action: "input", key: "arbitrary command" }).success, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("Herdr rejects replacement, foreign directory, non-Pi and working prompt before reading or sending", async () => {
  const f = await fixture();
  try {
    for (const mode of ["replaced", "wrong-kind", "busy"]) {
      await f.set(mode);
      assert.equal((await f.client.execute(f.target, { action: "prompt", text: "task" })).ok, false);
    }
    assert.equal((await f.client.execute({ ...f.target, authorizedDirectory: f.root }, { action: "read" })).ok, false);
    assert.equal((await f.client.execute({ ...f.target, paneId: "--current" }, { action: "read" })).ok, false);
    assert.ok(!(await f.calls()).some(argv => argv[3] === "read" || argv[3] === "prompt" || argv[3] === "send-keys"));
    await f.set("busy");
    assert.equal((await f.client.execute(f.target, { action: "read" })).ok, true);
    await f.set("replace-after-read");
    const replaced = await f.client.execute(f.target, { action: "read" });
    assert.equal(replaced.ok, false);
    assert.ok(!JSON.stringify(replaced).includes(f.secret));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("Herdr sending failure is unknown once, with stderr suppressed and no automatic readback", async () => {
  const f = await fixture();
  try {
    await f.set("unknown");
    await assert.rejects(f.client.execute(f.target, { action: "prompt", text: "task" }), error => {
      assert.ok(error instanceof AgentError && error.data.code === "TOOL_OUTCOME_UNKNOWN");
      assert.equal(error.data.retryable, false);
      assert.ok(!error.message.includes(f.secret));
      return true;
    });
    assert.deepEqual((await f.calls()).map(argv => argv[3]), ["get", "get", "prompt"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("Herdr cancellation before dispatch sends nothing; cancellation after input dispatch stays unknown", async () => {
  const f = await fixture();
  try {
    const cancelled = await f.client.execute(f.target, { action: "prompt", text: "task" }, AbortSignal.abort());
    assert.equal(cancelled.ok, false);
    if (!cancelled.ok) assert.equal(cancelled.error.code, "HERDR_CANCELLED");
    await assert.rejects(readFile(join(f.root, "calls.jsonl")), { code: "ENOENT" });
    await f.set("cancel");
    const abort = new AbortController();
    const result = f.client.execute(f.target, { action: "prompt", text: "task" }, abort.signal);
    const rejected = assert.rejects(result, error => error instanceof AgentError && error.data.code === "TOOL_OUTCOME_UNKNOWN");
    for (let attempt = 0; attempt < 500 && !(await f.calls().catch(() => [])).some(argv => argv[3] === "prompt"); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok((await f.calls()).some(argv => argv[3] === "prompt"));
    abort.abort();
    await rejected;
    assert.deepEqual((await f.calls()).map(argv => argv[3]), ["get", "get", "prompt"]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


it("Herdr pre-dispatch failures retain safe server, JSON and metadata reasons", async () => {
  const f = await fixture();
  try {
    for (const [mode, code] of [["server-not-running", "HERDR_SERVER_NOT_RUNNING"], ["invalid-json", "HERDR_INVALID_JSON"], ["invalid-metadata", "HERDR_INVALID_METADATA"]]) {
      await f.set(mode!);
      const result = await f.client.execute(f.target, { action: "prompt", text: "task" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, code);
      assert.ok(!JSON.stringify(result).includes(f.secret));
    }
    assert.ok(!(await f.calls()).some(argv => ["prompt", "send-keys", "read"].includes(argv[3]!)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


it("Herdr discovery checks running candidates and reports safe per-session and identity failures without reading or dispatch", async () => {
  const f = await fixture();
  try {
    await f.set("discovery");
    const result = await f.client.discover();
    assert.deepEqual(result.candidates, [{ target: f.target, title: "password=[REDACTED]", status: "idle", stateChangeSeq: 3 }]);
    assert.deepEqual(result.failures.map(item => [item.session, item.paneId, item.error.code]), [
      ["offline", "w1:p2", "HERDR_NOT_PI"], ["broken", undefined, "HERDR_SERVER_NOT_RUNNING"], ["stopped", undefined, "HERDR_SESSION_NOT_RUNNING"],
    ]);
    assert.ok(!JSON.stringify(result).includes(f.secret));
    const calls = await f.calls();
    assert.ok(!calls.some(argv => argv[1] === "stopped" || ["prompt", "send-keys", "read", "wait"].includes(argv[3]!)));
    await f.set("state-unknown");
    const unknown = await f.client.discover();
    assert.equal(unknown.candidates.length, 0);
    assert.equal(unknown.failures[0]?.error.code, "HERDR_STATE_UNKNOWN");
    const count = (await f.calls()).length;
    const cancelled = await f.client.discover(AbortSignal.abort());
    assert.equal(cancelled.failures[0]?.error.code, "HERDR_CANCELLED");
    assert.equal((await f.calls()).length, count);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("Herdr discovery rejects forbidden binaries and distinguishes a process that never spawned", async () => {
  const f = await fixture();
  try {
    const forbidden = new HerdrClient({ cwd: f.root, authorizedDirectory: f.root, env: { PATH: join(f.root, "bin") } });
    assert.equal((await forbidden.discover()).failures[0]?.error.code, "HERDR_BINARY_FORBIDDEN");
    await assert.rejects(readFile(join(f.root, "calls.jsonl")), { code: "ENOENT" });
    await writeFile(join(f.root, "bin", "herdr"), "#!/nonexistent-serika-herdr-interpreter\n");
    const failed = await f.client.execute(f.target, { action: "prompt", text: "task" });
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "HERDR_SPAWN_FAILED");
    await assert.rejects(readFile(join(f.root, "calls.jsonl")), { code: "ENOENT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
