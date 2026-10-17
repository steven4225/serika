import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import type { PreparedBatch } from "./memory-consolidation.js";
import { createMemoryStore } from "./memory-store.js";

// This is transport-free integration acceptance, not real-model recall quality:
// only model extraction and embedding vectors are scripted. Controller, runtime,
// committed transcripts, formal store, reviews, receipts and references are real.
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
function response(text: string) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "answer" },
    { type: "text-delta" as const, id: "answer", delta: text },
    { type: "text-end" as const, id: "answer" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
  ] }) };
}

function promptTexts(prompt: unknown): string[] {
  if (!Array.isArray(prompt)) return [];
  return prompt.flatMap(message => {
    if (typeof message.content === "string") return [message.content];
    return Array.isArray(message.content)
      ? message.content.flatMap((part: { type: string; text?: string }) => part.type === "text" && typeof part.text === "string" ? [part.text] : []) : [];
  });
}
function sources(batch: PreparedBatch): Array<{ messageId: string; text: string }> {
  return "bootstrap" in batch ? batch.turns.map(turn => turn.user)
    : batch.turns.flatMap(turn => turn.messages.filter(message => message.role === "user").map(message => ({ messageId: message.id, text: message.text })));
}
type Extract = (batch: PreparedBatch) => unknown[];

async function fixture(extract: Extract) {
  const root = await mkdtemp(join(tmpdir(), "memory-controller-chain-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: {
    enabled: true, autoConsolidate: true, writePolicy: "automatic", semantic: { enabled: true },
  } } }));
  const embeddingInputs: string[][] = [], references: string[][] = [];
  const extractions: PreparedBatch[] = [];
  let failEmbedding = false;
  const model = new MockLanguageModelV3({ doStream: async options => {
    const texts = promptTexts(options.prompt);
    const material = texts.find(text => text.startsWith("Extract only from this host-prepared material."));
    if (material) {
      const batch = JSON.parse(material.slice(material.indexOf("\n") + 1)) as PreparedBatch;
      extractions.push(batch);
      const proposals = extract(batch);
      return response(JSON.stringify({ batchId: batch.batchId, proposals, outcomes: sources(batch).map(source => ({
        messageId: source.messageId,
        status: proposals.some(proposal => typeof proposal === "object" && proposal !== null && "sourceMessageId" in proposal && proposal.sourceMessageId === source.messageId) ? "extracted" : "no_memory",
      })) }));
    }
    references.push(texts.filter(text => text.startsWith("Current Memory reference:")));
    return response("收到。保存结果以程序回执为准。");
  } });
  const controllers: AssistantController[] = [];
  const open = async (threadId: string) => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: threadId, configPath: config },
      modelAlias: "fixture/not-real-model", model, output, env: {}, cwd: root,
      memoryEmbedding: { modelId: "fixture/not-real-embedding", embed: async texts => {
        embeddingInputs.push([...texts]);
        if (failEmbedding) throw new Error("fixture provider failure must not enter reference diagnostics");
        return texts.map(() => [1, 0]);
      } } });
    const controller = createAssistantController(app);
    controllers.push(controller);
    controller.subscribe(event => {
      if (event.type === "approval") assert.fail(`Automatic memory unexpectedly requested ${event.approval.toolName} approval`);
    });
    return { app, controller };
  };
  return { root, workspace, open, embeddingInputs, references, extractions,
    failEmbedding: (value: boolean) => { failEmbedding = value; },
    cleanup: async () => { for (const controller of controllers) await controller.shutdown(); await rm(root, { recursive: true, force: true }); } };
}

async function run(controller: AssistantController, text: string) {
  const start = await controller.run(text);
  assert.ok(start.ok, JSON.stringify(start));
  const deadline = Date.now() + 5_000;
  while (controller.getSnapshot().state.kind !== "idle") {
    if (Date.now() > deadline) assert.fail("Controller chain did not settle");
    await delay(5);
  }
  assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
}

function coffee(source: { messageId: string; text: string }, sweetened: boolean) {
  return { action: "add", kind: "preference", text: sweetened ? "我喝咖啡加糖。" : "我喝咖啡不加糖。",
    sourceMessageId: source.messageId, sourceQuote: source.text, reason: "fixture 用户明确偏好",
    eligibility: "durable_self_statement", factIdentity: { attribute: "coffee", scenario: "general", value: sweetened ? "sweetened" : "unsweetened" } };
}

test("Controller chain: new preference persists, paraphrase references it, explicit change retains history, ordinary conflict stays actionable", async () => {
  const f = await fixture(batch => sources(batch).flatMap(source => {
    if (source.text === "记住：我喝咖啡不加糖。") return [coffee(source, false)];
    if (source.text === "从现在起，我喝咖啡改成加糖。") {
      const target = batch.memories.find(memory => memory.assertion?.factIdentity?.attribute === "coffee");
      assert.ok(target, "host must supply the current formal target to extraction");
      return [{ ...coffee(source, true), action: "change", memoryId: target.id, expectedRevision: target.revision,
        eligibility: "explicit_request", changeIntent: { type: "replace_from_now", sourceQuote: source.text } }];
    }
    return source.text === "我喝咖啡不加糖。" ? [coffee(source, false)] : [];
  }));
  try {
    const { controller, app } = await f.open("origin");
    await run(controller, "记住：我喝咖啡不加糖。");
    const saved = await createMemoryStore(f.workspace).list(); assert.ok(saved.ok);
    assert.equal(saved.entries.length, 1);
    const initial = saved.entries[0]!;
    assert.equal(initial.source?.kind, "conversation");
    const saveReceipts = await controller.getMemoryReceipts(); assert.ok(saveReceipts.ok);
    assert.match(saveReceipts.value[0]!.text, /当时已保存.*咖啡不加糖/);
    assert.equal((await controller.getMemoryMaintenance()).ok, true);

    await run(controller, "我平时对饮品的甜度有什么习惯？");
    const recalled = controller.getMemoryReferences(); assert.ok(recalled);
    assert.equal(recalled.semantic?.state, "ready");
    assert.deepEqual(recalled.selected.map(memory => [memory.id, memory.reason]), [[initial.id, "semantic"]]);
    assert.match(f.references.at(-1)!.join("\n"), /咖啡不加糖/);
    const execution = await controller.getRun(recalled.runId); assert.ok(execution);
    assert.equal(JSON.stringify(execution).includes(initial.id), true, "actual preparation is also retained in execution evidence");

    await run(controller, "从现在起，我喝咖啡改成加糖。");
    const changed = await app.memoryStore!.get(initial.id); assert.ok(changed.ok);
    assert.equal(changed.entry.revision, initial.revision! + 1);
    assert.equal(changed.entry.assertion?.factIdentity?.value, "sweetened");
    const history = await controller.getMemoryHistory({ id: initial.id }); assert.ok(history.ok);
    assert.equal(history.value.assertions.some(assertion => assertion.text === initial.text), true);
    assert.equal(history.value.assertions.some(assertion => assertion.text === changed.entry.text), true);
    const beforeConflict = await controller.listMemoryCandidates({ status: "pending" }); assert.ok(beforeConflict.ok);
    assert.equal(beforeConflict.value.candidates.length, 0, "explicit current change is not an unnecessary review");

    await run(controller, "我喝咖啡不加糖。");
    const pending = await controller.listMemoryCandidates({ status: "pending" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    const preview = await controller.getMemoryCandidate(pending.value.candidates[0]!.id); assert.ok(preview.ok);
    assert.equal(preview.value.candidate.status, "pending");
    assert.equal(preview.value.applicable, true, JSON.stringify(preview.value));
    const unchanged = await app.memoryStore!.get(initial.id); assert.ok(unchanged.ok);
    assert.equal(unchanged.entry.text, changed.entry.text);
    const conflictReceipts = await controller.getMemoryReceipts(); assert.ok(conflictReceipts.ok);
    assert.match(conflictReceipts.value.at(-1)!.text, /确认.*不加糖.*原记忆没有被覆盖/);
    const maintenance = await controller.getMemoryMaintenance(); assert.ok(maintenance.ok);
    assert.equal(maintenance.value.pending, 1);

    await run(controller, "咖啡偏好现在是什么？");
    assert.deepEqual(controller.getMemoryReferences()?.selected.map(memory => [memory.id, memory.text]), [[initial.id, changed.entry.text]]);
    assert.doesNotMatch(f.references.at(-1)!.join("\n"), /咖啡不加糖/);
    const candidate = preview.value.candidate;
    assert.equal(candidate.change.operation, "change");
    assert.equal("effectiveAt" in candidate.change && candidate.change.effectiveAt, null);
    const missingTime = await controller.resolveMemoryCandidate({ candidateId: candidate.id, expectedCandidateRevision: candidate.revision, decision: "accept" });
    assert.ok(!missingTime.ok);
    assert.equal(missingTime.error.code, "MEMORY_EFFECTIVE_AT_REQUIRED");
    const stillPending = await controller.getMemoryCandidate(candidate.id); assert.ok(stillPending.ok);
    assert.equal(stillPending.value.candidate.status, "pending");
    assert.equal(stillPending.value.candidate.revision, candidate.revision);
    const confirmed = await controller.resolveMemoryCandidate({ candidateId: candidate.id, expectedCandidateRevision: candidate.revision,
      decision: "accept", effectiveAt: "now" });
    assert.ok(confirmed.ok, JSON.stringify(confirmed));
    const afterConfirmation = await createMemoryStore(f.workspace).list(); assert.ok(afterConfirmation.ok);
    assert.equal(afterConfirmation.entries.filter(entry => entry.enabled).length, 1);
    assert.equal(afterConfirmation.entries[0]!.assertion?.factIdentity?.value, "unsweetened");
    const priorApplicability = await controller.queryMemory({ id: initial.id, validAt: changed.entry.assertion!.validTime.from! });
    assert.ok(priorApplicability.ok);
    assert.equal(priorApplicability.value.assertions[0]?.text, changed.entry.text,
      "accepting an ordinary conflict from now must preserve the earlier sweetened interval, not retroactively correct it");
    const originalApplicability = await controller.queryMemory({ id: initial.id, validAt: initial.createdAt! });
    assert.ok(originalApplicability.ok);
    assert.equal(originalApplicability.value.assertions[0]?.text, initial.text, "the first unsweetened interval also remains known after both transitions");
    const reviewed = await controller.listMemoryCandidates({ status: "pending" }); assert.ok(reviewed.ok);
    assert.equal(reviewed.value.candidates.length, 0, "explicit review handles the conflict rather than leaving an unresolvable terminal record");
    const document = JSON.parse(await readFile(join(f.workspace, ".runloom", "memory.json"), "utf8"));
    assert.equal(document.version, 4, "all acceptance assertions refer to the persisted v4 truth, not model prose");
  } finally { await f.cleanup(); }
});

test("Controller chain: current-Thread source never becomes foreign desktop/TG references or embedding material", async () => {
  const privateText = "仅当前对话有效：我喝咖啡加糖。";
  const f = await fixture(batch => sources(batch).flatMap(source => source.text === privateText
    ? [{ ...coffee(source, true), scope: { kind: "workspace" } }] : []));
  try {
    const publicFact = await createMemoryStore(f.workspace).add({ text: "复盘先结论，再列两步。" }); assert.ok(publicFact.ok);
    const origin = await f.open("origin");
    await run(origin.controller, privateText);
    const saved = await origin.app.memoryStore!.list(); assert.ok(saved.ok);
    const privateFact = saved.entries.find(entry => entry.assertion?.factIdentity?.attribute === "coffee"); assert.ok(privateFact);
    assert.deepEqual(privateFact.scope, { kind: "thread", threadId: "origin" }, "host must not widen an explicit current-Thread source despite a workspace proposal");
    await run(origin.controller, "我的咖啡甜度偏好是什么？");
    assert.equal(origin.controller.getMemoryReferences()?.selected.some(memory => memory.id === privateFact.id), true);
    await origin.controller.shutdown();

    // The same shared Controller/runtime boundary is used by desktop and TG.
    // This is Thread-route isolation, not Telegram network-delivery acceptance.
    for (const thread of ["other-desktop", "telegram:isolated-fixture"]) {
      f.embeddingInputs.length = 0;
      const other = await f.open(thread);
      await run(other.controller, "我的咖啡甜度偏好是什么？");
      assert.equal(other.controller.getMemoryReferences()?.selected.some(memory => memory.id === privateFact.id), false, thread);
      assert.equal(JSON.stringify(f.embeddingInputs).includes(privateFact.text), false, "private formal text cannot be exported even when another eligible fact triggers embedding");
      assert.doesNotMatch(f.references.at(-1)!.join("\n"), /咖啡加糖/);
      const hidden = await other.controller.getMemory(privateFact.id);
      assert.ok(!hidden.ok); assert.equal(hidden.error.code, "MEMORY_ENTRY_NOT_FOUND");
      assert.equal(f.embeddingInputs.length > 0, true, "fixture exercised embedding, rather than passing through an empty store");
      await other.controller.shutdown();
    }
  } finally { await f.cleanup(); }
});

test("Controller chain: service failure degrades visibly without blocking lexical chat; restarted retraction excludes stale vectors", async () => {
  const f = await fixture(batch => sources(batch).flatMap(source => source.text === "记住：我喝咖啡不加糖。" ? [coffee(source, false)] : []));
  try {
    const first = await f.open("origin");
    await run(first.controller, "记住：我喝咖啡不加糖。");
    const saved = await first.app.memoryStore!.list(); assert.ok(saved.ok);
    const formal = saved.entries[0]!;
    f.failEmbedding(true);
    await run(first.controller, "咖啡偏好是什么？");
    const degraded = first.controller.getMemoryReferences(); assert.ok(degraded);
    assert.equal(degraded.semantic?.state, "degraded");
    assert.deepEqual(degraded.selected.map(memory => [memory.id, memory.reason]), [[formal.id, "matched"]]);
    assert.doesNotMatch(JSON.stringify(degraded), /provider failure/);
    await first.controller.shutdown();

    f.failEmbedding(false);
    const reopened = await f.open("origin");
    await run(reopened.controller, "咖啡偏好是什么？");
    assert.equal(reopened.controller.getMemoryReferences()?.semantic?.state, "ready");
    const retract = await reopened.controller.applyMemoryAction({ operation: "retract", id: formal.id, expectedRevision: formal.revision! });
    assert.ok(retract.ok);
    f.embeddingInputs.length = 0;
    await run(reopened.controller, "咖啡偏好是什么？");
    const after = reopened.controller.getMemoryReferences(); assert.ok(after);
    assert.equal(after.selected.length, 0);
    assert.equal(after.semantic?.state, "not_applicable");
    assert.equal(f.embeddingInputs.length, 0, "cached vectors do not revive retracted formal memory or dispatch it upstream");
    assert.doesNotMatch(f.references.at(-1)!.join("\n"), /咖啡不加糖/);
    const persisted = await createMemoryStore(f.workspace).get(formal.id); assert.ok(persisted.ok);
    assert.equal(persisted.entry.temporalState, "retracted");
  } finally { await f.cleanup(); }
});
