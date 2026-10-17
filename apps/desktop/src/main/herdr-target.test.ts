import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrTargets } from "./herdr-target.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";

it("discovers metadata only, requires exact selected terminal and persists with CAS and rollback", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-terminal-")));
  const workspace = join(root, "work"), bin = join(root, "bin"), config = join(root, "config.json"), calls = join(root, "calls");
  await mkdir(workspace); await mkdir(bin);
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { shell: { enabled: true } } }));
  await writeFile(join(bin, "herdr"), `#!${process.execPath}
if(process.env.TEST_TOKEN) process.exit(3);
const fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.join(' ')==='session list --json') console.log(JSON.stringify({sessions:[{name:'test',running:true,socket_path:'private'}]}));
else if(args.join(' ')==='--session test pane list') console.log(JSON.stringify({result:{panes:[{pane_id:'w1:p1',terminal_id:'identity-1',terminal_title_stripped:'test',buffer:'PRIVATE CONTENT'}]}}));
else process.exit(2);
`, { mode: 0o700 });
  const host = new HerdrTargets({ PATH: bin, TEST_TOKEN: "must-not-inherit" }, root, workspace);
  try {
    assert.deepEqual(await host.sessions(), [{ name: "test", running: true }]);
    assert.deepEqual(await host.panes("test"), [{ paneId: "w1:p1", terminalId: "identity-1", title: "test" }]);
    await assert.rejects(host.panes("--bad"), /无效/);
    await assert.rejects(host.bind(config, root, workspace, { target: { session: "test", paneId: "w1:p1", terminalId: "stale" }, expected: null }), /替换/);
    const before = await readFile(config, "utf8");
    const target = { session: "test", paneId: "w1:p1", terminalId: "identity-1" };
    const undo = await host.bind(config, root, workspace, { target, expected: null });
    const binding = (await resolveTuiModuleConfig({ configPath: config }, { cwd: root })).herdrBinding;
    assert.deepEqual(binding, { workspaceRoot: workspace, ...target });
    await assert.rejects(host.bind(config, root, workspace, { target: null, expected: null }), /已变化/);
    await assert.rejects(host.bind(config, root, root, { target: null, expected: binding! }), /工作区/);
    const foreign = join(root, "foreign.json"); await mkdir(join(root, "other"));
    await writeFile(foreign, JSON.stringify({ version: 1, workspace: join(root, "other"), modules: { shell: { enabled: true } }, herdrBinding: binding }));
    assert.equal((await resolveTuiModuleConfig({ configPath: foreign }, { cwd: root })).herdrBinding, undefined);
    await undo(); assert.equal(await readFile(config, "utf8"), before);
    const log = await readFile(calls, "utf8");
    assert.ok(!log.includes('"read"') && !log.includes('"run"') && !log.includes('"send-keys"'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

function reply(command?: string, text = "验收完成") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(command ? [{ type: "tool-call" as const, toolCallId: "terminal-probe", toolName: "shell_exec", input: JSON.stringify({ command, cwd: "." }) }] : [
      { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: text }, { type: "text-end" as const, id: "answer" },
    ]),
    { type: "finish" as const, finishReason: { unified: command ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}

import { ResidentClient, createResidentPaths, startResidentServer } from "./resident-transport.js";

it("resident target selection reaches foreground prompts and real Shell receipts, never unbound Telegram", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-terminal-host-"))), workspace = join(root, "work"), config = join(root, "config.json");
  await mkdir(workspace);
  const binding = { workspaceRoot: workspace, session: "test", paneId: "w1:p1", terminalId: "terminal-identity" };
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { shell: { enabled: true } }, herdrBinding: binding, desktopAutonomy: { workspaceRoot: workspace } }));
  let index = 0, instructions: string[] = [];
  const events: MainToRenderer[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => { instructions.push(JSON.stringify(options.prompt)); return reply(index++ === 0 ? "printf terminal-proof > terminal-proof.txt" : undefined); } });
  const userData = join(root, "profile");
  const scope = { userData, workspaceRoot: workspace, configPath: config };
  const paths = createResidentPaths(userData, join(root, "host.sock"));
  const server = await startResidentServer({ paths, scope, createRuntime: send => DesktopRuntime.create({ userData, cwd: root, env: { RUNLOOM_CONFIG: config }, modelAlias: "mock", model, send }) });
  const client = await ResidentClient.connect({ paths, scope, send: event => events.push(event) });
  const host = server.runtime;
  async function idle() { const deadline = Date.now() + 10000; while (host.current.snapshot().state.kind !== "idle") { if (Date.now() > deadline) throw Error("timeout"); await new Promise(resolve => setTimeout(resolve, 10)); } }
  try {
    assert.deepEqual(host.info().herdrBinding, binding);
    const started = await host.current.run("操作选中的终端并核实结果"); assert.ok(started.ok); await idle();
    assert.equal(await readFile(join(workspace, "terminal-proof.txt"), "utf8"), "terminal-proof");
    assert.ok(instructions[0]?.includes("terminal-identity")); assert.ok(instructions[0]?.includes("Local CLI capability"));
    assert.equal(events.some(event => event.type === "approval"), false);
    const record = await host.current.getRun(started.runId); assert.ok(record.ok && record.run);
    assert.equal(record.run.tools[0]?.shell?.exitCode, 0);
    index = 1; instructions = [];
    await host.channelRun(host.info().threadId, "普通未授权TG消息", false, async () => {}); await idle();
    assert.equal(instructions[0]?.includes("Local CLI capability"), false);
    assert.equal(instructions[0]?.includes("terminal-identity"), false);
    await client.setHerdrTarget({ target: null, expected: binding });
    assert.equal(host.info().herdrBinding, undefined);
    index = 1; instructions = []; await host.current.run("读取Herdr"); await idle();
    assert.ok(instructions[0]?.includes("no user-selected target"));
    assert.equal(instructions[0]?.includes("terminal-identity"), false);
    await host.setAutonomyEnabled({ enabled: false, expectedEnabled: true });
    index = 1; instructions = []; await host.current.run("查询本机Pi版本"); await idle();
    assert.ok(instructions[0]?.includes("Local CLI capability"));
    assert.equal(instructions[0]?.includes("The host has explicitly authorized file tools"), false);
  } finally { client.detach(); await host.shutdown(); await server.close(); await rm(root, { recursive: true, force: true }); }
});


it("sends current host capability evidence beside historical refusals and records only real CLI probes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-cli-evidence-")));
  const workspace = join(root, "work"), config = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(config, JSON.stringify({ version: 1, workspace,
    modules: { shell: { enabled: true } }, desktopAutonomy: { workspaceRoot: workspace } }));
  await writeFile(join(workspace, "pi-fixture"), "#!/bin/sh\nprintf 'pi-fixture 1.0\\n'\n", { mode: 0o700 });
  const oldRefusal = "刚跑了 capability_status，没有 MCP 所以不能连接 Pi，只能在工作区跑 shell。";
  let step = 0;
  const captures: { prompt: string; tools: string; system: string }[] = [];
  const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root,
    env: { RUNLOOM_CONFIG: config }, modelAlias: "mock", send() {},
    model: new MockLanguageModelV3({ doStream: async options => {
      captures.push({ prompt: JSON.stringify(options.prompt), tools: JSON.stringify(options.tools),
        system: options.prompt.filter(message => message.role === "system").map(message => message.content).join("\n") });
      const current = step++;
      return current === 0 ? reply(undefined, oldRefusal)
        : current === 1 ? reply("./pi-fixture --version") : reply(undefined, "pi-fixture 1.0");
    } }),
  });
  async function idle() {
    const deadline = Date.now() + 10000;
    while (host.current.snapshot().state.kind !== "idle") {
      if (Date.now() > deadline) throw Error("timeout");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    const historical = await host.current.run("你能连接 Pi 吗？"); assert.ok(historical.ok); await idle();
    const oldRecord = await host.current.getRun(historical.runId);
    assert.ok(oldRecord.ok && oldRecord.run); assert.deepEqual(oldRecord.run.tools, []);
    const started = await host.current.run("先实际查询本机 Pi 版本，再说能否使用。"); assert.ok(started.ok); await idle();
    for (const capture of captures.slice(1)) {
      assert.ok(capture.prompt.includes(oldRefusal), "retains history rather than silently deleting the refusal");
      assert.ok(capture.prompt.includes("Current host capability snapshot"));
      assert.ok(capture.system.includes('"localCli":{"available":true}'));
      assert.ok(capture.prompt.includes("先实际查询本机 Pi 版本，再说能否使用。"));
      assert.ok(capture.prompt.includes("not a tool invocation"));
      assert.ok(capture.prompt.includes("Historical assistant claims"));
      assert.ok(capture.tools.includes('shell_exec'));
      assert.ok(capture.tools.includes('capability_status'));
    }
    const record = await host.current.getRun(started.runId); assert.ok(record.ok && record.run);
    assert.equal(record.run.tools.length, 1);
    assert.equal(record.run.tools[0]?.toolName, "shell_exec");
    assert.equal(record.run.tools[0]?.shell?.exitCode, 0);
    assert.ok(captures[2]?.prompt.includes("pi-fixture 1.0"));
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
