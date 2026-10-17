import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import type { AgentEvent, RunHandle, RunResult } from "@serika/core";
import { PRIMARY_AGENT_ID, type RuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";

function completed(runId: string): RunResult {
  return { runId, threadId: "memory-controls", status: "completed", text: "Done", steps: 1, usage: {} };
}

function handle(runId: string, events: AgentEvent[] = []): RunHandle {
  return {
    runId,
    events: (async function* () { yield* events; })(),
    result: Promise.resolve(completed(runId)),
    cancel: async () => undefined,
  };
}

function appWith(overrides: Partial<RuntimeApp>): RuntimeApp {
  return {
    tuiMode: true, agentId: PRIMARY_AGENT_ID,
    runtime: { run: async () => { throw new Error("Unexpected Run"); } } as unknown as RuntimeApp["runtime"],
    store: { getMessages: async () => [] } as unknown as RuntimeApp["store"],
    executionRecords: {
      claimThread: async () => ({ release: async () => undefined }), recoverInterrupted: async () => 0,
      finishRun: async () => undefined, listRuns: async () => [], getRun: async () => null,
    } as unknown as RuntimeApp["executionRecords"],
    enableExecutionRecords: () => undefined, bindNextExecutionWorkTask: () => () => undefined,
    workTasks: undefined, workTaskContext: { begin: () => undefined, end: () => undefined },
    threadId: "memory-controls", directory: "/private/tmp/memory-controls-unused", workspaceRoot: undefined,
    moduleConfig: undefined, toolConfirmation: undefined, commands: undefined, compaction: undefined,
    getContextDiagnostics: async () => ({ ok: false, error: { code: "TEST", message: "unused" } }),
    resume: undefined, autoConsolidationAgentId: undefined,
    renderHome: async () => undefined, registerNotificationRedraw: () => undefined, dispose: () => undefined,
    ...overrides,
  };
}

async function idle(controller: ReturnType<typeof createAssistantController>): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (controller.getSnapshot().state.kind !== "idle") {
    if (Date.now() > deadline) throw new Error("Controller did not become idle");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("AssistantController memory consolidation controls", () => {
  it("marks one ordinary user message excluded and skips only its automatic followup", async () => {
    const requests: Array<{ agentId: string; messages: UIMessage[] }> = [];
    let readinessChecks = 0;
    const controller = createAssistantController(appWith({
      autoConsolidationAgentId: "memory-consolidator",
      memoryConsolidation: {
        begin: () => undefined, discard: () => undefined, finalize: async () => undefined,
        canStart: async () => { readinessChecks += 1; return { ok: true, value: { canStart: true } }; },
      } as unknown as NonNullable<RuntimeApp["memoryConsolidation"]>,
      runtime: { run: async (request: { agentId: string; messages: UIMessage[] }) => {
        requests.push(request);
        return handle(`run-${requests.length}`);
      } } as unknown as RuntimeApp["runtime"],
    }));
    try {
      assert.equal((await controller.run("  Sensitive ordinary conversation  ", { memoryConsolidation: "exclude" })).ok, true);
      await idle(controller);
      assert.equal(requests.length, 1);
      assert.equal(readinessChecks, 0);
      assert.deepEqual(requests[0]?.messages[0], {
        id: requests[0]?.messages[0]?.id, role: "user", metadata: requests[0]?.messages[0]?.metadata,
        parts: [{ type: "text", text: "Sensitive ordinary conversation" }],
      });
      assert.equal((requests[0]?.messages[0]?.metadata as Record<string, unknown>).memoryConsolidation, "exclude");
      assert.equal(typeof (requests[0]?.messages[0]?.metadata as Record<string, unknown>).sentAt, "string");
      assert.equal(controller.getSnapshot().lastConsolidationResult, null);

      assert.equal((await controller.run("Ordinary next conversation")).ok, true);
      await idle(controller);
      assert.deepEqual(requests.map((request) => request.agentId), [PRIMARY_AGENT_ID, PRIMARY_AGENT_ID, "memory-consolidator"]);
      assert.equal((requests[1]?.messages[0]?.metadata as Record<string, unknown>).memoryConsolidation, undefined, "exclusion is not remembered for the next Run");
      assert.equal(readinessChecks, 1);
      assert.equal(controller.getSnapshot().lastConsolidationResult?.runId, "run-3");
    } finally { await controller.shutdown(); }
  });

  it("does not activate consolidation when the user has not enabled it", async () => {
    let runs = 0;
    const controller = createAssistantController(appWith({
      runtime: { run: async () => handle(`run-${++runs}`) } as unknown as RuntimeApp["runtime"],
    }));
    try {
      await controller.run("An ordinary lasting preference");
      await idle(controller);
      await controller.run("An excluded preference", { memoryConsolidation: "exclude" });
      await idle(controller);
      assert.equal(runs, 2);
      assert.equal(controller.getSnapshot().lastConsolidationResult, null);
    } finally { await controller.shutdown(); }
  });

  it("publishes memory_revise updates only from successful tool receipts", async () => {
    let invocation = 0;
    const controller = createAssistantController(appWith({
      runtime: { run: async () => {
        invocation += 1;
        const event = {
          type: "tool.call.completed", data: {
            toolCallId: `revision-${invocation}`, toolName: "memory_revise",
            output: invocation === 1 ? { ok: true, entry: { id: "memory" } } : { ok: false, error: { code: "MEMORY_REVISION_CONFLICT" } },
          },
        } as AgentEvent;
        return handle(`run-${invocation}`, [event]);
      } } as unknown as RuntimeApp["runtime"],
    }));
    const updates: string[] = [];
    controller.subscribe((event) => { if (event.type === "memory-updated") updates.push(event.reason); });
    try {
      await controller.run("Apply an explicit correction");
      await idle(controller);
      assert.deepEqual(updates, ["write"]);
      await controller.run("Apply a stale correction");
      await idle(controller);
      assert.deepEqual(updates, ["write"]);
    } finally { await controller.shutdown(); }
  });
});

it("memory library operations bind the host Thread, serialize with foreground work and create no Run", async () => {
  const calls: string[] = [], events: string[] = [];
  const view = { revision: 0, folders: [], documents: [] };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = createAssistantController(appWith({ memoryStore: {
    getLibrary: async (threadId: string) => { calls.push(`list:${threadId}`); return { ok: true, value: view }; },
    readLibraryDocument: async (id: string, threadId: string) => { calls.push(`read:${threadId}:${id}`); return { ok: false, error: { code: "MEMORY_ENTRY_NOT_FOUND", message: "not found" } }; },
    changeLibrary: async (_input: unknown, threadId: string) => { calls.push(`change:${threadId}`); await gate; return { ok: true, value: { ...view, revision: 1 } }; },
  } as unknown as NonNullable<RuntimeApp["memoryStore"]> }));
  controller.subscribe(event => { if (event.type === "memory-updated") events.push(event.reason); });
  try {
    assert.ok((await controller.getMemoryLibrary()).ok);
    assert.equal((await controller.readMemoryDocument("doc")).ok, false);
    const input = { operation: "create-folder" as const, id: "12345678-1234-4123-8123-123456789abc", name: "角色", expectedRevision: 0 };
    const saving = controller.changeMemoryLibrary(input);
    assert.equal(controller.getSnapshot().state.kind, "command");
    const second = await controller.changeMemoryLibrary(input); assert.equal(second.ok ? null : second.error.code, "BUSY");
    const foreground = await controller.run("cannot race document save"); assert.equal(foreground.ok ? null : foreground.reason, "busy");
    release(); assert.ok((await saving).ok);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    assert.deepEqual(calls, ["list:memory-controls", "read:memory-controls:doc", "change:memory-controls"]);
    assert.deepEqual(events, ["write"]);
  } finally { release(); await controller.shutdown(); }
});
