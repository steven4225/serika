import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
  JsonlAgentStore,
  type AgentStore,
  type BeforeToolExecute,
  type RunHandle,
} from "@serika/core";
import {
  AiSdkAgentLoop,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@serika/ai-sdk-adapter";
import {
  MAX_CONTEXT_BYTES,
  selectModelContext,
} from "./context-window.js";
import { createModuleHost } from "./module-host.js";
import { createMemoryModule } from "./modules/memory-module.js";
import type { MemoryEntry, WorkspaceMemoryStore } from "./memory-store.js";
import { createToolConfirmation } from "./tool-confirmation.js";
import { lookupTranscript } from "./work-summary.js";

const definition = {
  id: "context-window-test",
  version: "1",
  instructions: "Answer briefly.",
  model: "context-test-model",
  tools: [] as readonly string[],
  limits: { maxSteps: 1, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
};

function userMessage(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMessage(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: {
              total: 3,
              noCache: 3,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: 1,
              text: 1,
              reasoning: undefined,
            },
          },
        },
      ],
    }),
  };
}

function memoryAddResponse() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "memory-add-call",
          toolName: "memory_add",
          input: JSON.stringify({ text: "remember this" }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  };
}

class CountingStore extends InMemoryAgentStore {
  saveCount = 0;

  override async save(threadId: string, messages: UIMessage[]): Promise<void> {
    this.saveCount += 1;
    await super.save(threadId, messages);
  }
}

function runtimeFor(
  model: MockLanguageModelV3,
  store: AgentStore,
  options: {
    tools?: ToolRegistry;
    extraDefinition?: Partial<typeof definition>;
    beforeToolExecute?: BeforeToolExecute;
  } = {},
): DefaultAgentRuntime {
  return new DefaultAgentRuntime({
    catalog: new InMemoryAgentCatalog([{ ...definition, ...options.extraDefinition }]),
    loop: new AiSdkAgentLoop({
      models: new InMemoryModelRegistry({ [definition.model]: model }),
      tools: options.tools ?? new ToolRegistry(),
    }),
    prepareModelContext: ({ messages }) => selectModelContext(messages),
    store,
    ...(options.beforeToolExecute === undefined
      ? {}
      : { beforeToolExecute: options.beforeToolExecute }),
  });
}

function toolWriteMessage(id: string, path: string, bytes: number): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "write_file",
      toolCallId: `${id}-call`,
      state: "output-available",
      input: { path },
      output: { ok: true, path, bytes },
    }],
  };
}

function longThreadMessages(options: {
  prefix: string;
  goal: string;
  constraint: string;
  path: string;
  bytes: number;
}): UIMessage[] {
  const committed: UIMessage[] = [
    userMessage(`${options.prefix}-user-0`, options.goal),
    toolWriteMessage(`${options.prefix}-tool-0`, options.path, options.bytes),
    userMessage(`${options.prefix}-user-1`, options.constraint),
    assistantMessage(`${options.prefix}-assistant-1`, "Understood."),
  ];
  for (let turn = 2; turn < 10; turn += 1) {
    committed.push(
      userMessage(`${options.prefix}-user-${turn}`, `${options.prefix}-follow-up-${turn}`),
      assistantMessage(`${options.prefix}-assistant-${turn}`, `${options.prefix}-answer-${turn}`),
    );
  }
  return committed;
}

async function finishRun(handle: RunHandle) {
  const eventsDone = (async () => {
    for await (const _event of handle.events) {
      // Drain events so a failed or cancelled run cannot stall unread.
    }
  })();
  const result = await handle.result;
  await eventsDone;
  return result;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function outputBuffer(): Writable & { text(): string } {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  }) as Writable & { text(): string };
  output.text = () => chunks.join("");
  return output;
}

function writeFileTool(execute: () => { ok: true; path: string; bytes: number }) {
  return new ToolRegistry([
    {
      metadata: {
        name: "write_file",
        version: "1",
        risk: "write",
        timeoutMs: 500,
        idempotent: false,
      },
      tool: tool({
        inputSchema: z.object({ path: z.string() }),
        execute,
      }),
    },
  ]);
}

function truncatedResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "length" as const, raw: undefined },
          usage: {
            inputTokens: {
              total: 3,
              noCache: 3,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: {
              total: 1,
              text: 1,
              reasoning: undefined,
            },
          },
        },
      ],
    }),
  };
}

function toolCallResponse(toolName: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "uncommitted-write-call",
          toolName,
          input: JSON.stringify(input),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: undefined },
          usage: {
            inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  };
}

describe("context window Runtime integration", () => {
  it("trims only the model prompt while saving the complete transcript", async () => {
    const threadId = "context-window-trim";
    const committed: UIMessage[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      committed.push(
        userMessage(`history-user-${turn}`, `history-user-${turn}`),
        assistantMessage(`history-assistant-${turn}`, `history-assistant-${turn}`),
      );
    }

    const store = new CountingStore();
    await store.save(threadId, committed);
    store.saveCount = 0;
    const prompts: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        prompts.push(JSON.stringify(prompt));
        return textResponse("done");
      },
    });
    const runtime = runtimeFor(model, store);

    const handle = await runtime.run({
      agentId: definition.id,
      threadId,
      messages: [userMessage("current-user", "current question")],
    });
    const result = await handle.result;

    assert.equal(result.status, "completed");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0]!, /runloom-work-summary|Work summary reference/);
    assert.match(prompts[0]!, /history-user-0/);
    assert.equal(prompts[0]!.includes("history-user-2"), true);
    assert.equal(prompts[0]!.includes("history-assistant-9"), true);
    assert.equal(prompts[0]!.includes("current question"), true);

    assert.equal(store.saveCount, 1);
    const saved = await store.getMessages(threadId);
    assert.deepEqual(
      saved.slice(0, committed.length).map((message) => message.id),
      committed.map((message) => message.id),
    );
    assert.equal(saved.some((message) => message.id === "current-user"), true);
    assert.equal(saved.some((message) => message.id === "runloom-work-summary"), false);
  });

  it("rebuilds the summary from committed JSONL after restart without crossing thread boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runloom-context-restart-"));
    const threadId = "context-window-restart";
    const otherThreadId = "context-window-other-thread";
    const failedSentinel = "FAILED-RUN-MUST-NOT-RETURN";
    const cancelledSentinel = "CANCELLED-RUN-MUST-NOT-RETURN";
    const uncommittedPath = "tmp/uncommitted.md";
    const committed = longThreadMessages({
      prefix: "restart",
      goal: "Prepare docs/report.md from the existing notes",
      constraint: "Keep the original filename and never write outside docs/",
      path: "docs/report.md",
      bytes: 42,
    });
    const otherCommitted = longThreadMessages({
      prefix: "other",
      goal: "Prepare secret/other.md from a separate brief",
      constraint: "Never write outside secret/",
      path: "secret/other.md",
      bytes: 17,
    });

    try {
      const initialStore = new JsonlAgentStore({ directory });
      await initialStore.save(threadId, committed);
      await initialStore.save(otherThreadId, otherCommitted);

      let uncommittedWrites = 0;
      let failedModelCalls = 0;
      const failingModel = new MockLanguageModelV3({
        doStream: async () => {
          failedModelCalls += 1;
          if (failedModelCalls === 1) {
            return toolCallResponse("write_file", { path: uncommittedPath });
          }
          return truncatedResponse("partial answer after uncommitted write");
        },
      });
      const failedResult = await finishRun(
        await runtimeFor(failingModel, initialStore, {
          tools: writeFileTool(() => {
            uncommittedWrites += 1;
            return { ok: true, path: uncommittedPath, bytes: 9 };
          }),
          extraDefinition: {
            tools: ["write_file"],
            limits: { maxSteps: 2, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
          },
          beforeToolExecute: async () => ({ allow: true }),
        }).run({
          agentId: definition.id,
          threadId,
          messages: [userMessage("failed-user", failedSentinel)],
        }),
      );
      assert.equal(failedResult.status, "failed");
      assert.equal(failedModelCalls, 2);
      assert.equal(uncommittedWrites, 1);
      assert.deepEqual(await initialStore.getMessages(threadId), committed);

      let cancelledModelCalls = 0;
      let markCancelledStarted!: () => void;
      const cancelledStarted = new Promise<void>((resolve) => {
        markCancelledStarted = resolve;
      });
      const hangingHandle = await runtimeFor(
        new MockLanguageModelV3({
          doStream: async (options) => {
            cancelledModelCalls += 1;
            const signal = options.abortSignal;
            if (signal === undefined) {
              throw new Error("expected an abort signal for the cancelled run");
            }
            markCancelledStarted();
            await waitForAbort(signal);
            return textResponse("must not complete");
          },
        }),
        initialStore,
      ).run({
        agentId: definition.id,
        threadId,
        messages: [userMessage("cancelled-user", cancelledSentinel)],
      });
      const cancelledFinished = finishRun(hangingHandle);
      await cancelledStarted;
      await hangingHandle.cancel("stop before transcript save");
      const cancelledResult = await cancelledFinished;
      assert.equal(cancelledResult.status, "cancelled");
      assert.equal(cancelledModelCalls, 1);
      assert.deepEqual(await initialStore.getMessages(threadId), committed);

      const resumedPrompts: string[] = [];
      const reopenedStore = new JsonlAgentStore({ directory });
      const resumedResult = await finishRun(
        await runtimeFor(
          new MockLanguageModelV3({
            doStream: async ({ prompt }) => {
              resumedPrompts.push(JSON.stringify(prompt));
              return textResponse("resumed");
            },
          }),
          reopenedStore,
        ).run({
          agentId: definition.id,
          threadId,
          messages: [userMessage("restart-current", "What remains after restart?")],
        }),
      );
      assert.equal(resumedResult.status, "completed");
      assert.equal(resumedPrompts.length, 1);
      assert.match(resumedPrompts[0]!, /Work summary reference/);
      assert.match(resumedPrompts[0]!, /Prepare docs\/report\.md from the existing notes/);
      assert.match(resumedPrompts[0]!, /Keep the original filename and never write outside docs\//);
      assert.match(resumedPrompts[0]!, /write_file completed: ok=true path=docs\/report\.md bytes=42/);
      assert.equal(resumedPrompts[0]!.includes(failedSentinel), false);
      assert.equal(resumedPrompts[0]!.includes(cancelledSentinel), false);
      assert.equal(resumedPrompts[0]!.includes(uncommittedPath), false);
      assert.equal(resumedPrompts[0]!.includes("secret/other.md"), false);
      assert.equal(resumedPrompts[0]!.includes("Never write outside secret/"), false);

      const resumedTranscript = await reopenedStore.getMessages(threadId);
      assert.equal(
        resumedTranscript.some((message) => message.id === "runloom-work-summary"),
        false,
      );
      assert.equal(
        resumedTranscript.some((message) => message.id === "failed-user"),
        false,
      );
      assert.equal(
        resumedTranscript.some((message) => message.id === "cancelled-user"),
        false,
      );

      const turnZero = lookupTranscript(resumedTranscript, "turn:0");
      assert.equal(turnZero.ok, true);
      if (turnZero.ok) {
        assert.equal(turnZero.messages[0]?.id, "restart-user-0");
        assert.match(
          JSON.stringify(turnZero.messages),
          /Prepare docs\/report\.md from the existing notes/,
        );
      }
      const byId = lookupTranscript(resumedTranscript, "restart-user-0");
      assert.equal(byId.ok, true);

      const confirmationOutput = outputBuffer();
      const restartedConfirmation = createToolConfirmation(confirmationOutput, {
        workspaceRoot: "/tmp/runloom-r4b-workspace",
      });
      restartedConfirmation.beginRun();
      const pendingWrite = restartedConfirmation.beforeToolExecute({
        toolName: "write_file",
        toolCallId: "restart-auth-call",
        input: { path: "docs/report.md" },
        definition,
        signal: new AbortController().signal,
      });
      await Promise.resolve();
      assert.match(confirmationOutput.text(), /Tool: write_file/);
      assert.equal(restartedConfirmation.handleLine("n"), true);
      assert.deepEqual(await pendingWrite, {
        allow: false,
        reason: "User denied this tool call",
      });
      restartedConfirmation.endRun();

      const otherPrompts: string[] = [];
      const isolatedResult = await finishRun(
        await runtimeFor(
          new MockLanguageModelV3({
            doStream: async ({ prompt }) => {
              otherPrompts.push(JSON.stringify(prompt));
              return textResponse("isolated");
            },
          }),
          reopenedStore,
        ).run({
          agentId: definition.id,
          threadId: otherThreadId,
          messages: [userMessage("other-current", "What remains on the other thread?")],
        }),
      );
      assert.equal(isolatedResult.status, "completed");
      assert.equal(otherPrompts.length, 1);
      assert.match(otherPrompts[0]!, /Work summary reference/);
      assert.match(otherPrompts[0]!, /Prepare secret\/other\.md from a separate brief/);
      assert.match(otherPrompts[0]!, /Never write outside secret\//);
      assert.match(otherPrompts[0]!, /write_file completed: ok=true path=secret\/other\.md bytes=17/);
      assert.equal(otherPrompts[0]!.includes("docs/report.md"), false);
      assert.equal(otherPrompts[0]!.includes("never write outside docs/"), false);
      assert.equal(otherPrompts[0]!.includes(failedSentinel), false);

      const jsonlFiles = await readdir(directory);
      const jsonl = (
        await Promise.all(
          jsonlFiles.map((fileName) => readFile(join(directory, fileName), "utf8")),
        )
      ).join("\n");
      assert.equal(jsonl.includes("runloom-work-summary"), false);
      assert.equal(jsonl.includes(failedSentinel), false);
      assert.equal(jsonl.includes(cancelledSentinel), false);
      assert.equal(jsonl.includes(uncommittedPath), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails before the model and transcript save when the current turn is oversized", async () => {
    const threadId = "context-window-too-large";
    const store = new CountingStore();
    const committed = [
      userMessage("old-user", "old history"),
      assistantMessage("old-assistant", "old answer"),
    ];
    await store.save(threadId, committed);
    store.saveCount = 0;

    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return textResponse("must not run");
      },
    });
    const runtime = runtimeFor(model, store);
    const handle = await runtime.run({
      agentId: definition.id,
      threadId,
      messages: [
        userMessage("oversized-current", "x".repeat(MAX_CONTEXT_BYTES)),
      ],
    });
    const result = await handle.result;

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "CONTEXT_PREPARE_FAILED");
    assert.equal(modelCalls, 0);
    assert.equal(store.saveCount, 0);
    assert.deepEqual(await store.getMessages(threadId), committed);
  });

  it("reads newly added memory on the next model step without saving the injected message", async () => {
    const threadId = "context-window-memory";
    const store = new CountingStore();
    const entries: MemoryEntry[] = [];
    const memoryStore: WorkspaceMemoryStore = {
      checkCandidateCapacity: async () => { throw new Error("unexpected candidate capacity read"); },
      listCandidates: async () => { throw new Error("unexpected candidate list"); },
      getCandidate: async () => { throw new Error("unexpected candidate preview"); },
      resolveCandidate: async () => { throw new Error("unexpected candidate resolution"); },
      getConsolidationCursor: async () => { throw new Error("unexpected consolidation cursor"); },
      commitCandidateBatch: async () => { throw new Error("unexpected candidate commit"); },
      list: async () => ({ ok: true as const, entries: entries.map((entry) => ({ ...entry })) }),
      get: async (id) => {
        const entry = entries.find((value) => value.id === id);
        return entry
          ? { ok: true as const, entry: { ...entry } }
          : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "not found" } };
      },
      add: async ({ text, enabled }) => {
        const entry = { id: "memory-1", text, enabled: enabled ?? true };
        entries.push(entry);
        return { ok: true as const, entry: { ...entry } };
      },
      update: async () => ({ ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "not found" } }),
      delete: async (id) => ({ ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: `not found: ${id}` } }),
    };
    const moduleHost = createModuleHost([createMemoryModule(memoryStore)], {
      notify: () => undefined,
    });
    const prompts: string[] = [];
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        modelCalls += 1;
        prompts.push(JSON.stringify(prompt));
        return modelCalls === 1 ? memoryAddResponse() : textResponse("memory seen");
      },
    });
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([
        {
          ...definition,
          tools: ["memory_add"],
          limits: { maxSteps: 2, totalTimeoutMs: 1_000, stepTimeoutMs: 500 },
        },
      ]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ [definition.model]: model }),
        tools: new ToolRegistry(moduleHost.tools),
      }),
      prepareModelContext: async ({ messages, signal }) => {
        const listed = await memoryStore.list(signal);
        if (!listed.ok) throw new Error(listed.error.message);
        return selectModelContext(messages, listed.entries);
      },
      beforeToolExecute: async () => ({ allow: true }),
      store,
    });

    try {
      const handle = await runtime.run({
        agentId: definition.id,
        threadId,
        messages: [userMessage("memory-user", "remember something")],
      });
      const result = await handle.result;

      assert.equal(result.status, "completed");
      assert.equal(modelCalls, 2);
      assert.equal(prompts[1]!.includes("remember this"), true);
      const saved = await store.getMessages(threadId);
      assert.equal(saved.some((message) => message.id === "runloom-workspace-memory"), false);
    } finally {
      moduleHost.dispose();
    }
  });
});
