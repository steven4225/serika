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

for (const source of ["desktop", "telegram"] as const) it(`${source} browser CLI calls require individual approvals and execute only the confirmed offline fixture`, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-browser-cli-")));
  const directory = join(root, "directory"), binary = join(root, "ego-browser.mjs"), log = join(root, "argv.jsonl");
  await mkdir(directory);
  await writeFile(binary, `import {appendFileSync} from 'node:fs';
const argv=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify(argv)+'\\n');
console.log(argv.includes('skill')?'Offline fixture guide END':'Offline fixture observed');`);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectory: directory,
    desktopAutonomy: { authorizedDirectory: directory },
    telegramAutonomy: { authorizedDirectory: directory, botId: 1, userId: 2, chatId: 3, threadId: "thread" },
    modules: { terminal: { enabled: true } } }));
  const args = [["--help"], ["--ignore-user-config", "skill"], ["task", "snapshot", "offline"], ["task", "action", "offline"], ["task", "snapshot", "offline"]];
  let step = 0, sawInstructions = false;
  const app = await createRuntimeApp({ cwd: root, env: {}, directory: join(root, "transcripts"), output: new PassThrough(),
    assistant: { configPath, threadId: "thread", dataDirectory: join(root, "data") }, modelAlias: "scripted",
    desktopAutonomyHost: { home: join(root, "H") }, authorizeTelegramAutonomy: () => true,
    model: new MockLanguageModelV3({ doStream: async options => {
      sawInstructions ||= JSON.stringify(options.prompt).includes("--ignore-user-config");
      const argv = args[step++];
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start" as const, warnings: [] },
        ...(argv ? [{ type: "tool-call" as const, toolCallId: `browser-${step}`, toolName: "terminal_exec", input: JSON.stringify({ command: [process.execPath, binary, ...argv].map(quote).join(" ") }) }] : []),
        { type: "finish" as const, finishReason: { unified: argv ? "tool-calls" as const : "stop" as const, raw: undefined }, usage }] }) };
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
    assert.ok((await controller.run("观察离线浏览器 fixture", source === "telegram" ? { source } : { desktopEntry: true })).ok); await done;
    assert.equal(sawInstructions, true);
    assert.deepEqual(approvals, args.map(() => "terminal_exec"));
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls, args);
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
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
