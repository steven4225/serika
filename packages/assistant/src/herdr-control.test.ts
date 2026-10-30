import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
for (const source of ["desktop", "telegram"] as const) it(`${source} structured Herdr calls bind the fixed target and only sending asks each time`, async () => {
  const root = await realpath(await mkdtemp("/private/tmp/serika-herdr-control-"));
  const directory = join(root, "directory"), bin = join(root, "bin"), home = join(root, "home"), log = join(root, "calls.jsonl");
  await Promise.all([mkdir(directory), mkdir(bin), mkdir(home)]);
  const target = { authorizedDirectory: directory, session: "offline", paneId: "p1", terminalId: "t1" };
  await writeFile(join(bin, "herdr"), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='session'){console.log(JSON.stringify({sessions:[{name:'offline',running:true}]}));process.exit(0);}
if(args[0]!=='--session'||args[1]!=='offline')process.exit(3);
if(args[2]==='pane'&&args[3]==='list'){console.log(JSON.stringify({result:{panes:[{pane_id:'p1',terminal_id:'t1',terminal_title_stripped:'Pi'}]}}));process.exit(0);}
if(args[4]!=='p1')process.exit(3);
const agent={agent:'pi',agent_status:'idle',pane_id:'p1',terminal_id:'t1',state_change_seq:1};
if(args[2]==='pane')console.log(JSON.stringify({result:{type:'pane_info',pane:{pane_id:'p1',terminal_id:'t1'}}}));
else if(args[3]==='read')console.log('offline Pi output');
else if(args[3]==='send-keys')console.log(JSON.stringify({result:{type:'ok'}}));
else console.log(JSON.stringify({result:{type:args[3]==='prompt'?'agent_prompted':'agent_info',agent}}));`);
  await chmod(join(bin, "herdr"), 0o700);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: directory, access: "readwrite" }],
    desktopAutonomy: { authorizedDirectory: directory },
    telegramAutonomy: { authorizedDirectory: directory, botId: 1, userId: 2, chatId: 3, threadId: "thread" },
    modules: { terminal: { enabled: true, target } } }));
  const inputs = [{ action: "get" }, { action: "read" }, { action: "wait" }, { action: "prompt", text: "offline task" },
    { action: "input", key: "enter" }, { action: "stop" }] as const;
  let step = 0;
  const app = await createRuntimeApp({ cwd: root, env: { HOME: home, PATH: bin }, directory: join(root, "transcripts"), output: new PassThrough(),
    assistant: { configPath, threadId: "thread", dataDirectory: join(root, "data") }, modelAlias: "scripted",
    desktopAutonomyHost: { home }, authorizeTelegramAutonomy: () => true,
    model: new MockLanguageModelV3({ doStream: async () => {
      const index = step++ - 1, input = index < 0 ? {} : inputs[index];
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start" as const, warnings: [] },
        ...(input ? [{ type: "tool-call" as const, toolCallId: `herdr-${index}`, toolName: index < 0 ? "herdr_pi_discover" : index < 3 ? "herdr_pi_read" : "herdr_pi_control", input: JSON.stringify(input) }] : []),
        { type: "finish" as const, finishReason: { unified: input ? "tool-calls" as const : "stop" as const, raw: undefined }, usage }] }) };
    } }) });
  const controller = createAssistantController(app), approvals: string[] = [];
  const remove = controller.subscribe(event => {
    if (event.type === "approval" && event.approval.preview) {
      assert.equal(event.approval.remember, undefined);
      approvals.push(event.approval.toolName);
      assert.equal(controller.confirm({ approvalId: event.approval.approvalId, decision: "allow", remember: true }), false);
      controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    }
  });
  try {
    const done = new Promise<void>(resolve => { const off = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); } }); });
    const start = await controller.run("控制已选定的离线 Pi", source === "telegram" ? { source } : { desktopEntry: true });
    assert.ok(start.ok); await done;
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    assert.deepEqual(approvals, ["herdr_pi_control", "herdr_pi_control", "herdr_pi_control"]);
    const receipt = await controller.runs.get(start.runId);
    assert.equal(receipt?.tools.length, 7);
    assert.ok(receipt?.tools.every(tool => tool.status === "completed"));
    const calls: string[][] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.filter(argv => argv[3] === "prompt").length, 1);
    assert.equal(calls.filter(argv => argv[3] === "send-keys").length, 2);
    assert.equal(calls.filter(argv => argv[2] === "pane").length, 10);
    assert.ok(calls.filter(argv => argv[0] === "--session" && argv[3] !== "list").every(argv => argv[1] === "offline" && argv[4] === "p1"));
  } finally { remove(); await controller.shutdown(); app.dispose(); await rm(root, { recursive: true, force: true }); }
});
