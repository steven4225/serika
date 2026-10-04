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

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function response(tool = false) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(tool ? [{ type: "tool-call" as const, toolName: "add", toolCallId: "addition", input: '{"left":1,"right":2}' }] : []),
    { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
  ] }) };
}

describe("question-based Memory app context", () => {
  it("resolves a follow-up topic from the reopened Thread without reviving disabled memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-topic-recall-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace,
      modules: { memory: { enabled: true, queryRewrite: { enabled: true } } } }));
    const memory = createMemoryStore(workspace);
    const fact = await memory.add({ text: "复盘格式：先结论再两步。" }); assert.ok(fact.ok);
    const rewrites: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async options => {
        const prompt = JSON.stringify(options.prompt.filter(item => item.role === "user"));
        rewrites.push(prompt);
        return { content: [{ type: "text", text: '{"queries":["复盘格式"]}' }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
      doStream: async () => response(),
    });
    const output = new PassThrough(); output.resume();
    const open = () => createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "topic-thread", "--config", join(root, "config.json")], modelAlias: "mock", model, output, env: {}, cwd: root });
    let app = await open();
    const run = async (id: string, text: string) => {
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id, role: "user", parts: [{ type: "text", text }] }] });
      const pump = (async () => { for await (const _event of handle.events) {} })();
      assert.equal((await handle.result).status, "completed"); await pump;
    };
    try {
      await run("topic", "我想写项目复盘，先讨论格式。");
      app.dispose(); app = await open();
      await run("followup", "那个格式按我的偏好应该怎样？");
      assert.match(rewrites.at(-1)!, /我想写项目复盘/);
      assert.match(rewrites.at(-1)!, /那个格式/);
      assert.deepEqual(app.getMemoryReferences?.()?.selected.map(item => item.id), [fact.entry.id]);
      assert.ok((await memory.update(fact.entry.id, { expectedRevision: 1, enabled: false })).ok);
      await run("disabled", "那个格式呢？");
      assert.deepEqual(app.getMemoryReferences?.()?.selected, []);
      assert.equal(rewrites.length, 3);
    } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  for (const compact of [false, true]) {
    it(`uses current user query across steps and reopens current versions (compaction=${compact})`, async () => {
      const root = await mkdtemp(join(tmpdir(), "runloom-retrieval-app-"));
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const config = join(root, "config.json");
      await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } }, ...(compact ? { contextCompaction: {
        enabled: true, contextWindowTokens: 30000, maxOutputTokens: 1024, safetyMarginTokens: 512, keepRecentTokens: 3072, summaryMaxOutputTokens: 1024,
      } } : {}) }));
      const memory = createMemoryStore(workspace);
      const initial = await memory.add({ text: "复盘格式：先结论再两步。" }); assert.ok(initial.ok);
      const irrelevant = await memory.add({ text: "咖啡选择：浅烘焙。" }); assert.ok(irrelevant.ok);
      await memory.add({ text: "复盘私有事实", scope: { kind: "thread", threadId: "other" } });
      const prompts: string[] = [];
      let calls = 0;
      const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt)); calls++;
        if (calls === 1) return response(true);
        return response();
      } });
      const output = new PassThrough(); output.resume();
      const args = ["--tui", join(root, "transcripts"), "--thread", "fresh-thread", "--config", config];
      let app = await createRuntimeApp({ args, modelAlias: "mock", model, output, env: {}, cwd: root });
      app.toolConfirmation!.subscribePending((pending) => {
        if (pending) {
          // A write between steps must be seen on the next hook, not a stale cached prefix.
          void memory.update(initial.entry.id, { expectedRevision: 1, text: "复盘格式：先结论再三步。" }).then(() => app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: "allow" }));
        }
      });
      async function run(text: string, id: string) {
        const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id, role: "user", parts: [{ type: "text", text }] }] });
        const pump = (async () => { for await (const _event of handle.events) {} })();
        assert.equal((await handle.result).status, "completed"); await pump;
      }
      try {
        await run("复盘格式是什么？顺便算1+2。", "question-one");
        assert.match(prompts[0]!, /先结论再两步/);
        assert.match(prompts[1]!, /先结论再三步/);
        assert.doesNotMatch(prompts[1]!, /先结论再两步|浅烘焙|复盘私有事实/);
        const references = prompts.map((prompt) => JSON.parse(prompt) as Array<{ content?: unknown }>).flatMap((prompt) => prompt.flatMap((message) =>
          Array.isArray(message.content) ? message.content.filter((part: { text?: string }) => part.text?.startsWith("Current Memory reference:")) : [],
        ));
        assert.ok(references.length > 0);
        assert.doesNotMatch(JSON.stringify(references), /sourceQuote|history/);
        app.dispose();
        app = await createRuntimeApp({ args, modelAlias: "mock", model, output, env: {}, cwd: root });
        await run("复盘格式是什么？不要查询工具。", "question-two");
        assert.match(prompts.at(-1)!, /先结论再三步/);
        assert.doesNotMatch(prompts.at(-1)!, /先结论再两步/);
        await memory.update(initial.entry.id, { expectedRevision: 2, enabled: false });
        await run("复盘格式是什么？", "question-three");
        assert.match(prompts.at(-1)!, /No matching Memory entries/);
        assert.doesNotMatch(prompts.at(-1)!, /先结论再三步|浅烘焙/);
      } finally { app.dispose(); await rm(root, { recursive: true, force: true }); }
    });
  }
});
