import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { AgentDefinition, AgentEvent, RunHandle, RunResult } from "@aisdk-agent/core";
import { createAssistantController } from "./assistant-controller.js";
import { createRuntimeApp, PRIMARY_AGENT_ID, type RuntimeApp } from "./app.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";
import { createDemoModel } from "./demo-model.js";
import { EXECUTION_RECORD_FILE } from "./execution-record-store.js";
import { createExecutionRecordStore } from "./execution-record-store.js";
import { createWorkTaskStore } from "./work-task-store.js";
import { createToolConfirmation, type PendingToolApproval } from "./tui.js";
import { createMemoryStore, type WorkspaceMemoryStore } from "./memory-store.js";
import type { CandidateResolution, MemoryResult } from "./memory-candidates.js";
import { createMemoryConsolidation } from "./memory-consolidation.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

// Integration cases persist real transcripts, leases and bounded trace metadata.
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for controller state");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function result(runId: string, status: RunResult["status"]): RunResult {
  return {
    runId,
    threadId: "controller-thread",
    status,
    text: "",
    steps: 0,
    usage: {},
  };
}

function handle(runId: string, pending: ReturnType<typeof deferred<RunResult>>, onCancel: () => void): RunHandle {
  return {
    runId,
    events: (async function* (): AsyncGenerator<AgentEvent> {})(),
    result: pending.promise,
    cancel: async () => {
      onCancel();
      pending.resolve(result(runId, "cancelled"));
    },
  };
}

function appWith(overrides: Partial<RuntimeApp> = {}): RuntimeApp {
  return {
    tuiMode: true,
    agentId: PRIMARY_AGENT_ID,
    runtime: { run: async () => { throw new Error("unexpected Run"); } } as unknown as RuntimeApp["runtime"],
    store: { getMessages: async () => [] } as unknown as RuntimeApp["store"],
    executionRecords: {
      claimThread: async () => ({ release: async () => undefined }),
      recoverInterrupted: async () => 0,
      finishRun: async () => undefined,
      listRuns: async () => [],
      getRun: async () => null,
    } as unknown as RuntimeApp["executionRecords"],
    enableExecutionRecords: () => undefined,
    bindNextExecutionWorkTask: () => () => undefined,
    workTasks: undefined,
    workTaskContext: { begin: () => undefined, end: () => undefined },
    threadId: "controller-thread",
    directory: "/private/tmp/controller-transcripts",
    workspaceRoot: undefined,
    moduleConfig: undefined,
    toolConfirmation: undefined,
    commands: undefined,
    compaction: undefined,
    getContextDiagnostics: async () => ({ ok: false, error: { code: "TEST", message: "not configured" } }),
    resume: undefined,
    autoConsolidationAgentId: undefined,
    renderHome: async () => undefined,
    registerNotificationRedraw: () => undefined,
    dispose: () => undefined,
    ...overrides,
  };
}

describe("AssistantController memory candidates", () => {
  it("forwards read-only context diagnostics without starting a Run or recovery", async () => {
    let reads = 0;
    const controller = createAssistantController(appWith({
      getContextDiagnostics: async () => {
        reads += 1;
        return { ok: true, value: {
          threadId: "controller-thread", enabled: false, budget: { ...DEFAULT_CONTEXT_BUDGET_CONFIG },
          estimatorVersion: "char-half/v1", latestValidCompaction: null, lastPreparation: null,
        } };
      },
      executionRecords: { claimThread: async () => { throw new Error("diagnostics must not recover receipts"); } } as unknown as RuntimeApp["executionRecords"],
    }));
    const result = await controller.getContextDiagnostics();
    assert.equal(result.ok, true);
    assert.equal(reads, 1);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    await controller.shutdown();
  });

  it("returns MEMORY_DISABLED without invoking a Run or creating an implicit store", async () => {
    const controller = createAssistantController(appWith());
    try {
      for (const response of [
        await controller.listMemoryCandidates(),
        await controller.getMemoryCandidate("candidate"),
        await controller.resolveMemoryCandidate({ candidateId: "candidate", expectedCandidateRevision: 1, decision: "accept" }),
      ]) {
        assert.equal(response.ok, false);
        assert.equal(!response.ok && response.error.code, "MEMORY_DISABLED");
      }
      assert.equal(controller.getSnapshot().state.kind, "idle");
      assert.deepEqual(await controller.getHistory(), []);
    } finally { await controller.shutdown(); }
  });

  it("binds reads to the current Thread and reserves the idle mutex before awaiting review", async () => {
    const gate = deferred<MemoryResult<CandidateResolution>>();
    let boundThread: string | undefined;
    const calls: string[] = [];
    const memoryStore = {
      listCandidates: async (_input: unknown, _signal: unknown, options: { boundThreadId?: string }) => {
        calls.push("list"); boundThread = options.boundThreadId;
        return { ok: true, value: { candidates: [], nextOffset: null, truncated: false } };
      },
      getCandidate: async (_id: string, _signal: unknown, options: { boundThreadId?: string }) => {
        calls.push("get"); boundThread = options.boundThreadId;
        return { ok: false, error: { code: "MEMORY_CANDIDATE_NOT_FOUND", message: "missing" } };
      },
      resolveCandidate: async (_input: unknown, _signal: unknown, options: { boundThreadId?: string }) => {
        calls.push("resolve"); boundThread = options.boundThreadId;
        return gate.promise;
      },
    } as unknown as WorkspaceMemoryStore;
    const controller = createAssistantController(appWith({ workspaceRoot: "/private/tmp/memory-workspace", memoryStore }));
    const events: string[] = [];
    controller.subscribe((event) => { if (event.type === "memory-updated") events.push(event.reason); });
    try {
      await controller.listMemoryCandidates();
      await controller.getMemoryCandidate("candidate");
      const review = controller.resolveMemoryCandidate({ candidateId: "candidate", expectedCandidateRevision: 1, decision: "accept" });
      assert.deepEqual(controller.getSnapshot().state, { kind: "command", name: "memory-review" });
      assert.deepEqual(await controller.run("Work"), { ok: false, reason: "busy" });
      assert.deepEqual(await controller.command("/home"), { ok: false, reason: "busy" });
      const competing = await controller.resolveMemoryCandidate({ candidateId: "candidate", expectedCandidateRevision: 1, decision: "reject" });
      assert.equal(!competing.ok && competing.error.code, "MEMORY_CANDIDATE_CONFLICT");
      await waitFor(() => calls.includes("resolve"));
      gate.resolve({ ok: true, value: { candidateId: "candidate", status: "accepted", memoryId: "memory", memoryRevision: 1, replayed: false } });
      assert.equal((await review).ok, true);
      assert.equal(boundThread, "controller-thread");
      assert.deepEqual(events, ["review"]);
      assert.equal(controller.getSnapshot().lastPrimaryResult, null);
      assert.equal(controller.getSnapshot().state.kind, "idle");
    } finally { await controller.shutdown(); }
  });

  it("cancels an in-progress review and awaits it during shutdown", async () => {
    const entered = deferred<void>();
    const memoryStore = {
      resolveCandidate: async (_input: unknown, signal: AbortSignal) => {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { ok: false, error: { code: "WRITE_FAILED", message: "Operation cancelled before commit" } };
      },
    } as unknown as WorkspaceMemoryStore;
    const controller = createAssistantController(appWith({ workspaceRoot: "/private/tmp/memory-workspace", memoryStore }));
    const events: string[] = [];
    controller.subscribe((event) => { if (event.type === "memory-updated") events.push(event.reason); });
    const review = controller.resolveMemoryCandidate({ candidateId: "candidate", expectedCandidateRevision: 1, decision: "accept" });
    await entered.promise;
    await controller.shutdown();
    assert.equal((await review).ok, false);
    assert.deepEqual(events, []);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    const afterClose = await controller.resolveMemoryCandidate({ candidateId: "candidate", expectedCandidateRevision: 1, decision: "accept" });
    assert.equal(!afterClose.ok && afterClose.error.code, "MEMORY_CANDIDATE_CONFLICT");
  });

  it("reopens persisted candidates, accepts or rejects without Runs, and returns idempotent receipts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-candidates-"));
    const store = createMemoryStore(workspace);
    const batch = await store.commitCandidateBatch({
      batchId: "batch", originThreadId: "controller-thread", expectedCursor: null, nextCursor: null,
      candidates: ["Write concise reports", "Prefer practical steps"].map((text, index) => ({
        change: { operation: "add" as const, text, scope: { kind: "workspace" as const }, expiresAt: null },
        source: { kind: "conversation" as const, threadId: "controller-thread", messageId: `source-${index}`, quote: text },
        reason: "Explicit lasting preference",
      })),
    }, undefined, { boundThreadId: "controller-thread" });
    if (!batch.ok) throw new Error(batch.error.message);
    const first = createAssistantController(appWith({ workspaceRoot: workspace, memoryStore: store }));
    assert.equal((await first.listMemoryCandidates()).ok, true);
    await first.shutdown();
    const reopened = createAssistantController(appWith({ workspaceRoot: workspace, memoryStore: createMemoryStore(workspace) }));
    try {
      const page = await reopened.listMemoryCandidates();
      assert.equal(page.ok && page.value.candidates.length, 2);
      const [acceptId, rejectId] = batch.value.candidateIds;
      assert.ok(acceptId); assert.ok(rejectId);
      const preview = await reopened.getMemoryCandidate(acceptId);
      assert.equal(preview.ok && preview.value.applicable, true);
      const input = { candidateId: acceptId, expectedCandidateRevision: 1, decision: "accept" as const };
      const accepted = await reopened.resolveMemoryCandidate(input);
      assert.equal(accepted.ok && accepted.value.status, "accepted");
      const replay = await reopened.resolveMemoryCandidate(input);
      assert.equal(replay.ok && replay.value.replayed, true);
      assert.equal(replay.ok && accepted.ok && replay.value.memoryId, accepted.ok && accepted.value.memoryId);
      const rejected = await reopened.resolveMemoryCandidate({ candidateId: rejectId, expectedCandidateRevision: 1, decision: "reject" });
      assert.equal(rejected.ok && rejected.value.status, "rejected");
      const conflict = await reopened.resolveMemoryCandidate({ ...input, decision: "reject" });
      assert.equal(!conflict.ok && conflict.error.code, "MEMORY_CANDIDATE_CONFLICT");
      const memories = await store.list();
      assert.equal(memories.ok && memories.entries.length, 1);
      assert.deepEqual(await reopened.getHistory(), []);
      assert.deepEqual(await reopened.listRuns(), []);
      const foreign = createAssistantController(appWith({ workspaceRoot: workspace, memoryStore: store, threadId: "foreign-thread" }));
      try {
        const hidden = await foreign.getMemoryCandidate(acceptId);
        assert.equal(!hidden.ok && hidden.error.code, "MEMORY_CANDIDATE_NOT_FOUND");
      } finally { await foreign.shutdown(); }
    } finally {
      await reopened.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps the Run busy until candidates commit and notifies before its result", async () => {
    const gate = deferred<MemoryResult<{ candidateIds: string[]; replayed: boolean }>>();
    const began: string[] = [];
    const order: string[] = [];
    let discarded = 0;
    const app = appWith({
      memoryConsolidation: {
        begin: (agentId: string) => { began.push(agentId); },
        finalize: async () => gate.promise,
        discard: () => { discarded += 1; },
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: { run: async () => handle("primary", {
        promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined,
      }, () => undefined) } as unknown as RuntimeApp["runtime"],
    });
    const controller = createAssistantController(app);
    controller.subscribe((event) => {
      if (event.type === "memory-updated") order.push(event.reason);
      if (event.type === "run-result") order.push(event.phase);
    });
    try {
      assert.equal((await controller.run("Prepare proposals")).ok, true);
      assert.equal(controller.getSnapshot().state.kind, "running");
      assert.deepEqual(await controller.run("Competing request"), { ok: false, reason: "busy" });
      assert.deepEqual(order, []);
      gate.resolve({ ok: true, value: { candidateIds: ["candidate"], replayed: false } });
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.deepEqual(began, [PRIMARY_AGENT_ID]);
      assert.deepEqual(order, ["proposals", "primary"]);
      assert.equal(discarded, 1);
    } finally { await controller.shutdown(); }
  });

  it("runs the shared prepare-stage-finalize protocol and persists only pending proposals", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-protocol-"));
    const memoryStore = createMemoryStore(workspace);
    const messages = [{ id: "source", role: "user" as const, parts: [{ type: "text" as const, text: "I prefer concise reports." }] }];
    const memoryConsolidation = createMemoryConsolidation({
      store: memoryStore, threadId: "controller-thread", getMessages: async () => messages,
    });
    const controller = createAssistantController(appWith({
      workspaceRoot: workspace, memoryStore, memoryConsolidation,
      runtime: { run: async () => {
        const prepared = await memoryConsolidation.prepare({});
        if (!prepared.ok) throw new Error(prepared.error.message);
        const staged = await memoryConsolidation.stage({ batchId: prepared.value.batchId, proposals: [{
          action: "add", text: "Prefer concise reports", sourceMessageId: "source",
          sourceQuote: "I prefer concise reports.", reason: "Explicit preference", scope: { kind: "workspace" },
        }] });
        if (!staged.ok) throw new Error(staged.error.message);
        const before = await memoryStore.listCandidates({}, undefined, { boundThreadId: "controller-thread" });
        assert.equal(before.ok && before.value.candidates.length, 0);
        return {
          ...handle("primary", { promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined }, () => undefined),
          events: (async function* (): AsyncGenerator<AgentEvent> {
            for (const [index, toolName] of ["memory_prepare_consolidation", "memory_stage_candidates"].entries()) {
              yield {
                id: `request-${index}`, type: "tool.call.requested", runId: "primary", threadId: "controller-thread",
                sequence: index + 1, occurredAt: "2026-10-01T00:00:00.000Z",
                data: { toolCallId: `call-${index}`, toolName, input: {} },
              };
            }
          })(),
        };
      } } as unknown as RuntimeApp["runtime"],
    }));
    try {
      assert.equal((await controller.run("Prepare candidates")).ok, true);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      const after = await controller.listMemoryCandidates();
      assert.equal(after.ok && after.value.candidates.length, 1);
      assert.equal(after.ok && after.value.candidates[0]?.status, "pending");
      const entries = await memoryStore.list();
      assert.equal(entries.ok && entries.entries.length, 0);
    } finally {
      await controller.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("reports a failed candidate commit without turning a completed primary Run into failure", async () => {
    const events: string[] = [];
    const controller = createAssistantController(appWith({
      memoryConsolidation: {
        begin: () => undefined,
        finalize: async () => ({ ok: false, error: { code: "WRITE_FAILED", message: "disk failed" } }),
        discard: () => undefined,
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: { run: async () => handle("primary", {
        promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined,
      }, () => undefined) } as unknown as RuntimeApp["runtime"],
    }));
    controller.subscribe((event) => { if (event.type === "error") events.push(event.message); });
    try {
      await controller.run("Prepare proposals");
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
      assert.match(events[0] ?? "", /不能当作已经记住.*旧记忆仍保留/);
      assert.doesNotMatch(events[0] ?? "", /WRITE_FAILED|disk failed|Memory consolidation/);
    } finally { await controller.shutdown(); }
  });

  it("shows a persisted oversized-memory disposition in plain language without replay duplication", async () => {
    for (const replayed of [false, true]) {
      const outputs: string[] = [];
      const warnings: string[] = [];
      const controller = createAssistantController(appWith({
        memoryConsolidation: {
          begin: () => undefined, discard: () => undefined,
          finalize: async () => ({ ok: true, value: { candidateIds: [], replayed, processedCount: 1,
            outcomes: [{ messageId: "source", status: "not_saved", reason: "too_large" }] } }),
        } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
        runtime: { run: async () => handle("primary", {
          promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined,
        }, () => undefined) } as unknown as RuntimeApp["runtime"],
      }));
      controller.subscribe(event => {
        if (event.type === "output") outputs.push(event.text);
        if (event.type === "error") warnings.push(event.message);
      });
      try {
        await controller.run("记住这段很长的偏好");
        await waitFor(() => controller.getSnapshot().state.kind === "idle");
        if (replayed) { assert.equal(outputs.length, 0); assert.equal(warnings.length, 0); }
        else {
          assert.match(outputs.join(""), /没保存.*内容太长.*分段/);
          assert.doesNotMatch(outputs.join(""), /已记住|source|too_large/);
          assert.match(warnings.join(""), /没保存.*内容太长.*分段/, "normal UI receives the warning without opening diagnostic output");
        }
      } finally { await controller.shutdown(); }
    }
  });

  it("shows persisted retry exhaustion without reporting it as too-large or silently complete", async () => {
    const warnings: string[] = [];
    const controller = createAssistantController(appWith({
      memoryConsolidation: {
        begin: () => undefined, discard: () => undefined,
        finalize: async () => ({ ok: true, value: { candidateIds: [], replayed: false, processedCount: 1,
          outcomes: [{ messageId: "source", status: "not_saved", reason: "retry_exhausted", attempts: 3 }] } }),
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: { run: async () => handle("primary", {
        promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined,
      }, () => undefined) } as unknown as RuntimeApp["runtime"],
    }));
    controller.subscribe(event => { if (event.type === "error") warnings.push(event.message); });
    try {
      await controller.run("记住我的偏好");
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /剩余记忆没保存.*3 次.*原话仍保留/);
      assert.doesNotMatch(warnings[0]!, /内容太长|已记住|MEMORY_RETRY/);
    } finally { await controller.shutdown(); }
  });

  it("does not start the automatic model when the pending candidate queue is full", async () => {
    let runs = 0;
    const controller = createAssistantController(appWith({
      autoConsolidationAgentId: "memory-consolidator",
      memoryConsolidation: {
        begin: () => undefined,
        finalize: async () => ({ ok: true, value: { candidateIds: [], replayed: false } }),
        discard: () => undefined,
        canStart: async () => ({ ok: true, value: { canStart: false, pendingCount: 64 } }),
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: { run: async () => {
        runs += 1;
        return handle("primary", { promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined }, () => undefined);
      } } as unknown as RuntimeApp["runtime"],
    }));
    try {
      await controller.run("A lasting preference");
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.equal(runs, 1);
      assert.match(controller.getSnapshot().recentOutput, /candidate queue is full/);
    } finally { await controller.shutdown(); }
  });

  it("counts rejected prepare and stage requests so schema failures cannot bypass the batch protocol", async () => {
    let observed: { prepare: number; stage: number } | undefined;
    const controller = createAssistantController(appWith({
      memoryConsolidation: {
        begin: () => undefined, discard: () => undefined,
        finalize: async (completed: { consolidationAttempts?: { prepare: number; stage: number } }) => {
          observed = completed.consolidationAttempts;
          return { ok: false, error: { code: "MEMORY_BATCH_INVALID", message: "Second stage request is invalid" } };
        },
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: { run: async () => ({
        ...handle("primary", { promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined }, () => undefined),
        events: (async function* (): AsyncGenerator<AgentEvent> {
          for (const [index, toolName] of ["memory_prepare_consolidation", "memory_stage_candidates", "memory_stage_candidates"].entries()) {
            yield {
              id: `requested-${index}`, type: "tool.call.requested", runId: "primary", threadId: "controller-thread",
              sequence: index + 1, occurredAt: "2026-10-01T00:00:00.000Z",
              data: { toolCallId: `call-${index}`, toolName, input: index === 2 ? { invalid: true } : {} },
            };
          }
        })(),
      }) } as unknown as RuntimeApp["runtime"],
    }));
    try {
      await controller.run("Propose memory");
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.deepEqual(observed, { prepare: 1, stage: 2 });
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    } finally { await controller.shutdown(); }
  });
});

describe("AssistantController", () => {
  it("records a real pending confirmation once and restores its timestamp after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-controller-trace-"));
    try {
      const controller = createAssistantController(await createRuntimeApp({
        args: ["--tui", directory, "--thread", "trace-confirmation"], modelAlias: "mock", model: createDemoModel(),
        output: new PassThrough(), env: {}, cwd: directory,
      }));
      try {
        assert.ok((await controller.run("What is 20 + 22?")).ok);
        await waitFor(() => controller.getSnapshot().pendingApproval !== null);
        const pending = controller.getSnapshot().pendingApproval!;
        assert.equal(pending.toolName, "add");
        assert.equal(controller.confirm({ approvalId: pending.approvalId, decision: "allow" }), true);
        await waitFor(() => controller.getSnapshot().state.kind === "idle");
        const record = (await controller.listRuns())[0]!;
        assert.ok(record.tools[0]?.approvalRequestedAt);
        assert.equal(record.tools[0]?.status, "completed");
        const reopened = await createExecutionRecordStore(directory).getRun("trace-confirmation", record.runId);
        assert.equal(reopened?.tools[0]?.approvalRequestedAt, record.tools[0]?.approvalRequestedAt);
      } finally { await controller.shutdown(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("persists WorkTask memory exclusion across restart without excluding later ordinary chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-task-memory-exclusion-"));
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace: root,
      modules: { memory: { enabled: true, autoConsolidate: true } } }));
    const open = async () => {
      const instance = createAssistantController(await createRuntimeApp({
        args: ["--tui", join(root, "transcripts"), "--thread", "task-memory", "--config", config],
        modelAlias: "mock", model: createDemoModel(), output: new PassThrough(), env: {}, cwd: root,
      }));
      instance.subscribe(event => {
        if (event.type === "approval") instance.confirm({ approvalId: event.approval.approvalId, decision: "deny" });
      });
      return instance;
    };
    let controller = await open();
    try {
      const task = await controller.createWorkTask({ goal: "This plan needs Goal, Checks, Next sections",
        constraints: [], acceptance: [{ id: "quality", description: "Review plan", method: "human",
          verification: { kind: "human" }, required: true }] });
      assert.ok(task.ok);
      assert.ok((await controller.runWorkTask({ id: task.value.id, expectedRevision: task.value.revision, completionCheck: false })).ok);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
      await controller.shutdown();
      controller = await open();
      const history = await controller.getHistory();
      const instruction = history.find(message => message.role === "user");
      assert.equal((instruction?.metadata as Record<string, unknown>).memoryConsolidation, "exclude");
      assert.equal(typeof (instruction?.metadata as Record<string, unknown>).sentAt, "string");
      assert.equal((await controller.listRuns()).length, 1, "no automatic consolidation Run for task instruction");
      assert.ok((await controller.run("我的长期写作偏好是先结论后步骤", { memoryConsolidation: "exclude" })).ok);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      // No opt-out is inherited by subsequent ordinary user messages.
      assert.ok((await controller.run("Ordinary chat stays eligible")).ok);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      const latest = (await controller.getHistory()).find(message => message.role === "user"
        && message.parts.some(part => part.type === "text" && part.text === "Ordinary chat stays eligible"));
      assert.equal((latest?.metadata as Record<string, unknown>).memoryConsolidation, undefined);
      assert.ok((await controller.listRuns()).some(run => run.phase === "consolidation"));
    } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("drives the assembled Runtime and commits a demo turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-controller-app-"));
    try {
      const app = await createRuntimeApp({
        args: [directory], modelAlias: "mock", model: createDemoModel(),
        output: new PassThrough(), env: {}, cwd: directory,
      });
      const controller = createAssistantController(app);
      try {
        const started = await controller.run("What is 20 + 22?");
        assert.equal(started.ok, true);
        // Real receipt/trace flock writes under the full parallel test suite.
        await waitFor(() => controller.getSnapshot().state.kind === "idle", 5_000);
        assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
        assert.equal((await controller.getHistory())[0]?.role, "user");
        const recorded = await controller.listRuns();
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0]?.status, "completed");
        assert.equal(recorded[0]?.tools[0]?.status, "completed");
        assert.ok(recorded[0]?.trace?.events.some(event => event.type === "step.started"));
        assert.ok(recorded[0]?.trace?.events.some(event => event.type === "step.completed"));
      } finally {
        await controller.shutdown();
      }
      const reopened = createAssistantController(await createRuntimeApp({
        args: [directory], modelAlias: "mock", model: createDemoModel(),
        output: new PassThrough(), env: {}, cwd: directory,
      }));
      try {
        assert.equal((await reopened.listRuns())[0]?.status, "completed");
        assert.ok((await reopened.listRuns())[0]?.trace?.events.some(event => event.type === "step.completed"));
      } finally {
        await reopened.shutdown();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed before model execution when recovery records are corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-controller-bad-record-"));
    const file = join(directory, EXECUTION_RECORD_FILE);
    await writeFile(file, "{broken");
    const app = await createRuntimeApp({
      args: [directory], modelAlias: "mock", model: createDemoModel(),
      output: new PassThrough(), env: {}, cwd: directory,
    });
    const controller = createAssistantController(app);
    try {
      assert.deepEqual(await controller.run("What is 20 + 22?"), { ok: false, reason: "starting" });
      assert.deepEqual(await controller.getHistory(), []);
      assert.equal(await readFile(file, "utf8"), "{broken");
    } finally {
      await controller.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not recover a WorkTask Thread already owned through another transcript directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-work-owner-"));
    const firstTranscripts = await mkdtemp(join(tmpdir(), "runloom-controller-work-owner-a-"));
    const secondTranscripts = await mkdtemp(join(tmpdir(), "runloom-controller-work-owner-b-"));
    const app = (directory: string): RuntimeApp => appWith({
      directory,
      workspaceRoot: workspace,
      workTasks: createWorkTaskStore(workspace),
      executionRecords: createExecutionRecordStore(directory),
    });
    const first = createAssistantController(app(firstTranscripts));
    assert.deepEqual(await first.listWorkTasks(), { ok: true, value: [] });
    const second = createAssistantController(app(secondTranscripts));
    try {
      const blocked = await second.listWorkTasks();
      assert.equal(blocked.ok, false);
      assert.equal(!blocked.ok && blocked.error.code, "WORK_TASK_INVALID_STATE");
      assert.match(!blocked.ok ? blocked.error.message : "", /already controlled/);
    } finally {
      await second.shutdown();
      await first.shutdown();
    }

    const reopened = createAssistantController(app(secondTranscripts));
    try {
      assert.deepEqual(await reopened.listWorkTasks(), { ok: true, value: [] });
    } finally {
      await reopened.shutdown();
      await rm(workspace, { recursive: true, force: true });
      await rm(firstTranscripts, { recursive: true, force: true });
      await rm(secondTranscripts, { recursive: true, force: true });
    }
  });

  it("keeps WorkTask completion separate from a successful Run", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-work-task-"));
    const transcripts = await mkdtemp(join(tmpdir(), "runloom-controller-work-task-records-"));
    const workTasks = createWorkTaskStore(workspace, { generateId: () => "task-1" });
    const executionRecords = createExecutionRecordStore(transcripts);
    let boundTask: { id: string; expectedRevision: number } | undefined;
    const requestedAgents: string[] = [];
    const app = appWith({
      directory: transcripts,
      workspaceRoot: workspace,
      workTasks,
      executionRecords,
      autoConsolidationAgentId: "memory-consolidator",
      bindNextExecutionWorkTask: (input) => {
        boundTask = input;
        return () => { boundTask = undefined; };
      },
      runtime: {
        run: async (request: { agentId: string; messages: Array<{ metadata?: unknown }> }) => {
          requestedAgents.push(request.agentId);
          assert.equal(request.agentId, PRIMARY_AGENT_ID);
          assert.equal((request.messages[0]?.metadata as Record<string, unknown>).memoryConsolidation, "exclude");
          assert.ok(boundTask);
          const begun = await workTasks.beginRun(boundTask.id, {
            expectedRevision: boundTask.expectedRevision, runId: "work-run-1",
          });
          assert.equal(begun.ok, true);
          await executionRecords.startRun({
            runId: "work-run-1", threadId: "controller-thread", phase: "primary",
            workTaskId: boundTask.id,
          });
          return handle("work-run-1", {
            promise: Promise.resolve(result("work-run-1", "completed")),
            resolve: () => undefined,
          }, () => undefined);
        },
      } as unknown as RuntimeApp["runtime"],
    });
    const controller = createAssistantController(app);
    try {
      const created = await controller.createWorkTask({
        goal: "Prepare a reviewed answer", constraints: ["Do not claim user acceptance"],
        acceptance: [{ id: "quality", description: "User accepts quality", method: "human",
          verification: { kind: "human" }, required: true }],
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.deepEqual(await controller.runWorkTask({ id: created.value.id, expectedRevision: 1 }),
        { ok: true, runId: "work-run-1" });
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.deepEqual(requestedAgents, [PRIMARY_AGENT_ID], "task instructions must not trigger automatic consolidation");
      const paused = await controller.getWorkTask(created.value.id);
      assert.equal(paused.ok && paused.value.status, "paused");
      assert.equal(paused.ok && paused.value.runIds[0], "work-run-1");
      assert.equal((await controller.getRun("work-run-1"))?.workTaskId, "task-1");
      if (!paused.ok) return;
      const delivered = await controller.submitWorkTaskDelivery({
        id: paused.value.id, expectedRevision: paused.value.revision, summary: "Answer prepared",
      });
      assert.equal(delivered.ok && delivered.value.status, "awaiting_acceptance");
      if (!delivered.ok) return;
      const accepted = await controller.recordHumanAcceptance({
        id: delivered.value.id, expectedRevision: delivered.value.revision,
        criterionId: "quality", decision: "passed",
      });
      assert.equal(accepted.ok && accepted.value.status, "completed");
    } finally {
      await controller.shutdown();
      await rm(workspace, { recursive: true, force: true });
      await rm(transcripts, { recursive: true, force: true });
    }
  });

  it("recovers an unknown task Run for explicit reconciliation without replay", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-reconcile-"));
    const transcripts = await mkdtemp(join(tmpdir(), "runloom-controller-reconcile-records-"));
    const executionRecords = createExecutionRecordStore(transcripts);
    const workTasks = createWorkTaskStore(workspace, {
      generateId: (() => {
        const ids = ["task-review", "reconciliation-1"];
        return () => ids.shift() ?? "unexpected-id";
      })(),
      executionRecords,
    });
    let modelRuns = 0;
    try {
      const created = await workTasks.create({
        threadId: "controller-thread", goal: "Resume safely", constraints: [],
        acceptance: [{ id: "review", description: "User accepts", method: "human",
          verification: { kind: "human" }, required: true }],
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal((await workTasks.beginRun(created.value.id, { expectedRevision: 1, runId: "run-unknown" })).ok, true);
      await executionRecords.startRun({
        runId: "run-unknown", threadId: "controller-thread", workTaskId: created.value.id, phase: "primary",
      });
      await executionRecords.recordToolEvent("run-unknown", {
        id: "event-requested", type: "tool.call.requested", runId: "run-unknown",
        threadId: "controller-thread", sequence: 1, occurredAt: "2026-09-30T00:00:00.000Z",
        data: { toolCallId: "write-unknown", toolName: "write_file", input: { path: "report.md", content: "x" } },
      });
      await executionRecords.recordToolEvent("run-unknown", {
        id: "event-started", type: "tool.call.started", runId: "run-unknown",
        threadId: "controller-thread", sequence: 2, occurredAt: "2026-09-30T00:00:01.000Z",
        data: { toolCallId: "write-unknown", toolName: "write_file" },
      });

      const controller = createAssistantController(appWith({
        directory: transcripts, workspaceRoot: workspace, workTasks, executionRecords,
        runtime: { run: async () => { modelRuns += 1; throw new Error("must not run"); } } as unknown as RuntimeApp["runtime"],
      }));
      try {
        const recovered = await controller.getWorkTask(created.value.id);
        assert.equal(recovered.ok && recovered.value.status, "needs_review");
        if (!recovered.ok) return;
        const bypass = await controller.cancelWorkTask({
          id: recovered.value.id, expectedRevision: recovered.value.revision,
        });
        assert.equal(bypass.ok, false);
        assert.equal(!bypass.ok && bypass.error.code, "WORK_TASK_INVALID_STATE");
        const unresolved = await controller.reconcileWorkTask({
          id: recovered.value.id, expectedRevision: recovered.value.revision,
          observedOutcome: "still_unknown", decision: "continue", note: "Outcome is still unclear.",
        });
        assert.equal(unresolved.ok, false);
        const reconciled = await controller.reconcileWorkTask({
          id: recovered.value.id, expectedRevision: recovered.value.revision,
          observedOutcome: "not_applied", decision: "continue", note: "The target file was checked and was not created.",
        });
        assert.equal(reconciled.ok && reconciled.value.status, "paused");
        assert.equal(reconciled.ok && reconciled.value.reconciliations[0]?.runId, "run-unknown");
        assert.equal(modelRuns, 0);
      } finally {
        await controller.shutdown();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(transcripts, { recursive: true, force: true });
    }
  });

  it("accepts an automatic Shell criterion only from this task's exact zero-exit receipt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-work-shell-"));
    const transcripts = await mkdtemp(join(tmpdir(), "runloom-controller-work-shell-records-"));
    const executionRecords = createExecutionRecordStore(transcripts);
    const workTasks = createWorkTaskStore(workspace, { generateId: () => "task-shell", executionRecords });
    const command = "pnpm test --filter focused";
    try {
      const created = await workTasks.create({
        threadId: "controller-thread", goal: "Run the focused check", constraints: [],
        acceptance: [{ id: "check", description: "Focused test passes", method: "automatic",
          verification: { kind: "shell_exit_zero", command, cwd: "." }, required: true }],
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal((await workTasks.beginRun(created.value.id, { expectedRevision: 1, runId: "run-old-unknown" })).ok, true);
      await executionRecords.startRun({
        runId: "run-old-unknown", threadId: "controller-thread", workTaskId: created.value.id, phase: "primary",
      });
      await executionRecords.recordToolEvent("run-old-unknown", {
        id: "event-old-requested", type: "tool.call.requested", runId: "run-old-unknown",
        threadId: "controller-thread", sequence: 1, occurredAt: "2026-09-30T00:00:00.000Z",
        data: { toolCallId: "old-shell", toolName: "shell_exec", input: { command } },
      });
      await executionRecords.recordToolEvent("run-old-unknown", {
        id: "event-old-started", type: "tool.call.started", runId: "run-old-unknown",
        threadId: "controller-thread", sequence: 2, occurredAt: "2026-09-30T00:00:01.000Z",
        data: { toolCallId: "old-shell", toolName: "shell_exec" },
      });
      await executionRecords.recoverInterrupted("controller-thread");
      assert.equal((await workTasks.markNeedsReview(created.value.id, 2)).ok, true);
      assert.equal((await workTasks.reconcile(created.value.id, {
        expectedRevision: 3, observedOutcome: "not_applied", decision: "continue",
        note: "The prior command did not apply.",
      })).ok, true);
      assert.equal((await workTasks.beginRun(created.value.id, { expectedRevision: 4, runId: "run-shell" })).ok, true);
      assert.equal((await workTasks.pause(created.value.id, 5)).ok, true);
      await executionRecords.startRun({
        runId: "run-shell", threadId: "controller-thread", workTaskId: created.value.id, phase: "primary",
      });
      await executionRecords.recordToolEvent("run-shell", {
        id: "event-shell-requested", type: "tool.call.requested", runId: "run-shell",
        threadId: "controller-thread", sequence: 1, occurredAt: "2026-09-30T00:00:00.000Z",
        data: { toolCallId: "shell-1", toolName: "shell_exec", input: { command } },
      });
      await executionRecords.recordToolEvent("run-shell", {
        id: "event-shell-started", type: "tool.call.started", runId: "run-shell",
        threadId: "controller-thread", sequence: 2, occurredAt: "2026-09-30T00:00:01.000Z",
        data: { toolCallId: "shell-1", toolName: "shell_exec" },
      });
      await executionRecords.recordToolEvent("run-shell", {
        id: "event-shell-completed", type: "tool.call.completed", runId: "run-shell",
        threadId: "controller-thread", sequence: 3, occurredAt: "2026-09-30T00:00:02.000Z",
        data: { toolCallId: "shell-1", toolName: "shell_exec",
          output: { ok: true, exitCode: 0, timedOut: false, cancelled: false, output: "pass" } },
      });
      await executionRecords.finishRun("run-shell", result("run-shell", "completed"));

      const controller = createAssistantController(appWith({
        directory: transcripts, workspaceRoot: workspace, workTasks, executionRecords,
      }));
      try {
        const delivered = await controller.submitWorkTaskDelivery({
          id: created.value.id, expectedRevision: 6, summary: "Focused check completed",
        });
        assert.equal(delivered.ok && delivered.value.status, "completed");
        assert.equal(delivered.ok && delivered.value.acceptance[0]?.status, "passed");
        assert.equal(delivered.ok && delivered.value.delivery?.evidence[0]?.kind, "tool");
      } finally {
        await controller.shutdown();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(transcripts, { recursive: true, force: true });
    }
  });

  it("does not accept a pre-existing artifact without this task's successful write receipt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-work-artifact-"));
    const transcripts = await mkdtemp(join(tmpdir(), "runloom-controller-work-artifact-records-"));
    const executionRecords = createExecutionRecordStore(transcripts);
    const workTasks = createWorkTaskStore(workspace, { generateId: () => "task-artifact", executionRecords });
    await writeFile(join(workspace, "report.md"), "verified report\n");
    try {
      const created = await workTasks.create({
        threadId: "controller-thread", goal: "Write the report", constraints: [],
        acceptance: [{ id: "artifact", description: "Report exists", method: "automatic",
          verification: { kind: "artifact_exists", path: "report.md" }, required: true }],
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal((await workTasks.beginRun(created.value.id, { expectedRevision: 1, runId: "run-artifact" })).ok, true);
      assert.equal((await workTasks.pause(created.value.id, 2)).ok, true);
      await executionRecords.startRun({
        runId: "run-artifact", threadId: "controller-thread", workTaskId: created.value.id, phase: "primary",
      });
      await executionRecords.finishRun("run-artifact", result("run-artifact", "completed"));

      const controller = createAssistantController(appWith({
        directory: transcripts, workspaceRoot: workspace, workTasks, executionRecords,
      }));
      try {
        const delivered = await controller.submitWorkTaskDelivery({
          id: created.value.id, expectedRevision: 3, summary: "Report ready", artifactRefs: ["report.md"],
        });
        assert.equal(delivered.ok && delivered.value.status, "awaiting_acceptance");
        assert.equal(delivered.ok && delivered.value.acceptance[0]?.status, "failed");
        assert.equal(delivered.ok && delivered.value.delivery?.evidence.length, 0);
      } finally {
        await controller.shutdown();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(transcripts, { recursive: true, force: true });
    }
  });

  it("snapshots a verified artifact only after a successful task-owned write receipt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runloom-controller-work-written-artifact-"));
    const transcripts = await mkdtemp(join(tmpdir(), "runloom-controller-work-written-artifact-records-"));
    const executionRecords = createExecutionRecordStore(transcripts);
    const workTasks = createWorkTaskStore(workspace, { generateId: () => "task-written-artifact", executionRecords });
    await writeFile(join(workspace, "report.md"), "verified report\n");
    try {
      const created = await workTasks.create({
        threadId: "controller-thread", goal: "Write the report", constraints: [],
        acceptance: [{ id: "artifact", description: "Report exists", method: "automatic",
          verification: { kind: "artifact_exists", path: "report.md" }, required: true }],
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal((await workTasks.beginRun(created.value.id, { expectedRevision: 1, runId: "run-written-artifact" })).ok, true);
      assert.equal((await workTasks.pause(created.value.id, 2)).ok, true);
      await executionRecords.startRun({
        runId: "run-written-artifact", threadId: "controller-thread",
        workTaskId: created.value.id, phase: "primary",
      });
      await executionRecords.recordToolEvent("run-written-artifact", {
        id: "event-write-requested", type: "tool.call.requested", runId: "run-written-artifact",
        threadId: "controller-thread", sequence: 1, occurredAt: "2026-09-30T00:00:00.000Z",
        data: { toolCallId: "write-1", toolName: "write_file", input: { path: "report.md", content: "verified report\n" } },
      });
      await executionRecords.recordToolEvent("run-written-artifact", {
        id: "event-write-started", type: "tool.call.started", runId: "run-written-artifact",
        threadId: "controller-thread", sequence: 2, occurredAt: "2026-09-30T00:00:01.000Z",
        data: { toolCallId: "write-1", toolName: "write_file" },
      });
      await executionRecords.recordToolEvent("run-written-artifact", {
        id: "event-write-completed", type: "tool.call.completed", runId: "run-written-artifact",
        threadId: "controller-thread", sequence: 3, occurredAt: "2026-09-30T00:00:02.000Z",
        data: { toolCallId: "write-1", toolName: "write_file", output: { ok: true, path: "report.md" } },
      });
      await executionRecords.finishRun("run-written-artifact", result("run-written-artifact", "completed"));

      const controller = createAssistantController(appWith({
        directory: transcripts, workspaceRoot: workspace, workTasks, executionRecords,
      }));
      try {
        const delivered = await controller.submitWorkTaskDelivery({
          id: created.value.id, expectedRevision: 3, summary: "Report ready", artifactRefs: ["report.md"],
        });
        assert.equal(delivered.ok && delivered.value.status, "completed");
        const evidence = delivered.ok ? delivered.value.delivery?.evidence[0] : undefined;
        assert.equal(evidence?.kind, "artifact");
        if (evidence?.kind === "artifact") {
          assert.equal(evidence.path, "report.md");
          assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
        }
      } finally {
        await controller.shutdown();
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(transcripts, { recursive: true, force: true });
    }
  });

  it("cancels a Run requested during startup once its handle arrives", async () => {
    const starting = deferred<RunHandle>();
    const finished = deferred<RunResult>();
    let cancelled = 0;
    let disposed = 0;
    const app = appWith({
      runtime: { run: async () => starting.promise } as unknown as RuntimeApp["runtime"],
      dispose: () => { disposed += 1; },
    });
    const controller = createAssistantController(app);

    const startingRun = controller.run("Do the task");
    await waitFor(() => controller.getSnapshot().state.kind !== "idle");
    const cancellation = controller.cancel();
    starting.resolve(handle("run-1", finished, () => { cancelled += 1; }));
    await Promise.all([startingRun, cancellation]);
    await waitFor(() => controller.getSnapshot().state.kind === "idle");

    assert.equal(cancelled, 1);
    await controller.shutdown();
    assert.equal(disposed, 1);
  });

  it("keeps an asynchronous command busy until it settles", async () => {
    const commandFinished = deferred<void>();
    let calls = 0;
    const app = appWith({
      commands: new Map([
        ["slow", { execute: async () => { calls += 1; await commandFinished.promise; } }],
      ]),
    });
    const controller = createAssistantController(app);

    const command = controller.command("/slow");
    await waitFor(() => controller.getSnapshot().state.kind === "command");
    const attemptedRun = await controller.run("This must not start while the command is active");
    assert.deepEqual(attemptedRun, { ok: false, reason: "busy" });
    assert.equal(calls, 1);
    commandFinished.resolve();
    await command;
    assert.equal(controller.getSnapshot().state.kind, "idle");
    await controller.shutdown();
  });

  it("restores the pending approval in a snapshot and rejects a stale approval ID", async () => {
    const approval: PendingToolApproval = {
      approvalId: "approval-2",
      toolCallId: "call-2",
      toolName: "write_file",
      input: { path: "report.md" },
      preview: "Write report.md?",
    };
    let pending: PendingToolApproval | undefined = approval;
    let listener: ((next: PendingToolApproval | undefined) => void) | undefined;
    const resolved: string[] = [];
    const app = appWith({
      toolConfirmation: {
        getPending: () => pending,
        resolveApproval: ({ approvalId }: { approvalId: string }) => {
          if (pending?.approvalId !== approvalId) return false;
          resolved.push(approvalId);
          pending = undefined;
          listener?.(undefined);
          return true;
        },
        subscribePending: (next: (approval: PendingToolApproval | undefined) => void) => {
          listener = next;
          return () => { listener = undefined; };
        },
      } as unknown as RuntimeApp["toolConfirmation"],
    });
    const controller = createAssistantController(app);
    assert.deepEqual(controller.getSnapshot().pendingApproval, approval);
    assert.equal(controller.confirm({ approvalId: "approval-1", decision: "allow" }), false);
    assert.deepEqual(resolved, []);
    assert.deepEqual(controller.getSnapshot().pendingApproval, approval);
    assert.equal(controller.confirm({ approvalId: "approval-2", decision: "allow" }), true);
    assert.deepEqual(resolved, ["approval-2"]);
    assert.equal(controller.getSnapshot().pendingApproval, null);
    await controller.shutdown();
  });

  it("exposes a pending approval before its asynchronous preview resolves", async () => {
    const preview = deferred<string | undefined>();
    const confirmation = createToolConfirmation(new PassThrough(), {
      prompt: () => preview.promise,
      generateId: () => "approval-async",
    });
    const controller = createAssistantController(appWith({ toolConfirmation: confirmation }));
    const previews: Array<string | null> = [];
    controller.subscribe((event) => {
      if (event.type === "approval") previews.push(event.approval.preview);
    });

    const decision = confirmation.beforeToolExecute({
      toolName: "task_reschedule",
      toolCallId: "call-async",
      input: { id: "task-1", runAt: "2026-10-01T00:00:00.000Z" },
      definition: { id: PRIMARY_AGENT_ID } as AgentDefinition,
      signal: new AbortController().signal,
    });

    // The approval is visible immediately, before the preview text exists.
    const early = controller.getSnapshot().pendingApproval;
    assert.equal(early?.approvalId, "approval-async");
    assert.equal(early?.toolName, "task_reschedule");
    assert.equal(early?.preview, "");

    preview.resolve("Reschedule task-1 to 2026-10-01?");
    await waitFor(() => controller.getSnapshot().pendingApproval?.preview !== "");
    assert.match(controller.getSnapshot().pendingApproval?.preview ?? "", /Reschedule task-1/);
    assert.deepEqual(previews, ["", "Reschedule task-1 to 2026-10-01?"]);

    assert.equal(controller.confirm({ approvalId: "approval-async", decision: "deny" }), true);
    assert.deepEqual(await decision, { allow: false, reason: "User denied this tool call" });
    assert.equal(controller.getSnapshot().pendingApproval, null);
    await controller.shutdown();
  });

  it("reports a failed command in its response instead of ok", async () => {
    const controller = createAssistantController(appWith({
      commands: new Map([
        ["boom", { execute: async () => { throw new Error("exploded"); } }],
      ]),
    }));
    const errors: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "error") errors.push(event.message);
    });

    assert.deepEqual(await controller.command("/boom"), {
      ok: false,
      reason: "failed",
      message: "Error: exploded",
    });
    assert.deepEqual(errors, ["Error: exploded"]);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    await controller.shutdown();
  });

  it("reports a cancelled compaction instead of ok", async () => {
    const gate = deferred<void>();
    const controller = createAssistantController(appWith({
      compaction: {
        compact: async () => {
          await gate.promise;
          return { message: "unused" };
        },
      },
    }));

    const command = controller.command("/compact");
    await waitFor(() => controller.getSnapshot().state.kind === "compacting");
    await controller.cancel();
    gate.resolve();
    assert.deepEqual(await command, { ok: false, reason: "cancelled" });
    assert.equal(controller.getSnapshot().state.kind, "idle");
    assert.equal(controller.getSnapshot().recentOutput.includes("[compact]"), false);
    await controller.shutdown();
  });

  it("labels primary and consolidation results separately and cancels consolidation", async () => {
    const consolidationFinished = deferred<RunResult>();
    const agentIds: string[] = [];
    const phases: string[] = [];
    let consolidationCancelled = 0;
    let resumeBegins = 0;
    let resumeEnds = 0;
    const app = appWith({
      autoConsolidationAgentId: "memory-consolidator",
      memoryConsolidation: {
        begin: () => undefined, discard: () => undefined,
        canStart: async () => ({ ok: true, value: { canStart: true, pendingCount: 0 } }),
        finalize: async () => ({ ok: true, value: { candidateIds: [], replayed: false } }),
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: {
        run: async (request: { agentId: string }) => {
          agentIds.push(request.agentId);
          if (request.agentId === PRIMARY_AGENT_ID) {
            return handle("primary-run", {
              promise: Promise.resolve(result("primary-run", "completed")),
              resolve: () => undefined,
            }, () => undefined);
          }
          return handle("consolidation-run", consolidationFinished, () => { consolidationCancelled += 1; });
        },
      } as unknown as RuntimeApp["runtime"],
      resume: {
        beginRun: () => { resumeBegins += 1; },
        endRun: () => { resumeEnds += 1; },
        clear: () => undefined,
        inspect: async () => "unused",
      },
    });
    const controller = createAssistantController(app);
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === "run-result") phases.push(event.phase);
    });

    assert.deepEqual(await controller.run("Summarize the plan"), { ok: true, runId: "primary-run" });
    await waitFor(() => {
      const state = controller.getSnapshot().state;
      return state.kind === "running" && state.phase === "consolidation";
    });
    assert.equal(controller.getSnapshot().state.kind, "running");
    await controller.cancel();
    await waitFor(() => controller.getSnapshot().state.kind === "idle");

    assert.deepEqual(agentIds, [PRIMARY_AGENT_ID, "memory-consolidator"]);
    assert.deepEqual(phases, ["primary", "consolidation"]);
    assert.equal(consolidationCancelled, 1);
    assert.equal(resumeBegins, 1);
    assert.equal(resumeEnds, 1);
    unsubscribe();
    await controller.shutdown();
  });

  it("accepts ordinary chat during background consolidation but waits for cancellation and finalization", async () => {
    const background = deferred<RunResult>();
    const cancellationRequested = deferred<void>();
    const finalizing = deferred<void>();
    const calls: string[] = [];
    let finalizationAborted = false;
    const controller = createAssistantController(appWith({
      autoConsolidationAgentId: "memory-consolidator",
      memoryConsolidation: {
        begin: () => undefined, discard: () => undefined,
        canStart: async () => ({ ok: true, value: { canStart: true, pendingCount: 0 } }),
        finalize: async (value: { status: string }, signal?: AbortSignal) => {
          if (value.status === "cancelled") {
            finalizationAborted = signal?.aborted === true;
            await finalizing.promise;
          }
          return { ok: true, value: { candidateIds: [], replayed: false } };
        },
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: {
        run: async (request: { agentId: string }) => {
          calls.push(request.agentId);
          if (request.agentId === "memory-consolidator") return {
            runId: "background", events: (async function* () {})(), result: background.promise,
            cancel: async () => { cancellationRequested.resolve(); },
          };
          return handle(`primary-${calls.length}`, { promise: Promise.resolve(result(`primary-${calls.length}`, "completed")), resolve: () => undefined }, () => undefined);
        },
      } as unknown as RuntimeApp["runtime"],
    }));
    try {
      await controller.run("I prefer concise summaries");
      await waitFor(() => calls.length === 2);
      assert.equal(controller.getSnapshot().canSubmit, true);
      assert.equal((await controller.command("/home")).ok, false, "non-chat operations still require idle");
      const next = controller.run("Continue our conversation", { memoryConsolidation: "exclude" });
      await cancellationRequested.promise;
      assert.equal(controller.getSnapshot().canSubmit, false, "foreground reservation prevents a second submit");
      assert.deepEqual(await controller.run("Do not queue me"), { ok: false, reason: "busy" });
      assert.equal(calls.length, 2, "no overlapping Run while cancellation is pending");
      background.resolve(result("background", "cancelled"));
      await waitFor(() => finalizationAborted);
      assert.equal(calls.length, 2, "wait for finalization as well as result");
      finalizing.resolve();
      assert.deepEqual(await next, { ok: true, runId: "primary-3" });
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.deepEqual(calls, [PRIMARY_AGENT_ID, "memory-consolidator", PRIMARY_AGENT_ID]);
    } finally {
      background.resolve(result("background", "cancelled")); finalizing.resolve();
      await controller.shutdown();
    }
  });

  it("preempts automatic consolidation before its Run handle arrives without consuming a second authorization", async () => {
    const pendingHandle = deferred<RunHandle>();
    const background = deferred<RunResult>();
    const calls: string[] = [];
    let cancelCount = 0;
    const controller = createAssistantController(appWith({
      autoConsolidationAgentId: "memory-consolidator",
      memoryConsolidation: {
        begin: () => undefined, discard: () => undefined,
        canStart: async () => ({ ok: true, value: { canStart: true, pendingCount: 0 } }),
        finalize: async () => ({ ok: true, value: { candidateIds: [], replayed: false } }),
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: {
        run: async (request: { agentId: string }) => {
          calls.push(request.agentId);
          if (request.agentId === "memory-consolidator") return pendingHandle.promise;
          return handle(`primary-${calls.length}`, { promise: Promise.resolve(result(`primary-${calls.length}`, "completed")), resolve: () => undefined }, () => undefined);
        },
      } as unknown as RuntimeApp["runtime"],
    }));
    try {
      await controller.run("First preference");
      await waitFor(() => calls.length === 2);
      assert.equal(controller.getSnapshot().canSubmit, true);
      const next = controller.run("New question", { memoryConsolidation: "exclude" });
      assert.equal(calls.length, 2);
      pendingHandle.resolve(handle("background", background, () => { cancelCount++; }));
      assert.deepEqual(await next, { ok: true, runId: "primary-3" });
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.equal(cancelCount, 1);
    } finally { await controller.shutdown(); }
  });

  it("resumes current-Thread backlog on startup and cancelled staged proposals do not advance its cursor", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "controller-background-memory-"));
    const memoryStore = createMemoryStore(workspace);
    const messages = [{ id: "source", role: "user" as const, parts: [{ type: "text" as const, text: "I prefer concise reports." }] }];
    const service = createMemoryConsolidation({ store: memoryStore, threadId: "controller-thread", getMessages: async () => messages });
    const background = deferred<RunResult>();
    let starts = 0;
    const controller = createAssistantController(appWith({
      memoryStore, memoryConsolidation: service, autoConsolidationAgentId: "memory-consolidator",
      store: { getMessages: async () => messages } as unknown as RuntimeApp["store"],
      runtime: { run: async (request: { agentId: string }) => {
        starts++;
        if (request.agentId !== "memory-consolidator") return handle("primary", { promise: Promise.resolve(result("primary", "completed")), resolve: () => undefined }, () => undefined);
        const prepared = await service.prepare({ mode: "incremental" });
        if (!prepared.ok) throw new Error(prepared.error.message);
        const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [{
          action: "add", text: "Prefer concise reports", sourceMessageId: "source", sourceQuote: "I prefer concise reports.",
          reason: "Explicit preference", scope: { kind: "workspace" },
        }] });
        assert.equal(staged.ok, true);
        return { ...handle("background", background, () => undefined), events: (async function* (): AsyncGenerator<AgentEvent> {
          for (const [index, toolName] of ["memory_prepare_consolidation", "memory_stage_candidates"].entries()) yield {
            id: `request-${index}`, type: "tool.call.requested", runId: "background", threadId: "controller-thread",
            sequence: index + 1, occurredAt: "2026-10-01T00:00:00.000Z", data: { toolCallId: `call-${index}`, toolName, input: {} },
          };
        })() };
      } } as unknown as RuntimeApp["runtime"],
    }));
    try {
      await waitFor(() => { const current = controller.getSnapshot().state; return current.kind === "running" && current.runId === "background"; });
      assert.equal(starts, 1, "startup performs only this configured Thread's consolidation");
      assert.equal(controller.getSnapshot().canSubmit, true);
      assert.deepEqual(await controller.run("Hello", { memoryConsolidation: "exclude" }), { ok: true, runId: "primary" });
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.deepEqual(await memoryStore.getConsolidationCursor("controller-thread"), { ok: true, value: null });
      const candidates = await memoryStore.listCandidates({}, undefined, { boundThreadId: "controller-thread" });
      assert.equal(candidates.ok && candidates.value.candidates.length, 0, "cancelled staged batch is not committed");
    } finally { await controller.shutdown(); await rm(workspace, { recursive: true, force: true }); }
  });

  it("persists invalid host JSON attempts across Controller restarts without silently declaring memory saved", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "controller-invalid-memory-json-"));
    const messages = [{ id: "source", role: "user" as const, parts: [{ type: "text" as const, text: "暂未确定的偏好。" }] }];
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const memoryStore = createMemoryStore(workspace);
        const service = createMemoryConsolidation({ store: memoryStore, threadId: "controller-thread", getMessages: async () => messages });
        const warnings: string[] = [];
        const controller = createAssistantController(appWith({
          memoryStore, memoryConsolidation: service, autoConsolidationAgentId: "memory-consolidator", hostConsolidationExtraction: true,
          store: { getMessages: async () => messages } as unknown as RuntimeApp["store"],
          runtime: { run: async () => handle(`invalid-${attempt}`, {
            promise: Promise.resolve({ ...result(`invalid-${attempt}`, "completed"), text: "not-json" }), resolve: () => undefined,
          }, () => undefined) } as unknown as RuntimeApp["runtime"],
        }));
        controller.subscribe(event => { if (event.type === "error") warnings.push(event.message); });
        try {
          await waitFor(() => controller.getSnapshot().lastConsolidationResult != null && controller.getSnapshot().state.kind === "idle");
          const maintenance = await controller.getMemoryMaintenance(); assert.ok(maintenance.ok);
          const receipt = await memoryStore.getConsolidationReceipt!("controller-thread"); assert.ok(receipt.ok && receipt.value, JSON.stringify(maintenance.value.consolidation));
          assert.equal(receipt.value.outcomes[0]!.attempts, attempt);
          assert.equal(receipt.value.outcomes[0]!.status, attempt === 3 ? "not_saved" : "deferred");
          assert.match(warnings.join("\n"), attempt === 3 ? /剩余记忆没保存.*3 次/ : /尚未完成.*剩余内容未保存/);
          assert.equal(maintenance.value.consolidation.state, "failed");
          assert.equal(maintenance.value.consolidation.lastAttempt?.status, "failed");
        } finally { await controller.shutdown(); }
      }
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  it("bounds activity retained for a renderer reload", async () => {
    const controller = createAssistantController(appWith());
    controller.recordOutput("x".repeat(20 * 1024) + "tail");
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.recentOutput.length, 16 * 1024);
    assert.equal(snapshot.recentOutput.endsWith("tail"), true);
    assert.equal(snapshot.outputTruncated, true);
    await controller.shutdown();
  });

  it("keeps a bounded completed tool receipt when the view reloads", async () => {
    const app = appWith({
      runtime: {
        run: async () => ({
          runId: "run-receipt",
          events: (async function* (): AsyncGenerator<AgentEvent> {
            yield {
              id: "event-1", type: "tool.call.completed", runId: "run-receipt",
              threadId: "controller-thread", sequence: 1,
              occurredAt: "2026-09-29T00:00:00.000Z",
              data: { toolCallId: "write-1", toolName: "write_file", output: { ok: true, text: "x".repeat(2_000) } },
            };
          })(),
          result: Promise.resolve(result("run-receipt", "completed")),
          cancel: async () => undefined,
        }),
      } as unknown as RuntimeApp["runtime"],
    });
    const controller = createAssistantController(app);
    controller.subscribe(() => { throw new Error("view disconnected"); });
    assert.deepEqual(await controller.run("Write the file"), { ok: true, runId: "run-receipt" });
    await waitFor(() => controller.getSnapshot().state.kind === "idle");
    const [receipt] = controller.getSnapshot().toolActivity;
    assert.equal(receipt?.toolCallId, "write-1");
    assert.equal(receipt?.status, "completed");
    assert.equal(receipt?.truncated, true);
    assert.equal(receipt?.summary.length, 1_000);
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    await controller.shutdown();
  });

  it("failure activity Demo preserves returned failure before truncation and a completed Run cannot overwrite it", async () => {
    const output = { diagnostic: "x".repeat(2_000), ok: false, error: { code: "WRITE_FAILED", message: "Unable to save this file" } };
    const controller = createAssistantController(appWith({ runtime: {
      run: async () => ({ runId: "failed-activity", events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { id: "failure", type: "tool.call.completed", runId: "failed-activity", threadId: "controller-thread", sequence: 1,
          occurredAt: "2026-10-11T00:00:00Z", data: { toolCallId: "failure", toolName: "write_file", output } };
      })(), result: Promise.resolve(result("failed-activity", "completed")), cancel: async () => undefined }),
    } as unknown as RuntimeApp["runtime"] }));
    try {
      await controller.run("Save the file");
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      const snapshot = controller.getSnapshot();
      assert.equal(snapshot.lastPrimaryResult?.status, "completed");
      assert.equal(snapshot.toolActivity[0]?.status, "failed");
      assert.equal(snapshot.toolActivity[0]?.errorCode, "WRITE_FAILED");
      assert.equal(snapshot.toolActivity[0]?.summary, "WRITE_FAILED: Unable to save this file");
      assert.equal(snapshot.toolActivity[0]?.outcomeUnknown, undefined);
    } finally { await controller.shutdown(); }
  });

  it("failure activity Demo retains unknown effects from structured outputs and failed events", async () => {
    for (const type of ["tool.call.completed", "tool.call.failed"] as const) {
      const error = { code: "TOOL_OUTCOME_UNKNOWN" as const, message: "Connection lost after dispatch", retryable: false, phase: "tool" as const };
      const controller = createAssistantController(appWith({ runtime: {
        run: async () => ({ runId: "unknown-activity", events: (async function* (): AsyncGenerator<AgentEvent> {
          const base = { id: "unknown", runId: "unknown-activity", threadId: "controller-thread", sequence: 1, occurredAt: "2026-10-11T00:00:00Z" };
          yield type === "tool.call.completed" ? { ...base, type, data: { toolCallId: "unknown", toolName: "write_file", output: { ok: false, error } } }
            : { ...base, type, data: { toolCallId: "unknown", toolName: "write_file", error } };
        })(), result: Promise.resolve(result("unknown-activity", "completed")), cancel: async () => undefined }),
      } as unknown as RuntimeApp["runtime"] }));
      try {
        await controller.run("Save the file");
        await waitFor(() => controller.getSnapshot().state.kind === "idle");
        const [activity] = controller.getSnapshot().toolActivity;
        assert.equal(activity?.status, "failed");
        assert.equal(activity?.errorCode, "TOOL_OUTCOME_UNKNOWN");
        assert.equal(activity?.outcomeUnknown, true);
        assert.equal(activity?.summary, "TOOL_OUTCOME_UNKNOWN: Connection lost after dispatch");
      } finally { await controller.shutdown(); }
    }
  });

  it("forwards live shell output only while its Run is active", async () => {
    const finished = deferred<RunResult>();
    let progressListener: Parameters<NonNullable<RuntimeApp["subscribeShellProgress"]>>[0] | undefined;
    const app = appWith({
      runtime: {
        run: async () => handle("shell-run", finished, () => undefined),
      } as unknown as RuntimeApp["runtime"],
      subscribeShellProgress: (listener) => {
        progressListener = listener;
        return () => { progressListener = undefined; };
      },
    });
    const controller = createAssistantController(app);
    const events: Array<{ runId: string; toolCallId: string; sequence: number }> = [];
    controller.subscribe((event) => {
      if (event.type === "shell-progress") {
        events.push({
          runId: event.runId,
          toolCallId: event.progress.toolCallId,
          sequence: event.progress.sequence,
        });
      }
    });
    const progress = {
      toolCallId: "shell-call", sequence: 1, stream: "stdout" as const,
      text: "testing...", truncated: false,
    };
    progressListener?.(progress);
    assert.deepEqual(events, []);
    assert.deepEqual(await controller.run("Run a check"), { ok: true, runId: "shell-run" });
    progressListener?.(progress);
    assert.deepEqual(events, [{ runId: "shell-run", toolCallId: "shell-call", sequence: 1 }]);
    finished.resolve(result("shell-run", "completed"));
    await waitFor(() => controller.getSnapshot().state.kind === "idle");
    progressListener?.({ ...progress, sequence: 2 });
    assert.equal(events.length, 1);
    await controller.shutdown();
    assert.equal(progressListener, undefined);
  });

  it("waits for active Run cancellation before disposing the app", async () => {
    const finished = deferred<RunResult>();
    const order: string[] = [];
    const app = appWith({
      runtime: {
        run: async () => handle("shutdown-run", finished, () => { order.push("cancel"); }),
      } as unknown as RuntimeApp["runtime"],
      dispose: () => { order.push("dispose"); },
    });
    const controller = createAssistantController(app);
    assert.deepEqual(await controller.run("Work"), { ok: true, runId: "shutdown-run" });
    await controller.shutdown();
    assert.deepEqual(order, ["cancel", "dispose"]);
    assert.equal(controller.getSnapshot().state.kind, "idle");
  });
});
