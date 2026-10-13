import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { createMemoryStore } from "./memory-store.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function fixture(autoConsolidate = false) {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-app-b-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate } } }));
  return { root, workspace, configPath, args: ["--tui", join(root, "transcripts"), "--thread", "memory-app-b", "--config", configPath] };
}

function quietModel(observe?: (options: Parameters<MockLanguageModelV3["doStream"]>[0]) => void) {
  return new MockLanguageModelV3({ doStream: async (options) => {
    observe?.(options);
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
    ] }) };
  } });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Expected state was not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("Memory Phase B application integration", () => {
  for (const sourceQuote of [undefined, "记住我刚才说的那条。"] as const) {
    it(`current-source excerpt Demo: approved previous-message reference cannot write (${sourceQuote ?? "omitted quote"})`, async () => {
      const setup = await fixture();
      let nextInput: { text: string; sourceQuote?: string } | undefined;
      const model = new MockLanguageModelV3({ doStream: async () => {
        const input = nextInput; nextInput = undefined;
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          ...(input ? [{ type: "tool-call" as const, toolCallId: "remember-earlier", toolName: "memory_add", input: JSON.stringify(input) }] : []),
          { type: "finish" as const, finishReason: { unified: input ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
        ] }) };
      } });
      const app = await createRuntimeApp({ ...setup, modelAlias: "mock", model, output: new PassThrough(), env: {}, cwd: setup.root });
      const controller = createAssistantController(app);
      try {
        assert.ok((await controller.run("我喝咖啡不加糖。")).ok);
        await waitFor(() => controller.getSnapshot().state.kind === "idle");
        nextInput = { text: "我喝咖啡不加糖。", ...(sourceQuote === undefined ? {} : { sourceQuote }) };
        assert.ok((await controller.run("记住我刚才说的那条。")).ok);
        await waitFor(() => controller.getSnapshot().pendingApproval !== null || controller.getSnapshot().state.kind === "idle");
        const approval = controller.getSnapshot().pendingApproval;
        assert.ok(approval, "the normal approval boundary is unchanged");
        assert.equal(controller.confirm({ approvalId: approval.approvalId, decision: "allow" }), true);
        await waitFor(() => controller.getSnapshot().state.kind === "idle");
        assert.deepEqual(await app.memoryStore!.list(), { ok: true, entries: [] }, "approval cannot invent source evidence");
        assert.match(JSON.stringify(await controller.getHistory()), /INVALID_INPUT/);
        assert.deepEqual(await createMemoryStore(setup.workspace).list(), { ok: true, entries: [] });
      } finally { await controller.shutdown(); await rm(setup.root, { recursive: true, force: true }); }
    });
  }

  it("current-user source Demo: memory_add binds the real uncommitted user ID without asking the model to invent it", async () => {
    const setup = await fixture();
    const quote = "请记住，我喝咖啡不加糖。";
    let requests = 0;
    const model = new MockLanguageModelV3({ doStream: async ({ tools }) => {
      const add = tools?.find(tool => tool.type === "function" && tool.name === "memory_add");
      assert.ok(add?.type === "function");
      assert.doesNotMatch(JSON.stringify(add.inputSchema), /sourceMessageId/);
      requests++;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(requests === 1 ? [{ type: "tool-call" as const, toolCallId: "remember-current", toolName: "memory_add",
          input: JSON.stringify({ text: "我喝咖啡不加糖。", kind: "preference", sourceQuote: quote }) }] : []),
        { type: "finish" as const, finishReason: { unified: requests === 1 ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
      ] }) };
    } });
    const app = await createRuntimeApp({ ...setup, modelAlias: "mock", model, output: new PassThrough(), env: {}, cwd: setup.root });
    const controller = createAssistantController(app);
    try {
      assert.ok((await controller.run(quote)).ok);
      await waitFor(() => controller.getSnapshot().pendingApproval !== null || controller.getSnapshot().state.kind === "idle");
      const approval = controller.getSnapshot().pendingApproval;
      assert.ok(approval, "a quote without a guessed source ID must reach ordinary write approval");
      assert.deepEqual(await app.memoryStore!.list(), { ok: true, entries: [] });
      assert.equal((await controller.getHistory()).some(message => message.role === "user"), false, "source is not committed yet");
      assert.equal(controller.confirm({ approvalId: approval.approvalId, decision: "allow" }), true);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      const saved = await app.memoryStore!.list(); assert.ok(saved.ok);
      assert.equal(saved.entries.length, 1);
      const user = (await controller.getHistory()).find(message => message.role === "user"); assert.ok(user);
      assert.deepEqual(saved.entries[0]!.source, { kind: "conversation", threadId: app.threadId, messageId: user.id, quote });
      const reopened = await createMemoryStore(setup.workspace).list(); assert.ok(reopened.ok);
      assert.deepEqual(reopened.entries[0]!.source, saved.entries[0]!.source);
    } finally { await controller.shutdown(); await rm(setup.root, { recursive: true, force: true }); }
  });

  it("current-user source Demo: denial/cancellation never write and later Runs bind only their own user", async () => {
    const setup = await fixture();
    let callTool = false;
    let quote = "";
    const model = new MockLanguageModelV3({ doStream: async () => {
      const invoke = callTool; callTool = false;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(invoke ? [{ type: "tool-call" as const, toolCallId: "remember", toolName: "memory_add",
          input: JSON.stringify({ text: quote }) }] : []),
        { type: "finish" as const, finishReason: { unified: invoke ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
      ] }) };
    } });
    const app = await createRuntimeApp({ ...setup, modelAlias: "mock", model, output: new PassThrough(), env: {}, cwd: setup.root });
    const controller = createAssistantController(app);
    try {
      let savedCount = 0;
      for (const [index, decision] of ["deny", "cancel", "allow", "allow"].entries()) {
        quote = `请记住第 ${index} 条测试偏好。`; callTool = true;
        assert.ok((await controller.run(quote)).ok);
        await waitFor(() => controller.getSnapshot().pendingApproval !== null || controller.getSnapshot().state.kind === "idle");
        const approval = controller.getSnapshot().pendingApproval; assert.ok(approval);
        if (decision === "cancel") await controller.cancel();
        else assert.equal(controller.confirm({ approvalId: approval.approvalId, decision: decision as "allow" | "deny" }), true);
        await waitFor(() => controller.getSnapshot().state.kind === "idle");
        const saved = await app.memoryStore!.list(); assert.ok(saved.ok);
        if (decision === "allow") savedCount++;
        assert.equal(saved.entries.length, savedCount);
        if (decision === "allow") {
          const user = (await controller.getHistory()).find(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === quote));
          assert.ok(user);
          assert.deepEqual(saved.entries.find(entry => entry.text === quote)?.source, {
            kind: "conversation", threadId: app.threadId, messageId: user.id, quote,
          });
        }
      }
    } finally { await controller.shutdown(); await rm(setup.root, { recursive: true, force: true }); }
  });

  it("publishes the exact selected temporal provenance without quotes, terms, or history", async () => {
    const setup = await fixture();
    const modelPrompts: string[] = [];
    const app = await createRuntimeApp({ ...setup, modelAlias: "mock", model: quietModel((options) => modelPrompts.push(JSON.stringify(options.prompt))), output: new PassThrough(), env: {}, cwd: setup.root });
    try {
      assert.equal(app.autoConsolidationAgentId, undefined);
      assert.equal(app.moduleConfig?.autoConsolidate, false);
      const added = await app.memoryStore!.add({
        text: "Use bullet points for reviews.", kind: "preference", recallTerms: ["recap"],
        validTime: { from: "2020-01-01T00:00:00Z", to: null, basis: "explicit" },
        source: { kind: "conversation", threadId: app.threadId, messageId: "source-message", quote: "PRIVATE_QUOTE_NOT_FOR_CONTEXT" },
      });
      assert.equal(added.ok, true);
      if (!added.ok) return;
      const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id: "lookup-message", role: "user", parts: [{ type: "text", text: "recap" }] }] });
      assert.equal((await handle.result).status, "completed");
      const reference = app.getMemoryReferences!();
      assert.ok(reference);
      assert.equal(reference.messageId, "lookup-message");
      assert.equal(reference.temporalView.validAt, reference.temporalView.knownAt);
      assert.equal(reference.selected[0]?.reason, "recall_term");
      assert.equal(reference.selected[0]?.id, added.entry.id);
      assert.equal(reference.selected[0]?.text, added.entry.text);
      assert.equal(reference.selected[0]?.assertion?.kind, "preference");
      assert.equal(reference.selected[0]?.assertion?.state, "asserted");
      assert.deepEqual(reference.selected[0]?.assertion?.sourceIds, [{ kind: "conversation", threadId: app.threadId, messageId: "source-message" }]);
      const serialized = JSON.stringify(reference);
      assert.doesNotMatch(serialized, /PRIVATE_QUOTE_NOT_FOR_CONTEXT|recallTerms|history|versions/);
      assert.equal(modelPrompts.some((prompt) => prompt.includes(reference.selected[0]!.assertion!.assertionId)), true);
      assert.equal(modelPrompts.some((prompt) => prompt.includes("PRIVATE_QUOTE_NOT_FOR_CONTEXT")), false);
      assert.equal(modelPrompts.some((prompt) => prompt.includes('"recallTerms":')), false);
      await writeFile(join(setup.workspace, ".runloom", "memory.json"), "broken-json");
      const failed = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id: "failed-lookup", role: "user", parts: [{ type: "text", text: "recap" }] }] });
      assert.equal((await failed.result).status, "failed");
      assert.equal(app.getMemoryReferences!(), null, "failed preparation must clear the previous temporal reference");
      assert.equal(JSON.parse(await readFile(setup.configPath, "utf8")).modules.memory.autoConsolidate, false);
    } finally { app.dispose(); await rm(setup.root, { recursive: true, force: true }); }
  });

  it("gives primary and consolidation agents the same bounded proposal/time contract", async () => {
    const setup = await fixture(true);
    const observations: Array<{ system: string; names: string[] }> = [];
    const app = await createRuntimeApp({ ...setup, modelAlias: "mock", model: quietModel((options) => observations.push({
      system: JSON.stringify(options.prompt.filter((message) => message.role === "system")),
      names: options.tools?.flatMap((tool) => tool.type === "function" ? [tool.name] : []) ?? [],
    })), output: new PassThrough(), env: {}, cwd: setup.root });
    try {
      for (const agentId of [app.agentId, app.autoConsolidationAgentId!]) {
        const run = await app.runtime.run({ agentId, threadId: app.threadId, messages: [{ id: `prompt-${agentId}`, role: "user", parts: [{ type: "text", text: "Inspect instructions" }] }] });
        assert.equal((await run.result).status, "completed");
      }
      assert.equal(observations.length, 2);
      for (const observation of observations) {
        assert.match(observation.system, /one to four/);
        assert.match(observation.system, /change for a real transition/);
        assert.match(observation.system, /Legacy update is a correction/);
        assert.match(observation.system, /Never invent dates/);
        assert.match(observation.system, /ambiguous target/);
        assert.match(observation.system, /at most three relevant retrieval phrases/);
        assert.match(observation.system, /96 UTF-8 bytes/);
        assert.match(observation.system, /Historical assertions are conflict-review material/);
        assert.match(observation.system, /never active Memory/);
        assert.match(observation.system, /Only add accepts scope/);
        assert.match(observation.system, /alternate everyday names for the subject and action/);
      }
      assert.equal(observations[0]?.names.includes("memory_revise"), true);
      assert.equal(observations[0]?.names.includes("memory_query"), true);
      assert.deepEqual(observations[1]?.names, []);
      assert.match(observations[0]!.system, /never retry either in the same Run/);
      assert.match(observations[1]!.system, /Perform ONE extraction/);
      assert.match(observations[1]!.system, /outcomes/);
      assert.equal(JSON.parse(await readFile(setup.configPath, "utf8")).modules.memory.autoConsolidate, true);
    } finally { app.dispose(); await rm(setup.root, { recursive: true, force: true }); }
  });

  it("keeps direct memory writes confirmed when this conversation is excluded from consolidation", async () => {
    const setup = await fixture(true);
    let requests = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      requests += 1;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(requests === 1 ? [{ type: "tool-call" as const, toolCallId: "explicit-save", toolName: "memory_add", input: JSON.stringify({ text: "Explicitly approved preference", scope: { kind: "workspace" } }) }] : []),
        { type: "finish" as const, finishReason: { unified: requests === 1 ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
      ] }) };
    } });
    const app = await createRuntimeApp({ ...setup, modelAlias: "mock", model, output: new PassThrough(), env: {}, cwd: setup.root });
    const controller = createAssistantController(app);
    try {
      assert.equal((await controller.run("Save this: Explicitly approved preference; exclude my conversation from later consolidation", { memoryConsolidation: "exclude" })).ok, true);
      await waitFor(() => controller.getSnapshot().pendingApproval !== null);
      assert.deepEqual(await app.memoryStore!.list(), { ok: true, entries: [] });
      const approval = controller.getSnapshot().pendingApproval!;
      assert.equal(approval.toolName, "memory_add");
      assert.equal(controller.confirm({ approvalId: approval.approvalId, decision: "allow" }), true);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
      assert.equal(controller.getSnapshot().lastConsolidationResult, null);
      assert.equal(requests, 2);
      const memories = await app.memoryStore!.list();
      assert.equal(memories.ok && memories.entries.length, 1);
      const user = (await controller.getHistory()).find((message) => message.role === "user");
      assert.deepEqual(user?.metadata, { memoryConsolidation: "exclude" });
    } finally { await controller.shutdown(); await rm(setup.root, { recursive: true, force: true }); }
  });

  it("does not reveal another Thread's memory through a revision approval preview", async () => {
    const setup = await fixture();
    const privateEntry = await createMemoryStore(setup.workspace).add({ text: "PRIVATE_OTHER_THREAD_TEXT", scope: { kind: "thread", threadId: "other-thread" } });
    assert.equal(privateEntry.ok, true);
    if (!privateEntry.ok) return;
    let requests = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      requests += 1;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(requests === 1 ? [{ type: "tool-call" as const, toolCallId: "foreign-revision", toolName: "memory_revise", input: JSON.stringify({ id: privateEntry.entry.id, expectedRevision: 1, operation: "retract" }) }] : []),
        { type: "finish" as const, finishReason: { unified: requests === 1 ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
      ] }) };
    } });
    const app = await createRuntimeApp({ ...setup, modelAlias: "mock", model, output: new PassThrough(), env: {}, cwd: setup.root });
    const controller = createAssistantController(app);
    try {
      await controller.run("Withdraw the named memory");
      await waitFor(() => controller.getSnapshot().pendingApproval?.preview.includes("MEMORY_ENTRY_NOT_FOUND") === true);
      const preview = controller.getSnapshot().pendingApproval!;
      assert.doesNotMatch(preview.preview, /PRIVATE_OTHER_THREAD_TEXT/);
      assert.equal(controller.confirm({ approvalId: preview.approvalId, decision: "deny" }), true);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      const retained = await app.memoryStore!.get(privateEntry.entry.id);
      assert.equal(retained.ok && retained.entry.revision, 1);
    } finally { await controller.shutdown(); await rm(setup.root, { recursive: true, force: true }); }
  });
});
