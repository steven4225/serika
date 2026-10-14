import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { TelegramGateway } from "./telegram-gateway.js";
import { TelegramStore } from "./telegram-store.js";
import { TelegramApiError, createTelegramApi, type TelegramApi, type TelegramUpdate } from "./telegram-api.js";
import { createTaskStore, TASK_FILE_NAME, RSS_DIGEST_TASK_PROMPT } from "@aisdk-agent/example-cli/dist/task-store.js";
import { formatLocalTaskTime } from "@aisdk-agent/example-cli/dist/task-instructions.js";

function response(tool?: { name: string; input: unknown }, text = "已完成请求。") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(tool ? [{ type: "tool-call" as const, toolCallId: "call-1", toolName: tool.name, input: JSON.stringify(tool.input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: text }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("Telegram state did not settle"); await new Promise(done => setTimeout(done, 5)); }
}
const update = (id: number, text: string, userId = 42, type = "private", messageId = id): TelegramUpdate => ({ update_id: id,
  message: { message_id: messageId, date: 1, text, chat: { id: userId, type }, from: { id: userId, is_bot: false, first_name: "Owner" } } });
async function fixture(stream: (call: number, prompt?: string) => Promise<ReturnType<typeof response>> = async () => response()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-telegram-unit-")));
  const workspace = join(root, "workspace"), userData = join(root, "profile"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { "read-file": { enabled: true }, memory: { enabled: false }, shell: { enabled: false }, task: { enabled: true } } }));
  let calls = 0;
  let time = Date.now(), activations = 0;
  const host = await DesktopRuntime.create({ userData, cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock",
    model: new MockLanguageModelV3({ doStream: async ({ prompt }) => stream(++calls, JSON.stringify(prompt)) }), send: () => {},
    taskAutomation: { status: async () => ({ available: true, registered: true, running: true, todoistPlanningAvailable: false }), enable: async () => { activations++; return { enabled: true }; } } });
  const store = new TelegramStore(join(root, "private", "telegram.json"), host.info().workspaceRoot!);
  await store.load();
  const sent: string[] = [];
  let sends = 0, sendError: TelegramApiError | undefined;
  const api: TelegramApi = { identity: async () => ({ id: 100, username: "serika_test" }), webhook: async () => ({ url: "" }),
    updates: async (_offset, signal) => new Promise(resolve => { if (signal.aborted) resolve([]); else signal.addEventListener("abort", () => resolve([]), { once: true }); }),
    send: async (_chat, text) => { sends++; if (sendError) throw sendError; sent.push(text); return sends; } };
  const gateway = new TelegramGateway(host, store, api, () => time);
  host.attachTelegram(gateway);
  await gateway.initialize();
  const bind = async () => {
    await gateway.setEnabled(true); const code = gateway.beginPairing().pairing!.code;
    await gateway.receive(update(1, `/start ${code}`));
    assert.equal(store.snapshot().owner, null, "private message alone must not own the assistant");
    await gateway.confirmPairing(code);
  };
  return { root, workspace, host, store, gateway, api, sent, bind, calls: () => calls, sends: () => sends,
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
  const tasks = createTaskStore(f.workspace, { now: () => clock });
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
    await until(() => f.sent.some(x => x.includes("请求使用 task_create")));
    const preview = f.sent.find(x => x.includes("请求使用 task_create"))!;
    assert.match(preview, /结果将发送到本绑定私聊/);
    assert.match(f.host.current.snapshot().pendingApproval!.preview!, /Telegram 已绑定私聊 42/, "desktop and Telegram share destination disclosure");
    assert.equal(f.store.snapshot().routes.length, 0);
    assert.equal(f.activations(), 0);
    const code = /允许 ([A-F0-9]{10})/.exec(preview)![1]!;
    await f.gateway.receive(update(3, `允许 ${code}`));
    await until(() => f.store.snapshot().inputs.find(x => x.key === "42:2")?.state === "finished");
    const route = f.store.snapshot().routes[0]!;
    assert.equal(route.sourceRunId, f.store.snapshot().inputs.find(x => x.key === "42:2")!.runId);
    assert.equal(route.chatId, 42);
    const saved = await createTaskStore(f.workspace).get(route.id); assert(saved.ok && saved.value?.status === "scheduled");
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
    const before = await readFile(join(f.workspace, TASK_FILE_NAME), "utf8");
    f.failSend(new TelegramApiError("403", "not_sent"));
    await f.gateway.collectScheduledResults();
    const key = `scheduled:${job.id}`;
    assert.equal(f.store.snapshot().deliveries.find(x => x.key === key)?.state, "failed");
    assert(f.gateway.status().deliveries.find(x => x.key === key)?.retryAllowed);
    const sends = f.sends(); f.failSend(undefined);
    const outcomes = await Promise.allSettled([f.gateway.retryDelivery(key), f.gateway.retryDelivery(key)]);
    assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(f.sends(), sends + 1);
    assert.equal(await readFile(join(f.workspace, TASK_FILE_NAME), "utf8"), before);
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
    const store = new TelegramStore(f.store.path, f.workspace); await store.load();
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
    const tasks = createTaskStore(f.workspace, { now: () => clock });
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
    const tasks = createTaskStore(f.workspace, { now: () => clock });
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
    const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("请求使用 write_file"))!)![1]!;
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
    await until(() => f.sent.some(x => x.includes("请求使用 write_file")));
    const previous = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("请求使用 write_file"))!)![1]!;
    const run = f.store.snapshot().inputs.find(x => x.key === "42:2")!.runId;
    f.advanceTime(5 * 60_000 + 1);
    await f.gateway.receive(update(3, `允许 ${previous}`));
    await assert.rejects(readFile(join(f.workspace, "renewed.md")), { code: "ENOENT" });
    await f.gateway.receive(update(4, "/confirm"));
    const refreshed = /允许 ([A-F0-9]{10})/.exec(f.sent.filter(x => x.includes("请求使用 write_file")).at(-1)!)![1]!;
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
      await until(() => f.sent.some(x => x.includes("请求使用 write_file")));
      const old = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("请求使用 write_file"))!)![1]!;
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
      const renewed = /允许 ([A-F0-9]{10})/.exec(f.sent.filter(x => x.includes("请求使用 write_file")).at(-1)!)![1]!;
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
    const store = new TelegramStore(f.store.path, f.workspace); await store.load();
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
    const store = new TelegramStore(f.store.path, f.workspace); await store.load();
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
    let store = new TelegramStore(f.store.path, f.workspace); await store.load();
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
    store = new TelegramStore(f.store.path, f.workspace); await store.load();
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
      await until(() => f.sent.some(x => x.includes("请求使用 write_file")));
      const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("请求使用 write_file"))!)![1]!;
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
    assert.equal(f.sent.some(x => x.includes("请求使用")), false, "desktop tool details must not leak to IM");
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
    assert(!f.sent.some(x => x.includes("请求使用 write_file")), "no stale permission envelope was sent after the awaited claim");
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
    await until(() => f.sent.some(x => x.includes("请求使用 write_file")));
    const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("请求使用 write_file"))!)![1]!;
    await f.gateway.receive(update(3, "调整：不要写文件，只解释下一步"));
    await until(() => f.store.snapshot().inputs[0]!.state === "finished");
    await f.gateway.receive(update(4, `允许 ${code}`));
    assert.match(f.sent.at(-1)!, /没有批准任何操作/);
    await assert.rejects(readFile(join(f.workspace, "steer.md")), { code: "ENOENT" });
    const history = await f.host.current.history();
    const steer = history.find(x => x.role === "user" && JSON.stringify(x.parts).includes("不要写文件"));
    assert.deepEqual(steer?.metadata, { source: "steer", memoryConsolidation: "exclude" });
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
    await until(() => f.sent.some(x => x.includes("请求使用 write_file")));
    const code = /允许 ([A-F0-9]{10})/.exec(f.sent.find(x => x.includes("请求使用 write_file"))!)![1]!;
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
    await until(() => f.sent.some(x => x.includes("请求使用 write_file")));
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
