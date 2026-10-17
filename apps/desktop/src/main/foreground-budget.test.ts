import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const stream = (parts: unknown[], finish: "stop" | "tool-calls") => ({ stream: simulateReadableStream({ chunks: [
  { type: "stream-start" as const, warnings: [] }, ...parts as never[], { type: "finish" as const, finishReason: { unified: finish, raw: undefined }, usage },
] }) });
const text = (value: string) => stream([{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: value }, { type: "text-end", id: "t" }], "stop");
const shell = (id: string, command: string) => stream([{ type: "tool-call", toolCallId: id, toolName: "shell_exec", input: JSON.stringify({ command, cwd: "." }) }], "tool-calls");

// Regression for the daily Pi probe: a large fixed prompt left no room for
// version/help results, so every step triggered LLM compaction and the
// model lost the results it had just observed.
it("an autonomous Pi probe keeps its results without mid-Run compaction and omits chat-only consolidation tools", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-budget-")));
  const workspace = join(root, "ws"), bin = join(root, "bin"); await mkdir(workspace); await mkdir(bin);
  const help = Array.from({ length: 120 }, (_, i) => `  --option-${i}   Description of option ${i} for the pi agent CLI`).join("\n");
  await writeFile(join(bin, "pi"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.87.0; else cat <<'X'\nUsage: pi [options]\n${help}\nX\nfi\n`);
  await chmod(join(bin, "pi"), 0o755);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, desktopAutonomy: { workspaceRoot: workspace },
    modules: { shell: { enabled: true, timeoutMs: 5000 }, "read-file": { enabled: true }, memory: { enabled: true }, checkpoint: { enabled: true }, task: { enabled: true }, web: { enabled: true } },
    // Room for the full fixed prompt before this fix, but not for it plus help output.
    contextCompaction: { enabled: true, contextWindowTokens: 50_120, maxOutputTokens: 4096, safetyMarginTokens: 1024, keepRecentTokens: 4096, summaryMaxOutputTokens: 1024 },
    run: { maxSteps: 16, totalTimeoutMs: 120_000 }, automation: { hooks: [] } }));
  const plan = ["command -v pi", "pi --version", "pi --help"];
  let step = 0, compactions = 0; const toolNames: string[][] = []; const prompts: string[] = [];
  const model = new MockLanguageModelV3({ doStream: async (options: any) => {
    const prompt = JSON.stringify(options.prompt);
    if (prompt.includes("Return one JSON object with version: 2")) { compactions++; return text("{}"); }
    toolNames.push((options.tools ?? []).map((tool: { name: string }) => tool.name)); prompts.push(prompt);
    const command = plan[step++];
    return command ? shell(`c${step}`, command) : text("Pi 0.87.0，可通过本机 CLI 调用。");
  } });
  const previousPath = process.env.PATH; process.env.PATH = `${bin}:${previousPath}`;
  const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: { RUNLOOM_CONFIG: configPath, PATH: process.env.PATH }, modelAlias: "mock", model, send: () => {} } as never);
  try {
    const started = await host.current.run("查询本机 Pi 的版本和帮助，然后说明能否通过 CLI 调用它。", { desktopEntry: true } as never);
    assert.ok(started.ok);
    const deadline = Date.now() + 60_000;
    while (host.current.snapshot().state.kind !== "idle") { if (Date.now() > deadline) throw new Error("timeout"); await new Promise(r => setTimeout(r, 20)); }
    const read = await host.current.getRun(started.runId); assert.ok(read.ok && read.run);
    assert.equal(read.run.status, "completed");
    assert.equal(read.run.tools.length, 3);
    assert.ok(read.run.tools.every(call => call.shell?.exitCode === 0));
    assert.equal(compactions, 0, "fixed prompt must leave room for the observed help result");
    assert.ok(toolNames.every(names => !names.includes("memory_stage_candidates") && !names.includes("memory_prepare_consolidation")));
    assert.ok(toolNames[0]?.includes("shell_exec"));
    assert.match(prompts.at(-1)!, /0\.87\.0/);
    assert.match(prompts.at(-1)!, /--option-119/);
  } finally { await host.shutdown(); process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
});

it("autonomous independent Shell writes with identical status output all execute and persist", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-shell-progress-")));
  const workspace = join(root, "ws"), configPath = join(root, "config.json"); await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, desktopAutonomy: { workspaceRoot: workspace },
    modules: { shell: { enabled: true, timeoutMs: 5000 } }, automation: { hooks: [] } }));
  const files = ["a", "b", "c", "d"];
  let step = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    const file = files[step++];
    return file ? shell(`write-${file}`, `printf payload > ${file}.txt && echo Done`) : text("四个文件已写入。");
  } });
  const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root,
    env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model, send: () => {} });
  try {
    const started = await host.current.run("分别创建 a.txt、b.txt、c.txt、d.txt，每个文件写入 payload。");
    assert.ok(started.ok);
    const deadline = Date.now() + 60_000;
    while (host.current.snapshot().state.kind !== "idle") { if (Date.now() > deadline) throw new Error("timeout"); await new Promise(r => setTimeout(r, 20)); }
    const read = await host.current.getRun(started.runId); assert.ok(read.ok && read.run);
    assert.equal(read.run.status, "completed");
    assert.equal(read.run.tools.length, 4);
    assert.ok(read.run.tools.every(call => call.status === "completed" && call.shell?.exitCode === 0));
    for (const file of files) assert.equal(await readFile(join(workspace, `${file}.txt`), "utf8"), "payload");
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
