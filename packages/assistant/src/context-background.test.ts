import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlAgentStore } from "@serika/core";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { ContextCompactor } from "./context-compactor.js";
import { blockLimits, fitMessage } from "./context-blocks.js";
import { availableInputTokens, defaultContextBudget, effectiveContextBudget, estimateContextBudget } from "./context-budget.js";
import { createMemoryStore } from "./memory-v7-store.js";
import { createTranscriptAccess } from "./transcript-access.js";
import { createCompactionChecklist } from "./compaction-records.js";
import { createExecutionRecordStore } from "./execution-record-store.js";
import { createToolConfirmation } from "./tool-confirmation.js";
import { PassThrough } from "node:stream";
import { historyTools } from "./history-tools.js";
import { createMemoryExtraction } from "./memory-extraction.js";
import { compactPrefixHash } from "./context-compaction.js";

const msg = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const summary = { version: 2, goal: { text: "Continue task", evidenceMessageIds: ["u0"] }, constraints: [], decisions: [], actions: [], pending: [], files: [], nextStep: null };
const budgets = [effectiveContextBudget(defaultContextBudget(), { provider: "test", modelId: "32k", source: "configuration", contextWindowTokens: 32768 }), defaultContextBudget()];
const settle = async (condition: () => boolean) => { const end = Date.now() + 5000; while (!condition()) { if (Date.now() > end) throw new Error("Background did not settle"); await new Promise(resolve => setImmediate(resolve)); } };

test("foreground retains unpublished complete blocks without model wait below the hard trigger; cancellation never publishes", async () => {
  for (const budget of budgets) {
    const root = await mkdtemp(join(tmpdir(), "cm6-context-"));
    try {
      const store = new JsonlAgentStore({ directory: root }), limits = blockLimits(budget);
      const messages: UIMessage[] = [];
      for (let i = 0; i < 7; i++) {
        messages.push(msg(`u${i}`, "user", `request ${i}: ` + "x".repeat(limits.block)));
        messages.push({ id: `a${i}`, role: "assistant", parts: [{ type: "dynamic-tool", toolCallId: `c${i}`, toolName: "read_file", state: "output-available", input: { path: "a" }, output: { ok: true, content: "done" } }] });
      }
      messages.push(msg("current", "user", "Continue the task."));
      await store.save("t", messages);
      let calls = 0, release!: () => void;
      const compactor = new ContextCompactor({ store, threadId: "t", modelId: "fake", budget, fixedContext: () => ({ instructions: "system", tools: [] }),
        summarizer: { complete: async ({ signal }) => { calls++; await new Promise<void>(resolve => { release = resolve; signal.addEventListener("abort", () => resolve(), { once: true }); }); return { text: JSON.stringify(summary) }; } } });
      const prepared = await compactor.prepare(messages, new AbortController().signal);
      assert.equal(calls, 0); assert.equal(compactor.pending, true);
      assert.ok(estimateContextBudget({ instructions: "system", tools: [], messages: prepared }, budget).inputTokens <= availableInputTokens(budget));
      assert.equal(prepared.at(-1)?.id, "current"); assert.doesNotMatch(JSON.stringify(prepared), /masked pending/);
      assert.ok(messages.every(message => prepared.some(item => item.id === message.id)));
      const job = compactor.runPending(new AbortController().signal); await settle(() => calls > 0);
      await compactor.prepare(messages, new AbortController().signal); assert.equal(calls, 1);
      await compactor.pause(); release(); await job;
      assert.equal((await store.getContextCompactions("t")).length, 0);
      await compactor.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("a null tip boundary remains valid after append while a changed covered prefix fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-tip-"));
  try {
    const store = new JsonlAgentStore({ directory: root }), messages = [msg("u0", "user", "old"), msg("a", "assistant", "done")];
    await store.save("t", messages);
    await store.appendContextCompaction({ v: 2, type: "thread.context.compacted", threadId: "t", id: "tip", previousCompactionId: null,
      firstKeptMessageIndex: 2, firstKeptMessageId: null, sourcePrefixHash: compactPrefixHash(messages, 2), summary,
      strategyVersion: "summary-json/v2", modelId: "fake", createdAt: new Date().toISOString(), metrics: { estimatedInputBefore: 10, estimatedInputAfter: 5, durationMs: 1, attempts: 1 } });
    const current = [...messages, msg("new", "user", "continue")];
    const compactor = new ContextCompactor({ store, threadId: "t", modelId: "fake", budget: defaultContextBudget(), fixedContext: () => ({}), summarizer: { complete: async () => { throw new Error("must not call"); } } });
    assert.match(JSON.stringify(await compactor.prepare(current, new AbortController().signal)), /Continue task/);
    assert.doesNotMatch(JSON.stringify(await compactor.prepare([msg("u0", "user", "changed"), ...current.slice(1)], new AbortController().signal)), /Continue task/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("privacy exclusions survive restart, preserve original chat and redact memory, snapshots, search and numbered reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-exclude-"));
  try {
    const store = new JsonlAgentStore({ directory: join(root, "transcripts") }), memory = createMemoryStore(join(root, ".runloom/memory.json"), null);
    const text = "Secret preference alpha", source = msg("source", "user", text);
    const saved = await memory.writeV7!([{ operation: "add", scope: { kind: "user" }, text, category: "preference", source: { kind: "conversation", threadId: "t", messageId: "source", quote: text, sentAt: null } }]); assert.ok(saved.ok);
    await store.save("t", [source, { ...msg("later", "user", "Continue"), metadata: { contextSnapshot: [msg("stale", "assistant", text)] } }]);
    let invalidated = 0;
    const access = createTranscriptAccess({ store, threadId: "t", memory, invalidated: () => { invalidated++; } });
    await access.exclude({ messageId: "source", reason: "privacy" }); assert.equal(invalidated, 1);
    assert.match(JSON.stringify(await store.getMessages("t")), /Secret preference alpha/);
    assert.doesNotMatch(JSON.stringify(await access.read()), /Secret preference alpha/);
    const read = await memory.readV7!(); assert.ok(read.ok); assert.doesNotMatch(JSON.stringify(read.value), /Secret preference alpha/);
    assert.equal(read.value.entries[0]?.state, "retracted");
    const undo = await memory.writeV7!([{ operation: "undo", id: read.value.entries[0]!.id, expectedRevision: read.value.entries[0]!.revision, source: { kind: "manual" } }]); assert.equal(undo.ok, false);
    const reopened = createTranscriptAccess({ store: new JsonlAgentStore({ directory: join(root, "transcripts") }), threadId: "t", memory: createMemoryStore(join(root, ".runloom/memory.json"), null), invalidated() {} });
    const tools = historyTools(reopened, budgets[0]!);
    for (const [index, input] of [[0, { query: text, start: 0 }], [1, { id: "source", start: 0 }]] as const) {
      const result = await tools[index]!.tool.execute!(input as never, { toolCallId: "read", messages: [], context: undefined, abortSignal: new AbortController().signal });
      assert.doesNotMatch(JSON.stringify(result), /Secret preference alpha/); assert.match(JSON.stringify(result), /excluded/);
    }
    assert.equal((await store.getTranscriptExclusions("t")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("oversized messages and tool outputs keep head/tail plus a numbered range placeholder without changing originals", () => {
  const raw = msg("long", "user", "HEAD" + "x".repeat(100000) + "TAIL"), before = JSON.stringify(raw);
  const projected = fitMessage(raw, 1024);
  assert.match(JSON.stringify(projected), /HEAD/); assert.match(JSON.stringify(projected), /TAIL/); assert.match(JSON.stringify(projected), /history_read/);
  assert.equal(JSON.stringify(raw), before);
  const tool: UIMessage = { id: "tool", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "read_file", toolCallId: "c", state: "output-available", input: {}, output: "HEAD" + "x".repeat(100000) + "TAIL" }] };
  const bounded = JSON.stringify(fitMessage(tool, 1024)); assert.match(bounded, /HEAD/); assert.match(bounded, /TAIL/); assert.match(bounded, /history_read/);
});

test("oversized leading assistant and user material is extracted chronologically in exact fragments; cursor waits for the final fragment", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-fragments-"));
  try {
    const assistantText = "assistant-material ".repeat(1600);
    const store = createMemoryStore(join(root, ".runloom/memory.json"), null), messages = [msg("leading", "assistant", assistantText), msg("long", "user", "x".repeat(24000))];
    let assistantSeen = "";
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
      calls++;
      const current = await store.readV7!(); assert.ok(current.ok); assert.notEqual(current.value.progress[0]?.throughMessageId, "long");
      assert.ok(JSON.stringify(prompt).length < 26624 * 2);
      const text = prompt.flatMap(message => message.role === "user" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []) : []).join("\n");
      const block = JSON.parse(text.slice("Original block:\n".length).split("\nTask:")[0]!) as Array<{ id: string; text: string }>;
      assistantSeen += block.filter(message => message.id === "leading").map(message => message.text).join("");
      return { content: [{ type: "text", text: JSON.stringify({ proposals: [], outcomes: block.filter(message => message.id === "long").map(message => ({ messageId: message.id, status: "no_memory" })) }) }], finishReason: { unified: "stop", raw: undefined },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } }, warnings: [] };
    } });
    const extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => messages, model, budget: budgets[0]!, updated() {} });
    extraction.afterMask("long"); extraction.idle();
    await settle(() => !extraction.diagnostics().running); await extraction.pause();
    const result = await store.readV7!(); assert.ok(result.ok);
    assert.ok(calls > 1); assert.equal(assistantSeen, assistantText); assert.equal(result.value.progress[0]?.throughMessageId, "long"); assert.equal(result.value.progress[0]?.pending.length, 0);
    await extraction.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("background installs one bounded segment per item and folds the fifth into a bounded dated index at both windows", async () => {
  for (const budget of budgets) {
    const root = await mkdtemp(join(tmpdir(), "cm6-layers-"));
    try {
      const store = new JsonlAgentStore({ directory: root }), limits = blockLimits(budget);
      let calls = 0;
      const messages: UIMessage[] = [];
      const compactor = new ContextCompactor({ store, threadId: "t", modelId: "fake", budget, fixedContext: () => ({}), summarizer: {
        complete: async ({ prompt }) => { calls++; return { text: JSON.stringify({ ...summary, ...(prompt.includes("farIndex string") ? { farIndex: "Earlier requests, read original message range." } : {}) }) }; },
      } });
      for (let round = 0; round < 7; round++) {
        messages.push(msg(`u${round}`, "user", "x".repeat(limits.block * 2)), { id: `a${round}`, role: "assistant", parts: [{
          type: "dynamic-tool", toolName: "write_file", toolCallId: `w${round}`, state: "output-available", input: { path: `file${round}.md` }, output: { ok: true, path: `file${round}.md` },
        }] });
        const input = [...messages, msg(`current${round}`, "user", "continue")];
        await store.save("t", input);
        await compactor.prepare(input, new AbortController().signal);
        if (compactor.pending) {
          const before = calls; await compactor.runPending(new AbortController().signal);
          assert.equal(compactor.backgroundError, undefined); assert.equal(calls, before + 1);
          const records = await store.getContextCompactions("t");
          const record = records.at(-1)! as unknown as import("./context-compaction.js").ContextCompactionRecord;
          const start = (records.at(-2)?.firstKeptMessageIndex ?? 0) as number;
          const covered = new Set(input.slice(start, record.firstKeptMessageIndex).map(message => message.id));
          assert.ok(record.summary.files.every(file => file.evidenceMessageIds.every(id => covered.has(id))), "completed files must stay in their own segment instead of growing every later segment");
        }
      }
      const records = await store.getContextCompactions("t"); assert.ok(records.length >= 5);
      const last = records.at(-1)! as unknown as import("./context-compaction.js").ContextCompactionRecord;
      assert.equal(last.layers?.recent.length, 4); assert.equal(last.layers?.index.length, 1);
      assert.equal(last.layers!.index[0]!.firstMessageId, "u0");
      const prepared = await compactor.prepare([...messages, msg("current6", "user", "continue")], new AbortController().signal);
      assert.match(JSON.stringify(prepared), /Earlier requests/);
      assert.ok(estimateContextBudget({ messages: prepared }, budget).inputTokens <= availableInputTokens(budget));
      await compactor.close();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("a complete proportional block below the physical window retains every ordinary source byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-whole-block-"));
  try {
    const budget = { ...defaultContextBudget(), inputBudgetTokens: 400000, keepRecentTokens: 64000, summaryMaxOutputTokens: 8000 };
    const store = new JsonlAgentStore({ directory: root });
    const originals = Array.from({ length: 6 }, (_, i) => `HEAD${i}` + "x".repeat(20000) + `MIDDLE${i}` + "x".repeat(20000) + `TAIL${i}`);
    const messages = originals.flatMap((text, i) => [msg(`u${i}`, "user", text), msg(`a${i}`, "assistant", "done")]);
    messages.push(msg("current", "user", "continue")); await store.save("t", messages);
    let seen = false;
    const compactor = new ContextCompactor({ store, threadId: "t", modelId: "fake", budget, fixedContext: () => ({}), summarizer: { complete: async ({ prompt }) => {
      for (const text of originals.slice(0, 3)) assert.ok(prompt.includes(text), "ordinary complete block was clipped by an obsolete merge limit");
      seen = true; return { text: JSON.stringify(summary) };
    } } });
    await compactor.prepare(messages, new AbortController().signal); await compactor.runPending(new AbortController().signal);
    assert.equal(compactor.backgroundError, undefined); assert.ok(seen); assert.equal((await store.getContextCompactions("t")).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("extraction gives the model its exact schema and accepts one complete fenced JSON response without a retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-extraction-format-"));
  try {
    const store = createMemoryStore(join(root, ".runloom/memory.json"), null), messages = [msg("u", "user", "嗯")]; let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
      calls++; const text = JSON.stringify(prompt);
      assert.match(text, /Exact response JSON Schema/); assert.match(text, /no_memory/); assert.match(text, /sourceMessageId/);
      return { content: [{ type: "text", text: '```json\n{"proposals":[],"outcomes":[{"messageId":"u","status":"no_memory"}]}\n```' }],
        finishReason: { unified: "stop", raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
    } });
    const extraction = createMemoryExtraction({ store, threadId: "t", getMessages: async () => messages, model, budget: budgets[0]!, updated() {} });
    extraction.afterMask("u"); extraction.idle(); await settle(() => !extraction.diagnostics().running); await extraction.pause();
    assert.equal(calls, 1); assert.equal(extraction.diagnostics().completed, 1); assert.equal(extraction.diagnostics().failed, 0);
    await extraction.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("overflow checklist reads page through filtered receipts, including uncommitted unknown effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm6-checklist-read-"));
  try {
    const store = new JsonlAgentStore({ directory: join(root, "transcripts") });
    const records = createExecutionRecordStore(root);
    await records.startRun({ runId: "interrupted", threadId: "t", phase: "primary" });
    for (const type of ["tool.call.requested", "tool.call.started"] as const) await records.recordToolEvent("interrupted", {
      id: type, type, runId: "interrupted", threadId: "t", sequence: 1, occurredAt: new Date(0).toISOString(),
      data: { toolCallId: "uncommitted", toolName: "write_file", input: { path: "pending.md", content: "new" } },
    } as Parameters<typeof records.recordToolEvent>[1]);
    await records.recoverInterrupted("t");
    const messages: UIMessage[] = [msg("u", "user", "Continue"), ...Array.from({ length: 200 }, (_, i): UIMessage => ({ id: `failed-${i}`, role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "shell_exec", toolCallId: `failed-${i}`, state: "output-error", input: {}, errorText: "failed",
    }] })), { id: "private", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "read_file", toolCallId: "private-call", state: "output-available", input: { path: "SECRET_PATH" }, output: { ok: true, content: "SECRET_CONTENT" } }] }];
    await store.save("t", messages);
    const access = createTranscriptAccess({ store, threadId: "t", memory: undefined, invalidated() {} });
    await access.exclude({ messageId: "private", reason: "privacy" });
    const permission = createToolConfirmation(new PassThrough()); permission.beginRun(false);
    const full = async () => createCompactionChecklist({ messages: await access.read(), permissions: permission.snapshot(), runs: await access.filterRuns(await records.listRuns("t")) });
    for (const budget of budgets) {
      const bounded = createCompactionChecklist({ messages: await access.read(), permissions: permission.snapshot(), runs: await access.filterRuns(await records.listRuns("t")), maxTokens: blockLimits(budget).section });
      assert.match(JSON.stringify(bounded), /unknown.*1.*failed.*200/);
      assert.ok(estimateContextBudget({ messages: [bounded] }, budget).inputTokens <= blockLimits(budget).section + Math.floor(blockLimits(budget).recent / 2));
      assert.match(JSON.stringify(bounded), /request.*Continue.*permissions/);
      const reader = historyTools(access, budget, full)[1]!.tool;
      let start = 0, text = "", pages = 0;
      for (;;) {
        const result = await reader.execute!({ id: "runloom-compaction-checklist", start } as never, { toolCallId: "read", messages: [], context: undefined, abortSignal: new AbortController().signal }) as { ok: boolean; text: string; start: number; end: number; total: number; truncated: boolean };
        assert.equal(result.ok, true); assert.equal(result.start, start); assert.ok(result.end > start);
        assert.ok(Array.from(result.text).length <= blockLimits(budget).section * 2);
        text += result.text; pages++; start = result.end;
        if (!result.truncated) { assert.equal(start, result.total); break; }
      }
      assert.ok(pages > 1); assert.equal(text, JSON.stringify((await full()).parts));
      assert.match(text, /uncommitted.*write_file.*unknown.*pending.md/);
      assert.match(text, /failed-199/); assert.doesNotMatch(text, /SECRET_PATH|SECRET_CONTENT/);
    }
    assert.equal((await records.listRuns("t"))[0]!.tools[0]!.status, "unknown");
    assert.deepEqual(await store.getMessages("t"), messages);
  } finally { await rm(root, { recursive: true, force: true }); }
});
