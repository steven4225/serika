import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ResidentClient, createResidentPaths, startResidentServer } from "./resident-transport.js";
import { TelegramGateway } from "./telegram-gateway.js";
import { TelegramStore } from "./telegram-store.js";
import { TelegramApiError, createTelegramApi, type TelegramApi, type TelegramUpdate } from "./telegram-api.js";
import { createTaskStore } from "@serika/assistant";
import { RSS_DIGEST_TASK_PROMPT } from "@serika/assistant/testing";
import { formatLocalTaskTime } from "@serika/assistant";

function response(tool?: { name: string; input: unknown }, text = "已完成请求。", callId = "call-1") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(tool ? [{ type: "tool-call" as const, toolCallId: callId, toolName: tool.name, input: JSON.stringify(tool.input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: text }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Telegram state did not settle"); await new Promise(done => setTimeout(done, 5)); }
}
const update = (id: number, text: string, userId = 42, type = "private", messageId = id): TelegramUpdate => ({ update_id: id,
  message: { message_id: messageId, date: 1, text, chat: { id: userId, type }, from: { id: userId, is_bot: false, first_name: "Owner" } } });
it("bound TG owner queries actual capability registration without a model, tools or config writes", async () => {
  const f = await fixture();
  try {
    await f.bind();
    await f.gateway.receive(update(2, "/capabilities"));
    assert.equal(f.calls(), 0);
    assert.match(f.sent.join("\n"), /read_file/);
    assert.match(f.sent.join("\n"), /CUA：未配置/);
    assert.match(f.sent.join("\n"), /服务和系统权限尚未检查/);
    assert.equal(f.host.info().capabilities!.modules.find(item => item.id === "shell")!.state, "disabled");
  } finally { await f.cleanup(); }
});
it("TG capability queries never present cached registration as current during runtime recovery", async t => {
  const f = await fixture();
  try {
    await f.bind();
    const snapshot = f.host.channelSnapshot();
    t.mock.method(f.host, "channelSnapshot", () => ({ ...snapshot, info: { ...snapshot.info, runtimeRecovery: { state: "failed" as const, message: "offline" } } }));
    await f.gateway.receive(update(2, "/capabilities"));
    assert.match(f.sent.join("\n"), /缓存配置不能证明当前能力/);
    assert.doesNotMatch(f.sent.join("\n"), /read_file/);
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});
async function fixture(stream: (call: number, prompt?: string) => Promise<ReturnType<typeof response>> = async () => response(), backgroundReady = true, shellEnabled = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-telegram-unit-")));
  const workspace = join(root, "workspace"), applicationHome = join(root, "profile"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectory: workspace, modules: { "read-file": { enabled: true }, memory: { enabled: false }, shell: { enabled: shellEnabled }, task: { enabled: true } } }));
  let calls = 0;
  let time = Date.now(), activations = 0;
  const host = await DesktopRuntime.create({ applicationHome, cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock",
    model: new MockLanguageModelV3({ doStream: async ({ prompt }) => stream(++calls, JSON.stringify(prompt)) }), send: () => {},
    taskAutomation: { status: async () => ({ available: true, registered: true, running: backgroundReady, ready: backgroundReady, todoistPlanningAvailable: false }), enable: async () => { activations++; return { enabled: backgroundReady, ready: backgroundReady }; } } });
  const store = new TelegramStore(join(applicationHome, "resident", "telegram.json"), applicationHome);
  await store.load();
  const sent: string[] = [];
  const keyboards: { messageId: number; markup: unknown }[] = [], answered: string[] = [];
  let sends = 0, sendError: TelegramApiError | undefined;
  const api: TelegramApi = { identity: async () => ({ id: 100, username: "serika_test" }), webhook: async () => ({ url: "" }),
    updates: async (_offset, signal) => new Promise(resolve => { if (signal.aborted) resolve([]); else signal.addEventListener("abort", () => resolve([]), { once: true }); }),
    send: async (_chat, text, _signal, _format, markup) => { sends++; if (sendError) throw sendError; sent.push(text); if (markup) keyboards.push({ messageId: sends, markup }); return sends; },
    answerCallback: async id => { answered.push(id); } };
  const gateway = new TelegramGateway(host, store, api, () => time);
  host.attachTelegram(gateway);
  await gateway.initialize();
  const bind = async () => {
    await gateway.setEnabled(true); const code = gateway.beginPairing().pairing!.code;
    await gateway.receive(update(1, `/start ${code}`));
    assert.equal(store.snapshot().owner, null, "private message alone must not own the assistant");
    await gateway.confirmPairing(code);
  };
  return { root, workspace, host, store, gateway, api, sent, keyboards, answered, bind, calls: () => calls, sends: () => sends,
    activations: () => activations,
    failSend: (error: TelegramApiError | undefined) => { sendError = error; },
    advanceTime: (ms: number) => { time += ms; }, now: () => time,
    cleanup: async () => { await host.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

it("Telegram receive clock is persisted at +08:00 and used for relative reminders despite delayed admission", async () => {
  let promptText = "";
  const f = await fixture(async (_n, prompt) => { promptText = prompt ?? ""; return response(); });
  try {
    await f.bind();
    const receivedAt = formatLocalTaskTime(new Date(f.now()), "Asia/Shanghai");
    const original = f.host.channelRun.bind(f.host);
    f.host.channelRun = async (...args) => { f.advanceTime(45_000); return original(...args); };
    await f.gateway.receive(update(2, "两分钟后提醒我喝水。"));
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    const input = f.store.snapshot().inputs.find(x => x.key === "42:2")!;
    assert.equal((input as typeof input & { receivedAt?: string }).receivedAt, receivedAt);
    assert.ok(promptText.includes(`message was received at ${receivedAt}`), "the model must use this input clock, not an earlier conversation or run clock");
    await f.gateway.receive(update(2, "两分钟后提醒我喝水。"));
    assert.equal((f.store.snapshot().inputs.find(x => x.key === "42:2") as typeof input & { receivedAt?: string }).receivedAt, receivedAt);
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

const reminder = { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 } as const;
const callback = (id: number, data: string, messageId: number, userId = 42): TelegramUpdate => ({ update_id: id,
  callback_query: { id: `callback-${id}`, data, from: { id: userId, is_bot: false, first_name: "Owner" },
    message: { message_id: messageId, chat: { id: userId, type: "private" }, from: { id: 100, is_bot: true, first_name: "Serika" } } } });

it("package2: phone button saves one reminder, emits host readback, and delivers its due result once", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "手机按钮提醒", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined, "模型乱说：保存失败，请去电脑批准。"));
  try {
    await f.bind(); await f.gateway.receive(update(2, "两分钟后提醒我喝水"));
    await until(() => f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "submitted"));
    const approval = f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))!;
    assert.equal(f.keyboards.length, 1, "phone confirmation must have inline controls");
    const markup = f.keyboards[0]!.markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    const allow = markup.inline_keyboard[0]![0]!.callback_data;
    assert.equal(markup.inline_keyboard[0]![0]!.text, "确认保存");
    assert.match(approval.text, /北京时间|UTC\+08:00/);
    assert.ok(approval.text.length < 650, "primary phone preview must be compact");
    await f.gateway.receive(callback(3, allow, approval.messageId!));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    assert.ok(f.answered.includes("callback-3"));
    assert.ok(f.sent.some(text => /已定：|已记下：/.test(text)), "persisted tool result, not model prose, supplies the readback");
    assert.ok(!f.sent.some(text => text.includes("模型乱说")));
    const route = f.store.snapshot().routes[0]!;
    await f.gateway.receive(callback(4, allow, approval.messageId!));
    assert.equal(f.activations(), 1);
    const tasks = createTaskStore(join(f.root, "profile", "data/tasks.json"), { now: () => Date.now() + 180_000 });
    const claimed = await tasks.claimNextDue(); assert(claimed.ok && claimed.value);
    assert.equal(claimed.value.id, route.id);
    const finished = await tasks.finish(route.id, { status: "completed", execution: "deterministic", runId: null, resultText: "手机按钮提醒到点了", notification: true }); assert(finished.ok);
    await f.gateway.collectScheduledResults(); await f.gateway.collectScheduledResults();
    assert.equal(f.sent.filter(text => text.includes("手机按钮提醒到点了")).length, 1);
    assert.equal(f.calls(), 2, "control messages and scheduled delivery do not start extra model calls");
    assert.equal((await f.host.current.history()).filter(x => x.role === "user").length, 1);
  } finally { await f.cleanup(); }
});

for (const render of [ (code: string) => `允许${code.toLowerCase()}`, (code: string) => `允许：\n${code}`, (code: string) => `允许　 ${code}` ]) {
  it(`package2: phone approval spelling ${render("ABCDEF1234")} bypasses busy admission`, async () => {
    const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "兼容短码", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined));
    try {
      await f.bind(); await f.gateway.receive(update(2, "两分钟后提醒我"));
      await until(() => f.sent.some(x => x.includes("需要你确认 · 创建提醒")));
      const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 创建提醒"))!)![1]!;
      await f.gateway.receive(update(3, render(code)));
      assert.doesNotMatch(f.sent.at(-1)!, /正在处理其他消息/);
      assert.equal(f.host.current.snapshot().pendingApproval, null);
      await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
      assert.equal(f.activations(), 1);
    } finally { await f.cleanup(); }
  });
}

it("package2: incomplete phone control is not a new chat and a denied reminder cannot get model success copy", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "不要保存", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined, "已定：我擅自说成功"));
  try {
    await f.bind(); await f.gateway.receive(update(2, "提醒我"));
    await until(() => f.sent.some(x => x.includes("需要你确认 · 创建提醒")));
    await f.gateway.receive(update(3, "允许id"));
    assert.doesNotMatch(f.sent.at(-1)!, /正在处理其他消息/);
    assert.ok(f.host.current.snapshot().pendingApproval);
    const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 创建提醒"))!)![1]!;
    await f.gateway.receive(update(4, `拒绝${code}`));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    assert.equal(f.store.snapshot().routes.length, 0);
    assert.ok(!f.sent.some(x => x.includes("我擅自说成功")));
    assert.ok(f.sent.some(x => x.includes("未保存")));
  } finally { await f.cleanup(); }
});

it("package2: saved reminder retains the background-unavailable warning and survives gateway restart", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "后台不可用", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined, "已定，保证准点送达"), false);
  let restarted: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.receive(update(2, "提醒我"));
    await until(() => f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "submitted"));
    const approval = f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))!;
    const code = /允许 ([A-F0-9]{10})/.exec(approval.text)![1]!;
    await f.gateway.receive(callback(3, `allow:${code}`, approval.messageId!));
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    const result = f.store.snapshot().deliveries.find(x => x.key === "result:42:2")!;
    assert.match(result.text, /已记下：/); assert.match(result.text, /后台当前不可用或尚未就绪/);
    assert.doesNotMatch(result.text, /保证准点/);
    assert.equal(f.store.snapshot().routes.length, 1, "save and delivery route survive unavailable worker");
    await f.gateway.close();
    const sends = f.sends(), store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    assert.ok(store.snapshot().inputs.find(x => x.key === "42:2")?.reminderReceipts?.[0]?.text.includes("后台当前不可用"));
    restarted = new TelegramGateway(f.host, store, f.api); await restarted.initialize(); await restarted.start();
    await restarted.receive(callback(4, `allow:${code}`, approval.messageId!));
    assert.equal(f.activations(), 1); assert.equal(f.calls(), 2);
    assert.equal(f.sent.filter(text => text === result.parts![0]!.text).length, 1);
    assert.ok(f.sends() > sends, "stale callback gets a refusal, never a new creation");
  } finally { await restarted?.close(); await f.cleanup(); }
});

it("package2: copied or foreign callback cannot consume a valid confirmation; callback answer failure never replays it", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "精确绑定", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined));
  try {
    await f.bind(); await f.gateway.receive(update(2, "提醒我"));
    await until(() => f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "submitted"));
    const approval = f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))!;
    const code = /允许 ([A-F0-9]{10})/.exec(approval.text)![1]!;
    const foreign = callback(3, `allow:${code}`, approval.messageId!); foreign.callback_query!.from.id = 43;
    await f.gateway.receive(foreign);
    await f.gateway.receive(callback(4, `allow:${code}`, approval.messageId! + 1));
    assert.ok(f.host.current.snapshot().pendingApproval); assert.equal(f.activations(), 0);
    f.api.answerCallback = async () => { throw new TelegramApiError("NETWORK", "unknown"); };
    await f.gateway.receive(callback(5, `allow:${code}`, approval.messageId!));
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    await f.gateway.receive(callback(5, `allow:${code}`, approval.messageId!));
    await f.gateway.receive(callback(6, `allow:${code}`, approval.messageId!));
    assert.equal(f.activations(), 1); assert.equal(f.calls(), 2);
    assert.equal(f.store.snapshot().routes.length, 1);
  } finally { await f.cleanup(); }
});

for (const invalidation of ["expired", "desktop"] as const) {
  it(`package2: ${invalidation} phone buttons grant nothing and stop remains a control`, async () => {
    const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "过期按钮", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined));
    try {
      await f.bind(); await f.gateway.receive(update(2, "提醒我"));
      await until(() => f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "submitted"));
      const approval = f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))!;
      const code = /允许 ([A-F0-9]{10})/.exec(approval.text)![1]!;
      if (invalidation === "expired") f.advanceTime(5 * 60_000 + 1);
      else f.host.current.confirm({ approvalId: f.host.current.snapshot().pendingApproval!.approvalId, decision: "deny" });
      await f.gateway.receive(callback(3, `allow:${code}`, approval.messageId!));
      assert.equal(f.activations(), 0);
      assert.ok(f.sent.some(x => x.includes("没有批准任何操作")));
      if (invalidation === "expired") {
        await f.gateway.receive(update(4, "停止"));
        await until(() => f.host.current.snapshot().state.kind === "idle");
        await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
        assert.match(f.store.snapshot().deliveries.find(x => x.key === "result:42:2")!.text, /提醒未保存/);
        assert.ok(!f.sent.some(x => x.includes("本条未排队")));
      }
      assert.equal(f.store.snapshot().routes.length, 0);
    } finally { await f.cleanup(); }
  });
}

it("package2: invalid schedule returns a host failure instead of model success", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "过期时间", runAt: "2020-01-01T00:00:00Z", arrangement: reminder } } : undefined, "已定：无视失败"));
  try {
    await f.bind(); await f.gateway.receive(update(2, "提醒我"));
    await until(() => f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "submitted"));
    const approval = f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))!;
    const code = /允许 ([A-F0-9]{10})/.exec(approval.text)![1]!;
    await f.gateway.receive(callback(3, `allow:${code}`, approval.messageId!));
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    const result = f.store.snapshot().deliveries.find(x => x.key === "result:42:2")!;
    assert.match(result.text, /这条提醒未保存/); assert.doesNotMatch(result.text, /无视失败/);
    assert.equal(f.activations(), 0); assert.equal(f.store.snapshot().routes.length, 0);
  } finally { await f.cleanup(); }
});

it("package2: uncertain reminder commit is reported as unknown, not unsaved, and repeated approval never recreates it", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "未知写入", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined, "模型虚报成功"));
  try {
    await f.bind(); await f.gateway.receive(update(2, "提醒我"));
    await until(() => f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "submitted"));
    const approval = f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))!;
    const code = /允许 ([A-F0-9]{10})/.exec(approval.text)![1]!;
    const directory = join(f.root, "profile", "data"), target = await stat(directory);
    const probe = await open(directory, "r"), prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync;
    await probe.close(); let injected = false;
    const fault = t.mock.method(prototype, "sync", async function (this: typeof probe) {
      const current = await this.stat();
      if (!injected && current.isDirectory() && current.ino === target.ino && current.dev === target.dev) {
        injected = true; throw new Error("task directory acknowledgement failed");
      }
      return originalSync.call(this);
    });
    try {
      await f.gateway.receive(callback(3, `allow:${code}`, approval.messageId!));
      await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    } finally { fault.mock.restore(); }
    assert.ok(injected);
    const result = f.store.snapshot().deliveries.find(x => x.key === "result:42:2")!;
    assert.match(result.text, /保存结果未知/); assert.doesNotMatch(result.text, /这条提醒未保存|模型虚报成功/);
    assert.equal(f.store.snapshot().inputs.find(x => x.key === "42:2")?.state, "unknown");
    const saved = await createTaskStore(join(f.root, "profile", "data/tasks.json")).list({ limit: 50 }); assert(saved.ok);
    assert.equal(saved.value.tasks.length, 1, "rename happened even though acknowledgement failed");
    await f.gateway.receive(callback(4, `allow:${code}`, approval.messageId!));
    assert.equal(f.activations(), 0); assert.equal(f.calls(), 1);
    const after = await createTaskStore(join(f.root, "profile", "data/tasks.json")).list({ limit: 50 }); assert(after.ok && after.value.tasks.length === 1);
  } finally { await f.cleanup(); }
});

for (const outcome of ["not_sent", "unknown"] as const) {
  it(`package2: ${outcome} host receipt send does not undo or recreate a saved reminder`, async () => {
    const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "回执断网", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined, "忽略程序回执"));
    try {
      await f.bind(); await f.gateway.receive(update(2, "提醒我"));
      await until(() => f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "submitted"));
      const approval = f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))!;
      const code = /允许 ([A-F0-9]{10})/.exec(approval.text)![1]!;
      f.failSend(new TelegramApiError(outcome === "not_sent" ? "400" : "NETWORK", outcome));
      await f.gateway.receive(callback(3, `allow:${code}`, approval.messageId!));
      const state = outcome === "not_sent" ? "failed" : "unknown";
      await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === state);
      const result = f.store.snapshot().deliveries.find(x => x.key === "result:42:2")!;
      assert.match(result.text, /已定：/); assert.doesNotMatch(result.text, /忽略程序回执/);
      f.failSend(undefined);
      if (outcome === "not_sent") await f.gateway.retryDelivery(result.key);
      else await assert.rejects(f.gateway.retryDelivery(result.key), /未知/);
      assert.equal(f.activations(), 1); assert.equal(f.calls(), 2);
      const saved = await createTaskStore(join(f.root, "profile", "data/tasks.json")).list({ limit: 50 }); assert(saved.ok && saved.value.tasks.length === 1);
    } finally { await f.cleanup(); }
  });
}
it("formatted multipart result retries only the definitely rejected part after reopen, never the Run", async () => {
  const f = await fixture(async () => response(undefined, '# 报告\n\n' + '长文😀 '.repeat(1800)));
  let restarted: TelegramGateway | undefined;
  try {
    await f.bind();
    const send = f.api.send;
    let resultSends = 0;
    const dispatched: number[] = [];
    f.api.send = async (...args) => {
      assert.equal(args[3], 'HTML');
      dispatched.push(performance.now());
      if (++resultSends === 2) throw new TelegramApiError('429', 'not_sent', 1);
      return send(...args);
    };
    await f.gateway.receive(update(2, '返回长报告'));
    const key = 'result:42:2';
    await until(() => f.store.snapshot().deliveries.find(x => x.key === key)?.state === 'failed');
    const before = f.store.snapshot().deliveries.find(x => x.key === key)!;
    assert.equal(before.parts![0]!.state, 'submitted');
    assert.equal(before.parts![1]!.state, 'failed');
    assert.ok(dispatched[1]! - dispatched[0]! >= 1000, 'additional parts are paced');
    assert.ok(before.parts!.length > 2);
    await assert.rejects(f.gateway.retryDelivery(key), /限流/);
    const firstText = before.parts![0]!.text;
    await f.gateway.close(); f.advanceTime(2000);
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    restarted = new TelegramGateway(f.host, store, f.api, f.now); await restarted.initialize(); await restarted.start();
    assert.equal(resultSends, 2, 'definite failures also require explicit retry');
    await restarted.retryDelivery(key);
    const after = store.snapshot().deliveries.find(x => x.key === key)!;
    assert.equal(after.state, 'submitted');
    assert.ok(after.parts!.every(part => part.state === 'submitted'));
    assert.equal(f.sent.filter(text => text === firstText).length, 1);
    assert.equal(resultSends, after.parts!.length + 1);
    assert.equal(f.calls(), 1);
  } finally { await restarted?.close(); await f.cleanup(); }
});

it("an ambiguous multipart send stops remaining parts and stays blocked after restart", async () => {
  const f = await fixture(async () => response(undefined, '正文'.repeat(6000)));
  let restarted: TelegramGateway | undefined;
  try {
    await f.bind();
    const send = f.api.send; let attempts = 0;
    f.api.send = async (...args) => { if (++attempts === 2) throw new TelegramApiError('NETWORK', 'unknown'); return send(...args); };
    await f.gateway.receive(update(2, '长回复'));
    const key = 'result:42:2';
    await until(() => f.store.snapshot().deliveries.find(x => x.key === key)?.state === 'unknown');
    const delivery = f.store.snapshot().deliveries.find(x => x.key === key)!;
    assert.deepEqual(delivery.parts!.slice(0, 3).map(x => x.state), ['submitted', 'unknown', 'pending']);
    await f.gateway.close();
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    restarted = new TelegramGateway(f.host, store, f.api); await restarted.initialize(); await restarted.start();
    await assert.rejects(restarted.retryDelivery(key), /未知/);
    assert.equal(attempts, 2);
    assert.equal(f.calls(), 1);
  } finally { await restarted?.close(); await f.cleanup(); }
});

it("a crash in a persisted part dispatch does not restore send permission", async () => {
  const f = await fixture(); let restarted: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.close();
    await f.store.update(data => data.deliveries.push({ key: 'result:crash', chatId: 42, text: 'long', state: 'sending', messageId: 9,
      parts: [{ text: '1/3\nfirst', state: 'submitted', messageId: 9 }, { text: '2/3\nsecond', state: 'sending', messageId: null }, { text: '3/3\nthird', state: 'pending', messageId: null }] }));
    const sends = f.sends();
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    restarted = new TelegramGateway(f.host, store, f.api); await restarted.initialize(); await restarted.start();
    assert.equal(store.snapshot().deliveries.at(-1)!.state, 'unknown');
    assert.equal(store.snapshot().deliveries.at(-1)!.parts![1]!.state, 'unknown');
    assert.equal(f.sends(), sends);
    assert.equal(f.calls(), 0);
  } finally { await restarted?.close(); await f.cleanup(); }
});
it("Telegram result copy: ordinary replies omit gateway wrappers without changing model prose or Run linkage", async () => {
  const texts = ["已完成请求。", "正文中提到本轮已结束。\nRun: 用户自己给出的编号\n但后台当前不可用，到点不会执行。"];
  const f = await fixture(async n => response(undefined, texts[n - 1]));
  try {
    await f.bind();
    for (const [index, text] of texts.entries()) {
      const id = index + 2, key = `result:42:${id}`;
      await f.gateway.receive(update(id, "只回复原文"));
      await until(() => f.store.snapshot().deliveries.find(x => x.key === key)?.state === "submitted");
      const source = f.store.snapshot().inputs.find(x => x.key === `42:${id}`)!;
      const receipt = await f.host.channelReceipt(f.store.snapshot().owner!.threadId, source.runId!);
      assert.equal(receipt?.resultTextPreview, text);
      assert.equal(f.store.snapshot().deliveries.find(x => x.key === key)?.text, text);
      assert.equal(f.sent.at(-1), text);
      assert.equal(source.state, "finished");
      await f.gateway.receive(update(id, "只回复原文"));
      assert.equal(f.calls(), index + 1, "duplicate input never reruns the model");
    }
  } finally { await f.cleanup(); }
});

for (const scenario of [
  { name: "completed", status: "completed", text: "原始回复。", expected: "原始回复。" },
  { name: "empty", status: "completed", text: " \n ", expected: "这次没有可显示的回复，请查看桌面执行记录。" },
  { name: "task", status: "completed", text: "阶段结果。", task: true, expected: "结果仍需你在桌面验收。\n阶段结果。" },
  { name: "failed", status: "failed", text: "部分回复。", expected: "这次执行失败了；操作结果请查看桌面回执。\n部分回复。" },
  { name: "cancelled", status: "cancelled", text: null, expected: "本轮已停止；已执行的操作不会撤回，操作结果请查看桌面回执。" },
  { name: "interrupted", status: "interrupted", text: "部分回复。", expected: "执行中断或效果未知，请回桌面核对；不会自动重做。\n部分回复。" },
  { name: "unknown tool", status: "completed", text: "模型声称完成。", unknown: true, expected: "执行中断或效果未知，请回桌面核对；不会自动重做。\n模型声称完成。" },
  { name: "truncated receipt", status: "completed", text: "部分回执。", truncated: true, expected: "部分回执。\n[恢复的是回执预览，已截断；完整回复请看桌面]" },
] as const) {
  it(`Telegram result copy: recovery preserves ${scenario.name} boundaries without a new Run or visible Run suffix`, async () => {
    const f = await fixture();
    let restarted: TelegramGateway | undefined;
    try {
      await f.bind(); await f.gateway.receive(update(2, "保存真实回执"));
      await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
      const source = f.store.snapshot().inputs.find(x => x.key === "42:2")!;
      const receipt = await f.host.channelReceipt(f.store.snapshot().owner!.threadId, source.runId!);
      assert(receipt);
      await f.gateway.close();
      const taskId = "task" in scenario ? "fixture-task" : null;
      await f.store.update(data => { data.inputs[0]!.state = "bound"; data.inputs[0]!.taskId = taskId; data.deliveries = []; });
      // Fault injection at the owned receipt boundary; the initial Run and Store are real.
      f.host.channelReceipt = async () => ({ ...receipt, status: scenario.status,
        ...(taskId ? { workTaskId: taskId } : {}), resultTextPreview: scenario.text,
        resultTextTruncated: "truncated" in scenario,
        tools: "unknown" in scenario ? [{ toolCallId: "unknown-call", toolName: "write_file", status: "unknown", requestedAt: receipt.startedAt,
          startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, inputPreview: "{}", inputTruncated: false,
          resultPreview: null, resultTruncated: false, errorPreview: "效果未知", shell: null }] : [],
      });
      const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
      restarted = new TelegramGateway(f.host, store, f.api); await restarted.initialize(); await restarted.start();
      await until(() => store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
      const delivery = store.snapshot().deliveries.find(x => x.key === "result:42:2")!;
      assert.equal(delivery.text, scenario.expected);
      assert.equal(f.sent.at(-1), scenario.expected);
      if ("task" in scenario) assert.doesNotMatch(delivery.text, /这一轮已结束|本轮已结束|Run:/);
      assert(!delivery.text.includes(receipt.runId), "trace identity stays in records, not the bubble");
      assert.equal(store.snapshot().inputs[0]!.runId, receipt.runId);
      assert.equal(store.snapshot().inputs[0]!.state, scenario.status === "interrupted" || "unknown" in scenario ? "unknown" : "finished");
      const sends = f.sends(); await restarted.start();
      assert.equal(f.sends(), sends, "a delivered result is not sent again");
      assert.equal(f.calls(), 1, "recovery does not rerun model or tools");
    } finally { await restarted?.close(); await f.cleanup(); }
  });
}

async function savedReminder(f: Awaited<ReturnType<typeof fixture>>, route = true) {
  let clock = Date.now();
  const tasks = createTaskStore(join(f.root, "profile", "data/tasks.json"), { now: () => clock });
  const created = await tasks.create({ prompt: "提醒测试", runAt: new Date(clock + 60_000).toISOString(), arrangement: reminder });
  assert(created.ok);
  if (route) await f.gateway.setTaskRoute({ id: created.value.id, kind: "once", enabled: true });
  return { tasks, id: created.value.id, finish: async (notification = true) => {
    clock += 61_000;
    const claimed = await tasks.claimNextDue(); assert(claimed.ok && claimed.value?.id === created.value.id);
    assert((await tasks.finish(created.value.id, { status: "completed", execution: "deterministic", runId: null, resultText: "提醒测试", notification })).ok);
  } };
}

it("approved Telegram arrangement saves the exact destination before worker activation, no second scheduler", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "手机提醒", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined));
  try {
    await f.bind(); await f.gateway.receive(update(2, "两分钟后提醒我"));
    await until(() => f.sent.some(x => x.includes("需要你确认 · 创建提醒")));
    const preview = f.sent.find(x => x.includes("需要你确认 · 创建提醒"))!;
    assert.match(preview, /结果将发送到当前 TG 私聊/);
    assert.match(f.host.current.snapshot().pendingApproval!.preview!, /Telegram 已绑定私聊 42/, "desktop and Telegram share destination disclosure");
    assert.equal(f.store.snapshot().routes.length, 0);
    assert.equal(f.activations(), 0);
    const code = /允许 ([A-F0-9]{10})/.exec(preview)![1]!;
    await f.gateway.receive(update(3, `允许 ${code}`));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    const route = f.store.snapshot().routes[0]!;
    assert.equal(route.sourceRunId, f.store.snapshot().inputs.find(x => x.key === "42:2")!.runId);
    assert.equal(route.chatId, 42);
    const saved = await createTaskStore(join(f.root, "profile", "data/tasks.json")).get(route.id); assert(saved.ok && saved.value?.status === "scheduled");
    assert.equal(f.activations(), 1);
    await f.gateway.receive(update(4, `允许 ${code}`));
    assert.equal(f.store.snapshot().routes.length, 1);
    assert.equal(f.activations(), 1);
  } finally { await f.cleanup(); }
});

it("old or unselected results stay local; selected outcomes deliver once even when task capability is off", async () => {
  const f = await fixture();
  try {
    await f.bind();
    const local = await savedReminder(f, false); await local.finish();
    await f.gateway.collectScheduledResults();
    assert(!f.store.snapshot().deliveries.some(x => x.key === `scheduled:${local.id}`));
    await assert.rejects(f.gateway.setTaskRoute({ id: local.id, kind: "once", enabled: true }), /未结束/);
    await assert.rejects(f.gateway.setTaskRoute({ id: "foreign", kind: "once", enabled: true }), /当前工作区/);
    const selected = await savedReminder(f); await selected.finish();
    await f.host.setModuleEnabled({ id: "task", enabled: false, expectedEnabled: true });
    const calls = f.calls();
    await f.gateway.collectScheduledResults(); await f.gateway.collectScheduledResults();
    assert.equal(f.store.snapshot().deliveries.filter(x => x.key === `scheduled:${selected.id}`).length, 1);
    assert.equal(f.store.snapshot().deliveries.find(x => x.key === `scheduled:${selected.id}`)?.state, "submitted");
    assert.equal(f.calls(), calls);
  } finally { await f.cleanup(); }
});

it("a definite send failure can retry only delivery; concurrent, unknown and stale approval retries cannot replay", async () => {
  const f = await fixture();
  try {
    await f.bind(); const job = await savedReminder(f); await job.finish();
    const before = await readFile(join(f.root, "profile", "data/tasks.json"), "utf8");
    f.failSend(new TelegramApiError("403", "not_sent"));
    await f.gateway.collectScheduledResults();
    const key = `scheduled:${job.id}`;
    assert.equal(f.store.snapshot().deliveries.find(x => x.key === key)?.state, "failed");
    assert(f.gateway.status().deliveries.find(x => x.key === key)?.retryAllowed);
    const sends = f.sends(); f.failSend(undefined);
    const outcomes = await Promise.allSettled([f.gateway.retryDelivery(key), f.gateway.retryDelivery(key)]);
    assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(f.sends(), sends + 1);
    assert.equal(await readFile(join(f.root, "profile", "data/tasks.json"), "utf8"), before);
    assert.equal(f.calls(), 0);
    const unknown = await savedReminder(f); await unknown.finish();
    f.failSend(new TelegramApiError("NETWORK", "unknown")); await f.gateway.collectScheduledResults();
    await assert.rejects(f.gateway.retryDelivery(`scheduled:${unknown.id}`), /未知/);
    await assert.rejects(f.gateway.retryDelivery("approval:old"), /结果发送/);
    await f.gateway.collectScheduledResults();
    assert.equal(f.store.snapshot().deliveries.find(x => x.key === `scheduled:${unknown.id}`)?.state, "unknown");
  } finally { await f.cleanup(); }
});

it("handles all failed channel messages and unknown delivery observations without replay or false success", async () => {
  const f = await fixture();
  try {
    await f.bind();
    await f.store.update(data => {
      data.deliveries.push({ key: "approval:expired", chatId: 42, text: "expired approval", state: "failed", messageId: null });
      data.deliveries.push({ key: "result:unknown", chatId: 42, text: "unknown result", state: "unknown", messageId: null });
      data.deliveries.push({ key: "result:sending", chatId: 42, text: "sending", state: "sending", messageId: null });
    });
    assert(f.gateway.status().deliveries.some(x => x.key === "approval:expired"));
    const sends = f.sends(), calls = f.calls();
    await f.gateway.resolveDelivery({ key: "approval:expired", action: "cancel" });
    await assert.rejects(f.gateway.resolveDelivery({ key: "result:sending", action: "cancel" }), /发送中/);
    await assert.rejects(f.gateway.resolveDelivery({ key: "result:unknown", action: "cancel" }), /结果未知/);
    await assert.rejects(f.gateway.resolveDelivery({ key: "result:unknown", action: "review", note: " " }), /实际核对/);
    await f.gateway.resolveDelivery({ key: "result:unknown", action: "review", note: "手机收到了一份；不再尝试发送" });
    const record = f.store.snapshot().deliveries.find(x => x.key === "result:unknown")!;
    assert.equal(record.state, "unknown"); assert.equal(record.messageId, null); assert(record.reviewReport);
    assert.equal(f.sends(), sends); assert.equal(f.calls(), calls);
  } finally { await f.cleanup(); }
});

it("reopening reconstructs a missing pending result from TaskStore without calling model, but never retries unknown send", async () => {
  const f = await fixture(); let restored: TelegramGateway | undefined;
  try {
    await f.bind(); const job = await savedReminder(f); await job.finish();
    await f.gateway.close();
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    restored = new TelegramGateway(f.host, store, f.api); await restored.initialize();
    await until(() => store.snapshot().deliveries.find(x => x.key === `scheduled:${job.id}`)?.state === "submitted");
    assert.equal(f.calls(), 0);
    const sends = f.sends(); await restored.collectScheduledResults(); assert.equal(f.sends(), sends);
  } finally { await restored?.close(); await f.cleanup(); }
});

it("recurring opt-in excludes old history, pages past 50, and respects the persisted RSS no-new-item outcome", async () => {
  const f = await fixture();
  try {
    await f.bind();
    let clock = Date.now();
    const tasks = createTaskStore(join(f.root, "profile", "data/tasks.json"), { now: () => clock });
    const saved = await tasks.createRecurring({ prompt: RSS_DIGEST_TASK_PROMPT, recurrence: { kind: "daily", time: "08:00", utcOffset: "+08:00" },
      arrangement: { kind: "rss-digest", source: "existing-rss-binding", notification: "new-items", declarationVersion: 1 } }); assert(saved.ok);
    clock += 86_400_000;
    const old = await tasks.claimNextDue(); assert(old.ok && old.value);
    assert((await tasks.finish(old.value.id, { status: "completed", runId: null, execution: "deterministic", resultText: "旧结果", notification: true })).ok);
    // Route time is in between the old occurrence and the next one.
    f.advanceTime(86_400_000 + 1);
    await f.gateway.setTaskRoute({ id: saved.value.id, kind: "recurring", enabled: true });
    let firstNewId = "", emptyId = "";
    for (let n = 0; n < 52; n++) {
      clock += 86_400_000;
      const claimed = await tasks.claimNextDue(); assert(claimed.ok && claimed.value);
      if (n === 0) firstNewId = claimed.value.id;
      if (n === 51) emptyId = claimed.value.id;
      assert((await tasks.finish(claimed.value.id, { status: "completed", runId: null, execution: "deterministic", resultText: n === 51 ? "无新条目" : `新结果 ${n}`, notification: n !== 51 })).ok);
    }
    await f.gateway.collectScheduledResults();
    const deliveries = f.store.snapshot().deliveries;
    assert(!deliveries.some(x => x.key === `scheduled:${old.value!.id}`));
    assert(!deliveries.some(x => x.key === `scheduled:${emptyId}`));
    assert(deliveries.some(x => x.key === `scheduled:${firstNewId}` && x.state === "submitted"));
    assert.equal(deliveries.filter(x => x.key.startsWith("scheduled:")).length, 51);
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

it("recurring delivery survives over 1000 occurrences, persists scan progress and revisits later completions", async t => {
  const f = await fixture();
  try {
    await f.bind();
    let clock = Date.now();
    const tasks = createTaskStore(join(f.root, "profile", "data/tasks.json"), { now: () => clock });
    const saved = await tasks.createRecurring({ prompt: "reminder", recurrence: { kind: "daily", time: "08:00", utcOffset: "+08:00" }, arrangement: reminder }); assert(saved.ok);
    await f.gateway.setTaskRoute({ id: saved.value.id, kind: "recurring", enabled: true });
    clock += 86_400_000;
    const claim = await tasks.claimNextDue(); assert(claim.ok && claim.value);
    assert((await tasks.finish(claim.value.id, { status: "completed", runId: null, execution: "deterministic", resultText: "result", notification: true })).ok);
    const complete = await tasks.get(claim.value.id); assert(complete.ok);
    const date = new Date(clock).toISOString();
    let pages = 0, laterDone = false;
    t.mock.method(f.host, "channelScheduledTasks", async (input: { before?: { id: string } }) => {
      pages++;
      const page = input.before ? Number(input.before.id) + 1 : 0;
      const tasks = Array.from({ length: 50 }, (_, n) => ({ id: n === 0 ? page === 0 ? "newest" : page === 20 ? "oldest" : `running-${page}` : `running-${page}-${n}`, runAt: date,
        status: n === 0 && (page === 0 || page === 20 || laterDone && page === 1) ? "completed" : "running" }));
      return { ok: true, value: { tasks, truncated: page < 21, ...(page < 21 ? { nextCursor: { createdAt: date, id: String(page) } } : {}) } };
    });
    t.mock.method(f.host, "channelScheduledTask", async (id: string) => ({ ok: true, value: { ...complete.value, id } }));
    await f.gateway.collectScheduledResults();
    assert.equal(pages, 20); assert.equal(f.store.snapshot().routes[0]?.scanBefore?.id, "19");
    assert.equal(f.store.snapshot().deliveries.find(x => x.key === "scheduled:newest")?.state, "submitted", "found results send before all history is scanned");
    await f.gateway.collectScheduledResults();
    assert.equal(pages, 22); assert.equal(f.store.snapshot().routes[0]?.scanBefore, undefined);
    assert.equal(f.store.snapshot().deliveries.find(x => x.key === "scheduled:oldest")?.state, "submitted");
    laterDone = true;
    await f.gateway.collectScheduledResults();
    assert.equal(f.store.snapshot().deliveries.find(x => x.key === "scheduled:running-1")?.state, "submitted");
    assert.equal(f.store.snapshot().deliveries.filter(x => x.key === "scheduled:newest").length, 1);
    assert.equal(f.calls(), 0);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

it("requires desktop binding; foreign, group, bot and duplicate deliveries cannot start Runs", async () => {
  const f = await fixture();
  try {
    assert.equal(f.gateway.status().enabled, false);
    await f.gateway.receive(update(0, "unconfigured"));
    assert.equal(f.store.snapshot().offset, 0);
    const desktopThread = f.host.info().threadId;
    await f.bind();
    assert.equal(f.host.info().threadId, desktopThread, "binding registers a dedicated Thread without selecting it");
    assert.notEqual(f.store.snapshot().owner!.threadId, desktopThread);
    await f.gateway.receive(update(2, "foreign", 43));
    await f.gateway.receive(update(3, "group", 42, "group"));
    const bot = update(4, "bot"); bot.message!.from!.is_bot = true;
    await f.gateway.receive(bot);
    assert.equal(f.calls(), 0);
    await f.gateway.receive(update(5, "我的偏好是短句"));
    await until(() => f.store.snapshot().inputs.some(x => x.state === "finished"));
    await f.gateway.receive(update(5, "我的偏好是短句"));
    await f.gateway.receive(update(6, "我的偏好是短句", 42, "private", 5));
    assert.equal(f.calls(), 1);
    const input = f.store.snapshot().inputs[0]!;
    assert.ok(input.runId);
    assert.equal(f.host.info().threadId, f.store.snapshot().owner!.threadId);
    assert.equal((await f.host.channelReceipt(f.host.info().threadId, input.runId!))?.runId, input.runId);
    assert.equal(f.store.snapshot().offset, 7);
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:5")?.state === "submitted");
    assert.equal(f.sent.at(-1), "已完成请求。");
    assert.equal((await f.host.current.history()).filter(x => x.role === "user").length, 1);
  } finally { await f.cleanup(); }
});

it("shares the real file approval, shortcodes are single-use and plain yes is not authority", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "demo.md", content: "telegram one write" } } : undefined));
  try {
    await f.bind();
    await f.gateway.receive(update(2, "写 demo.md"));
    await until(() => f.sent.some(x => x.includes("允许 ")));
    assert.equal(f.store.snapshot().inputs[0]!.state, "bound");
    assert.ok(f.store.snapshot().inputs[0]!.runId, "source must already be persisted before tool approval");
    await assert.rejects(readFile(join(f.workspace, "demo.md")), { code: "ENOENT" });
    await f.gateway.receive(update(3, "可以"));
    await assert.rejects(readFile(join(f.workspace, "demo.md")), { code: "ENOENT" });
    const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 写入文件"))!)![1]!;
    await f.gateway.receive(update(4, `允许 ${code}`));
    assert.match(f.sent.at(-1)!, /已处理这一次确认/);
    await until(() => f.store.snapshot().inputs[0]!.state === "finished");
    assert.equal(await readFile(join(f.workspace, "demo.md"), "utf8"), "telegram one write");
    await f.gateway.receive(update(5, `允许 ${code}`));
    assert.match(f.sent.at(-1)!, /没有批准任何操作/);
    const receipt = await f.host.channelReceipt(f.store.snapshot().owner!.threadId, f.store.snapshot().inputs[0]!.runId!);
    assert.equal(receipt?.tools.length, 1); assert.equal(receipt?.tools[0]?.status, "completed");
    assert.equal((await f.host.current.history()).filter(x => x.role === "user").length, 1, "control text never becomes consolidation material");
  } finally { await f.cleanup(); }
});

it("expired confirmation can be renewed without a new Run; both old and repeated codes grant nothing", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "renewed.md", content: "one write" } } : undefined));
  try {
    await f.bind(); await f.gateway.receive(update(2, "写 renewed.md"));
    await until(() => f.sent.some(x => x.includes("需要你确认 · 写入文件")));
    const previous = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 写入文件"))!)![1]!;
    const run = f.store.snapshot().inputs.find(x => x.key === "42:2")!.runId;
    f.advanceTime(5 * 60_000 + 1);
    await f.gateway.receive(update(3, `允许 ${previous}`));
    await assert.rejects(readFile(join(f.workspace, "renewed.md")), { code: "ENOENT" });
    await f.gateway.receive(update(4, "/confirm"));
    const refreshed = /允许 ([A-F0-9]{10})/.exec(f.sent.filter(x => x.includes("需要你确认 · 写入文件")).at(-1)!)![1]!;
    assert.notEqual(refreshed, previous); assert.equal(f.calls(), 1);
    await f.gateway.receive(update(5, `允许 ${previous}`));
    await assert.rejects(readFile(join(f.workspace, "renewed.md")), { code: "ENOENT" });
    await f.gateway.receive(update(6, `允许 ${refreshed}`));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    await f.gateway.receive(update(7, `允许 ${refreshed}`));
    assert.equal(await readFile(join(f.workspace, "renewed.md"), "utf8"), "one write");
    assert.equal(f.store.snapshot().inputs.find(x => x.key === "42:2")!.runId, run);
    assert.equal((await f.host.channelReceipt(f.store.snapshot().owner!.threadId, run!))?.tools.length, 1);
    console.log(JSON.stringify({ demo: "telegram-confirmation-renewal", expiredCodeRejected: true,
      sameRun: true, successfulWrites: 1, repeatedCodeRejected: true, transport: "scripted", telegram: "not_run" }));
  } finally { await f.cleanup(); }
});

for (const outcome of ["not_sent", "unknown"] as const) {
  it(`confirmation renewal reports ${outcome}, revokes the old code and never blindly resends it`, async () => {
    const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "renew-fault.md", content: "one write" } } : undefined));
    try {
      await f.bind(); await f.gateway.receive(update(2, "写 renew-fault.md"));
      await until(() => f.sent.some(x => x.includes("需要你确认 · 写入文件")));
      const old = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 写入文件"))!)![1]!;
      const runId = f.store.snapshot().inputs.find(x => x.key === "42:2")!.runId;
      f.advanceTime(5 * 60_000 + 1);
      f.failSend(new TelegramApiError(outcome === "not_sent" ? "403" : "NETWORK", outcome));
      await f.gateway.receive(update(3, "/confirm"));
      const notice = f.store.snapshot().deliveries.find(x => x.key === "input:42:3")!;
      assert.match(notice.text, outcome === "not_sent" ? /发送明确失败/ : /发送结果未知/);
      assert.doesNotMatch(notice.text, /已重新发出/);
      const failedApproval = f.store.snapshot().deliveries.filter(x => x.key.startsWith("approval:")).at(-1)!;
      assert.equal(failedApproval.state, outcome === "not_sent" ? "failed" : "unknown");
      const sends = f.sends();
      f.failSend(undefined); await f.gateway.collectScheduledResults();
      assert.equal(f.sends(), sends, "recovery does not retry old failed or ambiguous confirmation sends");
      await f.gateway.receive(update(4, `允许 ${old}`));
      await assert.rejects(readFile(join(f.workspace, "renew-fault.md")), { code: "ENOENT" });
      await f.gateway.receive(update(5, "当前确认"));
      const renewed = /允许 ([A-F0-9]{10})/.exec(f.sent.filter(x => x.includes("需要你确认 · 写入文件")).at(-1)!)![1]!;
      assert.notEqual(renewed, old); assert.equal(f.calls(), 1);
      assert.equal(f.store.snapshot().deliveries.find(x => x.key === failedApproval.key)?.state, outcome === "not_sent" ? "cancelled" : "unknown");
      await f.gateway.receive(update(6, `允许 ${renewed}`));
      await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
      await f.gateway.receive(update(7, `允许 ${renewed}`));
      assert.equal(await readFile(join(f.workspace, "renew-fault.md"), "utf8"), "one write");
      assert.equal((await f.host.channelReceipt(f.store.snapshot().owner!.threadId, runId!))?.tools.length, 1);
    } finally { await f.cleanup(); }
  });
}

it("restart cancels queued stale confirmation sends, preserves ambiguous sends and never restores their authority", async () => {
  const f = await fixture(); let restarted: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.close();
    await f.store.update(data => {
      data.deliveries.push(
        { key: "approval:old:AAAAAAAAAA", chatId: 42, text: "stale pending code", state: "pending", messageId: null },
        { key: "approval:old:BBBBBBBBBB", chatId: 42, text: "stale failed code", state: "failed", messageId: null },
        { key: "approval:old:CCCCCCCCCC", chatId: 42, text: "ambiguous confirmation", state: "sending", messageId: null },
        { key: "result:pending", chatId: 42, text: "saved result", state: "pending", messageId: null });
    });
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    restarted = new TelegramGateway(f.host, store, f.api); await restarted.initialize();
    await until(() => store.snapshot().deliveries.find(x => x.key === "result:pending")?.state === "submitted");
    assert.equal(store.snapshot().deliveries.find(x => x.key.endsWith("AAAAAAAAAA"))?.state, "cancelled");
    assert.equal(store.snapshot().deliveries.find(x => x.key.endsWith("BBBBBBBBBB"))?.state, "cancelled");
    assert.equal(store.snapshot().deliveries.find(x => x.key.endsWith("CCCCCCCCCC"))?.state, "unknown");
    assert(!f.sent.some(x => x === "stale pending code" || x === "stale failed code" || x === "ambiguous confirmation"));
    const sent = f.sends(); await restarted.collectScheduledResults(); assert.equal(f.sends(), sent);
    await restarted.receive(update(2, "允许 AAAAAAAAAA"));
    assert.match(f.sent.at(-1)!, /没有批准任何操作/);
    await restarted.receive(update(3, "/confirm"));
    assert.match(f.sent.at(-1)!, /当前没有/); assert.equal(f.calls(), 0);
  } finally { await restarted?.close(); await f.cleanup(); }
});

it("archived inbound message IDs still dedupe even under a different update ID", async () => {
  const f = await fixture();
  try {
    await f.bind();
    await f.store.update(data => {
      data.inputs = Array.from({ length: 513 }, (_, n) => ({ key: `42:${n + 2}`, updateId: n + 2, text: "old", state: "finished", runId: `old-${n}`, taskId: null }));
      data.offset = 515;
    });
    assert(!f.store.snapshot().inputs.some(x => x.key === "42:2"));
    await f.gateway.receive(update(515, "old repeated", 42, "private", 2));
    assert.equal(f.calls(), 0); assert.equal(f.store.snapshot().offset, 516);
    await f.gateway.receive(update(516, "fresh"));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:516")?.state === "finished");
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

it("recovering an input with a terminal receipt does not resend its archived submitted result", async () => {
  const f = await fixture(); let restarted: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.receive(update(2, "ordinary chat"));
    await until(() => f.store.snapshot().deliveries.find(x => x.key === "result:42:2")?.state === "submitted");
    await f.gateway.close();
    const sends = f.sends();
    await f.store.update(data => {
      // A recoverable channel association and an independently saved Run result.
      // Archiving the submitted envelope must not erase the send dedupe marker.
      data.inputs.find(x => x.key === "42:2")!.state = "bound";
      const result = data.deliveries.find(x => x.key === "result:42:2")!;
      data.deliveries = [result, ...Array.from({ length: 1024 }, (_, n) => ({
        key: `result:older-${n}`, chatId: 42, text: "old result", state: "submitted" as const, messageId: n + 1,
      }))];
    });
    assert(await f.store.hasDelivery("result:42:2"));
    assert(!f.store.snapshot().deliveries.some(x => x.key === "result:42:2"));
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    restarted = new TelegramGateway(f.host, store, f.api); await restarted.initialize();
    await until(() => restarted!.status().connection === "online");
    await until(() => store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    await restarted.start(); // Await receipt recovery and its delivery pass.
    assert.equal(store.snapshot().inputs.find(x => x.key === "42:2")?.state, "finished");
    assert.equal(f.calls(), 1, "saved receipts recover without re-running the model");
    assert.equal(f.sends(), sends, "archived platform submission is not sent again");
    assert(!store.snapshot().deliveries.some(x => x.key === "result:42:2"));
  } finally { await restarted?.close(); await f.cleanup(); }
});

// This fixture durably archives ~2700 records with real file/directory fsync.
// Its deadline covers disk work, not an external model or Telegram timeout.
it("a full legacy journal resumes continuous channel traffic, preserves unresolved effects and dedupes after a second restart", { timeout: 120_000 }, async () => {
  const f = await fixture(); let active: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.close();
    const data = f.store.snapshot();
    data.offset = 5000;
    data.inputs = Array.from({ length: 1024 }, (_, n) => ({ key: `42:${n + 2}`, updateId: n + 2, text: "old private message",
      state: n === 0 ? "unknown" : "finished", runId: n === 0 ? null : `old-run-${n}`, taskId: null }));
    data.deliveries = Array.from({ length: 2048 }, (_, n) => ({ key: `result:legacy-${n}`, chatId: 42, text: "old result",
      state: n === 0 ? "pending" : n === 1 ? "unknown" : n === 2 ? "failed" : n === 3 ? "sending" : "submitted",
      messageId: n < 4 ? null : n + 1 }));
    await writeFile(f.store.path, JSON.stringify(data), { mode: 0o600 });
    let store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    active = new TelegramGateway(f.host, store, f.api); await active.initialize();
    await until(() => active!.status().connection === "online" && store.snapshot().deliveries.find(x => x.key === "result:legacy-0")?.state === "submitted");
    assert.equal(active.status().awaitingReview, 1);
    assert.equal(store.snapshot().deliveries.find(x => x.key === "result:legacy-1")?.state, "unknown");
    assert.equal(store.snapshot().deliveries.find(x => x.key === "result:legacy-2")?.state, "failed");
    assert.equal(store.snapshot().deliveries.find(x => x.key === "result:legacy-3")?.state, "unknown");
    await active.receive(update(5000, "/help")); assert.equal(f.calls(), 0);
    await f.host.selectThread(store.snapshot().owner!.threadId);
    await active.reviewInput({ key: "42:2", note: "验收操作：核对该旧请求没有启动 Run；不重新执行" });
    for (let id = 5001; id <= 5005; id++) {
      await active.receive(update(id, `fresh message ${id}`));
      await until(() => store.snapshot().inputs.find(x => x.key === `42:${id}`)?.state === "finished");
      await until(() => store.snapshot().deliveries.find(x => x.key === `result:42:${id}`)?.state === "submitted");
    }
    assert.equal(f.calls(), 5);
    assert(await store.hasInput("42:3")); assert(!store.snapshot().inputs.some(x => x.key === "42:3"));
    const sends = f.sends();
    await active.close();
    store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    active = new TelegramGateway(f.host, store, f.api); await active.initialize();
    await until(() => active!.status().connection === "online");
    await active.receive(update(5006, "duplicate old message", 42, "private", 3));
    assert.equal(f.calls(), 5); assert.equal(f.sends(), sends);
    await active.receive(update(5007, "after second restart"));
    await until(() => store.snapshot().inputs.find(x => x.key === "42:5007")?.state === "finished");
    assert.equal(f.calls(), 6); assert.equal(store.snapshot().offset, 5008);
    assert.equal(store.snapshot().deliveries.find(x => x.key === "result:legacy-1")?.state, "unknown");
    console.log(JSON.stringify({ demo: "telegram-lifecycle", seededInputs: 1024, seededDeliveries: 2048,
      activeInputs: store.snapshot().inputs.length, activeDeliveries: store.snapshot().deliveries.length,
      newRuns: f.calls(), oldMessageReplays: 0, unresolvedPreserved: true, transport: "scripted", telegram: "not_run" }));
  } finally { await active?.close(); await f.cleanup(); }
});

for (const change of ["input", "owner"] as const) {
  it(`a ${change} change invalidates a short code despite matching Run and approval ID`, async t => {
    const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "bound-input.md", content: "original input" } } : undefined));
    try {
      await f.bind(); await f.gateway.receive(update(2, "写 bound-input.md"));
      await until(() => f.sent.some(x => x.includes("需要你确认 · 写入文件")));
      const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 写入文件"))!)![1]!;
      if (change === "input") {
        const original = f.host.channelSnapshot.bind(f.host);
        t.mock.method(f.host, "channelSnapshot", () => {
          const value = original();
          if (value.snapshot.pendingApproval) value.snapshot.pendingApproval = { ...value.snapshot.pendingApproval, input: { path: "other.md", content: "different complete input" } };
          return value;
        });
      } else await f.store.update(data => { data.owner = { ...data.owner!, userId: 43, chatId: 43 }; });
      await f.gateway.receive(update(3, `允许 ${code}`, change === "owner" ? 43 : 42));
      assert.match(f.sent.at(-1)!, /没有批准任何操作/);
      assert(f.host.current.snapshot().pendingApproval);
      assert.equal(f.calls(), 1);
      await assert.rejects(readFile(join(f.workspace, "bound-input.md")), { code: "ENOENT" });
      await assert.rejects(readFile(join(f.workspace, "other.md")), { code: "ENOENT" });
    } finally { t.mock.restoreAll(); await f.cleanup(); }
  });
}

it("desktop confirmation invalidates Telegram approval and busy input never steals another Thread", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "read_file", input: { path: "missing.md" } } : undefined));
  try {
    await f.bind();
    const run = await f.host.current.run("desktop request", { memoryConsolidation: "exclude" }); assert.equal(run.ok, true);
    await until(() => !!f.host.current.snapshot().pendingApproval);
    await f.gateway.receive(update(2, "停止"));
    await f.gateway.receive(update(3, "调整：another"));
    await f.gateway.receive(update(4, "IM message while desktop busy"));
    assert.equal(f.calls(), 1);
    assert.equal(f.sent.some(x => x.includes("需要你确认 ·")), false, "desktop tool details must not leak to IM");
    f.host.current.confirm({ approvalId: f.host.current.snapshot().pendingApproval!.approvalId, decision: "deny" });
    await until(() => f.host.current.snapshot().state.kind === "idle");
    await f.gateway.receive(update(5, "ordinary chat"));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:5")?.state === "finished");
    assert.equal(f.calls(), 3);
  } finally { await f.cleanup(); }
});

it("desktop handling while a confirmation send claim is persisted prevents sending the stale envelope", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "stale-send.md", content: "must not write" } } : undefined));
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const save = f.store.update.bind(f.store);
  try {
    await f.bind();
    let held = false;
    f.store.update = async change => {
      await save(change);
      if (!held && f.store.snapshot().deliveries.some(x => x.key.startsWith("approval:") && x.state === "sending")) {
        held = true; await hold;
      }
    };
    await f.gateway.receive(update(2, "write first plan"));
    await until(() => held);
    const pending = f.host.current.snapshot().pendingApproval!;
    assert.equal(f.host.current.confirm({ approvalId: pending.approvalId, decision: "deny" }).accepted, true);
    release();
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    assert(!f.sent.some(x => x.includes("需要你确认 · 写入文件")), "no stale permission envelope was sent after the awaited claim");
    assert.equal(f.store.snapshot().deliveries.find(x => x.key.startsWith("approval:"))?.state, "cancelled");
    await assert.rejects(readFile(join(f.workspace, "stale-send.md")), { code: "ENOENT" });
  } finally { release(); f.store.update = save; await f.cleanup(); }
});

it("a source-barrier failure dispatches zero model calls", async () => {
  const f = await fixture();
  try {
    await f.bind();
    const save = f.store.update.bind(f.store);
    f.store.update = change => {
      const copy = f.store.snapshot(); change(copy);
      if (copy.inputs.some(x => x.state === "bound")) return Promise.reject(new Error("source disk failed"));
      return save(change);
    };
    await f.gateway.receive(update(2, "must not dispatch"));
    assert.equal(f.calls(), 0);
    assert.equal(f.store.snapshot().inputs[0]!.state, "rejected");
    const runs = await f.host.current.listRuns();
    assert.equal(runs.ok && runs.runs[0]?.status, "failed");
  } finally { await f.cleanup(); }
});

it("Steer supersedes old approval without authorizing it; control messages stay excluded", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "steer.md", content: "must not write" } } : undefined));
  try {
    await f.bind(); await f.gateway.receive(update(2, "write first plan"));
    await until(() => f.sent.some(x => x.includes("需要你确认 · 写入文件")));
    const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 写入文件"))!)![1]!;
    await f.gateway.receive(update(3, "调整：不要写文件，只解释下一步"));
    await until(() => f.store.snapshot().inputs[0]!.state === "finished");
    await f.gateway.receive(update(4, `允许 ${code}`));
    assert.match(f.sent.at(-1)!, /没有批准任何操作/);
    await assert.rejects(readFile(join(f.workspace, "steer.md")), { code: "ENOENT" });
    const history = await f.host.current.history();
    const steer = history.find(x => x.role === "user" && JSON.stringify(x.parts).includes("不要写文件"));
    const metadata = steer?.metadata as Record<string, unknown>;
    assert.equal(metadata.source, "steer"); assert.equal(metadata.memoryConsolidation, "exclude");
    assert.ok(Array.isArray(metadata.contextReferences));
  } finally { await f.cleanup(); }
});

it("desktop handling invalidates the IM short code, and expired binding/approval grant nothing", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "denied.md", content: "must not write" } } : undefined));
  try {
    await f.gateway.setEnabled(true);
    const stale = f.gateway.beginPairing().pairing!.code;
    f.advanceTime(5 * 60_000 + 1);
    await f.gateway.receive(update(0, `/start ${stale}`));
    await assert.rejects(f.gateway.confirmPairing(stale), /过期/);
    await f.bind();
    await f.gateway.receive(update(2, "write request"));
    await until(() => f.sent.some(x => x.includes("需要你确认 · 写入文件")));
    const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("需要你确认 · 写入文件"))!)![1]!;
    f.advanceTime(5 * 60_000 + 1);
    await f.gateway.receive(update(3, `允许 ${code}`));
    assert.ok(f.host.current.snapshot().pendingApproval);
    await assert.rejects(readFile(join(f.workspace, "denied.md")), { code: "ENOENT" });
    assert.equal(f.host.current.confirm({ approvalId: f.host.current.snapshot().pendingApproval!.approvalId, decision: "deny" }).accepted, true);
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    await f.gateway.receive(update(4, `允许 ${code}`));
    assert.match(f.sent.at(-1)!, /没有批准任何操作/);
    await assert.rejects(readFile(join(f.workspace, "denied.md")), { code: "ENOENT" });
    assert.equal(f.calls(), 2);
  } finally { await f.cleanup(); }
});

it("Stop cancels only the bound primary Run, never replays a pending tool", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "stopped.md", content: "must not write" } } : undefined));
  try {
    await f.bind(); await f.gateway.receive(update(2, "write request"));
    await until(() => f.sent.some(x => x.includes("需要你确认 · 写入文件")));
    await f.gateway.receive(update(3, "停止"));
    await until(() => f.store.snapshot().inputs[0]!.state === "finished");
    const source = f.store.snapshot().inputs[0]!;
    const receipt = await f.host.channelReceipt(f.store.snapshot().owner!.threadId, source.runId!);
    assert.equal(receipt?.status, "cancelled"); assert.equal(receipt?.tools[0]?.status, "not_started");
    await assert.rejects(readFile(join(f.workspace, "stopped.md")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

it("an explicit desktop observation unblocks the channel without rewriting an uncertain Run", async () => {
  const f = await fixture();
  try {
    await f.bind();
    await f.store.update(data => { data.inputs.push({ key: "42:2", updateId: 2, text: "uncertain start", state: "unknown", runId: null, taskId: null }); });
    await f.gateway.receive(update(3, "must wait for review")); assert.equal(f.calls(), 0);
    await assert.rejects(f.gateway.reviewInput({ key: "42:2", note: "核对未发现更改" }), /打开 Telegram/);
    await f.host.selectThread(f.store.snapshot().owner!.threadId);
    await f.gateway.reviewInput({ key: "42:2", note: "用户核对：未发现预期的文件更改" });
    const reviewed = f.store.snapshot().inputs.find(x => x.key === "42:2")!;
    assert.equal(reviewed.state, "reviewed"); assert.equal(reviewed.runId, null); assert.match(reviewed.reviewReport!, /用户核对/);
    await f.gateway.receive(update(4, "new request"));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:4")?.state === "finished");
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

it("restart never replays ambiguous input or unknown sends; terminal receipts recover delivery without a model", async () => {
  const f = await fixture();
  let restarted: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.receive(update(2, "real completed receipt"));
    await until(() => f.store.snapshot().inputs[0]!.state === "finished");
    await f.gateway.close();
    await f.store.update(data => {
      data.inputs[0]!.state = "bound";
      data.inputs.push({ key: "42:3", updateId: 3, text: "ambiguous dispatch", state: "reserved", runId: null, taskId: null });
      data.deliveries = [{ key: "lost-send", chatId: 42, text: "may already be sent", state: "sending", messageId: null }];
    });
    const reloaded = new TelegramStore(f.store.path, f.store.workspace); await reloaded.load();
    restarted = new TelegramGateway(f.host, reloaded, f.api); await restarted.initialize();
    await until(() => reloaded.snapshot().inputs[0]!.state === "finished");
    await until(() => reloaded.snapshot().deliveries.some(x => x.key === "result:42:2" && x.state === "submitted"));
    assert.equal(f.calls(), 1);
    assert.equal(reloaded.snapshot().inputs[1]!.state, "unknown");
    assert.equal(reloaded.snapshot().deliveries.find(x => x.key === "lost-send")!.state, "unknown");
    assert.equal(f.sent.includes("may already be sent"), false);
  } finally { await restarted?.close(); await f.cleanup(); }
});

it("polling acknowledges only persisted input and repeated platform updates start one Run", async () => {
  const f = await fixture();
  let poller: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.close();
    const offsets: number[] = [];
    poller = new TelegramGateway(f.host, f.store, { ...f.api, updates: async (offset, signal) => {
      offsets.push(offset);
      if (offsets.length === 1) return [update(2, "from real polling path")];
      assert.equal(f.store.snapshot().offset, 3);
      assert.ok(f.store.snapshot().inputs.find(x => x.key === "42:2")?.runId, "next poll cannot acknowledge an unpersisted source");
      if (offsets.length === 2) return [update(2, "duplicate")];
      return new Promise(resolve => signal.addEventListener("abort", () => resolve([]), { once: true }));
    } });
    await poller.initialize();
    await until(() => offsets.length >= 3 && f.store.snapshot().inputs[0]?.state === "finished");
    assert.deepEqual(offsets, [2, 3, 3]); assert.equal(f.calls(), 1);
    assert.equal(f.store.snapshot().inputs[0]?.text, "from real polling path");
  } finally { await poller?.close(); await f.cleanup(); }
});

it("send rejection and timeout remain distinct and neither retries task execution", async () => {
  const f = await fixture();
  try {
    await f.bind(); f.failSend(new TelegramApiError("403", "not_sent"));
    await f.gateway.receive(update(2, "first")); await until(() => f.gateway.status().failedDeliveries === 1);
    f.failSend(new TelegramApiError("NETWORK", "unknown"));
    await f.gateway.receive(update(3, "second")); await until(() => f.gateway.status().unknownDeliveries === 1);
    assert.equal(f.calls(), 2); assert.equal(f.sends(), 3, "no automatic send retry");
  } finally { await f.cleanup(); }
});

it("Task text gets an explicit preview and uses the existing WorkTask, not human acceptance", async () => {
  const f = await fixture();
  try {
    await f.bind(); await f.gateway.receive(update(2, "任务：整理今天的目标"));
    assert.equal(f.calls(), 0); assert.equal((await f.host.current.listWorkTasks()).ok, true);
    const code = /开始 ([A-F0-9]{10})/.exec(f.sent.at(-1)!)![1]!;
    await f.gateway.receive(update(3, `开始 ${code}`));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:3")?.state === "finished");
    const input = f.store.snapshot().inputs.find(x => x.key === "42:3")!;
    assert.ok(input.taskId);
    const task = await f.host.current.getWorkTask(input.taskId!);
    assert.equal(task.ok && task.value.status, "paused", "a text-only task with no automatic criteria must not invent evidence");
    assert.equal(task.ok && task.value.acceptance[0]?.status, "not_run");
    await until(() => f.sent.some(x => x.includes("仍需你在桌面验收")));
    await f.gateway.receive(update(4, `开始 ${code}`));
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});

it("private state validates corruption and permission, and failed writes freeze subsequent admission", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-telegram-store-")));
  try {
    const path = join(root, "private", "telegram.json"), store = new TelegramStore(path, root); await store.load();
    await store.update(data => { data.offset = 1; });
    await chmod(path, 0o644); await assert.rejects(new TelegramStore(path, root).load(), /权限/);
    await chmod(path, 0o600); await writeFile(path, "{broken"); await assert.rejects(new TelegramStore(path, root).load());
    await rm(join(root, "private"), { recursive: true });
    await assert.rejects(store.update(data => { data.offset = 2; }), /未确认/);
    await mkdir(join(root, "private"), { mode: 0o700 });
    await assert.rejects(store.update(data => { data.offset = 3; }), /停止接收/);
    assert.equal(store.snapshot().offset, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("API never leaks token URLs or retries sends, and refuses an existing webhook", async () => {
  const token = "123:THIS_IS_A_PRIVATE_TEST_TOKEN";
  let requests = 0;
  const api = createTelegramApi(token, async () => { requests++; throw new Error(`failed https://api.telegram.org/bot${token}/sendMessage`); });
  await assert.rejects(api.send(42, "hello", new AbortController().signal), error => error instanceof TelegramApiError && error.outcome === "unknown" && !error.message.includes(token));
  assert.equal(requests, 1);
  const f = await fixture();
  try {
    await f.gateway.close();
    const gateway = new TelegramGateway(f.host, f.store, { ...f.api, webhook: async () => ({ url: "https://existing-hook" }) });
    try { await gateway.setEnabled(true); assert.equal(gateway.status().connection, "failed"); assert.match(gateway.status().lastError!, /webhook/); }
    finally { await gateway.close(); }
    assert.equal(f.calls(), 0);
  } finally { await f.cleanup(); }
});

it("independent TG authorization runs chat and WorkTasks through real file/Shell tools, persists and restores per-call confirmation when disabled", async () => {
  type Call = { name: string; input: Record<string, unknown> };
  let plan: Call[] = [], step = 0;
  const prompts: string[] = [];
  const f = await fixture(async (_n, prompt) => { prompts.push(prompt ?? ""); const index = step++; return response(plan[index], "交付完成。", `autonomy-${index}`); }, true, true);
  const shell = (command: string): Call => ({ name: "shell_exec", input: { command, cwd: "." } });
  const reset = (calls: Call[]) => { step = 0; plan = calls; prompts.length = 0; };
  const idle = () => f.host.current.snapshot().state.kind === "idle";
  // Count unexpected phone approvals while testing the approved S02 path.
  const used = new Set<string>();
  const approveOnPhone = async (key: string, firstUpdate: number) => {
    let next = firstUpdate, approved = 0; const deadline = Date.now() + 60_000;
    while (f.store.snapshot().inputs.find(x => x.key === key)?.state !== "finished") {
      if (Date.now() > deadline) throw new Error("phone approval timeout");
      const text = [...f.sent].reverse().find(x => x.includes("需要你确认 · 执行命令"));
      const code = text ? /允许 ([A-F0-9]{10})/.exec(text)?.[1] : undefined;
      if (code && !used.has(code) && f.host.current.snapshot().pendingApproval?.toolName === "shell_exec") {
        used.add(code); await f.gateway.receive(update(next++, `允许 ${code}`)); approved++;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return approved;
  };
  try {
    await f.bind();
    const owner = f.store.snapshot().owner!;
    const setting = (enabled: boolean, expectedEnabled: boolean) => ({ enabled, expectedEnabled, expectedOwner: { userId: owner.userId, chatId: owner.chatId, threadId: owner.threadId } });
    assert.equal(f.gateway.status().autonomyEnabled, false);
    // Desktop authorization does not authorize the channel.
    await f.host.setAutonomyEnabled({ enabled: true, expectedEnabled: false });
    reset([shell("touch no-inheritance")]);
    await f.gateway.receive(update(2, "执行命令"));
    await until(() => !!f.host.current.snapshot().pendingApproval);
    assert.equal(f.gateway.status().autonomyEnabled, false);
    await assert.rejects(f.host.setTelegramAutonomyEnabled(setting(true, false)), /等待/);
    await f.gateway.receive(update(3, "停止")); await until(idle);
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    await assert.rejects(readFile(join(f.workspace, "no-inheritance")));
    await f.host.setAutonomyEnabled({ enabled: false, expectedEnabled: true });
    await assert.rejects(f.host.setTelegramAutonomyEnabled({ ...setting(true, false), expectedOwner: { ...setting(true, false).expectedOwner, userId: 99 } }), /绑定已变化/);
    await f.host.setTelegramAutonomyEnabled(setting(true, false));
    assert.equal(f.gateway.status().autonomyEnabled, true);
    assert.equal(f.host.info().autonomy?.enabled, false);
    await assert.rejects(f.host.setTelegramAutonomyEnabled(setting(false, false)), /配置已变化/);
    const config = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
    assert.deepEqual(config.telegramAutonomy, { authorizedDirectory: f.workspace, botId: 100, userId: 42, chatId: 42, threadId: owner.threadId });
    // Foreign users and group chats never reach a model or execute.
    const calls = f.calls(); await f.gateway.receive(update(4, "非法任务", 99)); await f.gateway.receive(update(5, "非法任务", 42, "group"));
    assert.equal(f.calls(), calls);
    reset([
      { name: "write_file", input: { path: "answer.txt", content: "wrong" } },
      shell('test "$(cat answer.txt)" = right'),
      { name: "edit_file", input: { path: "answer.txt", oldText: "wrong", newText: "right" } },
      { name: "read_file", input: { path: "answer.txt" } },
      ...Array.from({ length: 6 }, () => shell('test "$(cat answer.txt)" = right')),
    ]);
    await f.gateway.receive(update(6, "修复并运行多条检查"));
    assert.equal(await approveOnPhone("42:6", 1000), 0);
    const input = f.store.snapshot().inputs.find(x => x.key === "42:6")!;
    const run = await f.host.channelReceipt(owner.threadId, input.runId!);
    assert.equal(run?.status, "completed"); assert.equal(run?.tools.length, 10);
    assert.equal(run?.tools[1]?.shell?.exitCode, 1); assert.equal(run?.tools.at(-1)?.shell?.exitCode, 0);
    assert.ok(run?.tools.every(tool => !!tool.approvalRequestedAt === false));
    assert.equal(await readFile(join(f.workspace, "answer.txt"), "utf8"), "right");
    assert.ok(prompts[0]?.includes("host has explicitly authorized"));
    reset([shell("test -f answer.txt"), { name: "read_file", input: { path: "answer.txt" } }]);
    await f.gateway.receive(update(2007, "任务：检查交付"));
    const proposal = [...f.sent].reverse().find(text => text.includes("任务目标："))!;
    assert.match(proposal, /文件和 Seatbelt 内命令已授权连续执行，默认断网/);
    const code = /开始 ([A-F0-9]{10})/.exec(proposal)![1]!;
    await f.gateway.receive(update(2008, `开始 ${code}`));
    assert.equal(await approveOnPhone("42:2008", 2100), 0);
    const taskInput = f.store.snapshot().inputs.find(x => x.key === "42:2008")!;
    assert.ok(taskInput.taskId);
    const taskRun = await f.host.channelReceipt(owner.threadId, taskInput.runId!);
    assert.ok(taskRun?.tools.every(tool => !!tool.approvalRequestedAt === false));
    const task = await f.host.current.getWorkTask(taskInput.taskId!); assert.ok(task.ok); assert.equal(task.value.status, "paused"); // TG creates human-only criteria: no automatic completion evidence was declared.
    assert.equal(taskRun?.completion?.reason, "needs_information");
    // Other tools keep their existing per-call approval.
    reset([{ name: "recipe_list", input: {} }]);
    await f.gateway.receive(update(3009, "读取安排")); await until(() => !!f.host.current.snapshot().pendingApproval);
    assert.equal(f.host.current.snapshot().pendingApproval?.toolName, "recipe_list");
    await f.gateway.receive(update(3010, "停止")); await until(idle);
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:3009")?.state === "finished");
    await f.host.setTelegramAutonomyEnabled(setting(false, false));
    reset([shell("touch after-disable")]);
    await f.gateway.receive(update(3011, "执行命令")); await until(() => !!f.host.current.snapshot().pendingApproval);
    await f.gateway.receive(update(3012, "停止")); await until(idle);
    await assert.rejects(readFile(join(f.workspace, "after-disable")));
  } finally { await f.cleanup(); }
});

it("TG grant survives host restart but never authorizes a changed bot/user/chat/Thread or desktop entry, and cancelled effects are not replayed", async () => {
  let step = 0;
  const f = await fixture(async () => step++ === 0 ? response({ name: "shell_exec", input: { command: "printf started > marker; sleep 60; touch must-not-complete", cwd: "." } }) : response(), true, true);
  let restarted: DesktopRuntime | undefined;
  try {
    await f.bind(); const owner = f.store.snapshot().owner!;
    await f.host.setTelegramAutonomyEnabled({ enabled: true, expectedEnabled: false, expectedOwner: { userId: owner.userId, chatId: owner.chatId, threadId: owner.threadId } });
    const binding = f.gateway.autonomyBinding()!;
    for (const key of ["botId", "userId", "chatId", "threadId", "directory"] as const) {
      assert.equal(f.gateway.matchesAutonomyGrant({ ...binding, [key]: typeof binding[key] === "number" ? 99 : "foreign" }), false);
    }
    await f.gateway.receive(update(2, "执行长命令"));
    // S02: the same Seatbelt runner executes without a phone approval.
    await until(async () => { try { return await readFile(join(f.workspace, "marker"), "utf8") === "started"; } catch { return false; } });
    assert.equal(f.host.current.snapshot().pendingApproval, null);
    await f.gateway.receive(update(4, "停止"));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "unknown");
    const input = f.store.snapshot().inputs.find(x => x.key === "42:2")!;
    const cancelled = await f.host.channelReceipt(owner.threadId, input.runId!);
    assert.equal(cancelled?.tools[0]?.status, "unknown");
    await f.host.shutdown();
    let modelCalls = 0;
    restarted = await DesktopRuntime.create({ applicationHome: join(f.root, "profile"), cwd: f.root, env: { RUNLOOM_CONFIG: join(f.root, "config.json") }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => { modelCalls++; return response({ name: "shell_exec", input: { command: "touch desktop-must-not-run", cwd: "." } }); } }), send: () => {} });
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    const gateway = new TelegramGateway(restarted, store, f.api, f.now); restarted.attachTelegram(gateway); await gateway.initialize(); await gateway.start();
    assert.equal(gateway.status().autonomyEnabled, false); assert.equal(gateway.status().autonomyPaused, true); assert.equal(modelCalls, 0);
    assert.equal((await restarted.channelReceipt(owner.threadId, input.runId!))?.tools[0]?.status, "unknown");
    await gateway.receive(update(5, "继续执行")); assert.equal(modelCalls, 0); // unknown channel input blocks admission
    await restarted.current.run("桌面没有独立授权", { source: "telegram", desktopEntry: true } as never);
    await until(() => !!restarted!.current.snapshot().pendingApproval);
    await restarted.current.cancel(); await until(() => restarted!.current.snapshot().state.kind === "idle");
    await assert.rejects(readFile(join(f.workspace, "desktop-must-not-run")));
    await assert.rejects(readFile(join(f.workspace, "must-not-complete")));
    await store.update(data => { data.botId = 200; }); assert.equal(gateway.status().autonomyEnabled, false);
  } finally { await restarted?.shutdown(); await f.cleanup(); }
});

it("TG independent authority crosses the resident socket with identity CAS, without exposing host-only channel entry points", async () => {
  const f = await fixture(async () => response({ name: "shell_exec", input: { command: "touch forged-channel", cwd: "." } }), true, true);
  let client: Awaited<ReturnType<typeof ResidentClient.connect>> | undefined;
  let server: Awaited<ReturnType<typeof startResidentServer>> | undefined;
  try {
    await f.bind(); const owner = f.store.snapshot().owner!;
    const scope = { applicationHome: join(f.root, "profile"), configPath: join(f.root, "config.json"), workspaceRoot: f.workspace };
    const paths = createResidentPaths(scope.applicationHome, join(f.root, "host.sock"));
    server = await startResidentServer({ paths, scope, createRuntime: async () => f.host });
    client = await ResidentClient.connect({ paths, scope, send: () => {} });
    const input = { enabled: true, expectedEnabled: false, expectedOwner: { userId: owner.userId, chatId: owner.chatId, threadId: owner.threadId } };
    assert.equal((await client.setTelegramAutonomyEnabled(input)).autonomyEnabled, true);
    const created = await client.current.createWorkTask({ goal: "unauthorized desktop task", acceptance: [{ id: "human", description: "user acceptance", required: true, method: "human", verification: { kind: "human" } }] });
    assert.ok(created.ok);
    // A second RPC argument must not spoof the trusted TG source.
    const startTask = client.current.runWorkTask as (...args: unknown[]) => Promise<unknown>;
    await startTask({ id: created.value.id, expectedRevision: created.value.revision }, "telegram");
    await until(() => !!f.host.current.snapshot().pendingApproval);
    const state = f.host.current.snapshot().state; assert.ok(state.kind === "running"); assert.equal(state.source, undefined);
    await client.current.cancel(); await until(() => f.host.current.snapshot().state.kind === "idle");
    await assert.rejects(readFile(join(f.workspace, "forged-channel")));
    await assert.rejects(client.setTelegramAutonomyEnabled(input), /配置已变化/);
    assert.equal((await client.setTelegramAutonomyEnabled({ ...input, enabled: false, expectedEnabled: true })).autonomyEnabled, false);
    assert.equal(f.calls(), 1);
  } finally { client?.detach(); await server?.close(); await f.cleanup(); }
});

it("ordinary TG supplements bind before Steer, stay silent, and recover a lost acknowledgement without replay", async t => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "old-plan", content: "never" } } : undefined));
  let recovered: TelegramGateway | undefined;
  try {
    await f.bind(); await f.gateway.receive(update(2, "开始原任务"));
    await until(() => !!f.host.current.snapshot().pendingApproval?.preview);
    const parent = f.store.snapshot().inputs.find(item => item.key === "42:2")!;
    await f.gateway.receive(update(3, "好的"));
    assert.equal(f.store.snapshot().inputs.find(item => item.key === "42:3")?.state, "rejected");
    assert.ok(f.host.current.snapshot().pendingApproval);
    const bridge = f.host.current, original = bridge.steer.bind(bridge);
    let dispatched = 0;
    t.mock.method(bridge, "steer", async (input: Parameters<typeof bridge.steer>[0]) => {
      dispatched++;
      const saved = JSON.parse(await readFile(f.store.path, "utf8")).inputs.find((item: { key: string }) => item.key === "42:4");
      assert.equal(saved.runId, parent.runId); assert.equal(saved.steerId, input.id); assert.equal(saved.state, "reserved");
      const accepted = await original(input); assert.ok(accepted.ok);
      throw new Error("lost acknowledgement after accepted receipt");
    });
    await f.gateway.receive(update(4, "不要写文件，只解释下一步"));
    await until(() => f.store.snapshot().inputs.find(item => item.key === "42:2")?.state === "finished");
    await until(() => f.store.snapshot().deliveries.find(item => item.key === "result:42:2")?.state === "submitted");
    assert.equal(f.store.snapshot().inputs.find(item => item.key === "42:4")?.state, "unknown");
    assert.ok(f.sent.some(text => text.includes("补充接收结果未知")));
    assert.equal(dispatched, 1);
    await f.gateway.close();
    const store = new TelegramStore(f.store.path, f.store.workspace); await store.load();
    const sends = f.sends(), calls = f.calls();
    recovered = new TelegramGateway(f.host, store, f.api, f.now); await recovered.initialize(); await recovered.start();
    assert.equal(store.snapshot().inputs.find(item => item.key === "42:4")?.state, "finished");
    assert.equal(f.sends(), sends, "accepted recovery is silent"); assert.equal(f.calls(), calls); assert.equal(dispatched, 1);
    assert.equal(store.snapshot().deliveries.some(item => item.key === "result:42:4"), false);
    await recovered.receive(update(4, "不要写文件，只解释下一步")); assert.equal(dispatched, 1);
    const receipt = await f.host.channelReceipt(f.store.snapshot().owner!.threadId, parent.runId!);
    assert.equal(receipt?.steers?.find(item => item.id === "tg:42:4")?.status, "applied");
    await assert.rejects(readFile(join(f.workspace, "old-plan")), { code: "ENOENT" });
  } finally { t.mock.restoreAll(); await recovered?.close(); await f.cleanup(); }
});

it("successful ordinary TG Steer sends only the parent result and keeps an exact original Run association", async () => {
  const f = await fixture(async n => response(n === 1 ? { name: "write_file", input: { path: "superseded", content: "never" } } : undefined));
  try {
    await f.bind(); await f.gateway.receive(update(2, "原计划"));
    await until(() => !!f.host.current.snapshot().pendingApproval?.preview);
    await until(() => f.store.snapshot().deliveries.some(item => item.key.startsWith("approval:") && item.state === "submitted"));
    const before = f.sends();
    await f.gateway.receive(update(3, "不用写文件，直接说明结果"));
    await until(() => f.store.snapshot().deliveries.find(item => item.key === "result:42:2")?.state === "submitted");
    assert.equal(f.sends(), before + 1);
    const input = f.store.snapshot().inputs.find(item => item.key === "42:3")!;
    assert.equal(input.runId, f.store.snapshot().inputs.find(item => item.key === "42:2")!.runId);
    assert.equal(input.steerId, "tg:42:3"); assert.equal(input.state, "finished");
    assert.equal(f.store.snapshot().deliveries.some(item => item.key === "input:42:3" || item.key === "result:42:3"), false);
    assert.equal((await f.host.current.listRuns()).ok, true);
    await assert.rejects(readFile(join(f.workspace, "superseded")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});

it("stop pauses even an idle bound private chat across reload; only explicit resume restores its existing grant", async () => {
  const f = await fixture();
  try {
    await f.bind(); const owner = f.store.snapshot().owner!;
    const input = { enabled: true, expectedEnabled: false, expectedOwner: { userId: owner.userId, chatId: owner.chatId, threadId: owner.threadId } };
    await f.host.setTelegramAutonomyEnabled(input);
    await f.gateway.receive(update(2, "停止"));
    assert.equal(f.gateway.status().autonomyEnabled, false); assert.equal(f.gateway.status().autonomyPaused, true);
    const loaded = new TelegramStore(f.store.path, f.store.workspace); await loaded.load(); assert.equal(loaded.snapshot().autonomyPaused, true); assert.equal(loaded.snapshot().version, 3);
    await f.gateway.receive(update(3, "恢复自主执行", 99)); assert.equal(f.gateway.status().autonomyEnabled, false);
    await f.gateway.receive(update(4, "继续"));
    await until(() => f.store.snapshot().inputs.find(item => item.key === "42:4")?.state === "finished");
    assert.equal(f.gateway.status().autonomyEnabled, false);
    await f.gateway.receive(update(5, "恢复自主执行")); assert.equal(f.gateway.status().autonomyEnabled, true);
    await f.gateway.receive(update(6, "/stop")); assert.equal(f.gateway.status().autonomyEnabled, false);
    await f.host.setTelegramAutonomyEnabled(input); assert.equal(f.gateway.status().autonomyEnabled, true);
    assert.equal(f.gateway.status().autonomyPaused, false);
  } finally { await f.cleanup(); }
});

it("whole-message stop variants cancel the owned Run and persist the private-chat autonomy pause", async t => {
  for (const text of ["停", "停下", "停止", "stop", "STOP", "sToP", "/stop", " \t“停止！”\n", " ,StOp!?。 ", " （/stop）！ "]) {
    await t.test(JSON.stringify(text), async () => {
      const f = await fixture(async n => response(n === 1 ? { name: "task_create", input: { prompt: "待确认提醒", runAt: new Date(Date.now() + 120_000).toISOString(), arrangement: reminder } } : undefined));
      try {
        await f.bind(); const owner = f.store.snapshot().owner!;
        await f.host.setTelegramAutonomyEnabled({ enabled: true, expectedEnabled: false, expectedOwner: { userId: owner.userId, chatId: owner.chatId, threadId: owner.threadId } });
        await f.gateway.receive(update(2, "创建提醒"));
        await until(() => !!f.host.current.snapshot().pendingApproval);
        const calls = f.calls();
        await f.gateway.receive(update(3, text));
        assert.equal(f.gateway.status().autonomyPaused, true);
        await until(() => f.host.current.snapshot().state.kind === "idle");
        assert.equal(f.gateway.status().autonomyEnabled, false);
        const loaded = new TelegramStore(f.store.path, f.store.workspace); await loaded.load();
        assert.equal(loaded.snapshot().autonomyPaused, true);
        assert.equal(f.calls(), calls, "stop must cancel rather than enter the model or Steer");
      } finally { await f.cleanup(); }
    });
  }
});

it("sentences mentioning stop remain ordinary chat without pausing autonomy", async () => {
  const f = await fixture();
  try {
    await f.bind(); const owner = f.store.snapshot().owner!;
    await f.host.setTelegramAutonomyEnabled({ enabled: true, expectedEnabled: false, expectedOwner: { userId: owner.userId, chatId: owner.chatId, threadId: owner.threadId } });
    const messages = ["请停止当前任务", "停止执行", "不要停止", "stopped", "s top", "st/op"];
    for (const [index, text] of messages.entries()) {
      const id = index + 2;
      await f.gateway.receive(update(id, text));
      await until(() => f.store.snapshot().inputs.find(input => input.key === `42:${id}`)?.state === "finished");
      assert.equal(f.gateway.status().autonomyPaused, false, text);
      assert.equal(f.gateway.status().autonomyEnabled, true, text);
    }
    assert.equal(f.calls(), messages.length);
  } finally { await f.cleanup(); }
});

it("binding success describes the current host grant and authorized directory", async t => {
  for (const enabled of [false, true]) {
    await t.test(`autonomy=${enabled}`, async () => {
      const f = await fixture();
      try {
        t.mock.method(f.host, "channelTelegramAutonomyEnabled", () => enabled);
        await f.bind();
        const text = f.store.snapshot().deliveries.find(delivery => delivery.key.startsWith("binding:"))!.text;
        assert.match(text, /已绑定当前授权目录/);
        assert.doesNotMatch(text, /工作区/);
        assert.match(text, enabled ? /文件和 Seatbelt 内命令免逐条确认，其他工具仍逐次确认/ : /工具仍逐次确认/);
        if (!enabled) assert.doesNotMatch(text, /文件和 Seatbelt 内命令免逐条确认/);
      } finally { await f.cleanup(); }
    });
  }
});
