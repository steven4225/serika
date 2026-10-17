import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream } from "ai";
import { createMemoryStore } from "@serika/example-cli/dist/memory-store.js";
import { JsonlAgentStore } from "@serika/core";
import { restoreBackup } from "./backup.js";
import { RuntimeOwnership } from "./runtime-ownership.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { resolveResidentPaths, type ResidentServiceState } from "./resident-service.js";
import { readResidentStartup, residentStartup, saveResidentStartup } from "./resident-startup.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-runtime-ownership-")));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { pomodoro: { enabled: true } } }));
  const paths = resolveResidentPaths(root, workspace);
  let observed: ResidentServiceState = { ok: true, registered: false, running: false, compatible: true, label: paths.label };
  let enableCalls = 0, disableCalls = 0, modelCalls = 0;
  const events: MainToRenderer[] = [];
  let enable: () => Promise<ResidentServiceState> = async () => ({ ...observed, ok: false, message: "常驻助手测试注册失败" });
  const options = { userData: join(root, "profile"), cwd: root, home: root, hostEntry: join(root, "host.js"),
    env: { RUNLOOM_CONFIG: configPath, RUNLOOM_MODEL: "mock", DEEPSEEK_API_KEY: "secret-must-not-persist", UNRELATED_SECRET: "also-private" },
    modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { modelCalls++; throw new Error("No model calls expected"); } }),
    send: (event: MainToRenderer) => { events.push(event); },
    serviceFactory: () => ({ paths, plistPath: join(root, "unused.plist"), status: async () => observed,
      enable: async () => { enableCalls++; return enable(); },
      disable: async () => { disableCalls++; return observed; },
    }),
  };
  return { root, paths, options, events, observe: (state: Partial<ResidentServiceState>) => { observed = { ...observed, ...state }; },
    onEnable: (callback: typeof enable) => { enable = callback; }, state: () => observed,
    counts: () => ({ enableCalls, disableCalls, modelCalls }), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("normal startup writes only identity fields and does not register a service", async () => {
  const f = await fixture();
  const owner = await RuntimeOwnership.create(f.options);
  try {
    const saved = await readResidentStartup(f.paths.identityPath);
    assert.equal(saved.userData, f.options.userData);
    assert.equal(saved.env.RUNLOOM_CONFIG, f.options.env.RUNLOOM_CONFIG);
    assert.equal(saved.env.RUNLOOM_MODEL, "mock");
    const raw = await readFile(f.paths.identityPath, "utf8");
    assert.doesNotMatch(raw, /secret-must-not-persist|also-private|API_KEY|UNRELATED_SECRET/);
    assert.deepEqual(f.counts(), { enableCalls: 0, disableCalls: 0, modelCalls: 0 });
    assert.equal(owner.current.snapshot().state.kind, "idle");
  } finally { await owner.shutdown(); await f.cleanup(); }
});

test("opens restored history and memory, continues, reopens the selected recovery profile and returns without changing the original", async () => {
  const f = await fixture();
  let calls = 0;
  const options = { ...f.options, model: new MockLanguageModelV3({ doStream: async () => {
    calls++;
    return { stream: simulateReadableStream({ chunks: [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "收到保存的偏好。" }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } }] }) };
  } }) };
  let owner = await RuntimeOwnership.create(options);
  try {
    const original = owner.info(), memory = createMemoryStore(original.workspaceRoot!);
    const saved = await memory.add({ text: "复盘先写结论，再两条步骤" }); assert(saved.ok);
    const transcript = new JsonlAgentStore({ directory: original.directory });
    const messages = [{ id: "old-user", role: "user" as const, parts: [{ type: "text" as const, text: "旧对话可恢复" }] }];
    await transcript.save(original.threadId, messages);
    const memoryBefore = await readFile(join(original.workspaceRoot!, ".runloom", "memory.json"));
    const configBefore = await readFile(original.configPath!);
    const backup = join(f.root, "personal.serika-backup"); await owner.exportBackup(backup);
    const recovered = await restoreBackup(backup, f.root);
    await owner.activateRecovery(recovered.path);
    assert.notEqual(owner.info().workspaceRoot, original.workspaceRoot);
    assert.equal(owner.info().threadId, original.threadId); assert.equal(owner.info().recoveryWorkspace?.originalWorkspace, original.workspaceRoot);
    assert.deepEqual(await owner.current.history(), messages);
    const memories = await owner.current.listMemories(); assert(memories.ok && memories.value.entries.some(item => item.id === saved.entry.id));
    assert.equal(calls, 0, "activation does not call a model or replay tasks");
    assert((await owner.current.run("复盘怎么写", { memoryConsolidation: "exclude" })).ok);
    while (owner.current.snapshot().state.kind !== "idle") await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await owner.current.getMemoryReferences())?.selected[0]?.id, saved.entry.id);
    assert.equal(calls, 1); assert.equal((await owner.current.history()).length, 3);
    await owner.shutdown(); owner = await RuntimeOwnership.create(options);
    assert.equal(owner.info().workspaceRoot, join(recovered.path, "workspace"));
    assert.equal((await owner.current.history()).length, 3); assert.equal(calls, 1);
    await owner.activateRecovery(null);
    assert.equal(owner.info().workspaceRoot, original.workspaceRoot);
    assert.deepEqual(await owner.current.history(), messages);
    assert.deepEqual(await readFile(join(original.workspaceRoot!, ".runloom", "memory.json")), memoryBefore);
    assert.deepEqual(await readFile(original.configPath!), configBefore);
    assert.deepEqual(f.counts(), { enableCalls: 0, disableCalls: 0, modelCalls: 0 });
    await owner.shutdown(); owner = await RuntimeOwnership.create(options);
    assert.equal(owner.info().workspaceRoot, original.workspaceRoot); assert.equal(owner.info().recoveryWorkspace, undefined);
  } finally { await owner.shutdown(); await f.cleanup(); }
});

test("an active timer refuses ownership transfer without cancelling or registering", async () => {
  const f = await fixture();
  const owner = await RuntimeOwnership.create(f.options);
  try {
    assert.equal((await owner.current.command("/pomodoro start 3")).ok, true);
    const bridge = owner.current;
    await assert.rejects(owner.setResidentEnabled(true), /先结束番茄钟/);
    await assert.rejects(owner.activateRecovery(join(f.root, "not-a-recovery")), /先结束番茄钟/);
    assert.equal(owner.current, bridge);
    assert.deepEqual(f.counts(), { enableCalls: 0, disableCalls: 0, modelCalls: 0 });
    assert.equal((await owner.current.command("/pomodoro status")).ok, true);
    assert.ok(f.events.some(event => event.type === "output" && /番茄钟运行中，剩余/.test(event.text)));
    assert.equal((await owner.current.command("/pomodoro cancel")).ok, true);
  } finally { await owner.shutdown(); await f.cleanup(); }
});

test("invalid recovery data leaves the original controller and selection usable", async () => {
  const f = await fixture(); const owner = await RuntimeOwnership.create(f.options);
  try {
    const before = owner.info(), bridge = owner.current;
    const backup = join(f.root, "backup.serika-backup"); await owner.exportBackup(backup);
    const recovered = await restoreBackup(backup, f.root);
    await mkdir(join(recovered.path, "workspace", ".runloom"), { recursive: true });
    await writeFile(join(recovered.path, "workspace", ".runloom", "memory.json"), "broken");
    await assert.rejects(owner.activateRecovery(recovered.path));
    assert.equal(owner.current, bridge); assert.equal(owner.info().workspaceRoot, before.workspaceRoot);
    await assert.rejects(readFile(join(f.options.userData, "recovery-selection.json")), { code: "ENOENT" });
    assert.equal(f.counts().modelCalls, 0);
  } finally { await owner.shutdown(); await f.cleanup(); }
});

test("uncertain selection persistence freezes admission and restart reads the committed recovery pointer", async t => {
  const f = await fixture(); let owner = await RuntimeOwnership.create(f.options);
  const backup = join(f.root, "backup.serika-backup"); await owner.exportBackup(backup);
  const recovered = await restoreBackup(backup, f.root);
  const originalWorkspace = owner.info().workspaceRoot;
  const probe = await open(f.root, "r"), prototype = Object.getPrototypeOf(probe); await probe.close();
  const originalSync = prototype.sync, originalShutdown = DesktopRuntime.prototype.shutdown;
  let stopped = false, faulted = false;
  const stop = t.mock.method(DesktopRuntime.prototype, "shutdown", async function(this: DesktopRuntime) {
    await originalShutdown.call(this); stopped = true;
  });
  const sync = t.mock.method(prototype, "sync", async function(this: { stat(): Promise<{ isDirectory(): boolean }> }) {
    if (stopped && !faulted && (await this.stat()).isDirectory()) { faulted = true; throw new Error("selection directory sync fault"); }
    return originalSync.call(this);
  });
  try {
    await assert.rejects(owner.activateRecovery(recovered.path), /恢复入口保存结果未确认/);
    sync.mock.restore(); stop.mock.restore();
    assert.equal(faulted, true); assert.equal(owner.info().workspaceRoot, originalWorkspace);
    assert.equal(owner.info().runtimeRecovery?.state, "failed");
    assert.throws(() => owner.current, /退出重开/); await assert.rejects(owner.retryConnection(), /退出重开/);
    await owner.shutdown(); owner = await RuntimeOwnership.create(f.options);
    assert.equal(owner.info().workspaceRoot, join(recovered.path, "workspace"));
    assert.equal(owner.info().runtimeRecovery?.state, undefined); assert.equal(f.counts().modelCalls, 0);
  } finally { sync.mock.restore(); stop.mock.restore(); await owner.shutdown(); await f.cleanup(); }
});

test("explicit Thread launch overrides recovery without overwriting its saved selection", async () => {
  const f = await fixture(); let owner = await RuntimeOwnership.create(f.options);
  try {
    const backup = join(f.root, "backup.serika-backup"); await owner.exportBackup(backup);
    const recovered = await restoreBackup(backup, f.root); await owner.activateRecovery(recovered.path);
    const pointer = await readFile(join(f.options.userData, "recovery-selection.json"));
    await owner.shutdown();
    owner = await RuntimeOwnership.create({ ...f.options, env: { ...f.options.env, RUNLOOM_THREAD: "explicit-thread" } });
    assert.equal(owner.info().threadId, "explicit-thread"); assert.equal(owner.info().workspaceRoot, join(f.root, "workspace"));
    await assert.rejects(owner.activateRecovery(recovered.path), /显式指定/);
    assert.deepEqual(await readFile(join(f.options.userData, "recovery-selection.json")), pointer);
    assert.equal(f.counts().modelCalls, 0);
  } finally { await owner.shutdown(); await f.cleanup(); }
});

test("a failed enable confirmed unregistered restores the same local identity without model replay", async () => {
  const f = await fixture();
  const owner = await RuntimeOwnership.create(f.options);
  try {
    const before = owner.info(), bridge = owner.current;
    await assert.rejects(owner.setResidentEnabled(true), /测试注册失败/);
    assert.notEqual(owner.current, bridge);
    assert.equal(owner.info().threadId, before.threadId);
    assert.equal(owner.info().directory, before.directory);
    assert.equal(owner.info().workspaceRoot, before.workspaceRoot);
    assert.equal(owner.current.snapshot().state.kind, "idle");
    assert.deepEqual(await owner.current.listRuns(), { ok: true, runs: [], modelUsage: { calls: [], droppedCount: 0 } });
    assert.deepEqual(f.counts(), { enableCalls: 1, disableCalls: 0, modelCalls: 0 });
  } finally { await owner.shutdown(); await f.cleanup(); }
});

for (const finalState of [{ ok: false, registered: false }, { ok: true, registered: true }] as const) {
  test(`failed enable does not start a second local owner when recovery state is ${JSON.stringify(finalState)}`, async () => {
    const f = await fixture();
    const owner = await RuntimeOwnership.create(f.options);
    const create = DesktopRuntime.create.bind(DesktopRuntime);
    const spy = mock.method(DesktopRuntime, "create", (...args: Parameters<typeof create>) => create(...args));
    f.onEnable(async () => { f.observe(finalState); return { ...f.state(), ok: false, message: "常驻助手测试注册失败" }; });
    try {
      await assert.rejects(owner.setResidentEnabled(true), /测试注册失败/);
      assert.equal(spy.mock.callCount(), 0);
      assert.throws(() => owner.current, /不会启动第二个宿主/);
      assert.equal(owner.info().runtimeRecovery?.state, "failed");
      assert.equal(f.counts().modelCalls, 0);
    } finally { spy.mock.restore(); await owner.shutdown(); await f.cleanup(); }
  });
}

test("ownership transfer reserves admission synchronously and shutdown waits for its settlement", async () => {
  const f = await fixture();
  const owner = await RuntimeOwnership.create(f.options);
  const entered = deferred<void>(), release = deferred<ResidentServiceState>();
  f.onEnable(async () => { entered.resolve(); return release.promise; });
  try {
    const change = owner.setResidentEnabled(true);
    // Attach rejection handling immediately; the failing result arrives later.
    const failed = assert.rejects(change, /测试注册失败/);
    await assert.rejects(owner.setResidentEnabled(false), /暂不可用/);
    await assert.rejects(owner.retryConnection(), /正在切换/);
    await entered.promise;
    let settled = false;
    const stop = owner.shutdown().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release.resolve({ ...f.state(), ok: false, message: "常驻助手测试注册失败" });
    await failed;
    await stop;
    assert.equal(settled, true);
    assert.deepEqual(f.counts(), { enableCalls: 1, disableCalls: 0, modelCalls: 0 });
  } finally { release.resolve({ ...f.state(), ok: false }); await owner.shutdown(); await f.cleanup(); }
});

test("resident startup does not replace an existing service identity or accept private data fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-resident-startup-"));
  const path = join(root, "identity.json");
  const initial = residentStartup(join(root, "profile"), root, { RUNLOOM_CONFIG: join(root, "config.json"), DEEPSEEK_API_KEY: "do-not-store" });
  try {
    await saveResidentStartup(path, initial, false);
    await saveResidentStartup(path, initial, true);
    await assert.rejects(saveResidentStartup(path, { ...initial, userData: join(root, "other-profile") }, true), /另一份启动身份/);
    assert.deepEqual(await readResidentStartup(path), initial);
    await writeFile(path, JSON.stringify({ ...initial, env: { ...initial.env, DEEPSEEK_API_KEY: "forbidden" } }));
    await assert.rejects(readResidentStartup(path), /启动身份无效/);
    await writeFile(path, JSON.stringify(initial));
    await chmod(path, 0o644);
    await assert.rejects(readResidentStartup(path), /权限或大小无效/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
