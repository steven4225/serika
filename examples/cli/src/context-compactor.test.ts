import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import type {
  ContextCompactionStore,
  MessageStore,
  ThreadContextCompactionRecord,
} from "@aisdk-agent/core";
import { AgentError } from "@aisdk-agent/core";
import { ContextCompactor, type ContextCompactorOptions } from "./context-compactor.js";
import type { ContextSummaryV2, Summarizer } from "./context-compaction.js";
import type { ContextBudgetConfig } from "./context-budget.js";
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
  it("compacts over-budget history, persists an opaque record, and keeps recent messages", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const compactor = makeCompactor(store, summarizer);
    const messages = [
      user("u1", "old goal ".repeat(40)),
      assistant("a1", "old result ".repeat(40)),
      user("u2", "new request ".repeat(4)),
      assistant("a2", "recent result ".repeat(4)),
    ];

    const prepared = await compactor.prepare(messages, new AbortController().signal);

    assert.equal(summarizer.calls, 1);
    assert.equal(store.records.length, 1);
    assert.equal(prepared[0]?.metadata && (prepared[0].metadata as { source?: string }).source, "context-compaction");
    assert.ok(prepared.some((message) => message.id === "u2"), "current user request must remain in context");
    assert.equal(prepared.at(-1)?.id, "a2");
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
      user("u1", "old goal ".repeat(40)),
      assistant("a1", "old result ".repeat(40)),
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
    const messages = [user("u1", "old ".repeat(40)), assistant("a1", "old result ".repeat(40)), user("u2", "new ".repeat(4)), assistant("a2", "recent ".repeat(4))];
    await makeCompactor(store, first).prepare(messages, new AbortController().signal);

    const second = new FakeSummarizer();
    const prepared = await makeCompactor(store, second).prepare(messages, new AbortController().signal);
    assert.equal(second.calls, 0);
    assert.equal(prepared[0]?.metadata && (prepared[0].metadata as { source?: string }).source, "context-compaction");
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

  it("merges bounded summary chunks when omitted history is large", async () => {
    const store = new FakeStore();
    const summarizer = new FakeSummarizer();
    const messages: UIMessage[] = [];
    for (let index = 0; index < 4; index += 1) {
      messages.push(user(`old-user-${index}`, `old goal ${index} `.repeat(40)));
      messages.push(assistant(`old-answer-${index}`, `old result ${index} `.repeat(40)));
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
      user("u1", "old request ".repeat(40)),
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

  it("does not retry a non-retryable compaction error", async () => {
    const store = new FakeStore();
    const summarizer = new NonRetryableSummarizer();
    await assert.rejects(
      () => makeCompactor(store, summarizer).prepare([
        user("u1", "old request ".repeat(40)),
        assistant("a1", "old answer ".repeat(40)),
        user("u2", "continue"),
      ], new AbortController().signal),
      (error: unknown) => error instanceof AgentError && error.data.code === "MODEL_AUTH",
    );
    assert.equal(summarizer.calls, 1);
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
      user("u1", "old request ".repeat(40)),
      assistant("a1", "old answer ".repeat(40)),
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
        user("u1", "old request ".repeat(40)),
        assistant("a1", "old answer ".repeat(40)),
        user("u2", "continue"),
      ], new AbortController().signal),
    );
    assert.equal(boomCalls, 1);
    assert.equal(boomStore.records.length, 0);
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
      user("u1", "old request ".repeat(400)),
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
      user("u1", "old request ".repeat(400)),
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
      assistant("a1", "old result ".repeat(40)),
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
      assistant("a1", "old result ".repeat(40)),
      user("u2", "new ".repeat(4)),
      assistant("a2", "recent ".repeat(4)),
    ];
    store.messages = messages;
    await makeCompactor(store, summarizer).prepare(messages, new AbortController().signal);
    assert.equal(summarizer.calls, 1);
    const result = await makeCompactor(store, summarizer).compact(new AbortController().signal);
    assert.equal(summarizer.calls, 1);
    assert.match(result.message, /没有可压缩内容/);
  });
});
