import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { it, mock } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ResidentClient, createResidentPaths, readResidentCredentials, startResidentServer } from "./resident-transport.js";
import { historyPage, type HistoryPageInput } from "../shared/history.js";

it("history larger than one frame crosses the real socket without disconnecting, and page reads are bounded", async t => {
  const f = await fixture();
  const messages = Array.from({ length: 280 }, (_, i) => ({ id: `large-${i}`, role: "assistant" as const, parts: [{ type: "text" as const, text: "x".repeat(64 * 1024) }] }));
  const patched = t.mock.method(f.server.runtime.current, "history", async () => messages);
  const paged = t.mock.method(f.server.runtime.current, "historyPage", async (input?: HistoryPageInput) => historyPage(messages, f.server.runtime.info().threadId, input));
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  try {
    assert(Buffer.byteLength(JSON.stringify(messages)) > 16 * 1024 * 1024);
    assert.deepEqual(await client.current.history(), messages);
    assert.equal(client.connected, true);
    const first = await client.current.historyPage();
    assert.equal(first.threadId, client.info().threadId); assert(first.beforeId);
    assert(Buffer.byteLength(JSON.stringify(first)) < 2 * 1024 * 1024);
    const older = await client.current.historyPage({ beforeId: first.beforeId });
    assert.equal(older.messages.at(-1)?.id, messages[messages.findIndex(x => x.id === first.beforeId) - 1]?.id);
    await client.refresh(); assert.equal(client.connected, true);
  } finally { patched.mock.restore(); paged.mock.restore(); client.detach(); await f.cleanup(); }
});

function response() {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text" },
    { type: "text-delta" as const, id: "text", delta: "保持运行的回复。" },
    { type: "text-end" as const, id: "text" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
async function fixture(doStream: () => Promise<ReturnType<typeof response>> = async () => response(), onStop?: () => void, memoryEnabled = false) {
  const root = await mkdtemp(`${process.platform === "darwin" ? "/private/tmp" : "/tmp"}/serika-transport-`);
  const workspace = join(root, "workspace"), applicationHome = join(root, "profile"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: memoryEnabled } } }));
  const paths = createResidentPaths(applicationHome, join(root, "socket", "host.sock"));
  const scope = { applicationHome, configPath };
  let creates = 0;
  const createRuntime = async (send: Parameters<typeof DesktopRuntime.create>[0]["send"]) => {
    creates++;
    return DesktopRuntime.create({ applicationHome, cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream }), send });
  };
  const server = await startResidentServer({ paths, scope, createRuntime, ...(onStop ? { onStop } : {}) });
  return { root, paths, scope, server, createRuntime, creates: () => creates, cleanup: async () => { await server.runtime.shutdown(); await server.close(); await rm(root, { recursive: true, force: true }); } };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("Timed out waiting for host state"); await new Promise(done => setTimeout(done, 5)); }
}

it("a detached client does not cancel the original Controller, and reconnect reloads history, output and snapshot without a second model call", async () => {
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(done => { release = done; });
  const f = await fixture(async () => { calls++; await gate; return response(); });
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  try {
    const identity = client.info();
    const run = await client.current.run("不要在断开界面时取消", { memoryConsolidation: "exclude" });
    assert.equal(run.ok, true);
    await until(() => calls === 1);
    client.detach();
    assert.equal(f.server.runtime.current.snapshot().state.kind, "running");
    f.server.runtime.current.command("/home").catch(() => undefined);
    release(); await until(() => f.server.runtime.current.snapshot().state.kind === "idle");
    await f.server.runtime.current.home();
    await client.reconnect();
    assert.equal(client.info().threadId, identity.threadId);
    assert.equal(client.current.snapshot().state.kind, "idle");
    assert.equal(client.current.snapshot().lastPrimaryResult?.text, "保持运行的回复。");
    assert.ok(client.current.snapshot().recentOutput.length > 0);
    assert.ok((await client.current.history()).some(message => message.role === "assistant"));
    assert.ok((await client.listThreads(undefined)).length > 0, "undefined optional arguments must not become JSON null");
    assert.equal(calls, 1);
  } finally { release(); client.detach(); await f.cleanup(); }
});

it("RPC failures redact configured provider secrets as well as the socket token", async () => {
  const f = await fixture();
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  const secret = "test-provider-secret-not-a-real-credential";
  const previous = process.env.SERIKA_TRANSPORT_TEST_API_KEY;
  process.env.SERIKA_TRANSPORT_TEST_API_KEY = secret;
  const patched = mock.method(f.server.runtime.current, "command", () => { throw new Error(`provider failure ${secret}`); });
  try {
    await assert.rejects(client.current.command("/home"), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret));
      assert.match(error.message, /已隐藏/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.SERIKA_TRANSPORT_TEST_API_KEY; else process.env.SERIKA_TRANSPORT_TEST_API_KEY = previous;
    patched.mock.restore(); client.detach(); await f.cleanup();
  }
});

it("explicit host stop refuses an active Run or timer, then disposes only once the host is idle", async () => {
  let release!: () => void, calls = 0, stopped = 0;
  const gate = new Promise<void>(done => { release = done; });
  const f = await fixture(async () => { calls++; await gate; return response(); }, () => { stopped++; });
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  try {
    await client.current.run("运行期间不能停止宿主", { memoryConsolidation: "exclude" });
    await until(() => calls === 1);
    await assert.rejects(client.requestStop(), /结束当前执行和番茄钟/);
    assert.equal(stopped, 0);
    release(); await until(() => f.server.runtime.current.snapshot().state.kind === "idle");
    const timer = mock.method(f.server.runtime, "getLifecycleStatus", () => ({ pomodoroRunning: true }));
    await assert.rejects(client.requestStop(), /结束当前执行和番茄钟/);
    timer.mock.restore();
    await client.requestStop(); await until(() => stopped === 1);
    await assert.rejects(client.current.run("停止后不接新工作"), /正在停止/);
  } finally { release(); client.detach(); await f.cleanup(); }
});

it("partial shutdown failure exposes an unavailable host, rejects new work and reconnect, and requests process exit", async () => {
  let stopped = 0;
  const f = await fixture(undefined, () => { stopped++; });
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  const original = f.server.runtime.shutdown.bind(f.server.runtime);
  const patched = mock.method(f.server.runtime, "shutdown", async () => { await original(); throw new Error("failure after disposing controller"); });
  try {
    await assert.rejects(client.requestStop(), /连接已不可用/);
    await until(() => stopped === 1);
    assert.equal(client.info().runtimeRecovery?.state, "failed");
    assert.equal(client.current.snapshot().canSubmit, false);
    await assert.rejects(client.current.run("不得给部分释放的控制器开新 Run"), /正在停止/);
    assert.equal(client.info().runtimeRecovery?.state, "failed", "failed state must not be overwritten by refreshing disposed runtime info");
    client.detach();
    await assert.rejects(client.reconnect(), /正在停止/);
  } finally { patched.mock.restore(); client.detach(); await f.cleanup(); }
});

it("private credentials, authentication, identity scope and single owner are enforced", async () => {
  const f = await fixture();
  try {
    assert.equal((await lstat(f.paths.token)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.paths.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(f.root, "socket"))).mode & 0o777, 0o700);
    assert.equal((await lstat(f.paths.socket)).mode & 0o777, 0o600);
    await assert.rejects(ResidentClient.connect({ paths: f.paths, scope: { ...f.scope, applicationHome: join(f.root, "wrong") }, send: () => {} }), /不匹配/);
    await assert.rejects(startResidentServer({ paths: f.paths, scope: f.scope, createRuntime: f.createRuntime }), /已经运行/);
    assert.equal(f.creates(), 1);
    const rejected = await new Promise<string>((done, reject) => {
      const socket = createConnection(f.paths.socket);
      socket.once("error", reject);
      socket.once("data", data => { socket.destroy(); done(data.toString()); });
      socket.once("connect", () => socket.write(JSON.stringify({ type: "hello", version: 1, token: "wrong", scope: f.scope }) + "\n"));
    });
    assert.match(rejected, /rejected/);
    await chmod(f.paths.token, 0o644);
    await assert.rejects(readResidentCredentials(f.paths), /权限不安全/);
    await chmod(f.paths.token, 0o600);
  } finally { await f.cleanup(); }
});

it("a lost mutating response rejects as uncertain and is never resent on reconnect", async () => {
  const f = await fixture();
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  let release!: () => void, invoked = 0;
  const gate = new Promise<void>(done => { release = done; });
  const patched = mock.method(f.server.runtime.current, "command", async () => { invoked++; await gate; return { ok: true as const }; });
  try {
    const pending = client.current.command("/home");
    const rejected = assert.rejects(pending, /可能已执行/);
    await until(() => invoked === 1);
    client.detach(); await rejected;
    release(); await client.reconnect();
    assert.equal(invoked, 1);
    assert.equal(client.current.snapshot().state.kind, "idle");
    assert.equal(Reflect.get(client.current, "shutdown"), undefined);
    assert.equal(Reflect.get(client.current, "threadActivity"), undefined);
  } finally { release(); patched.mock.restore(); client.detach(); await f.cleanup(); }
});


it("bounded attachments larger than the old frame limit cross the resident socket intact", async t => {
  const f = await fixture();
  const bytes = Buffer.alloc(4.5 * 1024 * 1024, 1);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);
  const attachments = [1, 2].map(n => ({ name: `image${n}.png`, mediaType: "image/png" as const, data: bytes.toString("base64") }));
  const patched = t.mock.method(f.server.runtime.current, "run", async (_text: string, options?: Parameters<typeof f.server.runtime.current.run>[1]) => {
    assert.deepEqual(options?.attachments, attachments);
    return { ok: true as const, runId: "transport-attachment" };
  });
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  try {
    assert.ok(Buffer.byteLength(JSON.stringify(attachments)) > 8 * 1024 * 1024);
    assert.deepEqual(await client.current.run("read", { attachments }), { ok: true, runId: "transport-attachment" });
    assert.equal(client.connected, true);
  } finally { patched.mock.restore(); client.detach(); await f.cleanup(); }
});


it("memory folder and document operations cross the real resident socket and survive reconnect", async () => {
  const f = await fixture(undefined, undefined, true);
  const client = await ResidentClient.connect({ paths: f.paths, scope: f.scope, send: () => {} });
  try {
    assert.equal(client.info().memoryLibrary, true);
    const initial = await client.current.getMemoryLibrary(); assert.ok(initial.ok);
    const folderId = randomUUID(), documentId = randomUUID();
    const folder = await client.current.changeMemoryLibrary({ operation: "create-folder", id: folderId, name: "角色设定", expectedRevision: initial.value.revision }); assert.ok(folder.ok);
    const text = "# Character\n\n温暖直接。\n";
    assert.ok((await client.current.changeMemoryLibrary({ operation: "save-document", id: documentId, title: "Character", folderId, text, entries: [], expectedRevision: folder.value.revision })).ok);
    client.detach(); await client.reconnect();
    const document = await client.current.readMemoryDocument(documentId); assert.ok(document.ok);
    assert.equal(document.value.text, text); assert.equal(document.value.folderId, folderId);
    const view = await client.current.getMemoryLibrary(); assert.ok(view.ok); assert.equal(view.value.folders[0]?.name, "角色设定");
    const forged = await client.current.changeMemoryLibrary({ operation: "save-document", id: randomUUID(), title: "forged", folderId: null, text: "no scope authority", entries: [], expectedRevision: view.value.revision, scope: { kind: "workspace" } } as Parameters<typeof client.current.changeMemoryLibrary>[0]);
    assert.equal(forged.ok ? null : forged.error.code, "INVALID_INPUT");
  } finally { client.detach(); await f.cleanup(); }
});
