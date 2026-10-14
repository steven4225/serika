import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createMemoryStore } from "@aisdk-agent/example-cli/dist/memory-store.js";
import { DesktopRuntime } from "../../main/desktop-runtime.js";
import { loadDesktopEnvironment } from "../../main/desktop-env.js";
import { MemoryReferenceDetails } from "./memory-references.js";
import type { MainToRenderer } from "../../shared/ui-contract.js";

const MODEL = "qwen3.7-text-embedding-flash";
const FIXTURE_KEY = "isolated-embedding-fixture-not-a-real-key";

async function fixture(t: TestContext, options: { key?: boolean; httpStatus?: number; contextView?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "serika-desktop-semantic-"));
  let cleanupHost: DesktopRuntime | undefined;
  t.after(async () => {
    try { await cleanupHost?.shutdown(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const workspace = join(root, "workspace"), configPath = join(root, "config.json"), envPath = join(root, "host.env");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true,
    semantic: { enabled: true, provider: "dashscope", modelId: MODEL },
    ...(options.contextView ? { contextView: { enabled: true } } : {}),
  } } }));
  await writeFile(envPath, options.key === false ? "COMMAND_CODE_API_KEY=isolated-chat-fixture-not-an-embedding-key\n"
    : `DASHSCOPE_API_KEY=${FIXTURE_KEY}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { RUNLOOM_CONFIG: configPath, RUNLOOM_ENV_FILE: envPath };
  await loadDesktopEnvironment(env);
  const submitted: string[] = [], prompts: string[] = [], events: MainToRenderer[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${FIXTURE_KEY}`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, MODEL);
    assert.equal(typeof body.input, "string", "the observed cloud model must bind one input to each request");
    submitted.push(body.input);
    return options.httpStatus ? new Response("not retained provider failure", { status: options.httpStatus })
      : Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } });
  });
  const model = new MockLanguageModelV3({ doStream: async request => {
    prompts.push(JSON.stringify(request.prompt));
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "这是隔离接线验收，不代表真实模型质量。" }, { type: "text-end", id: "text" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      } },
    ] }) };
  } });
  const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env, modelAlias: "mock", model,
    send: event => events.push(event) });
  cleanupHost = host;
  const memory = createMemoryStore(workspace);
  const run = async (text: string, exclude = false) => {
    const started = await host.current.run(text, exclude ? { memoryConsolidation: "exclude" } : undefined);
    assert.ok(started.ok);
    const deadline = Date.now() + 10_000;
    while (host.current.snapshot().state.kind !== "idle") {
      assert.ok(Date.now() < deadline, "isolated desktop run must settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const reference = host.current.getMemoryReferences();
    assert.ok(reference);
    return reference;
  };
  return { root, workspace, configPath, host, memory, run, submitted, prompts, events };
}

it("desktop cloud path loads only the dedicated host Key, publishes and injects eligible references across Thread switches", async t => {
  const f = await fixture(t);
  const shared = await f.memory.add({ text: "验收事实：蓝鲸项目使用紫色封面。" }); assert.ok(shared.ok);
  const own = await f.memory.add({ text: "当前对话事实：海豚项目使用橙色封面。", scope: { kind: "thread", threadId: f.host.info().threadId } }); assert.ok(own.ok);
  const foreign = await f.memory.add({ text: "外国对话禁止导出的内容。", scope: { kind: "thread", threadId: "foreign-thread" } }); assert.ok(foreign.ok);
  const disabled = await f.memory.add({ text: "停用的禁止导出内容。", enabled: false }); assert.ok(disabled.ok);
  const expired = await f.memory.add({ text: "过期的禁止导出内容。", expiresAt: "2020-01-01T00:00:00.000Z" }); assert.ok(expired.ok);
  const first = await f.run("请回答那项设计选择。");
  assert.equal(first.semantic?.state, "ready"); assert.equal(first.semantic?.modelId, MODEL);
  assert.deepEqual(new Set(first.selected.map(entry => entry.id)), new Set([shared.entry.id, own.entry.id]));
  assert.ok(first.selected.every(entry => entry.reason === "semantic" || entry.reason === "hybrid"));
  assert.ok(f.prompts[0]?.includes(shared.entry.text)); assert.ok(f.prompts[0]?.includes(own.entry.text));
  const markup = renderToStaticMarkup(createElement(MemoryReferenceDetails, { reference: first }));
  assert.match(markup, /本轮语义检索：就绪/); assert.match(markup, /蓝鲸项目/);
  assert.ok(f.events.some(event => event.type === "memory-references-changed"));
  for (const entry of [foreign, disabled, expired]) {
    assert.equal(f.submitted.includes(entry.entry.text), false, "filter before cloud export");
    assert.equal(f.prompts[0]?.includes(entry.entry.text), false, "filter before model injection");
  }
  const beforeSwitch = f.submitted.length;
  await f.host.createThread();
  const second = await f.run("再次回答那项设计选择。");
  assert.deepEqual(second.selected.map(entry => entry.id), [shared.entry.id]);
  assert.equal(f.submitted.slice(beforeSwitch).includes(own.entry.text), false);
  assert.equal(f.prompts[1]?.includes(own.entry.text), false);
  const exported = JSON.stringify([f.host.info(), f.events, first, second, await f.host.current.listRuns()]);
  assert.equal(exported.includes(FIXTURE_KEY), false);
  for (const path of [f.configPath, join(f.workspace, ".runloom", "memory-semantic-index.json")]) {
    assert.equal((await readFile(path, "utf8")).includes(FIXTURE_KEY), false);
  }
});

it("missing desktop embedding Key does not borrow the chat Key or block a lexical-backed chat", async t => {
  const f = await fixture(t, { key: false });
  const saved = await f.memory.add({ text: "咖啡不加糖。" }); assert.ok(saved.ok);
  const reference = await f.run("咖啡怎么喝？");
  assert.equal(f.submitted.length, 0);
  assert.equal(reference.semantic?.state, "degraded");
  assert.ok(reference.selected.some(entry => entry.id === saved.entry.id));
  assert.ok(f.prompts[0]?.includes(saved.entry.text));
  assert.match(renderToStaticMarkup(createElement(MemoryReferenceDetails, { reference, hideEmpty: true })), /语义检索暂不可用.*关键词检索/);
  const runs = await f.host.current.listRuns(); assert.ok(runs.ok);
  assert.equal(runs.runs[0]?.status, "completed");
});

it("desktop embedding service errors degrade visibly without retrying the external requests", async t => {
  const f = await fixture(t, { httpStatus: 503 });
  const saved = await f.memory.add({ text: "咖啡不加糖。" }); assert.ok(saved.ok);
  const reference = await f.run("咖啡怎么喝？");
  assert.equal(reference.semantic?.state, "degraded");
  assert.equal(f.submitted.length, 2, "one request for the fact and one for the query; no retry");
  assert.ok(reference.selected.some(entry => entry.id === saved.entry.id));
  assert.equal(JSON.stringify([reference, f.events]).includes("not retained provider failure"), false);
});

it("excluded desktop input retains local keyword references but does not dispatch semantic inference or derived profiles", async t => {
  const f = await fixture(t, { contextView: true });
  const saved = await f.memory.add({ text: "咖啡不加糖。", kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }); assert.ok(saved.ok);
  const reference = await f.run("咖啡怎么喝？", true);
  assert.equal(f.submitted.length, 0);
  assert.equal(reference.semantic?.state, "not_applicable"); assert.equal(reference.contextView, undefined);
  assert.ok(reference.selected.some(entry => entry.id === saved.entry.id));
  assert.ok(f.prompts[0]?.includes(saved.entry.text));
  const history = await f.host.current.history();
  assert.ok(history.some(message => (message.metadata as { memoryConsolidation?: unknown })?.memoryConsolidation === "exclude"));
});
