import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { AgentDefinition, AgentEvent, RunHandle, RunResult } from "@aisdk-agent/core";
import { createAssistantController } from "./assistant-controller.js";
import { createRuntimeApp, PRIMARY_AGENT_ID, type RuntimeApp } from "./app.js";
import { createDemoModel } from "./demo-model.js";
import { createToolConfirmation, type PendingToolApproval } from "./tui.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
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
    threadId: "controller-thread",
    directory: "/private/tmp/controller-transcripts",
    workspaceRoot: undefined,
    moduleConfig: undefined,
    toolConfirmation: undefined,
    commands: undefined,
    compaction: undefined,
    resume: undefined,
    autoConsolidationAgentId: undefined,
    renderHome: async () => undefined,
    registerNotificationRedraw: () => undefined,
    dispose: () => undefined,
    ...overrides,
  };
}

describe("AssistantController", () => {
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
        await waitFor(() => controller.getSnapshot().state.kind === "idle");
        assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
        assert.equal((await controller.getHistory())[0]?.role, "user");
      } finally {
        await controller.shutdown();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
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
