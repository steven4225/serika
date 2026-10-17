import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import type { PreparedBatch } from "./memory-consolidation.js";

// Real application lifecycle, deterministic model fixture: wiring, not live semantic accuracy.
for (const domain of [
  { subject: "我", attribute: "主要用", before: "VS Code", after: "Neovim" },
  { subject: "项目A", attribute: "部署位置", before: "服务器A", after: "服务器B" },
]) test(`generic ${domain.attribute}: Controller extracts, updates, deduplicates and preserves current truth`, async () => {
  const root = await mkdtemp(join(tmpdir(), "app-generic-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const statement = (value: string) => `${domain.subject}${domain.attribute}${domain.attribute === "主要用" ? " " : "是"}${value}。`;
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" } } }));
  const stream = (text: string) => ({ stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "a" },
    { type: "text-delta" as const, id: "a", delta: text }, { type: "text-end" as const, id: "a" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } } },
  ] }) });
  let extractions = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    const texts = options.prompt.flatMap(message => typeof message.content === "string" ? [message.content] :
      message.content.flatMap(part => part.type === "text" ? [part.text] : []));
    const material = texts.find(text => text.startsWith("Extract only from this host-prepared material."));
    if (!material) return stream("明白，保存结果以程序回执为准。");
    assert.ok(texts.some(text => text.includes("factEvidence {statementQuote}")), "real extraction prompt must teach generic evidence");
    extractions++;
    const batch = JSON.parse(material.slice(material.indexOf("\n") + 1)) as PreparedBatch;
    const sources = "bootstrap" in batch ? batch.turns.map(turn => turn.user) :
      batch.turns.flatMap(turn => turn.messages.filter(message => message.role === "user").map(message => ({ messageId: message.id, text: message.text })));
    assert.equal(sources.length, 1);
    const source = sources[0]!, changing = source.text.startsWith("从现在起") || source.text.startsWith("已经迁到");
    const target = batch.memories.find(entry => entry.assertion?.factIdentity?.attribute === domain.attribute);
    const value = extractions === 1 ? domain.before : domain.after;
    return stream(JSON.stringify({ batchId: batch.batchId, proposals: [{ action: changing ? "change" : "add", kind: "fact",
      text: statement(value),
      factIdentity: { version: 3, subject: domain.subject, attribute: domain.attribute, scenario: "general", value },
      factEvidence: { statementQuote: source.text, ...(changing && domain.attribute === "部署位置" ? { targetQuote: target!.text } : {}) },
      sources: [{ sourceMessageId: source.messageId, sourceQuote: source.text }], reason: "明确的持续事实", eligibility: "explicit_request",
      ...(changing ? { memoryId: target!.id, expectedRevision: target!.revision, changeIntent: { type: "replace_from_now", sourceQuote: source.text } } : {}) }],
      outcomes: [{ messageId: source.messageId, status: "extracted" }] }));
  } });
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "t", configPath: config }, model, modelAlias: "fixture/no-network", output, env: {}, cwd: root });
  const controller = createAssistantController(app);
  try {
    for (const text of [statement(domain.before), domain.attribute === "部署位置" ? `已经迁到${domain.after}。` : `从现在起${statement(domain.after)}`, statement(domain.after)]) {
      assert.ok((await controller.run(text)).ok);
      const deadline = Date.now() + 15_000;
      while (controller.getSnapshot().state.kind !== "idle") { assert.ok(Date.now() < deadline); await delay(10); }
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    }
    assert.equal(extractions, 3);
    const list = await app.memoryStore!.list(); assert.ok(list.ok); assert.equal(list.entries.length, 1);
    assert.equal(list.entries[0]!.assertion?.factIdentity?.value, domain.after);
    const history = await controller.getMemoryHistory({ id: list.entries[0]!.id }); assert.ok(history.ok);
    assert.ok(history.value.assertions.some(assertion => assertion.text.includes(domain.before)));
    const pending = await controller.listMemoryCandidates({ status: "pending" }); assert.ok(pending.ok); assert.equal(pending.value.candidates.length, 0);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});
