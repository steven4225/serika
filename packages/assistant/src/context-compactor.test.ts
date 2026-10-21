import { strict as assert } from "node:assert";
import { it } from "node:test";
import type { UIMessage } from "ai";
import type { ContextCompactionStore, MessageStore, ThreadContextCompactionRecord } from "@serika/core";
import { ContextCompactor, readContextDiagnostics, reconcilePublishedSummary } from "./context-compactor.js";
import { compactPrefixHash, contextSummaryPrompt, type ContextCompactionRecord, type ContextSummaryV2, type Summarizer } from "./context-compaction.js";
import { defaultContextBudget, effectiveContextBudget, estimateContextBudget, estimateMessageTokens, estimateSerializedTokens } from "./context-budget.js";
import { blockLimits } from "./context-blocks.js";
import { createCompactionChecklist, compactedRecentMessages } from "./compaction-records.js";
import { createExecutionRecordStore } from "./execution-record-store.js";
import { createToolConfirmation } from "./tool-confirmation.js";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";

const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const assistant = (id: string, text: string): UIMessage => ({ id, role: "assistant", parts: [{ type: "text", text }] });
const summary: ContextSummaryV2 = { version: 2, goal: { text: "continue the task", evidenceMessageIds: ["u1"] },
  constraints: [], decisions: [], actions: [], pending: [], files: [], nextStep: null };
class FakeStore implements MessageStore, ContextCompactionStore {
  messages: UIMessage[] = []; records: ThreadContextCompactionRecord[] = [];
  async save(_threadId: string, messages: UIMessage[]) { this.messages = structuredClone(messages); }
  async getMessages(_threadId: string) { return structuredClone(this.messages); }
  async appendContextCompaction(record: ThreadContextCompactionRecord) { this.records.push(structuredClone(record)); }
  async getContextCompactions(_threadId: string) { return structuredClone(this.records); }
}
const budget = effectiveContextBudget(defaultContextBudget(), { provider: "mock", modelId: "mock", contextWindowTokens: 32768, source: "configuration" });
function seed(): UIMessage[] {
  return [user("u1", "Continue the task"), ...Array.from({ length: 7 }, (_, i) => [user(`u${i + 2}`, "x".repeat(blockLimits(budget).block * 2)), assistant(`a${i}`, "reply")]).flat(), user("current", "Continue")];
}
const make = (store: FakeStore, summarizer: Summarizer, extra: Partial<ConstructorParameters<typeof ContextCompactor>[0]> = {}) => new ContextCompactor({
  store, threadId: "thread-1", modelId: "mock", budget, fixedContext: () => ({ instructions: "instructions", tools: [] }), summarizer, ...extra });
const signal = () => new AbortController().signal;

it("step5: restart checklist reads an uncommitted unknown write from real receipts and masks retained old attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-step5-receipts-"));
  try {
    const records = createExecutionRecordStore(root);
    await records.startRun({ runId: "interrupted", threadId: "thread-1", phase: "primary" });
    for (const type of ["tool.call.requested", "tool.call.started"] as const) await records.recordToolEvent("interrupted", {
      id: type, type, runId: "interrupted", threadId: "thread-1", sequence: 1, occurredAt: new Date(0).toISOString(),
      data: { toolCallId: "uncertain-write", toolName: "write_file", input: { path: "notes/report.md", content: "new" } },
    } as Parameters<typeof records.recordToolEvent>[1]);
    await records.recoverInterrupted("thread-1");
    const permission = createToolConfirmation(new PassThrough()); permission.beginRun(true); permission.endRun();
    const old = user("old-attachment", "old text");
    old.parts.push({ type: "file", mediaType: "image/png", filename: "old.png", url: "data:OLD_BYTES" });
    const messages = [old, user("next-run", "new request")];
    const projected = compactedRecentMessages(messages, 0);
    assert.doesNotMatch(JSON.stringify(projected), /OLD_BYTES/);
    assert.match(JSON.stringify(messages), /OLD_BYTES/);
    const checklist = createCompactionChecklist({ messages, permissions: permission.snapshot(), runs: await createExecutionRecordStore(root).listRuns("thread-1") });
    assert.match(JSON.stringify(checklist), /uncertain-write.*write_file.*unknown.*notes\/report.md/);
    assert.match(JSON.stringify(checklist), /autonomousFiles.*false/);
    assert.doesNotMatch(JSON.stringify(checklist), /OLD_BYTES/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

  it("retains the last eight completed receipts plus rollup, unknown and denied effects without losing originals", () => {
    const effect = (id: string, state: "output-available" | "input-available" | "output-error"): UIMessage => ({
      id, role: "assistant", parts: [{ type: "dynamic-tool", toolName: "edit_file", toolCallId: id,
        state, input: { path: "notes/plan.md", oldText: "old", newText: "new" },
        ...(state === "output-available" ? { output: { ok: true, path: "notes/plan.md", bytes: 3 } } :
          state === "output-error" ? { errorText: "TOOL_DENIED: declined" } : {}),
      } as UIMessage["parts"][number]],
    });
    const originals = [user("u1", "preserve chapters"), ...Array.from({ length: 20 }, (_, i) => effect(`done-${i}`, "output-available")),
      effect("unknown", "output-available"), effect("denied", "output-error"), effect("after-1", "output-available"), effect("after-2", "output-available")];
    const unknownPart = originals.find(message => message.id === "unknown")!.parts[0];
    assert.ok(unknownPart?.type === "dynamic-tool" && unknownPart.state === "output-available");
    unknownPart.output = { path: "notes/plan.md" }; // Returned output without explicit ok remains unknown.
    const snapshot = structuredClone(originals);
    const reconciled = reconcilePublishedSummary(summary, originals, undefined);
    assert.equal(reconciled.files.length, 1);
    assert.deepEqual(reconciled.files[0]?.evidenceMessageIds, ["after-2"]);
    assert.match(reconciled.files[0]!.text, /not current disk state/);
    assert.equal(reconciled.actions.filter(item => item.status === "completed" && item.toolCallIds.length).length, 8);
    assert.match(reconciled.actions[0]!.text, /Earlier completed/);
    assert.deepEqual(reconciled.actions.find(item => item.status === "unknown")?.toolCallIds, ["unknown"]);
    assert.deepEqual(reconciled.actions.find(item => item.status === "not_executed")?.toolCallIds, ["denied"]);
    assert.deepEqual(reconciled.actions.at(-1)?.toolCallIds, ["after-2"]);
    assert.deepEqual(originals, snapshot, "projection never deletes or rewrites full receipts");
    const next = reconcilePublishedSummary(summary, originals, reconciled);
    assert.deepEqual(next.actions, reconciled.actions, "a later merge must not re-expand completed history");
    assert.equal(next.files.length, 1);
  });

  it("compacts interleaved successful reads and edits, without turning reads into saved file evidence", () => {
    const messages: UIMessage[] = [user("u1", "continue")];
    for (let i = 0; i < 20; i++) for (const toolName of ["read_file", "edit_file"]) {
      const id = `${toolName}-${i}`;
      messages.push({ id, role: "assistant", parts: [{ type: "dynamic-tool", toolName, toolCallId: id,
        state: "output-available", input: { path: "notes/plan.md" }, output: { ok: true, path: "notes/plan.md", bytes: 5 },
      }] });
    }
    const result = reconcilePublishedSummary(summary, messages, undefined);
    assert.equal(result.actions.length, 9);
    assert.match(result.actions[0]!.text, /Earlier completed/);
    assert.ok(result.actions.slice(1).every(action => action.status === "completed" && action.toolCallIds.length === 1));
    assert.equal(result.files.length, 1);
    assert.deepEqual(result.files[0]?.evidenceMessageIds, ["edit_file-19"]);
    const readsOnly = reconcilePublishedSummary(summary, messages.filter(message => !message.id.startsWith("edit_file")), undefined);
    assert.deepEqual(readsOnly.files, []);
  });

  it("asks the summarizer for evidenced values without an empty JSON template", () => {
    const prompt = contextSummaryPrompt({ messages: [user("u1", "Continue the report")] });
    assert.match(prompt, /non-empty text/);
    assert.match(prompt, /actual message id/);
    assert.match(prompt, /use \[\] when there is no evidence/);
    assert.match(prompt, /same item fields/);
    assert.doesNotMatch(prompt, /"text":""|"message-id"|"tool-call-id"/);
    assert.match(prompt, /Continue the report/);
  });


it("background compacts only uncovered blocks, publishes bounded action receipts, and restores without dispatch", async () => {
  const store = new FakeStore(); store.messages = seed(); let calls = 0;
  const prompts: string[] = [];
  const summarizer: Summarizer = { complete: async ({ prompt }) => { calls++; prompts.push(prompt); return { text: JSON.stringify({ ...summary,
    ...(prompt.includes("farIndex string") ? { farIndex: "Earlier task" } : {}) }), usage: { inputTokens: 100, outputTokens: 20 } }; } };
  const compactor = make(store, summarizer);
  const initial = await compactor.prepare(store.messages, signal()); assert.equal(calls, 0); assert.match(JSON.stringify(initial), /masked pending/);
  await compactor.runPending(signal()); assert.equal(calls, 1); assert.equal(compactor.backgroundError, undefined);
  const first = store.records[0] as unknown as ContextCompactionRecord;
  assert.equal(first.metrics.attempts, 1); assert.deepEqual(first.metrics.usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(first.sourcePrefixHash, compactPrefixHash(store.messages, first.firstKeptMessageIndex));
  await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
  assert.equal(compactor.backgroundError, undefined); assert.equal(store.records[1]?.previousCompactionId, first.id);
  assert.doesNotMatch(prompts[1]!.split("Return one JSON")[0]!, /"id":"u1"/);
  const before = calls, reopened = make(store, summarizer);
  const restored = await reopened.prepare(store.messages, signal()); assert.equal(calls, before);
  assert.match(JSON.stringify(restored), /Historical index/);
  assert.ok(estimateContextBudget({ instructions: "instructions", messages: restored }, budget).inputTokens <= budget.inputBudgetTokens!);
});

it("background excludes synthetic extraction turns while hashes remain bound to the physical prefix", async () => {
  const store = new FakeStore(); store.messages = [
    ...seed().slice(0, 2), { ...user("extract", 'secret-batch Extract only from this host-prepared material'), metadata: { source: AUTO_CONSOLIDATION_SOURCE } },
    assistant("extracted", 'secret-batch {"outcomes":[]}'), ...seed().slice(2) ];
  const compactor = make(store, { complete: async ({ prompt }) => { assert.doesNotMatch(prompt, /secret-batch/); return { text: JSON.stringify(summary) }; } });
  const prepared = await compactor.prepare(store.messages, signal()); assert.doesNotMatch(JSON.stringify(prepared), /secret-batch/);
  await compactor.runPending(signal()); assert.equal(compactor.backgroundError, undefined);
  const record = store.records[0] as unknown as ContextCompactionRecord;
  assert.equal(record.sourcePrefixHash, compactPrefixHash(store.messages, record.firstKeptMessageIndex));
});

it("invalid, empty, length-truncated and oversized background summaries never advance and never retry the item", async () => {
  for (const result of [{ text: "" }, { text: "{}" }, { text: JSON.stringify(summary), finishReason: "length" },
    { text: JSON.stringify({ ...summary, goal: { ...summary.goal, text: "overflow".repeat(1000) } }) }]) {
    const store = new FakeStore(); store.messages = seed(); let calls = 0;
    const compactor = make(store, { complete: async () => { calls++; return result; } });
    await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
    assert.equal(calls, 1); assert.equal(store.records.length, 0); assert.ok(compactor.backgroundError);
  }
});

it("changed source or exclusions invalidate all derived layers, including a source after the old boundary", async () => {
  const store = new FakeStore(); store.messages = seed();
  const compactor = make(store, { complete: async () => ({ text: JSON.stringify(summary) }) });
  await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
  assert.equal(store.records.length, 1);
  const current = store.messages.at(-1)!; current.metadata = { transcriptExcluded: true }; current.parts = [{ type: "text", text: "[Excluded]" }];
  const reopened = make(store, { complete: async () => { throw new Error("no foreground dispatch"); } });
  assert.doesNotMatch(JSON.stringify(await reopened.prepare(store.messages, signal())), /Historical index/);
  assert.equal(await reopened.referenceSnapshot(store.messages), undefined);
  const diagnostics = await reopened.getDiagnostics(); assert.ok(diagnostics.ok); assert.equal(diagnostics.value.latestValidCompaction, null);
});

it("source changes during background work discard the model result before persistence", async () => {
  const store = new FakeStore(); store.messages = seed();
  const compactor = make(store, { complete: async () => { store.messages[0] = user("u1", "changed"); return { text: JSON.stringify(summary) }; } });
  await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
  assert.equal(store.records.length, 0); assert.match(compactor.backgroundError!, /sources changed/);
});

it("diagnostics remain read-only, preserve unknown usage, and fail visibly on read errors", async () => {
  const store = new FakeStore(); store.messages = seed(); let calls = 0;
  const compactor = make(store, { complete: async () => { calls++; return { text: JSON.stringify(summary) }; } });
  const empty = await compactor.getDiagnostics(); assert.ok(empty.ok); assert.equal(empty.value.lastPreparation, null); assert.equal(calls, 0);
  await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
  assert.equal((store.records[0] as unknown as ContextCompactionRecord).metrics.usage, undefined);
  const result = await readContextDiagnostics(store, "thread-1", budget); assert.ok(result.ok); assert.equal(result.value.lastPreparation, null);
  store.getContextCompactions = async () => { throw new Error("unavailable"); };
  assert.equal((await readContextDiagnostics(store, "thread-1", budget)).ok, false);
});

it("foreground counts the supplied fixed prefix once, clips a single oversized message, and rejects fixed overflow", async () => {
  const store = new FakeStore(), prefix = [assistant("reference", "current memory")]; let reads = 0;
  const compactor = make(store, { complete: async () => { throw new Error("must not dispatch"); } }, { promptPrefix: () => { reads++; return prefix; } });
  const input = [user("current", "HEAD" + "x".repeat(100000) + "TAIL")];
  const view = await compactor.prepare(input, signal(), false, prefix); assert.equal(reads, 0);
  assert.deepEqual(compactor.effectiveReferencePrefix, prefix); assert.match(JSON.stringify(view), /history_read/);
  assert.ok(estimateContextBudget({ instructions: "instructions", messages: [...prefix, ...view] }, budget).inputTokens <= budget.inputBudgetTokens!);
  const overflow = make(store, { complete: async () => { throw new Error("must not dispatch"); } }, { fixedContext: () => ({ instructions: "x".repeat(100000) }) });
  await assert.rejects(overflow.prepare([user("current", "hello")], signal()), /Fixed context exceeds/);
});

it("host reconciliation rejects invented success/files/evidence and retains denied, failed, unknown and unexecuted actions", () => {
  const messages: UIMessage[] = [user("u1", "task"), ...["denied", "failed", "unknown", "success"].map((id): UIMessage => ({ id, role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "write_file", toolCallId: id, input: { path: "real.md" },
    ...(id === "denied" || id === "failed" ? { state: "output-error" as const, errorText: id === "denied" ? "TOOL_DENIED: no" : "failed" } :
      { state: "output-available" as const, output: id === "unknown" ? { value: 1 } : { ok: true, path: "real.md" } }),
  }] }))];
  const modeled: ContextSummaryV2 = { ...summary, goal: { text: "task", evidenceMessageIds: ["invented"] },
    actions: [{ text: "pretend", status: "completed", toolCallIds: [], evidenceMessageIds: ["u1"] },
      { text: "plan", status: "not_executed", toolCallIds: [], evidenceMessageIds: ["u1"] }],
    files: [{ text: "invented", path: "fake.md", purpose: "fake", evidenceMessageIds: ["u1"] }] };
  const result = reconcilePublishedSummary(modeled, messages, undefined);
  assert.deepEqual(result.actions.map(action => action.status), ["not_executed", "failed", "unknown", "completed", "not_executed"]);
  assert.deepEqual(result.files.map(file => file.path), ["real.md"]); assert.deepEqual(result.goal.evidenceMessageIds, ["u1"]);
  assert.doesNotMatch(JSON.stringify(result), /pretend|fake.md|invented/);
});

it("an irreducible failure ledger fails before dispatch without dropping failures or changing the journal", async () => {
  const store = new FakeStore(); store.messages = [user("old", "request"), ...Array.from({ length: 200 }, (_, i): UIMessage => ({ id: `failure-${i}`, role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "shell_exec", toolCallId: `failure-${i}`, state: "output-error", input: {}, errorText: "failure details ".repeat(20),
  }] })), user("current", "next")];
  const before = structuredClone(store.messages); let calls = 0;
  const compactor = make(store, { complete: async () => { calls++; return { text: JSON.stringify(summary) }; } });
  await assert.rejects(compactor.prepare(store.messages, signal()), /checklist exceeds/);
  assert.equal(calls, 0); assert.equal(store.records.length, 0); assert.deepEqual(store.messages, before);
});

it("reported provider overflow recalibrates a single oversized current message when there is no additional safe block", async () => {
  const store = new FakeStore(); store.messages = [user("current", "HEAD" + "x".repeat(60000) + "TAIL")];
  const before = structuredClone(store.messages); let calls = 0;
  const compactor = make(store, { complete: async () => { calls++; return { text: JSON.stringify(summary) }; } });
  await compactor.prepare(store.messages, signal()); compactor.reportedOverflow(40000);
  const projected = await compactor.prepare(store.messages, signal());
  assert.match(JSON.stringify(projected), /HEAD/); assert.match(JSON.stringify(projected), /TAIL/); assert.match(JSON.stringify(projected), /history_read/);
  const diagnostics = await compactor.getDiagnostics(); assert.ok(diagnostics.ok);
  assert.ok(diagnostics.value.lastPreparation!.estimatedInputTokens! <= budget.inputBudgetTokens!);
  assert.equal(calls, 0); assert.deepEqual(store.messages, before);
});
