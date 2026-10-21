import { strict as assert } from "node:assert";
import { it } from "node:test";
import type { UIMessage } from "ai";
import type { ContextCompactionStore, MessageStore, ThreadContextCompactionRecord } from "@serika/core";
import { ContextCompactor, readContextDiagnostics, reconcilePublishedSummary } from "./context-compactor.js";
import { compactPrefixHash, contextSummaryPrompt, contextSummaryFailurePaths, type ContextCompactionRecord, type ContextSummaryV2, type Summarizer } from "./context-compaction.js";
import { defaultContextBudget, effectiveContextBudget, estimateContextBudget, estimateMessageTokens, estimateSerializedTokens } from "./context-budget.js";
import { blockLimits, fitSummaryLayer, summaryText } from "./context-blocks.js";
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
    assert.match(prompt, /goal MUST be a JSON object, NEVER an array/);
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
  for (const result of [{ text: "" }, { text: "not-json", finishReason: "stop" }, { text: "{}", finishReason: "stop" }, { text: JSON.stringify(summary), finishReason: "length" },
    { text: JSON.stringify({ ...summary, goal: { ...summary.goal, text: "overflow".repeat(1000) } }) }]) {
    const store = new FakeStore(); store.messages = seed(); let calls = 0;
    const compactor = make(store, { complete: async () => { calls++; return result; } });
    await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
    assert.equal(calls, 1); assert.equal(store.records.length, 0); assert.ok(compactor.backgroundError);
    if (result.text === "{}") { assert.ok(compactor.backgroundFailure?.schemaPaths.includes("version")); assert.equal(compactor.backgroundFailure?.finishReason, "stop"); }
  }
});

it("recorded array shape failures normalize only collection containers and retain remaining semantic failures", async () => {
  // Structural reproductions of ffd528fb, de15f87c, 838b2c66 and 3dd1bb9d/ac8df6e5/0f5b23c5; no original text was retained.
  const cases = [
    { value: { ...summary, goal: [summary.goal] }, paths: ["goal"] },
    { value: { ...summary, ...Object.fromEntries(["constraints", "pending", "decisions", "actions", "files"].map(key => [key, { items: [] }])) }, paths: [] },
    { value: { ...summary, constraints: { items: [] }, pending: { items: [] } }, paths: [] },
    { value: { ...summary, constraints: { items: [] } }, paths: [] },
  ];
  for (const { value, paths } of cases) {
    const store = new FakeStore(); store.messages = seed(); let calls = 0;
    const compactor = make(store, { complete: async () => { calls++; return { text: JSON.stringify(value), finishReason: "stop" }; } });
    await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
    if (paths.length) await compactor.runPending(signal());
    if (paths.length) {
      assert.deepEqual(contextSummaryFailurePaths(JSON.stringify(value)), paths);
      assert.deepEqual(compactor.backgroundFailure?.schemaPaths, paths);
    } else {
      assert.equal(compactor.backgroundError, undefined);
      assert.ok(compactor.backgroundNormalizations.length);
    }
    assert.equal(calls, 1); assert.equal(store.records.length, paths.length ? 0 : 1);
  }
});

it("recorded CE03/CE05 proportional overflows retain four old segments; bounded summary and index can publish", async () => {
  for (const config of [budget, defaultContextBudget()]) for (const overflow of ["segment", "index"] as const) {
    const limits = blockLimits(config), store = new FakeStore();
    store.messages = [user("u1", "continue"), ...Array.from({ length: 7 }, (_, i) => user(`u${i + 2}`, "x".repeat(limits.block * 2))), user("current", "continue")];
    let reject = false, calls = 0;
    const compactor = make(store, { complete: async ({ prompt }) => {
      calls++;
      assert.match(prompt, new RegExp(`Recent segment budget: ${limits.section} estimated tokens`));
      const archive = prompt.includes("farIndex string");
      return { text: JSON.stringify({ ...summary, ...(reject && overflow === "segment" ? { goal: { ...summary.goal, text: "x".repeat(limits.section * 2 + 1) } } : {}),
        ...(archive ? { farIndex: reject && overflow === "index" ? "x".repeat(limits.section * 2) : "earlier task" } : {}) }) };
    } }, { budget: config });
    await compactor.prepare(store.messages, signal());
    for (let i = 0; i < 4; i++) await compactor.runPending(signal());
    assert.equal(store.records.length, 4); const before = structuredClone(store.records);
    store.messages.splice(store.messages.length - 1, 0, ...Array.from({ length: 3 }, (_, i) => user(`later-${i}`, "x".repeat(limits.block * 2))));
    reject = true; await compactor.prepare(store.messages, signal());
    assert.equal(compactor.pending, true, JSON.stringify({ limits, overflow, boundary: store.records.at(-1)?.firstKeptMessageIndex, messages: store.messages.length }));
    await compactor.runPending(signal());
    assert.ok(compactor.backgroundError, JSON.stringify({ limits, overflow, calls, records: store.records.length, pending: compactor.pending }));
    assert.match(compactor.backgroundError!, /proportional budget/); assert.deepEqual(store.records, before);
    const count = calls; await compactor.runPending(signal()); assert.equal(calls, count);
    reject = false; await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
    assert.equal(compactor.backgroundError, undefined); assert.equal(store.records.length, 5);
    assert.equal((store.records.at(-1) as unknown as ContextCompactionRecord).layers?.recent.length, 4);
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

it("an oversized checklist stays within its section and total summary budget with an explicit numbered overflow reference", async () => {
  const store = new FakeStore(); store.messages = [user("old", "request"), ...Array.from({ length: 200 }, (_, i): UIMessage => ({ id: `failure-${i}`, role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "shell_exec", toolCallId: `failure-${i}`, state: "output-error", input: {}, errorText: "failure details ".repeat(20),
  }] })), user("current", "next")];
  const before = structuredClone(store.messages); let calls = 0;
  const compactor = make(store, { complete: async () => { calls++; return { text: JSON.stringify(summary) }; } });
  const projected = await compactor.prepare(store.messages, signal());
  const checklist = projected.find(message => message.id === "runloom-compaction-checklist")!;
  assert.ok(estimateMessageTokens([checklist]) <= blockLimits(budget).section);
  assert.match(JSON.stringify(checklist), /failed.*200/); assert.match(JSON.stringify(checklist), /history_read.*runloom-compaction-checklist/);
  const summaryView = projected.filter(message => ["runloom-compaction-checklist", "runloom-context-summary"].includes(message.id));
  assert.ok(estimateMessageTokens(summaryView) <= blockLimits(budget).totalSummary);
  assert.ok(estimateContextBudget({ instructions: "instructions", messages: projected }, budget).inputTokens <= budget.inputBudgetTokens!);
  const diagnostics = await compactor.getDiagnostics(); assert.ok(diagnostics.ok);
  assert.equal(diagnostics.value.lastPreparation?.degradation?.reason, "checklist_overflow");
  assert.ok(diagnostics.value.lastPreparation!.degradation!.maskedThroughMessageId);
  assert.equal(calls, 0); assert.equal(store.records.length, 0); assert.deepEqual(store.messages, before);
});

it("reusing an old summary rebuilds a checklist with the current permission snapshot", async () => {
  const store = new FakeStore(); store.messages = seed();
  const initial = make(store, { complete: async () => ({ text: JSON.stringify(summary) }) });
  await initial.prepare(store.messages, signal()); await initial.runPending(signal());
  const permission = createToolConfirmation(new PassThrough()); permission.beginRun(true);
  const reopened = make(store, { complete: async () => { throw new Error("must not dispatch"); } }, { checklist: () => ({ permissions: permission.snapshot() }) });
  const view = await reopened.prepare(store.messages, signal());
  const checklist = JSON.stringify(view.find(message => message.id === "runloom-compaction-checklist"));
  assert.match(checklist, /permissions/); assert.match(checklist, /files\\\":true/);
  permission.endRun();
  const next = await reopened.prepare(store.messages, signal());
  assert.match(JSON.stringify(next.find(message => message.id === "runloom-compaction-checklist")), /files\\\":false/);
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


it("C5 preserves oversized essential legacy continuation using unused recent capacity without a model call", async () => {
  for (const sizedBudget of [budget, defaultContextBudget()]) {
    const store = new FakeStore(); store.messages = [user("u1", "old request"), assistant("a", "done"), user("now", "continue")];
    const record: ContextCompactionRecord = { v: 2, type: "thread.context.compacted", threadId: "thread-1", id: "legacy-large", previousCompactionId: null,
      firstKeptMessageIndex: 2, firstKeptMessageId: "now", sourcePrefixHash: compactPrefixHash(store.messages, 2),
      summary: { ...summary, goal: { ...summary.goal, text: "x".repeat(blockLimits(sizedBudget).totalSummary * 2) } }, consolidationExcluded: true,
      strategyVersion: "summary-json/v2", modelId: "mock", createdAt: new Date(0).toISOString(), metrics: { estimatedInputBefore: 100, estimatedInputAfter: 50, durationMs: 1, attempts: 1 } };
    store.records.push(record as unknown as ThreadContextCompactionRecord);
    const before = structuredClone(store.records);
    const compactor = make(store, { complete: async () => { throw new Error("must not dispatch"); } }, { budget: sizedBudget });
    const prepared = await compactor.prepare(store.messages, signal());
    const diagnostic = await compactor.getDiagnostics(); assert.ok(diagnostic.ok);
    assert.equal(diagnostic.value.lastPreparation?.outcome, "reused");
    assert.ok(JSON.stringify(prepared).includes(record.summary.goal.text));
    assert.equal(diagnostic.value.lastPreparation?.degradation?.reason, "summary_overflow");
    assert.ok(diagnostic.value.lastPreparation!.summaryLayer!.reduction!.requiredTokens > blockLimits(sizedBudget).totalSummary);
    assert.deepEqual(store.records, before);
  }
});


it("CE05 1248 total minus 193 checklist retains goals, confirmed decisions, pending and permissions", async () => {
  const item = (text: string) => ({ text, evidenceMessageIds: ["fidelity-contract"] });
  const core: ContextSummaryV2 = { ...summary, goal: item("完成验收报告"), constraints: [item("部署尚未获批准，不能把旧回执当新的读取授权")],
    decisions: [{ ...item("采用本地文件方案"), source: "user", status: "confirmed" }], pending: [item("补充失败样本")],
    files: [{ ...item("old detail"), path: "notes/fixture.txt", purpose: "x".repeat(300) }] };
  const record = { summary: core, firstKeptMessageIndex: 73, layers: {
    index: [{ firstMessageId: "fidelity-contract", lastMessageId: "old", timeRange: [null, null], text: "早期验收讨论；读取成功，不是新的读取授权" }],
    recent: Array.from({ length: 4 }, (_, i) => ({ firstMessageId: `daily-u-${i}`, lastMessageId: `daily-a-${i}`, timeRange: [null, null], summary: core })) } } as ContextCompactionRecord;
  const before = structuredClone(record), fitted = fitSummaryLayer(record, 1248 - 193);
  assert.equal(blockLimits(budget).totalSummary, 1248);
  assert.equal(fitted.fits, true); assert.ok(fitted.diagnostics.reducedSegments > 0);
  assert.ok(estimateMessageTokens([fitted.message]) + 193 <= 1248);
  for (const text of ["完成验收报告", "user/confirmed: 采用本地文件方案", "补充失败样本", "部署尚未获批准", "读取成功"]) assert.ok(JSON.stringify(fitted.message).includes(text), text);
  assert.deepEqual(record, before);
  const currentId = "00000000-0000-0000-0000-00000000000";
  const store = new FakeStore(); store.messages = [user("fidelity-contract", "old"), { id: "fidelity-write-result", role: "assistant", parts: [{
    type: "dynamic-tool", toolName: "write_file", toolCallId: "fidelity-write", state: "output-error", input: { path: "notes/uncertain.txt" },
    errorText: "TOOL_OUTCOME_UNKNOWN: dispatched write lost its receipt; effect unknown, must not retry automatically.",
  }] }, user(currentId, "continue")];
  Object.assign(record, { v: 2, type: "thread.context.compacted", threadId: "thread-1", id: "overflow", previousCompactionId: null,
    firstKeptMessageIndex: 2, firstKeptMessageId: currentId, sourcePrefixHash: compactPrefixHash(store.messages, 2), consolidationExcluded: true,
    strategyVersion: "summary-json/v2", modelId: "mock", createdAt: new Date(0).toISOString(), metrics: { attempts: 1 } });
  store.records.push(record as unknown as ThreadContextCompactionRecord);
  const compactor = make(store, { complete: async () => { throw new Error("must not dispatch"); } }, { checklist: () => ({ permissions: createToolConfirmation(new PassThrough()).snapshot() }) });
  const prepared = await compactor.prepare(store.messages, signal());
  const diagnostic = await compactor.getDiagnostics(); assert.ok(diagnostic.ok);
  assert.equal(diagnostic.value.lastPreparation?.summaryLayer?.checklistTokens, 193);
  assert.ok(prepared.some(message => message.id === "runloom-context-summary"));
  for (const text of ["完成验收报告", "采用本地文件方案", "补充失败样本", "部署尚未获批准"]) assert.ok(JSON.stringify(prepared).includes(text), text);
});

it("C5 masks the oldest complete block for excess essential summary tokens while keeping goals, decisions, pending and permissions", async () => {
  const store = new FakeStore(); store.messages = seed();
  store.messages[2] = { id: "fidelity-write-result", role: "assistant", parts: [{ type: "dynamic-tool", toolName: "write_file",
    toolCallId: "fidelity-write", state: "output-error", input: { path: "notes/uncertain.txt" },
    errorText: "TOOL_OUTCOME_UNKNOWN: dispatched write lost its receipt; effect unknown, must not retry automatically." }] };
  store.messages.at(-1)!.id = "00000000-0000-0000-0000-00000000000";
  const item = (text: string) => ({ text, evidenceMessageIds: ["u1"] });
  const core: ContextSummaryV2 = { ...summary, goal: item("完成验收报告"), constraints: [item("部署未获批准")],
    decisions: [{ ...item("采用本地文件方案"), source: "user", status: "confirmed" }], pending: [item("补充失败样本")], files: [] };
  const limits = blockLimits(budget);
  const recent = Array.from({ length: 4 }, (_, i) => {
    const required: ContextSummaryV2 = { ...core, goal: item(`目标${i}：`), constraints: [item(`部署未获批准（阶段${i}）`)],
      decisions: [{ ...item(`采用本地文件方案（阶段${i}）`), source: "user", status: "confirmed" }], pending: [item(`补充失败样本（阶段${i}）`)] };
    required.goal.text += String(i).repeat((limits.section - estimateSerializedTokens(summaryText(required))) * 2);
    assert.ok(estimateSerializedTokens(summaryText(required)) <= limits.section);
    return { firstMessageId: `${i}0000000-0000-0000-0000-000000000000`, lastMessageId: `${i}0000000-0000-0000-0000-000000000001`,
      timeRange: ["2026-10-20T12:00:00.000Z", "2026-10-21T12:00:00.000Z"] as [string, string], summary: required };
  });
  const index = [{ firstMessageId: "00000000-0000-0000-0000-000000000000", lastMessageId: "10000000-0000-0000-0000-000000000000",
    timeRange: ["2026-10-20T00:00:00.000Z", "2026-10-20T12:00:00.000Z"] as [string, string], text: "" }];
  index[0]!.text = "索".repeat((limits.section - estimateSerializedTokens(index)) * 2);
  const record: ContextCompactionRecord = { v: 2, type: "thread.context.compacted", threadId: "thread-1", id: "saturated", previousCompactionId: null,
    firstKeptMessageIndex: 1, firstKeptMessageId: store.messages[1]!.id, sourcePrefixHash: compactPrefixHash(store.messages, 1), summary: core,
    layers: { index, recent },
    consolidationExcluded: true, strategyVersion: "summary-json/v2", modelId: "mock", createdAt: new Date(0).toISOString(),
    metrics: { estimatedInputBefore: 100, estimatedInputAfter: 50, durationMs: 1, attempts: 1 } };
  store.records.push(record as unknown as ThreadContextCompactionRecord);
  const before = structuredClone({ messages: store.messages, records: store.records }); let calls = 0;
  const compactor = make(store, { complete: async () => { calls++; throw new Error("no foreground model"); } },
    { checklist: () => ({ permissions: createToolConfirmation(new PassThrough()).snapshot() }) });
  const prepared = await compactor.prepare(store.messages, signal());
  const diagnostic = await compactor.getDiagnostics(); assert.ok(diagnostic.ok);
  const layer = diagnostic.value.lastPreparation!.summaryLayer!, degradation = diagnostic.value.lastPreparation!.degradation!;
  assert.equal(layer.checklistTokens, 193); assert.equal(degradation.reason, "summary_overflow"); assert.ok(layer.borrowedTokens > 0);
  assert.ok(degradation.maskedOriginalTokens! >= layer.borrowedTokens);
  assert.ok(degradation.maskedThroughMessageId); assert.equal(calls, 0); assert.equal(compactor.pending, true);
  assert.ok(diagnostic.value.lastPreparation!.estimatedInputTokens! <= 26624);
  console.info("CM_STEP6_METRICS " + JSON.stringify({ case: "C5 essential summary overflow", ...diagnostic.value.lastPreparation, modelCalls: calls }));
  for (const segment of record.layers!.recent) assert.ok(JSON.stringify(prepared).includes(segment.summary.goal.text));
  for (const text of ["采用本地文件方案", "补充失败样本", "部署未获批准"]) assert.ok(JSON.stringify(prepared).includes(text));
  assert.deepEqual({ messages: store.messages, records: store.records }, before);
});

it("recorded single-object constraints normalize with diagnostics before unchanged semantic and budget checks", async () => {
  for (const fault of ["none", "semantic", "budget", "extra-wrapper-field"] as const) {
    const store = new FakeStore(); store.messages = seed();
    const value = { ...summary, constraints: { text: fault === "budget" ? "x".repeat(1000) : "不得部署", evidenceMessageIds: ["u1"] },
      ...(fault === "semantic" ? { decisions: [{ text: "decision", evidenceMessageIds: ["u1"], source: "user", status: "invented" }] } : {}),
      ...(fault === "extra-wrapper-field" ? { constraints: { items: [], text: "do not drop me" } } : {}) };
    const compactor = make(store, { complete: async () => ({ text: JSON.stringify(value) }) });
    await compactor.prepare(store.messages, signal()); await compactor.runPending(signal());
    assert.equal(store.records.length, fault === "none" ? 1 : 0);
    assert.deepEqual(compactor.backgroundNormalizations, fault === "extra-wrapper-field" ? [] : [{ field: "constraints", operation: "single_object_to_array" }]);
    const diagnostic = await compactor.getDiagnostics(); assert.ok(diagnostic.ok);
    assert.deepEqual(diagnostic.value.background?.normalizations, compactor.backgroundNormalizations);
    if (fault === "semantic") assert.deepEqual(compactor.backgroundFailure?.schemaPaths, ["decisions.0.status"]);
    if (fault === "budget") assert.match(compactor.backgroundError!, /proportional budget/);
  }
});
