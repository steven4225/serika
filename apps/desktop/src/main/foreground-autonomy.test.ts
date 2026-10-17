import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ResidentClient, createResidentPaths, startResidentServer } from "./resident-transport.js";
import { changeAutonomySetting } from "./module-settings.js";
import { resolveTuiModuleConfig } from "@serika/example-cli";
import { createRuntimeApp } from "@serika/example-cli";
import { createAssistantController } from "@serika/example-cli";
import { TeeOutput } from "./runtime-bridge.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

type Call = { name: string; input: Record<string, unknown> };
function response(call?: Call, index = 0, text = "已完成文件修复并通过检查。") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(call ? [{ type: "tool-call" as const, toolCallId: `call-${index}`, toolName: call.name, input: JSON.stringify(call.input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: text }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: call ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
async function until(check: () => boolean, message = "state timeout") {
  const deadline = Date.now() + 60_000;
  while (!check()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-autonomy-")));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json"); await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { shell: { enabled: true, timeoutMs: 2000 }, "read-file": { enabled: true } }, run: { maxSteps: 2, totalTimeoutMs: 10_000 }, automation: { hooks: [] } }));
  return { root, workspace, configPath };
}

it("persists workspace authority, runs a multi-step repair, preserves attachments and keeps Telegram chat/tasks unapproved", async () => {
  const f = await fixture(); const events: MainToRenderer[] = [];
  let plan: Call[] = [], index = 0;
  const instructions: string[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => {
    instructions.push(JSON.stringify(options.prompt)); const current = index++; return response(plan[current], current);
  } });
  const options = { userData: join(f.root, "profile"), cwd: f.root, env: { RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model, send: (message: MainToRenderer) => events.push(message) };
  let host = await DesktopRuntime.create(options);
  const shell = (command: string): Call => ({ name: "shell_exec", input: { command, cwd: "." } });
  const waitIdle = () => until(() => host.current.snapshot().state.kind === "idle");
  const reset = (calls: Call[]) => { plan = calls; index = 0; events.length = 0; instructions.length = 0; };
  const cancelPending = async () => { await until(() => !!host.current.snapshot().pendingApproval); await host.current.cancel(); await waitIdle(); };
  try {
    assert.equal(host.info().autonomy?.enabled, false);
    reset([shell("touch should-not-exist")]);
    assert.equal((await host.current.run("运行命令", { desktopEntry: true } as never)).ok, true);
    await until(() => !!host.current.snapshot().pendingApproval);
    await assert.rejects(host.setAutonomyEnabled({ enabled: true, expectedEnabled: false }), /等待/);
    await cancelPending();
    await assert.rejects(readFile(join(f.workspace, "should-not-exist")));
    await host.setAutonomyEnabled({ enabled: true, expectedEnabled: false });
    assert.equal(host.info().autonomy?.enabled, true);
    reset([
      { name: "write_file", input: { path: "answer.txt", content: "wrong" } },
      shell("test \"$(cat answer.txt)\" = right"),
      { name: "edit_file", input: { path: "answer.txt", oldText: "wrong", newText: "right" } },
      { name: "read_file", input: { path: "answer.txt" } },
      ...Array.from({ length: 7 }, (_, n) => shell(`test -f answer.txt && test ${n} -ge 0`)),
      shell("test \"$(cat answer.txt)\" = right"),
    ]);
    const started = await host.current.run("修复并检查", { attachments: [{ name: "note.txt", mediaType: "text/plain", data: Buffer.from("保留附件").toString("base64") }] } as never);
    assert.equal(started.ok, true); await waitIdle();
    assert.equal(events.some(event => event.type === "approval"), false);
    assert.equal(await readFile(join(f.workspace, "answer.txt"), "utf8"), "right");
    assert.ok(instructions[0]?.includes("host has explicitly authorized"));
    assert.ok(instructions[0]?.includes("保留附件"));
    assert.ok(started.ok);
    const read = await host.current.getRun(started.runId);
    assert.ok(read.ok && read.run); const run = read.run;
    assert.equal(run.status, "completed"); assert.equal(run.tools.length, 12);
    assert.equal(run.tools[1]?.shell?.exitCode, 1); assert.equal(run.tools.at(-1)?.shell?.exitCode, 0);
    assert.equal(run.tools.some(tool => tool.approvalRequestedAt), false);
    const task = await host.current.createWorkTask({ goal: "检查文件", acceptance: [
      { id: "check", description: "文件存在", required: true, method: "automatic", verification: { kind: "shell_exit_zero", command: "test -f answer.txt", cwd: "." } },
      { id: "quality", description: "用户接受质量", required: true, method: "human", verification: { kind: "human" } },
    ] });
    assert.ok(task.ok); reset([shell("test -f answer.txt")]);
    assert.equal((await host.current.runWorkTask({ id: task.value.id, expectedRevision: task.value.revision })).ok, true);
    await waitIdle(); assert.equal(events.some(event => event.type === "approval"), false);
    const delivered = await host.current.getWorkTask(task.value.id); assert.ok(delivered.ok); assert.equal(delivered.value.status, "awaiting_acceptance");
    for (const asTask of [false, true]) {
      reset([shell("touch telegram-must-not-run")]);
      assert.equal((await host.channelRun(host.info().threadId, "Telegram 任务", asTask, async () => {})).ok, true);
      await until(() => !!host.current.snapshot().pendingApproval);
      const state = host.current.snapshot().state; assert.ok(state.kind === "running"); assert.equal(state.source, "telegram");
      assert.equal(instructions[0]?.includes("host has explicitly authorized"), false);
      await cancelPending();
    }
    await assert.rejects(readFile(join(f.workspace, "telegram-must-not-run")));
    await host.shutdown(); host = await DesktopRuntime.create(options);
    assert.equal(host.info().autonomy?.enabled, true);
    await host.setAutonomyEnabled({ enabled: false, expectedEnabled: true });
    reset([shell("touch after-disable")]); await host.current.run("运行"); await cancelPending();
    assert.equal(host.info().autonomy?.enabled, false);
    await assert.rejects(readFile(join(f.workspace, "after-disable")));
  } finally { await host.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

it("uses the resident socket for authority changes, retains other approvals and cancels a running autonomous Shell without replay", async () => {
  const f = await fixture();
  const userData = join(f.root, "profile"), paths = createResidentPaths(userData, join(f.root, "host.sock"));
  const scope = { userData, configPath: f.configPath, workspaceRoot: f.workspace };
  let calls = 0, otherTool = true;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls++;
    return response(otherTool ? { name: "recipe_list", input: {} } :
      { name: "shell_exec", input: { command: "printf started > marker.txt; sleep 60; touch must-not-complete", cwd: "." } }, calls);
  } });
  const server = await startResidentServer({ paths, scope, createRuntime: send => DesktopRuntime.create({ userData, cwd: f.root, env: { RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model, send }) });
  const client = await ResidentClient.connect({ paths, scope, send: () => {} });
  try {
    await client.setAutonomyEnabled({ enabled: true, expectedEnabled: false });
    assert.equal(client.info().autonomy?.enabled, true);
    await client.current.run("其他工具保留确认");
    await until(() => !!server.runtime.current.snapshot().pendingApproval);
    assert.equal(server.runtime.current.snapshot().pendingApproval?.toolName, "recipe_list");
    await client.current.cancel(); await until(() => server.runtime.current.snapshot().state.kind === "idle");
    otherTool = false;
    const started = await client.current.run("执行并停止"); assert.ok(started.ok);
    // Wait for the real process to run, rather than only a dispatched event.
    const deadline = Date.now() + 20_000;
    while (true) {
      try { assert.equal(await readFile(join(f.workspace, "marker.txt"), "utf8"), "started"); break; }
      catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    assert.equal(server.runtime.current.snapshot().pendingApproval, null);
    await assert.rejects(client.setAutonomyEnabled({ enabled: false, expectedEnabled: true }), /等待/);
    await client.current.cancel(); await until(() => server.runtime.current.snapshot().state.kind === "idle");
    const read = await client.current.getRun(started.runId); assert.ok(read.ok && read.run);
    assert.equal(read.run.status, "cancelled");
    assert.equal(read.run.tools[0]?.status, "unknown");
    await assert.rejects(readFile(join(f.workspace, "must-not-complete")));
    const beforeRestart = calls;
    client.detach();
    await server.runtime.shutdown();
    const restarted = await DesktopRuntime.create({ userData, cwd: f.root, env: { RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model, send: () => {} });
    try {
      assert.equal(calls, beforeRestart);
      assert.equal(restarted.info().autonomy?.enabled, true);
      const reopened = await restarted.current.getRun(started.runId); assert.ok(reopened.ok && reopened.run);
      assert.equal(reopened.run.tools[0]?.status, "unknown");
    } finally { await restarted.shutdown(); }
  } finally { client.detach(); await server.runtime.shutdown(); await server.close(); await rm(f.root, { recursive: true, force: true }); }
});

it("does not inherit persisted desktop authority in a TUI/controller assembly without host opt-in", async () => {
  const f = await fixture();
  try {
    await changeAutonomySetting(f.configPath, { enabled: true, expectedEnabled: false }, f.root, f.workspace);
    const output = new TeeOutput(() => {});
    const app = await createRuntimeApp({ args: ["--tui", join(f.root, "history"), "--thread", "no-inherit", "--config", f.configPath], modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => response({ name: "shell_exec", input: { command: "touch forbidden" } }) }), output, env: {}, cwd: f.root });
    const controller = createAssistantController(app); output.attach(controller);
    try {
      assert.equal(app.desktopAutonomyEnabled, false);
      await controller.run("run", { desktopEntry: true });
      await until(() => !!controller.getSnapshot().pendingApproval);
      await controller.cancel(); await until(() => controller.getSnapshot().state.kind === "idle");
      await assert.rejects(readFile(join(f.workspace, "forbidden")));
    } finally { await controller.shutdown(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("validates explicit setting CAS, workspace binding and external config; ignores grants after workspace changes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(changeAutonomySetting(f.configPath, { enabled: true, expectedEnabled: false, workspace: f.workspace } as never, f.root, f.workspace), /参数无效/);
    const undo = await changeAutonomySetting(f.configPath, { enabled: true, expectedEnabled: false }, f.root, f.workspace);
    await assert.rejects(changeAutonomySetting(f.configPath, { enabled: false, expectedEnabled: false }, f.root, f.workspace), /配置已变化/);
    assert.equal((await resolveTuiModuleConfig({ configPath: f.configPath }, { cwd: f.root })).desktopAutonomy?.workspaceRoot, f.workspace);
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    const other = join(f.root, "other"); await mkdir(other); config.workspace = other;
    await writeFile(f.configPath, JSON.stringify(config));
    assert.equal((await resolveTuiModuleConfig({ configPath: f.configPath }, { cwd: f.root })).desktopAutonomy, undefined);
    await assert.rejects(undo(), /其他程序修改/);
    config.workspace = f.workspace;
    const internal = join(f.workspace, "config.json"); await writeFile(internal, JSON.stringify(config));
    await assert.rejects(resolveTuiModuleConfig({ configPath: internal }, { cwd: f.root }), /outside the workspace/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("does not enable disabled modules or replace a configured Docker sandbox", async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    config.modules.shell.enabled = false; config.modules["read-file"].enabled = false;
    await writeFile(f.configPath, JSON.stringify(config));
    await changeAutonomySetting(f.configPath, { enabled: true, expectedEnabled: false }, f.root, f.workspace);
    const host = await DesktopRuntime.create({ userData: join(f.root, "profile"), cwd: f.root, env: { RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model: new MockLanguageModelV3(), send: () => {} });
    try {
      assert.equal(host.info().autonomy?.enabled, true);
      for (const name of ["shell_exec", "read_file", "write_file", "edit_file"]) assert.equal(host.info().capabilities?.tools.includes(name), false);
    } finally { await host.shutdown(); }
    config.workspace = "./workspace";
    config.modules.shell = { enabled: true, sandbox: { backend: "docker", image: "node:22-bookworm-slim", readablePaths: [], writablePaths: [] } };
    await writeFile(f.configPath, JSON.stringify(config));
    await assert.rejects(changeAutonomySetting(f.configPath, { enabled: true, expectedEnabled: false }, f.root, f.workspace), /不会替换 Docker/);
    assert.deepEqual(JSON.parse(await readFile(f.configPath, "utf8")), config);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

it("halts after an uncertain autonomy config commit, then rereads it without launching a Run", async t => {
  const f = await fixture(); let calls = 0;
  const host = await DesktopRuntime.create({ userData: join(f.root, "profile"), cwd: f.root, env: { RUNLOOM_CONFIG: f.configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send: () => {} });
  try {
    const probe = await open(f.root, "r"), prototype = Object.getPrototypeOf(probe), original = prototype.sync; await probe.close();
    let faulted = false;
    const fault = t.mock.method(prototype, "sync", async function(this: { stat(): Promise<{ isDirectory(): boolean }> }) {
      if (!faulted && (await this.stat()).isDirectory()) { faulted = true; throw new Error("sync failed"); }
      return original.call(this);
    });
    await assert.rejects(host.setAutonomyEnabled({ enabled: true, expectedEnabled: false }), /配置保存结果未确认/); fault.mock.restore();
    assert.equal(host.info().runtimeRecovery?.state, "failed"); assert.throws(() => host.current);
    await host.retryConnection(); assert.equal(host.info().autonomy?.enabled, true); assert.equal(calls, 0);
  } finally { await host.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

it("retains the exact active request after same-Run compaction consumes its user message and tool result", async () => {
  const f = await fixture(); const events: MainToRenderer[] = [];
  const config = JSON.parse(await readFile(f.configPath, "utf8"));
  config.desktopAutonomy = { workspaceRoot: f.workspace };
  config.contextCompaction = { enabled: true, contextWindowTokens: 18000, maxOutputTokens: 1024, safetyMarginTokens: 512,
    keepRecentTokens: 256, summaryMaxOutputTokens: 1024 };
  await writeFile(f.configPath, JSON.stringify(config));
  await writeFile(join(f.workspace, "large.txt"), "bounded tool content\n".repeat(3000));
  const request = "Read large.txt, then run the remaining checks without asking me to continue. CURRENT_TASK_168";
  let primaryCalls = 0, summaries = 0; const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
    const serialized = JSON.stringify(prompt);
    if (serialized.includes("You are a context compactor")) {
      summaries++;
      const sourceText = prompt.flatMap(message => typeof message.content === "string" ? [message.content]
        : message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n");
      const source = JSON.parse(sourceText.split("Transcript to merge:\n")[1]!) as { id: string }[];
      return response(undefined, 0, JSON.stringify({ version: 2, goal: { text: request, evidenceMessageIds: [source[0]!.id] },
        constraints: [], decisions: [], actions: [], pending: [], files: [], nextStep: null }));
    }
    prompts.push(prompt);
    return response(primaryCalls++ === 0 ? { name: "read_file", input: { path: "large.txt" } } : undefined);
  } });
  const host = await DesktopRuntime.create({ userData: join(f.root, "profile"), cwd: f.root, env: { RUNLOOM_CONFIG: f.configPath },
    modelAlias: "mock", model, send: event => events.push(event) });
  try {
    const started = await host.current.run(request); assert.ok(started.ok);
    await until(() => host.current.snapshot().state.kind === "idle");
    const run = await host.current.getRun(started.runId); assert.ok(run.ok && run.run);
    assert.equal(run.run.status, "completed", run.run.errorPreview ?? "");
    assert.equal(primaryCalls, 2); assert.ok(summaries > 0, "must exercise real automatic compaction");
    const lastPrompt = prompts.at(-1) as { role: string; content: unknown }[];
    assert.ok(lastPrompt.some(message => message.role === "user" && JSON.stringify(message.content).includes(request)),
      "after a compacted tool result, the model still needs the exact current user task, not only an assistant summary");
    assert.doesNotMatch(JSON.stringify(await host.current.history()), /runloom-foreground-task/,
      "the retained request is process-local model context, not another committed user message");
    assert.equal(events.some(event => event.type === "approval"), false);
  } finally { await host.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});
