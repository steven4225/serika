import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { startQqHost } from "./qq-host.js";
import { readQqConfig } from "./qq-config.js";
import { OneBotError, type OneBotApi, type OneBotSegment } from "./onebot-api.js";

class Api implements OneBotApi {
  sent: { group: number; message: OneBotSegment[] }[] = [];
  disconnected: () => void = () => {};
  failure: OneBotError | undefined;
  bot = 100;
  async connect(_receive: (event: unknown) => void, disconnected: () => void) { this.disconnected = disconnected; return this.bot; }
  async send(group: number, message: OneBotSegment[]) { this.sent.push({ group, message }); if (this.failure) throw this.failure; return this.sent.length; }
  close() {}
  texts() { return this.sent.map(x => x.message.filter(s => s.type === "text").map(s => s.data.text).join("")); }
  code() { return /允许 ([A-F0-9]{10})/.exec(this.texts().reverse().find(x => x.includes("需要主人确认")) ?? "")?.[1]; }
}
function response(tool?: { name: string; input: unknown }, text = "群回答", id = "call-1") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(tool ? [{ type: "tool-call" as const, toolCallId: id, toolName: tool.name, input: JSON.stringify(tool.input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: text }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
const message = (id: number, text: string, userId = 400, overrides: Record<string, unknown> = {}) => ({ post_type: "message", message_type: "group", self_id: 100, group_id: 200,
  user_id: userId, message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: "at", data: { qq: "100" } }, { type: "text", data: { text } }], ...overrides });
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { if (Date.now() > deadline) throw new Error("QQ state did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(modelResponse: (call: number, prompt: string) => ReturnType<typeof response> = () => response(), env: NodeJS.ProcessEnv = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "serika-qq-"))), workspace = join(root, "group"), configPath = join(root, "qq.json");
  await mkdir(workspace);
  const config = { version: 1, endpoint: "ws://127.0.0.1:3001/", botId: 100, groupId: 200, ownerId: 300, workspace, modules: { "read-file": { enabled: true } } };
  await writeFile(configPath, JSON.stringify(config));
  let calls = 0;
  const prompts: string[] = [];
  const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => { const text = JSON.stringify(prompt); prompts.push(text); return modelResponse(++calls, text); } });
  const api = new Api(), logs: string[] = [];
  const options = { configPath, env, modelAlias: "mock", model, api, log: (message: string) => logs.push(message) };
  let host = await startQqHost(options);
  return { root, workspace, configPath, config, api, logs, prompts, model, calls: () => calls,
    get host() { return host; }, restart: async () => { await host.close(); host = await startQqHost(options); },
    idle: async () => { await until(() => host.controller.getSnapshot().state.kind === "idle"); await host.gateway.settled(); },
    cleanup: async () => { await host.close(); await rm(root, { recursive: true, force: true }); } };
}
it("QQ members share one Thread, only mentioned text in the configured group is admitted, and duplicates do not run", async () => {
  const f = await fixture();
  try {
    for (const override of [{ group_id: 201 }, { self_id: 101 }, { user_id: 100 }, { message_type: "private" },
      { time: Math.floor(Date.now() / 1000) - 600 }, { message: [{ type: "text", data: { text: "no mention" } }] },
      { message: [{ type: "at", data: { qq: "100" } }, { type: "image", data: { file: "private" } }] }]) {
      await f.host.gateway.receive(message(1, "ignored", 400, override));
    }
    assert.equal(f.calls(), 0);
    await f.host.gateway.receive(message(10, "first member question")); await f.idle();
    await f.host.gateway.receive(message(10, "duplicate"));
    await f.host.gateway.receive(message(11, "second member question", 401)); await f.idle();
    assert.equal(f.calls(), 2); assert.match(f.prompts[1]!, /first member question/); assert.match(f.prompts[1]!, /second member question/);
    assert.equal(f.api.sent.every(x => x.group === 200), true);
    assert.equal((await f.host.controller.listRuns()).every(x => x.threadId === f.host.config.binding.threadId), true);
    assert.equal((await f.host.controller.getHistory()).filter(x => x.role === "user").length, 2);
    assert.equal(f.host.config.runtimeConfig.modules && (f.host.config.runtimeConfig.modules as Record<string, { enabled: boolean }>).memory!.enabled, false);
    await f.host.gateway.receive(message(12, "当前确认", 300));
    assert.match(f.api.texts().at(-1)!, /当前没有属于本群/); assert.equal(f.calls(), 2);
  } finally { await f.cleanup(); }
});
it("QQ owner approval produces one real file write; members, other groups, superseded codes and replays cannot authorize", async () => {
  const f = await fixture(call => call === 1 ? response({ name: "write_file", input: { path: "demo.txt", content: "QQ demo" } }) : response());
  try {
    await f.host.gateway.receive(message(1, "write demo"));
    await until(() => !!f.api.code());
    const oldCode = f.api.code()!;
    assert.equal(f.host.controller.getSnapshot().state.kind, "running");
    await assert.rejects(readFile(join(f.workspace, "demo.txt")), { code: "ENOENT" });
    await f.host.gateway.receive(message(2, `允许 ${oldCode}`, 400));
    await f.host.gateway.receive(message(3, `允许 ${oldCode}`, 300, { group_id: 201 }));
    await f.host.gateway.receive(message(4, "another question", 401));
    assert.equal(f.calls(), 1); assert.match(f.api.texts().join("\n"), /未排队/);
    await assert.rejects(readFile(join(f.workspace, "demo.txt")), { code: "ENOENT" });
    await f.host.gateway.receive(message(5, "当前确认", 300));
    const newCode = f.api.code()!; assert.notEqual(oldCode, newCode);
    await f.host.gateway.receive(message(6, `允许 ${oldCode}`, 300));
    await assert.rejects(readFile(join(f.workspace, "demo.txt")), { code: "ENOENT" });
    await f.host.gateway.receive(message(7, `允许 ${newCode}`, 300)); await f.idle();
    assert.equal(await readFile(join(f.workspace, "demo.txt"), "utf8"), "QQ demo");
    await f.host.gateway.receive(message(8, `允许 ${newCode}`, 300));
    await f.host.gateway.receive(message(7, `允许 ${newCode}`, 300));
    assert.equal(f.calls(), 2);
    const runs = await f.host.controller.listRuns(); assert.equal(runs.length, 1);
    assert.equal(runs[0]!.tools.filter(x => x.toolName === "write_file" && x.status === "completed").length, 1);
  } finally { await f.cleanup(); }
});
it("QQ refusal does not write and a second tool call requires a fresh owner confirmation", async () => {
  const f = await fixture(call => call <= 2 ? response({ name: "write_file", input: { path: `demo-${call}.txt`, content: "demo" } }, "", `call-${call}`) : response());
  try {
    await f.host.gateway.receive(message(1, "write files")); await until(() => !!f.api.code());
    const first = f.api.code()!;
    await f.host.gateway.receive(message(2, `允许 ${first}`, 300));
    await until(() => !!f.api.code() && f.api.code() !== first);
    assert.equal(await readFile(join(f.workspace, "demo-1.txt"), "utf8"), "demo");
    await assert.rejects(readFile(join(f.workspace, "demo-2.txt")), { code: "ENOENT" });
    await f.host.gateway.receive(message(3, `允许 ${first}`, 300));
    await f.host.gateway.receive(message(4, `拒绝 ${f.api.code()!}`, 300)); await f.idle();
    await assert.rejects(readFile(join(f.workspace, "demo-2.txt")), { code: "ENOENT" });
  } finally { await f.cleanup(); }
});
it("QQ restart retains shared history and dedupe without restoring old approvals or replaying unfinished sources", async () => {
  const f = await fixture();
  try {
    await f.host.gateway.receive(message(1, "saved conversation")); await f.idle();
    await f.host.store.update(data => {
      data.inputs.push({ key: "99", userId: 400, runId: null, state: "received" });
      data.deliveries.push({ key: "interrupted", state: "sending", messageId: null });
    });
    const sends = f.api.sent.length;
    await f.restart(); assert.equal(f.calls(), 1); assert.equal(f.api.sent.length, sends);
    assert.equal(f.host.store.snapshot().inputs.find(x => x.key === "99")!.state, "unknown");
    assert.equal(f.host.store.snapshot().deliveries.find(x => x.key === "interrupted")!.state, "unknown");
    await f.host.gateway.receive(message(1, "saved conversation")); assert.equal(f.calls(), 1);
    await f.host.gateway.receive(message(2, "new question")); assert.equal(f.calls(), 1);
    await f.host.gateway.receive(message(3, "核对 99 checked receipts, no execution was started", 400));
    assert.equal(f.host.store.snapshot().inputs.find(x => x.key === "99")!.reviewReport, undefined);
    await f.host.gateway.receive(message(4, "核对 99 checked receipts, no execution was started", 300));
    await f.host.gateway.receive(message(5, "after review")); await f.idle();
    assert.equal(f.calls(), 2); assert.match(f.prompts[1]!, /saved conversation/);
    assert.equal(f.host.store.snapshot().inputs.find(x => x.key === "99")!.state, "unknown");
  } finally { await f.cleanup(); }
});
it("QQ uncertain outgoing sends are persisted and never retried by restart", async () => {
  const f = await fixture();
  try {
    f.api.failure = new OneBotError("unknown");
    await f.host.gateway.receive(message(1, "question")); await f.idle();
    assert.equal(f.api.sent.length, 1); assert.equal(f.host.store.snapshot().deliveries[0]!.state, "unknown");
    await f.restart(); assert.equal(f.api.sent.length, 1); assert.equal(f.calls(), 1);
    f.api.failure = undefined;
    await f.host.gateway.receive(message(2, "结果 1"));
    assert.match(f.api.texts().at(-1)!, /群回答/); assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});
it("QQ mode ignores personal desktop environment and refuses private modules, forged grants and changed binding", async () => {
  const f = await fixture(() => response(), { RUNLOOM_CONFIG: "/personal/config-must-not-be-read.json", RUNLOOM_WORKSPACE: "/personal/workspace", RUNLOOM_THREAD: "personal-thread" });
  try {
    await f.host.gateway.receive(message(1, "independent group")); await f.idle();
    assert.equal((await f.host.controller.listRuns())[0]!.threadId, f.host.config.binding.threadId);
    await assert.rejects(startQqHost({ configPath: f.configPath, env: {}, modelAlias: "mock", model: f.model, api: new Api() }), /已有运行/);
    const copy = join(f.root, "copy.json"); await writeFile(copy, JSON.stringify(f.config));
    await assert.rejects(startQqHost({ configPath: copy, env: {}, modelAlias: "mock", model: f.model, api: new Api() }), /已有运行/);
    for (const change of [{ modules: { memory: { enabled: true } } }, { modules: { task: { enabled: true } } }, { fileAuthorizations: [] }, { telegramAutonomy: {} }, { automation: {} }]) {
      await writeFile(f.configPath, JSON.stringify({ ...f.config, ...change }));
      await assert.rejects(readQqConfig(f.configPath));
    }
    await f.host.close();
    await writeFile(f.configPath, JSON.stringify({ ...f.config, ownerId: 301 }));
    await assert.rejects(startQqHost({ configPath: f.configPath, env: {}, modelAlias: "mock", model: f.model, api: new Api() }), /绑定不匹配/);
  } finally { await f.cleanup(); }
});
it("QQ approval expires after five minutes and only a fresh owner request restores a usable code", async t => {
  const realNow = Date.now; let elapsed = 0;
  t.mock.method(Date, "now", () => realNow() + elapsed);
  const f = await fixture(call => call === 1 ? response({ name: "write_file", input: { path: "expiry.txt", content: "demo" } }) : response());
  try {
    await f.host.gateway.receive(message(1, "write")); await until(() => !!f.api.code());
    const expired = f.api.code()!; elapsed = 6 * 60_000;
    await f.host.gateway.receive(message(2, `允许 ${expired}`, 300));
    await assert.rejects(readFile(join(f.workspace, "expiry.txt")), { code: "ENOENT" });
    await f.host.gateway.receive(message(3, "当前确认", 300));
    assert.notEqual(f.api.code(), expired);
    await f.host.gateway.receive(message(4, `允许 ${f.api.code()!}`, 300)); await f.idle();
    assert.equal(await readFile(join(f.workspace, "expiry.txt"), "utf8"), "demo");
  } finally { await f.cleanup(); }
});
it("QQ restart during an approval never restores its code or repeats its tool", async () => {
  const f = await fixture(call => call === 1 ? response({ name: "write_file", input: { path: "restart.txt", content: "demo" } }) : response());
  try {
    await f.host.gateway.receive(message(1, "write")); await until(() => !!f.api.code());
    const code = f.api.code()!; await f.restart();
    await f.host.gateway.receive(message(2, `允许 ${code}`, 300));
    await assert.rejects(readFile(join(f.workspace, "restart.txt")), { code: "ENOENT" });
    assert.equal(f.calls(), 1); assert.equal(f.host.store.snapshot().inputs.find(x => x.key === "1")!.state, "unknown");
  } finally { await f.cleanup(); }
});
it("QQ transport loss cancels a waiting tool; a member cannot stop it and the old code cannot execute after disconnect", async () => {
  const f = await fixture(call => call === 1 ? response({ name: "write_file", input: { path: "disconnect.txt", content: "demo" } }) : response());
  try {
    await f.host.gateway.receive(message(1, "write")); await until(() => !!f.api.code());
    await f.host.gateway.receive(message(2, "停止", 400));
    assert.equal(f.host.controller.getSnapshot().state.kind, "running");
    const code = f.api.code()!; f.api.disconnected(); await f.idle();
    await f.host.gateway.receive(message(3, `允许 ${code}`, 300));
    await assert.rejects(readFile(join(f.workspace, "disconnect.txt")), { code: "ENOENT" });
    assert.equal(f.calls(), 1);
  } finally { await f.cleanup(); }
});
it("QQ persistence failure stops before model admission and does not accept a later message", async t => {
  const f = await fixture();
  try {
    t.mock.method(f.host.store, "update", async () => { throw new Error("uncertain persistence"); });
    await f.host.gateway.receive(message(1, "must not run"));
    await f.host.gateway.receive(message(2, "must not run either"));
    assert.equal(f.calls(), 0); assert.equal(f.api.sent.length, 0); assert.equal(f.logs.some(x => x.includes("接收已停止")), true);
  } finally { await f.cleanup(); }
});
it("QQ text received before final settlement stays rejected even if a queued finish becomes idle first", async () => {
  const f = await fixture(); let injected = false;
  const remove = f.host.controller.subscribe(event => {
    if (event.type === "run-result" && !injected) { injected = true; void f.host.gateway.receive(message(2, "arrived during prior run")); }
  });
  try {
    await f.host.gateway.receive(message(1, "first question")); await f.idle();
    assert.equal(injected, true); assert.equal(f.calls(), 1); assert.match(f.api.texts().join("\n"), /未排队/);
  } finally { remove(); await f.cleanup(); }
});
