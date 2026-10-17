import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import type { MemoryProposal, PreparedBatch } from "./memory-consolidation.js";

// Recorded desktop failure, NOT a simulated proof that a model follows guidance.
const statements = ["仅在当前对话里，我喝咖啡不加糖。", "从现在起，仅在当前对话里，我的咖啡改成加糖。", "仅在当前对话里，我喝咖啡不加糖。"] as const;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
function response(text: string) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "answer" },
    { type: "text-delta" as const, id: "answer", delta: text }, { type: "text-end" as const, id: "answer" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
  ] }) };
}
function texts(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap(message => typeof message.content === "string" ? [message.content]
    : Array.isArray(message.content) ? message.content.flatMap((part: { type: string; text?: string }) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : []) : []);
}
async function replay() {
  const root = await mkdtemp(join(tmpdir(), "memory-historical-conflict-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: {
    enabled: true, autoConsolidate: true, writePolicy: "automatic",
  } } }));
  let extraction = 0, extractionInstructions = "", primaryInstructions = "";
  let finalBatch: PreparedBatch | undefined;
  const model = new MockLanguageModelV3({ doStream: async options => {
    const content = texts(options.prompt);
    const material = content.find(text => text.startsWith("Extract only from this host-prepared material."));
    if (!material) {
      primaryInstructions = options.prompt.filter(item => item.role === "system").map(item => item.content).join("\n");
      return response("收到，保存状态以程序回执为准。");
    }
    extractionInstructions = options.prompt.filter(item => item.role === "system").map(item => item.content).join("\n");
    const batch = JSON.parse(material.slice(material.indexOf("\n") + 1)) as PreparedBatch;
    const sources = "bootstrap" in batch ? batch.turns.map(turn => turn.user)
      : batch.turns.flatMap(turn => turn.messages.filter(message => message.role === "user").map(message => ({ messageId: message.id, text: message.text })));
    const source = sources.at(-1); assert.ok(source);
    extraction += 1;
    let proposals: MemoryProposal[];
    if (extraction === 1) proposals = [{ action: "add", kind: "preference", text: statements[0],
      scope: { kind: "thread" }, eligibility: "durable_self_statement", reason: "当前对话的明确偏好",
      sources: [{ sourceMessageId: source.messageId, sourceQuote: source.text }],
      factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }];
    else if (extraction === 2) {
      const target = batch.memories[0]; assert.ok(target);
      assert.ok(target.revision);
      proposals = [{ action: "change", memoryId: target.id, expectedRevision: target.revision,
        kind: "preference", text: "仅在当前对话里，我喝咖啡加糖。", eligibility: "explicit_request", reason: "明确从现在起变更",
        sources: [{ sourceMessageId: source.messageId, sourceQuote: source.text }],
        changeIntent: { type: "replace_from_now", sourceQuote: source.text },
        factIdentity: { attribute: "coffee", scenario: "general", value: "sweetened" } }];
    } else {
      finalBatch = batch;
      // Observed: empty proposals despite differing current and matching historical values.
      proposals = [];
    }
    return response(JSON.stringify({ batchId: batch.batchId, proposals,
      outcomes: sources.map(item => ({ messageId: item.messageId, status: "extracted" })) }));
  } });
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "origin", configPath: config },
    modelAlias: "fixture/not-real-model", model, output, env: {}, cwd: root });
  const controller = createAssistantController(app);
  try {
    let previousCursor: unknown;
    for (let index = 0; index < statements.length; index += 1) {
      const result = await controller.run(statements[index]!); assert.ok(result.ok);
      const deadline = Date.now() + 5_000;
      while (controller.getSnapshot().state.kind !== "idle") {
        assert.ok(Date.now() < deadline, "Automatic consolidation did not settle"); await delay(5);
      }
      if (index === 1) previousCursor = await app.memoryStore!.getConsolidationCursor("origin");
    }
    assert.equal(extraction, 3);
    assert.ok(finalBatch);
    const target = finalBatch.memories[0]; assert.ok(target);
    assert.equal(target.revision, 2);
    assert.equal(target.assertion?.factIdentity?.value, "sweetened");
    assert.ok(target.relatedAssertions?.some(item => item.text === statements[0]), "Historical unsweetened assertion must reach the actual extraction boundary");
    const pending = await controller.listMemoryCandidates({ status: "pending" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0, "Recorded empty proposals cannot fabricate review");
    assert.deepEqual(await app.memoryStore!.getConsolidationCursor("origin"), previousCursor, "False extracted coverage must not advance the cursor");
    const receipt = await app.memoryStore!.getConsolidationReceipt!("origin"); assert.ok(receipt.ok);
    assert.equal(receipt.value?.outcomes.at(-1)?.status, "deferred");
    const current = await app.memoryStore!.get(target.id); assert.ok(current.ok);
    assert.equal(current.entry.revision, 2); assert.equal(current.entry.assertion?.factIdentity?.value, "sweetened");
    return { extractionInstructions, primaryInstructions };
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
}

test("recorded three-turn empty extraction stays deferred without reviving the historical same-value preference", async () => {
  await replay();
});

test("three-turn conflict prompt distinguishes CURRENT targets from same-value historical assertions", async () => {
  const contract = await replay();
  assert.match(contract.extractionInstructions, /A historical same-value assertion does not account for a new source/);
  assert.match(contract.extractionInstructions, /ordinary contradiction[\s\S]*source-backed add[\s\S]*needs_review/i);
  assert.match(contract.primaryInstructions, /Do not say an ordinary conflicting statement has changed back, overwritten, or invalidated the old preference/);
});
