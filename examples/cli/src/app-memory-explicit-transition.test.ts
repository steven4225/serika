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
import { createMemoryStore } from "./memory-store.js";

// These are output-contract/host-wiring tests, NOT a claim that a real model
// chooses the documented operation. The live D05 rerun must establish that.
const sourceText = "从现在起，仅在当前对话里，我的咖啡改成加糖。";
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
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
  return prompt.flatMap(message => typeof message.content === "string" ? [message.content]
    : Array.isArray(message.content) ? message.content.flatMap((part: { type: string; text?: string }) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : []) : []);
}
async function fixture(mode: "documented_change" | "recorded_add") {
  const root = await mkdtemp(join(tmpdir(), "memory-explicit-operation-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: {
    enabled: true, autoConsolidate: true, writePolicy: "automatic",
  } } }));
  const memory = createMemoryStore(workspace);
  const saved = await memory.add({ text: "仅在当前对话里，我喝咖啡不加糖。", kind: "preference",
    scope: { kind: "thread", threadId: "origin" }, factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } });
  assert.ok(saved.ok);
  let calls = 0, contractFound = false, proposalInstructions = "", primaryInstructions = "";
  const proposals: MemoryProposal[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => {
    const texts = promptTexts(options.prompt);
    const material = texts.find(text => text.startsWith("Extract only from this host-prepared material."));
    if (!material) {
      primaryInstructions = options.prompt.filter(message => message.role === "system").map(message => message.content).join("\n");
      return response("明白，保存状态以程序回执为准。");
    }
    proposalInstructions = options.prompt.filter(message => message.role === "system").map(message => message.content).join("\n");
    calls += 1;
    const batch = JSON.parse(material.slice(material.indexOf("\n") + 1)) as PreparedBatch;
    const sources = "bootstrap" in batch ? batch.turns.map(turn => turn.user)
      : batch.turns.flatMap(turn => turn.messages.filter(message => message.role === "user").map(message => ({ messageId: message.id, text: message.text })));
    const source = sources.find(item => item.text === sourceText); assert.ok(source);
    const target = batch.memories.find(entry => entry.id === saved.entry.id); assert.ok(target);
    assert.deepEqual(target.scope, { kind: "thread", threadId: "origin" });
    assert.equal(target.revision, 1);
    let proposal: MemoryProposal;
    if (mode === "documented_change") {
      const contract = texts.join("\n").match(/<same-scope-transition-example>\n([\s\S]*?)\n<\/same-scope-transition-example>/);
      contractFound = contract !== null;
      if (!contract) return response(JSON.stringify({ batchId: batch.batchId, proposals: [],
        outcomes: sources.map(item => ({ messageId: item.messageId, status: "deferred" })) }));
      // Rebind only example placeholders. The production example's action,
      // fields and field omissions themselves reach the real stage/store.
      proposal = JSON.parse(contract[1]!, (_key, value: unknown) => value === "<target.id>" ? target.id
        : value === "<target.revision>" ? target.revision
        : value === "<source.messageId>" ? source.messageId
        : value === "<source.fullText>" ? source.text : value) as MemoryProposal;
    } else {
      // Recorded failure shape: a model's add, even with an explicit source,
      // is NOT host authorization to invent a missing changeIntent.
      proposal = { action: "add", kind: "preference", text: "仅在当前对话里，我喝咖啡加糖。",
        scope: { kind: "thread" }, eligibility: "explicit_request", reason: "用户明确的新偏好",
        sources: [{ sourceMessageId: source.messageId, sourceQuote: source.text }],
        factIdentity: { attribute: "coffee", scenario: "general", value: "sweetened" } };
    }
    proposals.push(proposal);
    return response(JSON.stringify({ batchId: batch.batchId, proposals: [proposal],
      outcomes: sources.map(item => ({ messageId: item.messageId, status: "extracted" })) }));
  } });
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "origin", "--config", config],
    modelAlias: "fixture/not-real-model", model, output, env: {}, cwd: root });
  const controller = createAssistantController(app);
  controller.subscribe(event => { if (event.type === "approval") assert.fail("Tool-free automatic extraction must not request approval"); });
  return { memory, controller, initial: saved.entry, proposals, instructions: () => proposalInstructions,
    primaryInstructions: () => primaryInstructions, calls: () => calls, contractFound: () => contractFound,
    cleanup: async () => { await controller.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
async function run(controller: ReturnType<typeof createAssistantController>) {
  const started = await controller.run(sourceText); assert.ok(started.ok, JSON.stringify(started));
  const until = Date.now() + 5_000;
  while (controller.getSnapshot().state.kind !== "idle") {
    assert.ok(Date.now() < until, "Automatic consolidation did not settle");
    await delay(5);
  }
  assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
}

test("the supplied same-scope change example executes once through Controller/stage/store and preserves thread history", async () => {
  const f = await fixture("documented_change");
  try {
    await run(f.controller);
    assert.doesNotMatch(f.primaryInstructions(), /add tool/, "real-model instructions never mention the offline demo tool");
    assert.match(f.primaryInstructions(), /In automatic memory mode, briefly acknowledge the statement and let the host consolidate/);
    assert.match(f.primaryInstructions(), /For a new self-statement or memory request, acknowledge only what the user just said; do not proactively compare it with retrieved or historical preferences/);
    assert.equal(f.contractFound(), true, "the model needs an executable same-scope change example, not only an add example");
    assert.match(f.instructions(), /set eligibility to "needs_review"/, "review is an eligibility value, not an extra boolean");
    assert.match(f.instructions(), /Never add proposal keys named needs_review or confidence/, "strict proposal keys must remain explicit");
    assert.equal(f.calls(), 1, "no second extraction or retry compensates for the contract");
    assert.equal(f.proposals[0]?.action, "change");
    assert.equal("scope" in f.proposals[0]!, false, "target edits retain scope; they must not carry add-only scope");
    assert.equal("effectiveAt" in f.proposals[0]!, false, "the host resolves source-bound from-now intent");
    assert.equal(f.proposals[0]?.changeIntent?.sourceQuote, sourceText);
    const changed = await f.memory.get(f.initial.id); assert.ok(changed.ok);
    assert.equal(changed.entry.revision, 2);
    assert.equal(changed.entry.assertion?.factIdentity?.value, "sweetened");
    assert.deepEqual(changed.entry.scope, f.initial.scope);
    const list = await f.memory.list(); assert.ok(list.ok); assert.equal(list.entries.length, 1);
    const history = await f.controller.getMemoryHistory({ id: f.initial.id }); assert.ok(history.ok);
    assert.equal(history.value.assertions.some(assertion => assertion.text === f.initial.text), true);
    assert.equal(history.value.assertions.some(assertion => assertion.text === changed.entry.text), true);
    const pending = await f.controller.listMemoryCandidates({ status: "pending" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0);
  } finally { await f.cleanup(); }
});

test("recorded D05 add without changeIntent remains actionable review and cannot silently replace the old thread preference", async () => {
  const f = await fixture("recorded_add");
  try {
    await run(f.controller);
    assert.equal(f.calls(), 1);
    assert.equal(f.proposals[0]?.action, "add");
    assert.equal(f.proposals[0]?.changeIntent, undefined);
    const unchanged = await f.memory.get(f.initial.id); assert.ok(unchanged.ok);
    assert.equal(unchanged.entry.revision, 1);
    assert.equal(unchanged.entry.text, f.initial.text);
    const pending = await f.controller.listMemoryCandidates({ status: "pending" }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 1);
    const candidate = await f.controller.getMemoryCandidate(pending.value.candidates[0]!.id); assert.ok(candidate.ok);
    assert.equal(candidate.value.candidate.status, "pending");
    assert.equal(candidate.value.applicable, true, JSON.stringify(candidate.value));
  } finally { await f.cleanup(); }
});
