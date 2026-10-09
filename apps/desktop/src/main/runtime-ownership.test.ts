import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
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
  const root = await mkdtemp(join(tmpdir(), "serika-runtime-ownership-"));
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

test("an active timer refuses ownership transfer without cancelling or registering", async () => {
  const f = await fixture();
  const owner = await RuntimeOwnership.create(f.options);
  try {
    assert.equal((await owner.current.command("/pomodoro start 3")).ok, true);
    const bridge = owner.current;
    await assert.rejects(owner.setResidentEnabled(true), /先结束番茄钟/);
    assert.equal(owner.current, bridge);
    assert.deepEqual(f.counts(), { enableCalls: 0, disableCalls: 0, modelCalls: 0 });
    assert.equal((await owner.current.command("/pomodoro status")).ok, true);
    assert.ok(f.events.some(event => event.type === "output" && /番茄钟运行中，剩余/.test(event.text)));
    assert.equal((await owner.current.command("/pomodoro cancel")).ok, true);
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
    assert.deepEqual(await owner.current.listRuns(), { ok: true, runs: [] });
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
