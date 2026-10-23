import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { resolveTuiModuleConfig } from "./tui-module-config.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };

it("confirmed Telegram terminal calls control an offline existing-Pi fixture through the shared host executor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-terminal-control-")));
  const directory = join(root, "directory"), binary = join(root, "fake-herdr.mjs"), log = join(root, "argv.jsonl");
  await mkdir(directory);
  await writeFile(join(directory, "protected.txt"), "unchanged");
  await writeFile(binary, `import {appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
const argv=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify(argv)+'\\n');
if(argv[0]!=='--session'||argv[1]!=='offline'||!argv.includes('p1')) process.exit(2);
const stateFile=${JSON.stringify(join(root, "state.json"))};
let sequence=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):1;
if(argv[3]==='prompt') { sequence++; writeFileSync(stateFile,JSON.stringify(sequence)); writeFileSync(${JSON.stringify(join(directory, "result.txt"))},'fixture-result'); }
console.log(JSON.stringify({terminal_id:'terminal-1',kind:'pi',state:'done',state_change_seq:sequence,output:'offline Pi fixture'}));`);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectory: directory,
    telegramAutonomy: { authorizedDirectory: directory, botId: 1, userId: 2, chatId: 3, threadId: "thread" },
    modules: { terminal: { enabled: true, target: { authorizedDirectory: directory, session: "offline", paneId: "p1", terminalId: "terminal-1" } } } }));
  const invoke = `${quote(process.execPath)} ${quote(binary)} --session offline`;
  const commands = [`${invoke} pane get p1`, `${invoke} agent get p1`,
    `${invoke} agent prompt p1 'write fixture result' --wait --timeout 100`, `${invoke} agent get p1`, `${invoke} agent read p1 --source recent-unwrapped --lines 120`];
  let step = 0, sawInstructions = false;
  const app = await createRuntimeApp({ cwd: root, env: {}, directory: join(root, "transcripts"), output: new PassThrough(),
    assistant: { configPath, threadId: "thread", dataDirectory: join(root, "data") }, modelAlias: "scripted",
    desktopAutonomyHost: { home: join(root, "H") }, authorizeTelegramAutonomy: () => true,
    model: new MockLanguageModelV3({ doStream: async options => {
      sawInstructions ||= JSON.stringify(options.prompt).includes("terminal-1") && JSON.stringify(options.prompt).includes("agent_prompt_stalled");
      const command = commands[step++];
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start" as const, warnings: [] },
        ...(command ? [{ type: "tool-call" as const, toolCallId: `terminal-${step}`, toolName: "terminal_exec", input: JSON.stringify({ command }) }] : []),
        { type: "finish" as const, finishReason: { unified: command ? "tool-calls" as const : "stop" as const, raw: undefined }, usage }] }) };
    } }) });
  const controller = createAssistantController(app), approvals: string[] = [];
  const remove = controller.subscribe(event => {
    if (event.type === "approval" && event.approval.preview) {
      assert.equal(event.approval.remember, undefined);
      approvals.push(event.approval.toolName);
      controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    }
  });
  try {
    const done = new Promise<void>(resolve => { const off = controller.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); } }); });
    assert.ok((await controller.run("控制已绑定的离线 Pi fixture", { source: "telegram" })).ok);
    await done;
    assert.equal(sawInstructions, true);
    assert.deepEqual(approvals, commands.map(() => "terminal_exec"));
    const calls: string[][] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(calls.length, commands.length);
    assert.equal(calls.filter(argv => argv[3] === "prompt").length, 1);
    assert.equal(JSON.parse(await readFile(join(root, "state.json"), "utf8")), 2);
    assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "fixture-result");
    assert.equal(await readFile(join(directory, "protected.txt"), "utf8"), "unchanged");
  } finally { remove(); await controller.shutdown(); app.dispose(); await rm(root, { recursive: true, force: true }); }
});

it("terminal target/config boundaries reject writable config, foreign directory and Docker coexistence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-terminal-config-")));
  const directory = join(root, "directory"); await mkdir(directory);
  const config = { version: 1, authorizedDirectory: directory, modules: { terminal: { enabled: true } } };
  try {
    const inside = join(directory, "config.json"); await writeFile(inside, JSON.stringify(config));
    await assert.rejects(resolveTuiModuleConfig({ configPath: inside, dataDirectory: join(root, "data") }, { cwd: root }), /outside the workspace/);
    const outside = join(root, "config.json");
    await writeFile(outside, JSON.stringify({ ...config, modules: { terminal: { enabled: true, target: { authorizedDirectory: root, session: "offline", paneId: "p1", terminalId: "t1" } } } }));
    await assert.rejects(resolveTuiModuleConfig({ configPath: outside, dataDirectory: join(root, "data") }, { cwd: root }), /exact authorizedDirectory/);
    await writeFile(outside, JSON.stringify({ ...config, authorizedDirectory: "./directory", modules: { ...config.modules, shell: { enabled: true, sandbox: { backend: "docker", image: "fixture", readablePaths: ["."], writablePaths: ["."] } } } }));
    await assert.rejects(resolveTuiModuleConfig({ configPath: outside, dataDirectory: join(root, "data") }, { cwd: root }), /cannot be combined with Docker/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
