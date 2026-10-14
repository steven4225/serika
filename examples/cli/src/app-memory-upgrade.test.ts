import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createMemoryStore } from "./memory-store.js";
import { createWorkTaskStore } from "./work-task-store.js";
import { RETRIEVED_MEMORY_MAX_BYTES } from "./memory-retrieval.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const response = (tool: boolean) => ({ stream: simulateReadableStream({ chunks: [
  { type: "stream-start" as const, warnings: [] },
  ...(tool ? [{ type: "tool-call" as const, toolName: "add", toolCallId: "sum", input: '{"left":1,"right":2}' }] : [{ type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "回答" }, { type: "text-end" as const, id: "answer" }]),
  { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
] }) });

describe("assembled memory upgrade", () => {
  it("keeps cloud-configured chat usable without a dedicated key and truthfully reports lexical degradation", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-cloud-app-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, semantic: { enabled: true, provider: "dashscope" } } } }));
    assert.ok((await createMemoryStore(workspace).add({ text: "咖啡不加糖。" })).ok);
    let prompt = "";
    const model = new MockLanguageModelV3({ doStream: async options => { prompt = JSON.stringify(options.prompt); return response(false); } });
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "current", "--config", config], modelAlias: "fixture", model, output,
      env: { OPENAI_API_KEY: "fixture-chat-key-must-not-be-used" }, cwd: root });
    try {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id: "cloud-query", role: "user", parts: [{ type: "text", text: "咖啡" }] }] });
      const pump = (async () => { for await (const _event of handle.events) {} })();
      assert.equal((await handle.result).status, "completed"); await pump;
      const reference = app.getMemoryReferences!();
      assert.equal(reference?.semantic?.state, "degraded");
      assert.equal(reference?.semantic?.modelId, "qwen3.7-text-embedding-flash");
      assert.equal(reference?.selected[0]?.reason, "matched");
      assert.match(prompt, /咖啡不加糖/);
      assert.doesNotMatch(prompt + JSON.stringify(reference), /fixture-chat-key/);
    } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  for (const compact of [false, true]) it(`retrieves paraphrase with fixture vectors, sees latest facts and reuses query per message (compact=${compact})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-hybrid-app-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, semantic: { enabled: true } } }, ...(compact ? { contextCompaction: { enabled: true, contextWindowTokens: 30000, maxOutputTokens: 1024, safetyMarginTokens: 512, keepRecentTokens: 3072, summaryMaxOutputTokens: 1024 } } : {}) }));
    const memory = createMemoryStore(workspace);
    const saved = await memory.add({ text: "复盘先结论，再列两步。" }); assert.ok(saved.ok);
    await memory.add({ text: "私有复盘材料", scope: { kind: "thread", threadId: "other" } });
    await memory.add({ text: "停用复盘材料", enabled: false });
    let calls = 0;
    const prompts: string[] = [], embeddings: string[][] = [];
    const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => { prompts.push(JSON.stringify(prompt)); return response(++calls === 1); } });
    const output = new PassThrough(); output.resume();
    const open = () => createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "current", "--config", config], modelAlias: "fixture", model, output,
      memoryEmbedding: { modelId: "deterministic-fixture-not-real-model", embed: async texts => { embeddings.push([...texts]); return texts.map(() => [1, 0]); } }, env: {}, cwd: root });
    let app = await open();
    app.toolConfirmation!.subscribePending(pending => { if (pending) app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: "allow" }); });
    const run = async (id: string, text: string) => {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id, role: "user", parts: [{ type: "text", text }] }] });
      const pump = (async () => { for await (const _event of handle.events) {} })();
      assert.equal((await handle.result).status, "completed"); await pump;
    };
    try {
      await run("query-1", "回顾应该怎么组织？顺便算1+2。");
      assert.match(prompts[0]!, /复盘先结论/);
      assert.equal(app.getMemoryReferences!()?.selected[0]?.reason, "semantic");
      assert.equal(embeddings.length, 1, "tool steps do not repeat an unchanged query embedding");
      assert.doesNotMatch(JSON.stringify(embeddings), /私有|停用/);
      app.dispose(); app = await open();
      await run("query-2", "回顾应该怎么组织？");
      assert.equal(embeddings.at(-1)!.length, 1, "restart reuses fact vectors but performs a real new query embedding");
      assert.ok((await memory.update(saved.entry.id, { expectedRevision: 1, text: "复盘先结论，再列三步。" })).ok);
      await run("query-3", "回顾应该怎么组织？");
      assert.match(prompts.at(-1)!, /三步/); assert.doesNotMatch(prompts.at(-1)!, /两步/);
      assert.ok((await memory.update(saved.entry.id, { expectedRevision: 2, enabled: false })).ok);
      await run("query-4", "回顾应该怎么组织？");
      assert.equal(app.getMemoryReferences!()?.selected.length, 0);
    } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("injects only effective derived profile/current Thread continuation within the shared budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-profile-app-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, contextView: { enabled: true } } } }));
    const memory = createMemoryStore(workspace);
    const profile = await memory.add({ text: "我希望回答先结论。", kind: "preference", factIdentity: { attribute: "review_format", scenario: "general", value: "conclusion_first" } }); assert.ok(profile.ok);
    await memory.add({ text: "其他对话私有偏好", scope: { kind: "thread", threadId: "other" }, kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "sweetened" } });
    const tasks = createWorkTaskStore(workspace);
    const acceptance = [{ id: "quality", description: "用户验收", method: "human" as const, required: true, verification: { kind: "human" as const } }];
    assert.ok((await tasks.create({ threadId: "current", goal: "待续：核对项目报告", acceptance })).ok);
    assert.ok((await tasks.create({ threadId: "other", goal: "不应注入的私有任务", acceptance })).ok);
    let prompt = "";
    let referenceBytes = 0;
    const model = new MockLanguageModelV3({ doStream: async options => {
      prompt = JSON.stringify(options.prompt);
      return response(false);
    } });
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "current", "--config", config], modelAlias: "fixture", model, output, env: {}, cwd: root });
    try {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id: "new-topic", role: "user", parts: [{ type: "text", text: "你好" }] }] });
      const pump = (async () => { for await (const _event of handle.events) {} })();
      assert.equal((await handle.result).status, "completed"); await pump;
      assert.match(prompt, /我希望回答先结论/);
      assert.match(prompt, /待续：核对项目报告/);
      assert.doesNotMatch(prompt, /No matching Memory entries for this question/);
      assert.doesNotMatch(prompt, /其他对话私有偏好|不应注入的私有任务/);
      const snapshot = app.getMemoryReferences!()!;
      assert.deepEqual(snapshot.selected.map(item => [item.id, item.reason]), [[profile.entry.id, "stable_profile"]]);
      assert.equal(snapshot.contextView?.continuationCount, 1);
      referenceBytes = snapshot.referenceBytes ?? Infinity;
      assert.ok(referenceBytes <= RETRIEVED_MEMORY_MAX_BYTES);
    } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
  });

  it("rechecks formal revisions after embedding and skips excluded synthetic input", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-inference-race-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, semantic: { enabled: true } } } }));
    const memory = createMemoryStore(workspace);
    const saved = await memory.add({ text: "推理期间撤回的旧偏好" }); assert.ok(saved.ok);
    let embeddings = 0, prompt = "";
    const model = new MockLanguageModelV3({ doStream: async options => { prompt = JSON.stringify(options.prompt); return response(false); } });
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "current", "--config", config], modelAlias: "fixture", model, output, env: {}, cwd: root,
      memoryEmbedding: { modelId: "race-fixture", embed: async texts => {
        embeddings += 1;
        assert.ok((await memory.update(saved.entry.id, { expectedRevision: 1, enabled: false })).ok);
        return texts.map(() => [1, 0]);
      } } });
    const run = async (message: import("ai").UIMessage) => {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [message] });
      const pump = (async () => { for await (const _event of handle.events) {} })();
      assert.equal((await handle.result).status, "completed"); await pump;
    };
    try {
      await run({ id: "race", role: "user", parts: [{ type: "text", text: "我之前有什么习惯？" }] });
      assert.equal(embeddings, 1);
      assert.equal(app.getMemoryReferences!()?.selected.length, 0);
      assert.doesNotMatch(prompt, /推理期间撤回的旧偏好/);
      await run({ id: "excluded", role: "user", metadata: { memoryConsolidation: "exclude" }, parts: [{ type: "text", text: "隔离输入" }] });
      assert.equal(embeddings, 1, "excluded inputs never dispatch embedding");
      assert.equal(app.getMemoryReferences!()?.semantic?.state, "not_applicable");
      await run({ id: "no-eligible-facts", role: "user", parts: [{ type: "text", text: "换一个普通问题" }] });
      assert.equal(embeddings, 1, "no eligible facts means no embedding request or readiness claim");
      assert.equal(app.getMemoryReferences!()?.semantic?.state, "not_applicable");
      assert.ok((await memory.update(saved.entry.id, { expectedRevision: 2, enabled: true })).ok);
      await run({ id: "scheduled", role: "user", metadata: { source: "scheduled-task" }, parts: [{ type: "text", text: "提醒到期，不是新的用户消息" }] });
      assert.equal(embeddings, 1, "scheduled synthetic messages never dispatch embedding");
      assert.equal(app.getMemoryReferences!()?.semantic?.state, "not_applicable");
    } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
