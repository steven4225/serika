import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ExecutionRecordStore } from "@serika/assistant";
import type { MainToRenderer } from "../shared/ui-contract.js";

function response(toolName?: string, input?: unknown, text = "收到。") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(toolName ? [{ type: "tool-call" as const, toolCallId: toolName, toolName, input: JSON.stringify(input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: text }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: toolName ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
async function idle(host: DesktopRuntime) {
  const deadline = Date.now() + 10_000;
  while (host.current.snapshot().state.kind !== "idle") {
    if (Date.now() > deadline) throw new Error("Desktop remained busy");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("normal desktop memory and history entry", () => {
  it("blocks new execution after a post-rename config acknowledgement fault until an explicit reread", async t => {
    const root = await mkdtemp(join(tmpdir(), "serika-config-uncertain-"));
    const workspace = join(root, "workspace"), configPath = join(root, "config.json"); await mkdir(workspace);
    await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { shell: { enabled: true }, memory: { enabled: false } } }));
    let calls = 0;
    const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send: () => {} });
    try {
      const probe = await open(root, "r"), prototype = Object.getPrototypeOf(probe), fd = probe.fd; await probe.close();
      const original = prototype.sync;
      let reached = false;
      const fault = t.mock.method(prototype, "sync", async function(this: { fd: number; stat(): Promise<{ isDirectory(): boolean }> }) {
        if ((await this.stat()).isDirectory() && !reached) { reached = true; throw new Error(`directory sync fault ${fd}`); }
        return original.call(this);
      });
      await assert.rejects(host.setModuleEnabled({ id: "shell", enabled: false, expectedEnabled: true }), /配置保存结果未确认/);
      fault.mock.restore();
      assert.equal(reached, true); assert.equal(JSON.parse(await readFile(configPath, "utf8")).modules.shell.enabled, false);
      assert.equal(host.info().runtimeRecovery?.state, "failed");
      assert.throws(() => host.current, /暂停新执行/);
      await host.retryConnection();
      assert.equal(host.info().modules?.find(module => module.id === "shell")?.enabled, false);
      assert.equal(host.current.snapshot().state.kind, "idle"); assert.equal(calls, 0);
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("rejects a workspace changed between the identity check and actual app assembly", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-runtime-workspace-race-"));
    const workspace = join(root, "original"), other = join(root, "other"), configPath = join(root, "config.json");
    await mkdir(workspace); await mkdir(other);
    const config = { version: 1, workspace, modules: { memory: { enabled: false }, shell: { enabled: false } } };
    await writeFile(configPath, JSON.stringify(config));
    let calls = 0, switched = false;
    const env: NodeJS.ProcessEnv = { RUNLOOM_CONFIG: configPath };
    Object.defineProperty(env, "RUNLOOM_TODOIST_TIMEZONE", { get() {
      if (!switched) { switched = true; writeFileSync(configPath, JSON.stringify({ ...config, workspace: other })); }
      return undefined;
    } });
    const options = { userData: join(root, "profile"), cwd: root, env, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send: () => {} };
    let host: DesktopRuntime | undefined;
    try {
      await assert.rejects(DesktopRuntime.create(options), /连接期间变化/);
      assert.equal(calls, 0);
      await writeFile(configPath, JSON.stringify(config));
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().workspaceRoot, await realpath(workspace));
      assert.equal(host.current.snapshot().state.kind, "idle");
      assert.deepEqual(await host.current.listRuns(), { ok: true, runs: [], modelUsage: { calls: [], droppedCount: 0 } });
      assert.equal(calls, 0, "reconnection after rejected assembly must not replay anything");
    } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("still rebuilds a usable controller when shutdown fails and a concurrent config edit prevents rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-runtime-rollback-conflict-"));
    let calls = 0;
    const events: MainToRenderer[] = [];
    const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send: event => { events.push(event); } });
    try {
      await host.current.run("保留对话，不自动重做", { memoryConsolidation: "exclude" }); await idle(host);
      const identity = host.info(), modelCalls = calls;
      const bridge = host.current, shutdown = bridge.shutdown.bind(bridge);
      const patched = mock.method(bridge, "shutdown", async () => {
        await shutdown();
        const external = JSON.parse(await readFile(identity.configPath!, "utf8"));
        external.modules.todoist = { enabled: false };
        external.modules.shell.enabled = false;
        await writeFile(identity.configPath!, JSON.stringify(external));
        throw new Error("simulated failure after shutdown released its leases");
      });
      await assert.rejects(host.setModuleEnabled({ id: "todoist", enabled: true, expectedEnabled: false }), /配置回滚未完成/);
      patched.mock.restore();
      assert.equal(host.recoveryError, undefined);
      assert.equal(host.current.snapshot().state.kind, "idle");
      assert.equal(host.info().threadId, identity.threadId);
      assert.equal(host.info().modules?.find(module => module.id === "shell")?.enabled, false);
      assert.equal(JSON.parse(await readFile(identity.configPath!, "utf8")).modules.shell.enabled, false, "must not erase the external config edit");
      assert.ok((await host.current.history()).some(message => message.role === "user"));
      assert.ok(events.some(event => event.type === "identity-changed" && event.configurationError?.includes("配置回滚未完成")));
      assert.equal(calls, modelCalls, "rebuilding after a config conflict must never rerun the conversation");
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("exposes a failed connection after activation and rollback both fail, then reconnects only the repaired original identity without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-runtime-reconnect-"));
    let calls = 0;
    const events: MainToRenderer[] = [];
    const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send: event => { events.push(event); } });
    try {
      await host.current.run("重连后仍保留的消息", { memoryConsolidation: "exclude" }); await idle(host);
      const identity = host.info(), modelCalls = calls;
      const before = await readFile(identity.configPath!, "utf8");
      const runs = await host.current.listRuns();
      const bridge = host.current, shutdown = bridge.shutdown.bind(bridge);
      const patched = mock.method(bridge, "shutdown", async () => {
        await shutdown();
        // An unrelated editor writes a still-unusable config after our setting.
        await writeFile(identity.configPath!, await readFile(identity.configPath!, "utf8") + " ");
      });
      await assert.rejects(host.setModuleEnabled({ id: "todoist", enabled: true, expectedEnabled: false }), /连接未恢复/);
      patched.mock.restore();
      assert.match(host.recoveryError!, /连接未恢复/);
      assert.throws(() => host.current, /连接未恢复/);
      assert.equal(host.info().threadId, identity.threadId);
      assert.equal(host.info().runtimeRecovery?.state, "failed");
      assert.ok(events.some(event => event.type === "identity-changed" && event.info.runtimeRecovery?.state === "failed"));
      await assert.rejects(host.retryConnection(), /仍未连接/);
      const otherWorkspace = join(root, "other-workspace"); await mkdir(otherWorkspace);
      await writeFile(identity.configPath!, JSON.stringify({ ...JSON.parse(before), workspace: otherWorkspace }));
      await assert.rejects(host.retryConnection(), /仍未连接/, "retry cannot silently switch a trusted workspace");
      await writeFile(identity.configPath!, before);
      await host.retryConnection();
      assert.equal(host.info().runtimeRecovery, undefined);
      assert.equal(host.recoveryError, undefined);
      assert.equal(host.info().threadId, identity.threadId);
      assert.equal(host.info().directory, identity.directory);
      assert.equal(host.current.snapshot().state.kind, "idle");
      assert.ok((await host.current.history()).some(message => message.role === "user"));
      assert.deepEqual(await host.current.listRuns(), runs, "retry does not create or replay a Run");
      assert.equal(calls, modelCalls, "all failed/successful reconnect attempts are model-free");
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("applies capability switches to the real runtime, preserves history and identity, persists after restart and rolls back failed activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-capability-runtime-"));
    let calls = 0;
    const changes: MainToRenderer[] = [];
    const options = { userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send: (event: MainToRenderer) => { changes.push(event); } };
    let host = await DesktopRuntime.create(options);
    try {
      const initial = host.info();
      await host.current.run("保留当前对话", { memoryConsolidation: "exclude" });
      await assert.rejects(host.setModuleEnabled({ id: "pomodoro", enabled: false, expectedEnabled: true }), /等待/);
      await idle(host);
      const transcriptCalls = calls;
      await host.setModuleEnabled({ id: "pomodoro", enabled: false, expectedEnabled: true });
      assert.equal(host.info().commands.includes("pomodoro"), false);
      assert.equal(host.info().threadId, initial.threadId); assert.equal(host.info().directory, initial.directory);
      assert.equal(calls, transcriptCalls);
      assert.ok((await host.current.history()).some(message => message.role === "user"));
      await host.shutdown(); host = await DesktopRuntime.create(options);
      assert.equal(host.info().commands.includes("pomodoro"), false);
      await host.setModuleEnabled({ id: "pomodoro", enabled: true, expectedEnabled: false });
      assert.equal(host.info().commands.includes("pomodoro"), true);
      await host.setModuleEnabled({ id: "web", enabled: true, expectedEnabled: false });
      assert.equal(host.info().modules?.find(module => module.id === "web")?.enabled, true);
      await host.setModuleEnabled({ id: "web", enabled: false, expectedEnabled: true });
      // Valid config, but no credentials: assembly must fail and restore the prior config/runtime.
      const path = host.info().configPath!;
      const before = await readFile(path, "utf8");
      await assert.rejects(host.setModuleEnabled({ id: "todoist", enabled: true, expectedEnabled: false }), /TODOIST_API_TOKEN/);
      assert.ok(changes.some(event => event.type === "identity-changed" && event.reason === "modules" && event.configurationError?.includes("TODOIST_API_TOKEN")));
      assert.equal(await readFile(path, "utf8"), before);
      assert.equal(host.info().threadId, initial.threadId);
      assert.equal(host.current.snapshot().state.kind, "idle");
      assert.equal(host.info().modules?.find(module => module.id === "todoist")?.enabled, false);
      assert.ok((await host.current.history()).some(message => message.role === "user"));
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("reuses verified empty conversations, keeps draft identities separate, and never hides tasks, receipts or unreadable records", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-history-activity-"));
    let calls = 0;
    const options = { userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send: () => {} };
    let host = await DesktopRuntime.create(options);
    try {
      const first = host.info();
      for (let click = 0; click < 3; click++) await host.createThread();
      assert.equal(host.info().threadId, first.threadId);
      assert.equal((await host.listThreads()).length, 1);
      assert.equal((await host.listThreads())[0]?.emptyVerified, true);
      await host.createThread({ preserveDraft: true });
      assert.notEqual(host.info().threadId, first.threadId);
      assert.equal((await host.listThreads()).length, 2, "a local draft retains a separate identity");
      const taskThread = host.info().threadId;
      const task = await host.current.createWorkTask({ goal: "香蕉项目计划", acceptance: [{ id: "human", required: true, description: "可执行", method: "human", verification: { kind: "human" } }] });
      assert.ok(task.ok);
      const taskSummary = (await host.listThreads("香蕉")).find(item => item.threadId === taskThread)!;
      assert.equal(taskSummary.messageCount, 0); assert.equal(taskSummary.taskCount, 1); assert.equal(taskSummary.emptyVerified, false);
      assert.equal(taskSummary.matchesQuery, true); assert.match(taskSummary.title, /香蕉/);
      await host.createThread();
      const receiptThread = host.info();
      const journal = new ExecutionRecordStore(receiptThread.directory);
      await journal.startRun({ threadId: receiptThread.threadId, runId: "uncommitted-run", phase: "primary" });
      const before = await readFile(join(receiptThread.directory, "execution-records.json"), "utf8");
      const receiptSummary = (await host.listThreads()).find(item => item.threadId === receiptThread.threadId)!;
      assert.equal(receiptSummary.messageCount, 0); assert.equal(receiptSummary.runCount, 1); assert.equal(receiptSummary.emptyVerified, false);
      assert.equal(await readFile(join(receiptThread.directory, "execution-records.json"), "utf8"), before, "listing must not recover an interrupted Run");
      await host.createThread();
      assert.notEqual(host.info().threadId, receiptThread.threadId);
      const broken = host.info();
      const invalid = join(broken.directory, "execution-records.json");
      await writeFile(invalid, "invalid");
      const brokenSummary = (await host.listThreads()).find(item => item.threadId === broken.threadId)!;
      assert.equal(brokenSummary.emptyVerified, false); assert.match(brokenSummary.error!, /无法读取/);
      assert.equal(await readFile(invalid, "utf8"), "invalid");
      await assert.rejects(host.listThreads("x".repeat(201)), /200/);
      assert.equal(calls, 0, "listing, searching, creating and switching never call a model");
      // Restore the test journal before orderly shutdown; only the fixture is modified.
      await writeFile(invalid, JSON.stringify({ version: 1, runs: [] }));
      await host.selectThread(taskThread);
      await host.shutdown(); host = await DesktopRuntime.create(options);
      assert.equal(host.info().threadId, taskThread);
      const reopened = await host.current.listWorkTasks(); assert.ok(reopened.ok);
      assert.equal(reopened.value[0]?.id, task.value.id); assert.equal(reopened.value[0]?.status, "ready");
      assert.equal(calls, 0, "reopening a task is not executing it");
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("explicitly enables an old disabled config while keeping the selected Thread and committed history", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-enable-test-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const configPath = join(root, "custom.json");
    await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: false }, shell: { enabled: false } } }));
    const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root,
      env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} });
    try {
      const identity = host.info(); assert.equal(identity.memory.enabled, false);
      assert.ok((await host.current.run("保留这条旧对话")).ok); await idle(host);
      await host.enableMemory();
      assert.equal(host.info().threadId, identity.threadId); assert.equal(host.info().directory, identity.directory);
      assert.equal(host.info().memory.enabled, true); assert.equal(host.info().memory.autoConsolidate, true);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === "保留这条旧对话")));
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("uses generated identity, explicitly remembers through the single writer, recalls in a new Thread and reopens history", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-daily-test-"));
    const events: MainToRenderer[] = [];
    let written = false;
    const model = new MockLanguageModelV3({ doStream: async () => {
      if (written) return response();
      written = true;
      return response("memory_write", { operation: "add", text: "我的复盘长期偏好：先结论，再两条步骤。", category: "preference", sourceQuote: "我的复盘长期偏好：先结论，再两条步骤。" });
    } });
    const options = { userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock", model, send: (event: MainToRenderer) => events.push(event) };
    let host = await DesktopRuntime.create(options);
    try {
      const initial = host.info();
      assert.equal(initial.memory.enabled, true); assert.equal(initial.memory.autoConsolidate, true);
      assert.equal(initial.workspaceRoot, await realpath(join(root, "profile", "workspaces", "personal")));
      assert.ok((await host.current.run("记住：我的复盘长期偏好：先结论，再两条步骤。")).ok);
      await assert.rejects(host.createThread(), /等待/);
      await idle(host);
      const saved = await host.current.listMemories(); assert.ok(saved.ok); assert.equal(saved.value.entries.length, 1);
      const files = await host.listThreads(); assert.equal(files[0]!.messageCount! > 0, true);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().threadId, initial.threadId); assert.equal(host.info().directory, initial.directory);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text.includes("复盘长期偏好"))));
      await host.createThread();
      const other = host.info().threadId;
      assert.notEqual(other, initial.threadId);
      assert.ok((await host.current.run("总结报告怎么写？", { memoryConsolidation: "exclude" })).ok);
      await idle(host);
      const reference = await host.current.getMemoryReferences(); assert.equal(reference?.selected.length, 1); assert.equal(reference?.selected[0]?.reason, "snapshot");
      await host.selectThread(initial.threadId);
      assert.equal(host.info().threadId, initial.threadId);
      await host.selectThread(other);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().threadId, other);
      assert.equal((await host.listThreads()).length, 2);
      assert.ok(events.some(event => event.type === "identity-changed"));
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("moves legacy review memory to automatic saving on startup and preserves daily history across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-legacy-setup-"));
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    await mkdir(profile); await mkdir(workspace);
    const configPath = join(profile, "runloom.json");
    const legacy = { version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true }, shell: { enabled: false, timeoutMs: 45000 } }, run: { totalTimeoutMs: 600000 } };
    await writeFile(configPath, JSON.stringify(legacy));
    const options = { userData: profile, cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} };
    let host = await DesktopRuntime.create(options);
    try {
      const initial = host.info();
      assert.equal(initial.configPath, configPath);
      assert.equal(initial.memory.writePolicy, "automatic", "desktop has no review queue");
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(saved.modules.memory.writePolicy, "automatic");
      assert.deepEqual(saved.modules.shell, legacy.modules.shell);
      assert.equal(saved.modules.memory.queryRewrite, undefined);
      assert.ok((await host.current.run("保留这条日用历史", { memoryConsolidation: "exclude" })).ok);
      await idle(host);
      const memories = await host.current.listMemories();
      assert.ok(memories.ok); assert.equal(memories.value.entries.length, 0);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().memory.writePolicy, "automatic");
      assert.equal(host.info().threadId, initial.threadId);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === "保留这条日用历史")));
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("restores the previous conversation when the chosen Thread is owned by another controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-switch-lock-"));
    const options = { userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} };
    const host = await DesktopRuntime.create(options);
    let owner: DesktopRuntime | undefined;
    try {
      const previous = host.info();
      assert.ok((await host.current.run("切换失败后仍能看到的旧消息", { memoryConsolidation: "exclude" })).ok); await idle(host);
      await host.createThread(); const target = host.info();
      await host.selectThread(previous.threadId);
      owner = await DesktopRuntime.create({ ...options, userData: join(root, "other-profile"),
        env: { RUNLOOM_CONFIG: previous.configPath!, RUNLOOM_THREAD: target.threadId, RUNLOOM_TRANSCRIPTS: target.directory } });
      await assert.rejects(host.selectThread(target.threadId));
      assert.equal(host.info().threadId, previous.threadId);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === "切换失败后仍能看到的旧消息")));
      const registry = JSON.parse(await readFile(join(root, "profile", "desktop-identity.json"), "utf8"));
      assert.equal(registry.profiles[0].activeThreadId, previous.threadId);
    } finally { await owner?.shutdown(); await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
});

it("create-task opens a distinct Thread with persistent creation intent before identity-changed, preserving the old draft and making no model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-task-entry-"));
  const { ConversationDraftStore } = await import("./conversation-draft-store.js");
  const drafts = new ConversationDraftStore(join(root, "profile"));
  let calls = 0;
  const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock",
    model: new MockLanguageModelV3({ doStream: async () => { calls++; return response(); } }), send() {} });
  try {
    const first = host.info();
    await drafts.saveDraft(first, { text: "old unsent draft", excludeFromMemory: true });
    await host.createThread({ preserveDraft: true, taskDraft: "" });
    const second = host.info(); assert.notEqual(second.threadId, first.threadId);
    assert.deepEqual((await drafts.load(second)).draft, { text: "", excludeFromMemory: false, createTask: true });
    assert.equal((await drafts.load(first)).draft.text, "old unsent draft");
    await host.createThread({ preserveDraft: true, chatDraft: "Use a recipe" });
    assert.deepEqual((await drafts.load(host.info())).draft, { text: "Use a recipe", excludeFromMemory: false });
    assert.equal(calls, 0);
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
