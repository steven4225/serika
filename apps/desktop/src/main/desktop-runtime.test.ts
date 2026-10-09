import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ExecutionRecordStore } from "@aisdk-agent/example-cli/dist/execution-record-store.js";
import { discoverThreadDirectory } from "./thread-history.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

function findMaterial(value: unknown): { batchId: string; turns: Array<{ user: { messageId: string; text: string } }> } | undefined {
  if (typeof value !== "object" || value === null) return;
  const object = value as Record<string, unknown>;
  if (typeof object.batchId === "string" && Array.isArray(object.turns)) return object as ReturnType<typeof findMaterial>;
  for (const child of Object.values(object).reverse()) { const result = findMaterial(child); if (result) return result; }
}
function response(toolName?: string, input?: unknown) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(toolName ? [{ type: "tool-call" as const, toolCallId: toolName, toolName, input: JSON.stringify(input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "收到。" }, { type: "text-end" as const, id: "text" },
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
      assert.deepEqual(await host.current.listRuns(), { ok: true, runs: [] });
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
  it("uses generated daily identity, reviews/rejects proposals, recalls in a new Thread, and reopens either history", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-daily-test-"));
    let step = 0, failStage = false;
    const events: MainToRenderer[] = [];
    const model = new MockLanguageModelV3({ doStream: async options => {
      if (options.tools?.length !== 2) return response();
      step++;
      if (step % 3 === 1) return response("memory_prepare_consolidation", { mode: "incremental" });
      if (step % 3 === 2) {
        const material = findMaterial(options.prompt); assert.ok(material);
        const user = material.turns[0]?.user;
        return response("memory_stage_candidates", { batchId: material.batchId, proposals: user ? [{ action: "add",
          text: user.text, scope: { kind: "workspace" }, recallTerms: ["总结报告"], kind: "preference", reason: "明确偏好",
          sourceMessageId: user.messageId, sourceQuote: failStage ? "forged quote" : user.text }] : [] });
      }
      return response();
    } });
    const options = { userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock", model, send: (event: MainToRenderer) => events.push(event) };
    let host = await DesktopRuntime.create(options);
    try {
      const initial = host.info();
      assert.equal(initial.memory.enabled, true); assert.equal(initial.memory.autoConsolidate, true);
      assert.equal(initial.workspaceRoot, await realpath(join(root, "profile", "workspaces", "personal")));
      assert.ok((await host.current.run("我的复盘长期偏好：先结论，再两条步骤。")).ok);
      await assert.rejects(host.createThread(), /等待/);
      await idle(host);
      const candidates = await host.current.listMemoryCandidates({ status: "pending" }); assert.ok(candidates.ok); assert.equal(candidates.value.candidates.length, 1);
      const candidate = candidates.value.candidates[0]!;
      assert.ok((await host.current.resolveMemoryCandidate({ candidateId: candidate.id, expectedCandidateRevision: candidate.revision, decision: "accept" })).ok);
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
      const reference = await host.current.getMemoryReferences(); assert.equal(reference?.selected.length, 1); assert.equal(reference?.selected[0]?.reason, "recall_term");
      assert.equal((await host.current.listMemoryCandidates()).ok, true);
      await host.selectThread(initial.threadId);
      assert.equal(host.info().threadId, initial.threadId);
      await host.selectThread(other);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().threadId, other);
      assert.equal((await host.listThreads()).length, 2);
      assert.ok(events.some(event => event.type === "identity-changed"));
      failStage = true;
      assert.ok((await host.current.run("长期排版偏好：使用大标题。")).ok); await idle(host);
      const health = await host.current.getMemoryMaintenance(); assert.ok(health.ok); assert.equal(health.value.consolidation.state, "failed");
      failStage = false;
      assert.ok((await host.current.consolidateMemory({ mode: "incremental" })).ok); await idle(host);
      const retry = await host.current.listMemoryCandidates(); assert.ok(retry.ok); assert.equal(retry.value.candidates.length, 1);
      const rejected = retry.value.candidates[0]!;
      assert.ok((await host.current.resolveMemoryCandidate({ candidateId: rejected.id, expectedCandidateRevision: rejected.revision, decision: "reject" })).ok);
      const memories = await host.current.listMemories(); assert.ok(memories.ok); assert.equal(memories.value.entries.length, 1);
      const sources = await host.current.listMemoryConsolidationSources(); assert.ok(sources.ok);
      const excluded = sources.value.sources.find(source => source.preview === "总结报告怎么写？"); assert.equal(excluded?.excluded, true);
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("discovers legacy transcripts without tail repair and registers only after workspace confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-import-test-"));
    const directory = join(root, "legacy"); await mkdir(directory);
    const file = join(directory, `${createHash("sha256").update("personal").digest("hex")}.jsonl`);
    const transcript = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: "personal", messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "旧对话" }] }] }) + "\n";
    await writeFile(file, transcript + "unfinished");
    const found = await discoverThreadDirectory(directory); assert.equal(found[0]?.messageCount, 1); assert.ok(found[0]?.error);
    assert.equal(await readFile(file, "utf8"), transcript + "unfinished");
    await writeFile(file, transcript);
    const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} });
    try {
      await assert.rejects(host.registerThread({ threadId: "personal", transcriptDirectory: directory, confirmedWorkspace: false } as never), /确认/);
      assert.equal((await host.listThreads()).length, 1);
      await host.registerThread({ threadId: "personal", transcriptDirectory: directory, confirmedWorkspace: true });
      await host.selectThread("personal");
      assert.equal((await host.current.history())[0]?.id, "u");
      assert.equal(await readFile(file, "utf8"), transcript);
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("upgrades memory only on explicit request and preserves daily history across restart", async () => {
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
      assert.equal(initial.memory.queryRewriteEnabled, false);
      assert.equal(await readFile(configPath, "utf8"), JSON.stringify(legacy));
      assert.ok((await host.current.run("保留这条日用历史", { memoryConsolidation: "exclude" })).ok);
      await idle(host);
      const file = join(initial.directory, `${createHash("sha256").update(initial.threadId).digest("hex")}.jsonl`);
      const transcript = await readFile(file, "utf8");
      await host.enableMemory();
      assert.equal(host.info().threadId, initial.threadId);
      assert.equal(host.info().directory, initial.directory);
      assert.equal(host.info().memory.queryRewriteEnabled, true);
      assert.equal(await readFile(file, "utf8"), transcript);
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(saved.modules.shell, legacy.modules.shell);
      const memories = await host.current.listMemories();
      assert.ok(memories.ok); assert.equal(memories.value.entries.length, 0);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().memory.queryRewriteEnabled, true);
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
