import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import type {
  ContextCompactionStore,
  MessageStore,
  ThreadContextCompactionRecord,
} from "@aisdk-agent/core";
import { AgentError } from "@aisdk-agent/core";
import { ContextCompactor, readContextDiagnostics, reconcilePublishedSummary, summarySourceChunks, type ContextCompactorOptions } from "./context-compactor.js";
import { compactPrefixHash, contextSummaryPrompt, type ContextCompactionRecord, type ContextSummaryV2, type Summarizer } from "./context-compaction.js";
import { estimateContextBudget, estimateMessageTokens, type ContextBudgetConfig } from "./context-budget.js";
import {
  CHECKPOINT_CONTEXT_MESSAGE_ID,
  checkpointAndMemoryContextMessages,
  createMemoryContextMessage,
  selectValidMemoryEntries,
} from "./context-window.js";
import type { CheckpointSnapshot } from "./checkpoint-store.js";

const budget: ContextBudgetConfig = {
  enabled: true,
  contextWindowTokens: 510,
  maxOutputTokens: 40,
  safetyMarginTokens: 20,
  keepRecentTokens: 20,
  summaryMaxOutputTokens: 100,
};

const roomyBudget: ContextBudgetConfig = {
  enabled: true,
  contextWindowTokens: 2_000,
  maxOutputTokens: 40,
  safetyMarginTokens: 20,
  keepRecentTokens: 40,
  summaryMaxOutputTokens: 200,
};

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

const summary: ContextSummaryV2 = {
  version: 2,
  goal: { text: "continue the task", evidenceMessageIds: ["u1"] },
  constraints: [],
  decisions: [],
  actions: [],
  pending: [{ text: "continue", evidenceMessageIds: ["u1"] }],
  files: [],
  nextStep: { text: "continue", evidenceMessageIds: ["u1"] },
};

class FakeStore implements MessageStore, ContextCompactionStore {
  messages: UIMessage[] = [];
  records: ThreadContextCompactionRecord[] = [];
  async save(_threadId: string, messages: UIMessage[]): Promise<void> { this.messages = structuredClone(messages); }
  async getMessages(_threadId: string): Promise<UIMessage[]> { return structuredClone(this.messages); }
  async appendContextCompaction(record: ThreadContextCompactionRecord): Promise<void> { this.records.push(structuredClone(record)); }
  async getContextCompactions(_threadId: string): Promise<ThreadContextCompactionRecord[]> { return structuredClone(this.records); }
}

class FakeSummarizer implements Summarizer {
  calls = 0;
  async complete(): Promise<{ text: string }> {
    this.calls += 1;
    return { text: JSON.stringify(summary) };
  }
}

class NonRetryableSummarizer implements Summarizer {
  calls = 0;
  async complete(): Promise<{ text: string }> {
    this.calls += 1;
    throw new AgentError({
      code: "MODEL_AUTH",
      message: "invalid compaction credentials",
      retryable: false,
      phase: "model",
    });
  }
}

function makeCompactor(
  store: FakeStore,
  summarizer: Summarizer,
  budgetOverride: ContextBudgetConfig = budget,
  extra: Partial<ContextCompactorOptions> = {},
): ContextCompactor {
  return new ContextCompactor({
    store,
    threadId: "thread-1",
    modelId: "mock/default",
    summarizer,
    budget: budgetOverride,
    fixedContext: () => ({ instructions: "instructions", tools: [], memories: [], dynamicContext: "" }),
    generateId: () => "compact-1",
    ...extra,
  });
}

describe("ContextCompactor", () => {
  it("preserves the middle and Unicode of user text, even when its turn cannot fit one source chunk", () => {
    for (const text of ["important-middle-constraint", `${"开头🙂".repeat(100)} NEVER DELETE OLD CHAPTERS ${"结尾🚀".repeat(100)}`]) {
      const chunks = summarySourceChunks([{ messages: [user("u1", text), assistant("a1", "large output ".repeat(500))] }], 256);
      assert.ok(chunks.every(chunk => estimateMessageTokens(chunk) <= 256));
      const fragments = chunks.flat().filter(message => message.id === "u1");
      const recovered = fragments.map(message => message.parts.map(part => part.type === "text" ? part.text : "").join("\n")).join("");
      assert.equal(recovered, text);
      for (const message of fragments) for (const part of message.parts) {
        if (part.type === "text") assert.equal(Buffer.from(part.text, "utf8").toString("utf8"), part.text);
      }
    }
  });

  it("aggregates repeated completed file receipts without merging across uncertain effects or losing original receipts", () => {
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
    assert.deepEqual(reconciled.actions.map(item => item.status), ["completed", "unknown", "not_executed", "completed"]);
    assert.equal(reconciled.actions[0]?.toolCallIds.length, 8);
    assert.deepEqual(reconciled.actions[1]?.toolCallIds, ["unknown"]);
    assert.deepEqual(reconciled.actions[3]?.toolCallIds, ["after-1", "after-2"]);
    assert.deepEqual(originals, snapshot, "projection never deletes or rewrites full receipts");
    const next = reconcilePublishedSummary(summary, originals, reconciled);
    assert.deepEqual(next.actions, reconciled.actions, "a later merge must not re-expand completed history");
    assert.equal(next.files.length, 1);
  });

  it("fails oversized lossless user sources without advancing an existing valid recovery boundary", async () => {
    const store = new FakeStore();
    const old = [user("old-user", "old task"), assistant("old-assistant", "old response")];
    store.messages = [...old, user("large", "middle constraint ".repeat(2000)), assistant("large-answer", "done"), user("current", "continue")];
    store.records.push({ v: 2, type: "thread.context.compacted", threadId: "thread-1", id: "valid-old",
      previousCompactionId: null, firstKeptMessageIndex: 2, firstKeptMessageId: "large",
      sourcePrefixHash: compactPrefixHash(store.messages, 2), summary, strategyVersion: "summary-json/v2",
      modelId: "mock/default", createdAt: new Date(0).toISOString(),
      metrics: { estimatedInputBefore: 1000, estimatedInputAfter: 100, durationMs: 1, attempts: 1 },
    } as unknown as ThreadContextCompactionRecord);
    const before = structuredClone(store.records);
    const summarizer = new FakeSummarizer();
    const compactor = makeCompactor(store, summarizer);
    await assert.rejects(() => compactor.prepare(store.messages, new AbortController().signal), /bounded summary merge/);
    assert.equal(summarizer.calls, 0);
    assert.deepEqual(store.records, before);
    const diagnostics = await compactor.getDiagnostics(); assert.ok(diagnostics.ok);
    assert.equal(diagnostics.value.latestValidCompaction?.id, "valid-old");
    assert.equal(diagnostics.value.lastPreparation?.outcome, "failed");
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
    assert.equal(result.actions.length, 2);
    assert.ok(result.actions.every(action => action.status === "completed" && action.toolCallIds.length === 8));
    assert.equal(result.files.length, 1);
    assert.deepEqual(result.files[0]?.evidenceMessageIds, ["edit_file-19"]);
    const readsOnly = reconcilePublishedSummary(summary, messages.filter(message => !message.id.startsWith("edit_file")), undefined);
    assert.deepEqual(readsOnly.files, []);
  });

  it("merges only the uncovered suffix after restart, including an old boundary inside a now-complete turn", async () => {
    const store = new FakeStore();
    const old = Array.from({ length: 12 }, (_, i) => [user(`old-u-${i}`, "ALREADY_COVERED ".repeat(100)), assistant(`old-a-${i}`, "ALREADY_COVERED ".repeat(100))]).flat();
    const messages = [...old, user("u1", "read the current file"), assistant("read-result", "CURRENT_DISK ".repeat(400)), user("u2", "continue")];
    // Stored while u1 was the current turn; the safe boundary is after that
    // request. On the next Run u1 and its assistant result form one history unit.
    const boundary = old.length + 1;
    store.records.push({ v: 2, type: "thread.context.compacted", threadId: "thread-1", id: "previous", previousCompactionId: null,
      firstKeptMessageIndex: boundary, firstKeptMessageId: messages[boundary]!.id,
      sourcePrefixHash: compactPrefixHash(messages, boundary), summary,
      strategyVersion: "summary-json/v2", modelId: "mock/default", createdAt: new Date(0).toISOString(),
      metrics: { estimatedInputBefore: 20000, estimatedInputAfter: 500, durationMs: 1, attempts: 1 },
    } as unknown as ThreadContextCompactionRecord);
    let calls = 0;
    const summarizer: Summarizer = { complete: async ({ prompt }) => {
      calls += 1;
      assert.doesNotMatch(prompt, /ALREADY_COVERED/);
      assert.match(prompt, /CURRENT_DISK/);
      assert.match(prompt, /continue the task/, "prior summary remains merge input");
      return { text: JSON.stringify(summary) };
    } };
    const prepared = await makeCompactor(store, summarizer, { ...roomyBudget, keepRecentTokens: 256 }).prepare(messages, new AbortController().signal);
    assert.equal(calls, 1, "covered prefix must not exhaust the four-merge limit");
    assert.equal(store.records.length, 2);
    assert.equal(store.records[1]?.previousCompactionId, "previous");
    const record = store.records[1] as unknown as ContextCompactionRecord;
    assert.equal(record.sourcePrefixHash, compactPrefixHash(messages, record.firstKeptMessageIndex));
    assert.ok(prepared.some(message => message.id === "u2"));
    const restored = makeCompactor(store, summarizer, { ...roomyBudget, keepRecentTokens: 256 });
    await restored.prepare(messages, new AbortController().signal);
    assert.equal(calls, 1, "new record is reusable without additional model work");
  });
  it("reads diagnostics without preparing, calling the model, or writing; restart is not a preparation", async () => {
    const store = new FakeStore();
    store.messages = [user("u1", "old goal ".repeat(4)), assistant("a1", "old result ".repeat(100)), user("u2", "continue")];
    const summarizer = new FakeSummarizer();
    const original = makeCompactor(store, summarizer);
    await original.prepare(store.messages, new AbortController().signal);
    const recorded = await original.getDiagnostics();
    assert.equal(recorded.ok, true);
    if (!recorded.ok) return;
    assert.equal(recorded.value.lastPreparation?.outcome, "written");
    assert.equal(recorded.value.lastPreparation?.compactionId, "compact-1");
    assert.equal(recorded.value.lastPreparation?.estimatedInputTokens, recorded.value.latestValidCompaction?.metrics.estimatedInputAfter);
    assert.equal(recorded.value.latestValidCompaction?.metrics.usage, undefined);
    assert.equal("summary" in (recorded.value.latestValidCompaction ?? {}), false);
    const before = structuredClone(store.records);
    const reopened = makeCompactor(store, summarizer);
    const restored = await reopened.getDiagnostics();
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.value.latestValidCompaction?.id, "compact-1");
    assert.equal(restored.value.lastPreparation, null);
    assert.equal(summarizer.calls, 1);
    assert.deepEqual(store.records, before);
    await reopened.prepare(store.messages, new AbortController().signal);
    const reused = await reopened.getDiagnostics();
    assert.equal(reused.ok && reused.value.lastPreparation?.outcome, "reused");
    assert.equal(summarizer.calls, 1);
  });

  it("skips nonmatching records, retains valid historical evidence after a failed preparation, and reports read failure", async () => {
    const store = new FakeStore();
    store.messages = [user("u1", "old goal ".repeat(4)), assistant("a1", "old result ".repeat(100)), user("u2", "continue")];
    await makeCompactor(store, new FakeSummarizer()).prepare(store.messages, new AbortController().signal);
    const invalid = { ...structuredClone(store.records[0]!), id: "invalid", sourcePrefixHash: "not-the-prefix" };
    store.records.push(invalid);
    const compactor = makeCompactor(store, new NonRetryableSummarizer(), budget, {
      fixedContext: () => { throw new Error("fixed context unavailable"); },
    });
    await assert.rejects(compactor.prepare(store.messages, new AbortController().signal), /unavailable/);
    const result = await compactor.getDiagnostics();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.latestValidCompaction?.id, "compact-1");
    assert.equal(result.value.lastPreparation?.outcome, "failed");
    assert.equal(result.value.lastPreparation?.compactionId, null);
    assert.match(result.value.lastPreparation?.error?.message ?? "", /unavailable/);
    store.getMessages = async () => { throw new Error("cannot read transcript"); };
    const unreadable = await compactor.getDiagnostics();
    assert.equal(unreadable.ok, false);
    if (!unreadable.ok) assert.match(unreadable.error.message, /cannot read/);
  });

  it("reports empty and disabled context without claiming a preparation or model usage", async () => {
    const store = new FakeStore();
    const result = await readContextDiagnostics(store, "thread-1", { ...budget, enabled: false });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.enabled, false);
    assert.equal(result.value.estimatorVersion, "char-half/v1");
    assert.equal(result.value.latestValidCompaction, null);
    assert.equal(result.value.lastPreparation, null);
    assert.equal(store.records.length, 0);
  });

  it("does not manufacture zero usage fields that the model did not return", async () => {
    const store = new FakeStore();
    store.messages = [user("u1", "old goal ".repeat(4)), assistant("a1", "old result ".repeat(100)), user("u2", "continue")];
    const compactor = makeCompactor(store, {
      complete: async () => ({ text: JSON.stringify(summary), usage: { inputTokens: 9 } }),
    });
    await compactor.prepare(store.messages, new AbortController().signal);
    const result = await compactor.getDiagnostics();
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.latestValidCompaction?.metrics.usage, { inputTokens: 9 });
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

  it("compacts over-budget history, persists an opaque record, and keeps recent messages", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const compactor = makeCompactor(store, summarizer);
    const messages = [
      user("u1", "old goal ".repeat(4)),
      assistant("a1", "old result ".repeat(100)),
      user("u2", "new request ".repeat(4)),
      assistant("a2", "recent result ".repeat(4)),
    ];

    const prepared = await compactor.prepare(messages, new AbortController().signal);

    assert.equal(summarizer.calls, 1);
    assert.equal(store.records.length, 1);
    assert.equal(prepared[0]?.metadata && (prepared[0].metadata as { source?: string }).source, "context-compaction");
    assert.ok(prepared.some((message) => message.id === "u2"), "current user request must remain in context");
    assert.equal(prepared.at(-1)?.id, "a2");
    assert.ok(!estimateContextBudget({ instructions: "instructions", messages: prepared }, budget).exceeds);
    assert.equal(store.records[0]?.type, "thread.context.compacted");
    assert.match(
      String(store.records[0]?.sourcePrefixHash ?? ""),
      /^compact-prefix\/jcs-sha256:v1:/,
    );
  });

  it("restores an old decision in the summary and injects only the current memory", async () => {
    const store = new FakeStore();
    const oldDecision = "prefer single agent";
    const currentDecision = "multi-agent is allowed";
    const summarizer: Summarizer = {
      async complete() {
        return {
          text: JSON.stringify({
            ...summary,
            decisions: [{
              text: oldDecision,
              evidenceMessageIds: ["u1"],
              source: "user",
              status: "confirmed",
            }],
          }),
        };
      },
    };
    const messages = [
      user("u1", "old goal ".repeat(4)),
      assistant("a1", "old result ".repeat(100)),
      user("u2", "new request ".repeat(4)),
      assistant("a2", "recent result ".repeat(4)),
    ];
    await makeCompactor(store, summarizer, roomyBudget).prepare(messages, new AbortController().signal, true);

    let restartedCalls = 0;
    const restarted = await makeCompactor(store, {
      async complete() {
        restartedCalls += 1;
        throw new Error("restart must reuse the saved summary");
      },
    }, roomyBudget).prepare(messages, new AbortController().signal);
    assert.equal(restartedCalls, 0);
    const summaryText = restarted
      .filter((message) => message.id === "runloom-context-summary")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.match(summaryText, /prefer single agent/);

    const memory = createMemoryContextMessage(selectValidMemoryEntries([{
      id: "mem-1",
      text: currentDecision,
      enabled: true,
      status: "active",
      scope: { kind: "workspace" },
      history: [{
        revision: 1,
        text: oldDecision,
        status: "active",
        scope: { kind: "workspace" },
        expiresAt: null,
        source: { kind: "manual" },
        changedAt: "2026-09-01T00:00:00.000Z",
      }],
    }], { threadId: "thread-1", now: new Date("2026-09-22T00:00:00.000Z") }));
    assert.ok(memory);
    const memoryText = memory.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    assert.match(memoryText, /multi-agent is allowed/);
    assert.doesNotMatch(memoryText, /prefer single agent/);
    assert.equal(restarted[0]?.id === "runloom-context-summary" || restarted.some((message) => message.id === "runloom-context-summary"), true);
  });

  it("reuses a valid persisted summary after reopen without another summary call", async () => {
    const store = new FakeStore();
    const first = new FakeSummarizer();
    const messages = [user("u1", "old ".repeat(40)), assistant("a1", "old result ".repeat(100)), user("u2", "new ".repeat(4)), assistant("a2", "recent ".repeat(4))];
    await makeCompactor(store, first).prepare(messages, new AbortController().signal);

    const second = new FakeSummarizer();
    const prepared = await makeCompactor(store, second).prepare(messages, new AbortController().signal);
    assert.equal(second.calls, 0);
    assert.equal(prepared[0]?.metadata && (prepared[0].metadata as { source?: string }).source, "context-compaction");
  });

  for (const force of [false, true]) {
    it(`rejects an old summary when added fixed context exceeds budget without a safe new boundary (force=${force})`, async () => {
      const store = new FakeStore();
      store.messages = [user("u1", "a".repeat(150)), assistant("a1", "b".repeat(150)), user("u2", "continue")];
      store.records.push({ v: 2, type: "thread.context.compacted", threadId: "thread-1", id: "prior",
        previousCompactionId: null, firstKeptMessageIndex: 2, firstKeptMessageId: "u2",
        sourcePrefixHash: compactPrefixHash(store.messages, 2),
        summary: { ...summary, goal: { text: "continue", evidenceMessageIds: ["u1"] }, pending: [], nextStep: null },
        strategyVersion: "summary-json/v2", modelId: "mock/default", createdAt: new Date(0).toISOString(),
        metrics: { estimatedInputBefore: 500, estimatedInputAfter: 100, durationMs: 1, attempts: 1 },
      } as unknown as ThreadContextCompactionRecord);
      const before = structuredClone(store.records);
      const limitedBudget = { ...roomyBudget, contextWindowTokens: 1000, maxOutputTokens: 50,
        safetyMarginTokens: 50, keepRecentTokens: 800, summaryMaxOutputTokens: 100 };
      let instructions = "x".repeat(800);
      const summarizer = new FakeSummarizer();
      const compactor = makeCompactor(store, summarizer, limitedBudget, {
        fixedContext: () => ({ instructions, tools: [], dynamicContext: "" }),
      });
      const prepared = await compactor.prepare(store.messages, new AbortController().signal, force);
      assert.ok(!estimateContextBudget({ instructions, messages: prepared }, limitedBudget).exceeds);
      instructions = "x".repeat(1600);
      await assert.rejects(
        () => compactor.prepare(store.messages, new AbortController().signal, force),
        (error: unknown) => error instanceof AgentError && error.data.code === "CONTEXT_PREPARE_FAILED",
      );
      const diagnostics = await compactor.getDiagnostics();
      assert.ok(diagnostics.ok);
      assert.equal(diagnostics.value.lastPreparation?.outcome, "failed");
      assert.equal(diagnostics.value.lastPreparation?.compactionId, null);
      assert.equal(diagnostics.value.lastPreparation?.estimatedInputTokens, 1064);
      assert.match(diagnostics.value.lastPreparation?.error?.message ?? "", /budget/);
      assert.equal(diagnostics.value.latestValidCompaction?.id, "prior");
      assert.equal(summarizer.calls, 0);
      assert.deepEqual(store.records, before, "failure must not change the valid recovery boundary");
    });
  }

  it("rejects a forced raw noop when the current user message cannot fit", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const compactor = makeCompactor(store, summarizer);
    await assert.rejects(
      () => compactor.prepare([user("huge", "x".repeat(4000))], new AbortController().signal, true),
      (error: unknown) => error instanceof AgentError && error.data.code === "CONTEXT_PREPARE_FAILED",
    );
    const diagnostics = await compactor.getDiagnostics();
    assert.ok(diagnostics.ok);
    assert.equal(diagnostics.value.lastPreparation?.outcome, "failed");
    assert.equal(summarizer.calls, 0);
    assert.equal(store.records.length, 0);
  });

  it("rejects an oversized new summary before saving and records its final failed estimate", async () => {
    const store = new FakeStore();
    const messages = [user("u1", "old goal"), assistant("a1", "old result ".repeat(100)), user("u2", "continue")];
    const compactor = makeCompactor(store, { complete: async () => ({ text: JSON.stringify({
      ...summary, goal: { text: "x".repeat(1200), evidenceMessageIds: ["u1"] },
    }) }) });
    await assert.rejects(() => compactor.prepare(messages, new AbortController().signal),
      (error: unknown) => error instanceof AgentError && error.data.code === "CONTEXT_PREPARE_FAILED");
    const diagnostics = await compactor.getDiagnostics();
    assert.ok(diagnostics.ok);
    assert.equal(diagnostics.value.lastPreparation?.outcome, "failed");
    assert.equal(diagnostics.value.lastPreparation?.compactionId, null);
    const estimate = diagnostics.value.lastPreparation?.estimatedInputTokens;
    assert.ok(estimate !== undefined && estimate !== null && estimate >
      budget.contextWindowTokens - budget.maxOutputTokens - budget.safetyMarginTokens);
    assert.match(diagnostics.value.lastPreparation?.error?.message ?? "", new RegExp(`${estimate} > 450 tokens`));
    assert.equal(store.records.length, 0);
  });

  it("links a second compaction to the first and restores the latest summary after restart", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const firstMessages = [
      user("u1", "old goal ".repeat(4)),
      assistant("a1", "old result ".repeat(100)),
      user("u2", "new request ".repeat(4)),
      assistant("a2", "recent result ".repeat(4)),
    ];
    const compactor = makeCompactor(store, summarizer);
    await compactor.prepare(firstMessages, new AbortController().signal);
    const first = store.records[0];
    assert.ok(first);

    const laterMessages = [
      ...firstMessages,
      user("u3", "another task ".repeat(40)),
      assistant("a3", "another result ".repeat(40)),
      user("u4", "continue"),
    ];
    const prepared = await compactor.prepare(laterMessages, new AbortController().signal);
    assert.equal(store.records.length, 2);
    assert.equal(store.records[1]?.previousCompactionId, first.id);
    assert.ok((store.records[1]?.firstKeptMessageIndex ?? 0) > (first.firstKeptMessageIndex ?? 0));
    assert.equal(prepared.at(-1)?.id, "u4");

    const restarted = new FakeSummarizer();
    const restored = await makeCompactor(store, restarted).prepare(laterMessages, new AbortController().signal);
    assert.equal(restarted.calls, 0);
    assert.deepEqual(restored, prepared);
  });

  it("does not compact below the threshold", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const prepared = await makeCompactor(store, summarizer).prepare(
      [user("u1", "short request")],
      new AbortController().signal,
    );

    assert.deepEqual(prepared, [user("u1", "short request")]);
    assert.equal(summarizer.calls, 0);
    assert.equal(store.records.length, 0);
  });

  it("counts promptPrefix in the budget and leaves checkpoint injection to the caller", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const checkpoint: CheckpointSnapshot = {
      id: "checkpoint-1",
      version: 1,
      status: "active",
      goal: "Continue Runloom",
      summary: "Compaction counts this prefix.",
      completed: [],
      inProgress: [],
      nextActions: [],
      blockers: [],
      artifacts: [],
      source: { threadId: "thread-1" },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const prefix = checkpointAndMemoryContextMessages(checkpoint, [
      { id: "memory-current", text: "Keep M5 in one PR.", enabled: true },
    ], { threadId: "thread-1" });
    const conversation = [user("u1", "short request")];
    const prepared = await makeCompactor(store, summarizer, roomyBudget, {
      promptPrefix: () => prefix,
    }).prepare(conversation, new AbortController().signal);

    assert.deepEqual(prepared, conversation);
    assert.equal(prepared.some((message) => message.id === CHECKPOINT_CONTEXT_MESSAGE_ID), false);
    const selected = [...prefix, ...prepared];
    assert.equal(selected[0]?.id, CHECKPOINT_CONTEXT_MESSAGE_ID);
    assert.equal(selected.filter((message) => message.id === CHECKPOINT_CONTEXT_MESSAGE_ID).length, 1);
    assert.equal(selected.at(-1)?.id, "u1");
  });

  it("uses a supplied prefix snapshot for budgeting without rereading it", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    let fallbackReads = 0;
    const compactor = makeCompactor(store, summarizer, roomyBudget, {
      promptPrefix: () => {
        fallbackReads += 1;
        return [assistant("memory", "x".repeat(10_000))];
      },
    });
    const conversation = [user("u1", "short request")];
    const captured = [assistant("memory", "captured revision 1")];
    const prepared = await compactor.prepare(conversation, new AbortController().signal, false, captured);
    assert.deepEqual(prepared, conversation);
    assert.equal(fallbackReads, 0);
    assert.equal([...captured, ...prepared][0], captured[0]);
    await compactor.prepare(conversation, new AbortController().signal, false, []);
    assert.equal(fallbackReads, 0);
    await assert.rejects(compactor.prepare(conversation, new AbortController().signal, false,
      [assistant("memory", "x".repeat(10_000))]),
    (error: unknown) => error instanceof AgentError && error.data.code === "CONTEXT_PREPARE_FAILED");
  });

  it("publishes the budgeted prefix after dropping optional resume without rereading Memory", async () => {
    const summarizer = new FakeSummarizer();
    const compactor = makeCompactor(new FakeStore(), summarizer, roomyBudget);
    const memory = assistant("runloom-workspace-memory", "captured revision 1");
    const prefix = [assistant("runloom-resume-observation", "x".repeat(10_000)), memory];
    const conversation = [user("u1", "short request")];
    assert.deepEqual(await compactor.prepare(conversation, new AbortController().signal, false, prefix), conversation);
    assert.deepEqual(compactor.effectiveReferencePrefix, [memory]);
    assert.equal(prefix.length, 2);
    await compactor.prepare(conversation, new AbortController().signal, false, [memory]);
    assert.deepEqual(compactor.effectiveReferencePrefix, [memory]);
  });

  it("manual compact builds its prefix from committed messages once per preparation", async () => {
    const store = new FakeStore();
    store.messages = [user("u1", "writing preference")];
    const snapshots: UIMessage[][] = [];
    let revision = 1;
    const compactor = makeCompactor(store, new FakeSummarizer(), roomyBudget, {
      promptPrefix: (_signal, messages) => {
        snapshots.push([...messages]);
        return [assistant("memory", `revision ${revision++}`)];
      },
    });
    await compactor.compact(new AbortController().signal);
    await compactor.prepare(store.messages, new AbortController().signal);
    assert.equal(snapshots.length, 2);
    assert.deepEqual(snapshots[0], store.messages);
    assert.deepEqual(snapshots[1], store.messages);
    assert.equal(revision, 3);
  });

  it("keeps captured Memory while summarizing and reads the changed version only next preparation", async () => {
    const store = new FakeStore();
    let currentText = "revision 1";
    let reads = 0;
    const readPrefix = (): UIMessage[] => {
      reads += 1;
      return [assistant("memory", currentText)];
    };
    const summarizer: Summarizer = {
      complete: async () => {
        currentText = "revision 2";
        return { text: JSON.stringify(summary) };
      },
    };
    const compactor = makeCompactor(store, summarizer, roomyBudget, { promptPrefix: readPrefix });
    const messages = [user("old", "old request"), assistant("answer", "old answer"), user("next", "new request")];
    const captured = readPrefix();
    const prepared = await compactor.prepare(messages, new AbortController().signal, true, captured);
    assert.equal(reads, 1);
    assert.equal(currentText, "revision 2");
    assert.equal(captured[0]?.parts[0]?.type, "text");
    assert.deepEqual([...captured, ...prepared][0]?.parts, [{ type: "text", text: "revision 1" }]);
    const next = readPrefix();
    await compactor.prepare(messages, new AbortController().signal, false, next);
    assert.equal(reads, 2);
    assert.deepEqual(next[0]?.parts, [{ type: "text", text: "revision 2" }]);
  });

  it("merges bounded summary chunks when omitted history is large", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const messages: UIMessage[] = [];
    for (let index = 0; index < 4; index += 1) {
      messages.push(user(`old-user-${index}`, `old goal ${index} `.repeat(4)));
      messages.push(assistant(`old-answer-${index}`, `old result ${index} `.repeat(100)));
    }
    messages.push(user("current", "continue"));

    await makeCompactor(store, summarizer).prepare(messages, new AbortController().signal);
    assert.ok(summarizer.calls > 1);
    assert.ok(summarizer.calls <= 4);
  });

  it("reconciles an ok:false tool result as failed instead of completed", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const messages: UIMessage[] = [
      user("u1", "old request ".repeat(4)),
      assistant("filler", "old reference ".repeat(100)),
      {
        id: "call-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tool-1",
          state: "input-available",
          input: { path: "missing.md" },
        }],
      },
      {
        id: "result-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tool-1",
          state: "output-available",
          input: { path: "missing.md" },
          output: { ok: false, code: "NOT_FOUND" },
        }],
      },
      user("u2", "continue"),
    ];

    await makeCompactor(store, summarizer).prepare(messages, new AbortController().signal);
    const persisted = store.records[0];
    assert.ok(persisted);
    const persistedSummary = persisted.summary as unknown as ContextSummaryV2;
    assert.equal(persistedSummary.actions[0]?.status, "failed");
  });

  it("summarizes a long completed tool result without splitting its call and result", async () => {
    const store = new FakeStore();
    const messages: UIMessage[] = [
      user("u1", "inspect the file"),
      {
        id: "call-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tool-1",
          state: "input-available",
          input: { path: "docs/large.md" },
        }],
      },
      {
        id: "result-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "tool-1",
          state: "output-available",
          input: { path: "docs/large.md" },
          output: { ok: true, content: "x".repeat(8_000) },
        }],
      },
      user("u2", "what was found?"),
    ];

    const prepared = await makeCompactor(store, new FakeSummarizer()).prepare(
      messages,
      new AbortController().signal,
    );
    assert.equal(store.records.length, 1);
    assert.equal(store.records[0]?.firstKeptMessageIndex, 3);
    assert.deepEqual(prepared.map((message) => message.id), ["runloom-context-summary", "u2"]);
    const persistedSummary = store.records[0]?.summary as unknown as ContextSummaryV2;
    assert.deepEqual(persistedSummary.actions.map((action) => ({
      id: action.toolCallIds[0],
      status: action.status,
    })), [{ id: "tool-1", status: "completed" }]);
  });

  it("does not retry a non-retryable compaction error", async () => {
    const store = new FakeStore();
    const summarizer = new NonRetryableSummarizer();
    await assert.rejects(
      () => makeCompactor(store, summarizer).prepare([
        user("u1", "old request ".repeat(4)),
        assistant("a1", "old answer ".repeat(100)),
        user("u2", "continue"),
      ], new AbortController().signal),
      (error: unknown) => error instanceof AgentError && error.data.code === "MODEL_AUTH",
    );
    assert.equal(summarizer.calls, 1);
    assert.equal(store.records.length, 0);
  });

  it("counts usage from invalid JSON attempts in the saved metrics and /compact report", async () => {
    const store = new FakeStore();
    store.messages = [
      user("u1", "old request ".repeat(4)),
      assistant("a1", "old answer ".repeat(100)),
      user("u2", "continue"),
    ];
    let calls = 0;
    const summarizer: Summarizer = {
      async complete() {
        calls += 1;
        return calls === 1
          ? { text: "not JSON", usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } }
          : { text: JSON.stringify(summary), usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 } };
      },
    };

    const result = await makeCompactor(store, summarizer).compact(new AbortController().signal);

    assert.equal(calls, 2);
    assert.match(result.message, /尝试 2 次/);
    assert.match(result.message, /usage in=24 out=10/);
    const record = store.records[0] as unknown as ContextCompactionRecord;
    assert.ok(record);
    assert.equal(record.metrics.attempts, 2);
    assert.deepEqual(record.metrics.usage, { inputTokens: 24, outputTokens: 10, totalTokens: 34 });
  });

  it("never installs a length-truncated summary even if its visible JSON parses, and retries within the same budget", async () => {
    const store = new FakeStore();
    store.messages = [user("u1", "old request ".repeat(4)), assistant("a1", "old answer ".repeat(100)), user("u2", "continue")];
    let calls = 0;
    const summarizer: Summarizer = {
      async complete({ prompt, maxOutputTokens }) {
        calls += 1;
        assert.equal(maxOutputTokens, budget.summaryMaxOutputTokens);
        if (calls === 2) assert.match(prompt, /shorter complete JSON object/);
        assert.equal(store.records.length, 0);
        return { text: JSON.stringify(summary), finishReason: calls === 1 ? "length" : "stop",
          usage: { inputTokens: 5, outputTokens: 100, totalTokens: 105 } };
      },
    };
    await makeCompactor(store, summarizer).compact(new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(store.records.length, 1);
    const record = store.records[0] as unknown as ContextCompactionRecord;
    assert.equal(record.metrics.attempts, 2);
    assert.equal(record.metrics.usage?.outputTokens, 200);
  });

  it("reports observed usage when every summary attempt fails", async () => {
    const store = new FakeStore();
    let calls = 0;
    const summarizer: Summarizer = {
      async complete() {
        calls += 1;
        return { text: "not JSON", usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      },
    };
    await assert.rejects(
      () => makeCompactor(store, summarizer).prepare([
        user("u1", "old request ".repeat(4)),
        assistant("a1", "old answer ".repeat(100)),
        user("u2", "continue"),
      ], new AbortController().signal),
      (error: unknown) => error instanceof AgentError &&
        error.data.code === "CONTEXT_PREPARE_FAILED" &&
        /"inputTokens":15/.test(error.message) &&
        /"outputTokens":6/.test(error.message),
    );
    assert.equal(calls, 3);
    assert.equal(store.records.length, 0);
  });

  it("does not save a summary when cancelled after model completion", async () => {
    const store = new FakeStore();
    const controller = new AbortController();
    const summarizer: Summarizer = {
      async complete() {
        controller.abort(new DOMException("cancelled", "AbortError"));
        return { text: JSON.stringify(summary) };
      },
    };
    await assert.rejects(
      () => makeCompactor(store, summarizer).prepare([
        user("u1", "old request ".repeat(4)),
        assistant("a1", "old answer ".repeat(100)),
        user("u2", "continue"),
      ], controller.signal),
      /cancelled/,
    );
    assert.equal(store.records.length, 0);
  });

  it("retries empty summary output and does not retry generic errors", async () => {
    const store = new FakeStore();
    let emptyCalls = 0;
    const emptyThenOk: Summarizer = {
      async complete() {
        emptyCalls += 1;
        if (emptyCalls < 3) return { text: "  " };
        return { text: JSON.stringify(summary) };
      },
    };
    await makeCompactor(store, emptyThenOk).prepare([
      user("u1", "old request ".repeat(4)),
      assistant("a1", "old answer ".repeat(100)),
      user("u2", "continue"),
    ], new AbortController().signal);
    assert.equal(emptyCalls, 3);
    assert.equal(store.records.length, 1);

    const boomStore = new FakeStore();
    let boomCalls = 0;
    const boom: Summarizer = {
      async complete() {
        boomCalls += 1;
        throw new Error("boom");
      },
    };
    await assert.rejects(
      () => makeCompactor(boomStore, boom).prepare([
        user("u1", "old request ".repeat(4)),
        assistant("a1", "old answer ".repeat(100)),
        user("u2", "continue"),
      ], new AbortController().signal),
    );
    assert.equal(boomCalls, 1);
    assert.equal(boomStore.records.length, 0);
  });

  it("installs a DeepSeek-shaped summary that omits evidence ids and file text", async () => {
    const store = new FakeStore();
    const summarizer: Summarizer = {
      async complete() {
        return {
          text: JSON.stringify({
            version: 2,
            goal: { text: "continue the task", evidenceMessageIds: ["u1"] },
            constraints: [],
            decisions: [{ text: "keep notes only", source: "user", status: "confirmed" }],
            actions: [{ text: "wrote notes/plan.md", status: "completed", toolCallIds: ["write-1"] }],
            pending: [],
            files: [{ path: "notes/plan.md", purpose: "plan" }],
            nextStep: { text: "continue", evidenceMessageIds: ["u1"] },
          }),
        };
      },
    };
    const messages: UIMessage[] = [
      user("u1", "old request"),
      assistant("filler", "old reference ".repeat(400)),
      {
        id: "write-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "write_file",
          toolCallId: "write-1",
          state: "output-available",
          input: { path: "notes/plan.md", content: "ok" },
          output: { ok: true, path: "notes/plan.md", bytes: 2 },
        }],
      },
      user("u2", "continue"),
    ];
    await makeCompactor(store, summarizer, roomyBudget).prepare(messages, new AbortController().signal);
    const persisted = store.records[0]?.summary as unknown as ContextSummaryV2;
    assert.ok(persisted);
    assert.equal(persisted.files[0]?.path, "notes/plan.md");
    assert.equal(persisted.decisions[0]?.text, "keep notes only");
    assert.ok((persisted.decisions[0]?.evidenceMessageIds.length ?? 0) > 0);
  });

  it("retries invalid summary JSON then installs a valid summary", async () => {
    const store = new FakeStore();
    let calls = 0;
    const summarizer: Summarizer = {
      async complete() {
        calls += 1;
        if (calls === 1) return { text: "{" };
        return { text: JSON.stringify(summary) };
      },
    };
    await makeCompactor(store, summarizer).prepare([
      user("u1", "old request ".repeat(4)),
      assistant("a1", "old answer ".repeat(100)),
      user("u2", "continue"),
    ], new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(store.records.length, 1);
  });

  it("corrects denied, missing-ok, invented files, and invalid evidence", async () => {
    const store = new FakeStore();
    const invented: ContextSummaryV2 = {
      ...summary,
      goal: { text: "continue the task", evidenceMessageIds: ["not-in-transcript"] },
      actions: [{
        text: "pretend success",
        evidenceMessageIds: ["call-1"],
        status: "completed",
        toolCallIds: ["tool-1"],
      }],
      files: [{
        text: "stole a file",
        evidenceMessageIds: ["u1"],
        path: "/etc/passwd",
        purpose: "secrets",
      }],
    };
    const summarizer: Summarizer = {
      async complete() {
        return { text: JSON.stringify(invented) };
      },
    };
    const messages: UIMessage[] = [
      user("u1", "old request"),
      assistant("filler", "old reference ".repeat(400)),
      {
        id: "call-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "shell_exec",
          toolCallId: "tool-1",
          state: "output-error",
          errorText: "TOOL_DENIED: user declined",
          input: { command: "rm" },
        }],
      },
      {
        id: "calc-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "add",
          toolCallId: "tool-2",
          state: "output-available",
          input: { a: 1, b: 2 },
          output: { value: 3 },
        }],
      },
      user("u2", "continue"),
    ];

    await makeCompactor(store, summarizer, roomyBudget).prepare(
      messages,
      new AbortController().signal,
    );
    const persistedSummary = store.records[0]?.summary as unknown as ContextSummaryV2;
    assert.ok(persistedSummary);
    assert.equal(persistedSummary.files.length, 0);
    assert.deepEqual(
      persistedSummary.actions.map((action) => ({
        id: action.toolCallIds[0],
        status: action.status,
      })),
      [
        { id: "tool-1", status: "not_executed" },
        { id: "tool-2", status: "unknown" },
      ],
    );
    assert.equal(persistedSummary.goal.evidenceMessageIds.includes("not-in-transcript"), false);
    assert.equal(persistedSummary.goal.evidenceMessageIds.includes("u1"), true);
  });

  it("keeps an unexecuted plan but not an invented completed action", async () => {
    const store = new FakeStore();
    const summarizer: Summarizer = {
      async complete() {
        return { text: JSON.stringify({
          ...summary,
          actions: [
            { text: "inspect the failing test", evidenceMessageIds: ["u1"], status: "not_executed", toolCallIds: [] },
            { text: "pretend write succeeded", evidenceMessageIds: ["u1"], status: "completed", toolCallIds: [] },
          ],
        }) };
      },
    };
    await makeCompactor(store, summarizer, roomyBudget).prepare([
      user("u1", "inspect the failing test"),
      assistant("filler", "old reference ".repeat(400)),
      user("u2", "continue"),
    ], new AbortController().signal);
    const persisted = store.records[0]?.summary as unknown as ContextSummaryV2;
    assert.deepEqual(persisted.actions.map((action) => action.text), ["inspect the failing test"]);
    assert.equal(persisted.actions[0]?.status, "not_executed");
  });

  it("keeps write_file receipts in files and drops model-invented paths", async () => {
    const store = new FakeStore();
    const invented: ContextSummaryV2 = {
      ...summary,
      files: [{
        text: "invented",
        evidenceMessageIds: ["write-1"],
        path: "notes/secret.md",
        purpose: "secret",
      }],
    };
    const summarizer: Summarizer = {
      async complete() {
        return { text: JSON.stringify(invented) };
      },
    };
    const messages: UIMessage[] = [
      user("u1", "old request"),
      assistant("filler", "old reference ".repeat(400)),
      {
        id: "write-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "write_file",
          toolCallId: "write-1",
          state: "output-available",
          input: { path: "reports/ok.md", content: "ok" },
          output: { ok: true, path: "reports/ok.md", bytes: 2 },
        }],
      },
      user("u2", "continue"),
    ];
    await makeCompactor(store, summarizer, roomyBudget).prepare(
      messages,
      new AbortController().signal,
    );
    const persistedSummary = store.records[0]?.summary as unknown as ContextSummaryV2;
    assert.deepEqual(persistedSummary.files.map((file) => file.path), ["reports/ok.md"]);
  });

  it("does not restore a compaction record that does not match the committed prefix", async () => {
    const store = new FakeStore();
    store.records.push({
      v: 2,
      type: "thread.context.compacted",
      threadId: "thread-1",
      id: "stale",
      previousCompactionId: null,
      firstKeptMessageIndex: 5,
      firstKeptMessageId: null,
      sourcePrefixHash: "compact-prefix/jcs-sha256:v1:deadbeef",
      summary,
      strategyVersion: "summary-json/v2",
      modelId: "mock/default",
      createdAt: new Date(0).toISOString(),
      metrics: {
        estimatedInputBefore: 1,
        estimatedInputAfter: 1,
        durationMs: 1,
        attempts: 1,
      },
    } as unknown as ThreadContextCompactionRecord);
    const summarizer = new FakeSummarizer();
    const prepared = await makeCompactor(store, summarizer).prepare(
      [user("u1", "short request")],
      new AbortController().signal,
    );
    assert.deepEqual(prepared, [user("u1", "short request")]);
    assert.equal(summarizer.calls, 0);
  });

  it("recompacts when a stored prefix hash no longer matches", async () => {
    const store = new FakeStore();
    const first = new FakeSummarizer();
    const messages = [
      user("u1", "old ".repeat(40)),
      assistant("a1", "old result ".repeat(100)),
      user("u2", "new ".repeat(4)),
      assistant("a2", "recent ".repeat(4)),
    ];
    await makeCompactor(store, first).prepare(messages, new AbortController().signal);
    assert.equal(store.records.length, 1);
    store.records[0] = {
      ...store.records[0]!,
      sourcePrefixHash: "compact-prefix/jcs-sha256:v1:deadbeef",
    };

    const second = new FakeSummarizer();
    await makeCompactor(store, second).prepare(messages, new AbortController().signal);
    assert.equal(second.calls, 1);
    assert.equal(store.records.length, 2);
  });

  it("summarizes a completed tool result that does not fit beside the user message", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const prepared = await makeCompactor(store, summarizer, roomyBudget).prepare([
      user("u1", "inspect the banner"),
      {
        id: "read-1",
        role: "assistant",
        parts: [{
          type: "dynamic-tool",
          toolName: "read_file",
          toolCallId: "read-1",
          state: "output-available",
          input: { path: "examples/cli/src/tui.ts" },
          output: { ok: true, path: "examples/cli/src/tui.ts", content: "x".repeat(8_000), bytes: 8_000 },
        }],
      },
    ], new AbortController().signal);

    assert.equal(summarizer.calls > 0, true);
    assert.equal(store.records.length, 1);
    assert.equal(prepared.some((message) => message.id === "runloom-context-summary"), true);
    assert.equal(JSON.stringify(prepared).includes("x".repeat(200)), false);
  });

  it("fails when the current turn alone exceeds the input budget", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    await assert.rejects(
      () => makeCompactor(store, summarizer).prepare(
        [user("huge", "x".repeat(4_000))],
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof AgentError && error.data.code === "CONTEXT_PREPARE_FAILED",
    );
    assert.equal(summarizer.calls, 0);
    assert.equal(store.records.length, 0);
  });

  it("does not call the summarizer again when /compact is already at the keep boundary", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const messages = [
      user("u1", "old ".repeat(40)),
      assistant("a1", "old result ".repeat(100)),
      user("u2", "new ".repeat(4)),
      assistant("a2", "recent ".repeat(4)),
    ];
    store.messages = messages;
    await makeCompactor(store, summarizer).prepare(messages, new AbortController().signal);
    assert.equal(summarizer.calls, 1);
    const reopened = makeCompactor(store, summarizer);
    const result = await reopened.compact(new AbortController().signal);
    assert.equal(summarizer.calls, 1);
    assert.match(result.message, /没有可压缩内容/);
    const diagnostics = await reopened.getDiagnostics();
    assert.ok(diagnostics.ok);
    assert.equal(diagnostics.value.lastPreparation?.compactionId, "compact-1");
    assert.ok((diagnostics.value.lastPreparation?.estimatedInputTokens ?? Infinity) <=
      budget.contextWindowTokens - budget.maxOutputTokens - budget.safetyMarginTokens);
  });
});
