import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentError } from "@serika/core";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { asSchema, type UIMessage } from "ai";
import { AUTO_CONSOLIDATION_AGENT_ID, MAX_CONSOLIDATION_TURNS } from "../consolidation.js";
import { MAX_CONTEXT_BYTES } from "../context-window.js";
import type { MemoryConsolidation } from "../memory-consolidation.js";
import {
  MEMORY_ENTRY_MAX_BYTES,
  type MemoryAddInput,
  type MemoryWriteOptions,
} from "../memory-store.js";
import {
  CONSOLIDATION_RESULT_MAX_BYTES,
  createMemoryModule,
  type MemoryModuleOptions,
  type MemoryEntry,
  type WorkspaceMemoryStore,
} from "./memory-module.js";

function entry(id: string, text: string, enabled = true): MemoryEntry {
  return { id, text, enabled };
}
const candidateStubs = {
  checkCandidateCapacity: async () => { throw new Error("unexpected candidate capacity read"); },
  listCandidates: async () => { throw new Error("unexpected candidate list"); },
  getCandidate: async () => { throw new Error("unexpected candidate detail"); },
  resolveCandidate: async () => { throw new Error("unexpected candidate resolution"); },
  getConsolidationCursor: async () => { throw new Error("unexpected cursor read"); },
  commitCandidateBatch: async () => { throw new Error("unexpected candidate batch"); },
};

function createStore(): {
  store: WorkspaceMemoryStore;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const entries = [entry("one", "pnpm")];
  const store = {
    ...candidateStubs,
    list: async () => {
      calls.push({ method: "list", args: [] });
      return { ok: true as const, entries: [...entries] };
    },
    get: async (id: string) => {
      calls.push({ method: "get", args: [id] });
      const found = entries.find((value) => value.id === id);
      return found
        ? { ok: true as const, entry: found }
        : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "Memory not found" } };
    },
    add: async (input: { text: string; enabled?: boolean }) => {
      calls.push({ method: "add", args: [input] });
      const added = entry("two", input.text, input.enabled ?? true);
      entries.push(added);
      return { ok: true as const, entry: added };
    },
    update: async (
      id: string,
      input: { expectedRevision?: number; text?: string; enabled?: boolean },
    ) => {
      calls.push({ method: "update", args: [id, input] });
      const current = entries.find((value) => value.id === id);
      if (!current) {
        throw new Error("Memory not found");
      }
      const { expectedRevision: _expectedRevision, ...changes } = input;
      Object.assign(current, changes);
      return { ok: true as const, entry: current };
    },
    delete: async (id: string) => {
      calls.push({ method: "delete", args: [id] });
      const index = entries.findIndex((value) => value.id === id);
      if (index === -1) {
        throw new Error("Memory not found");
      }
      entries.splice(index, 1);
      return { ok: true as const, id };
    },
  } satisfies WorkspaceMemoryStore;

  return { store, calls };
}

function setupTools(
  store: WorkspaceMemoryStore,
  getMessages?: () => Promise<UIMessage[]>,
  options?: MemoryModuleOptions,
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  createMemoryModule(store, getMessages, options).setup({
    registerTool: (registered) => tools.push(registered),
    addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
    notify: () => {},
  });
  return tools;
}

function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function toolOnlyMessage(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "tool-search", toolCallId: id, state: "output-available", input: {}, output: {} }],
  } as UIMessage;
}

function toolByName(tools: RegisteredTool[], name: string): RegisteredTool {
  const registered = tools.find((value) => value.metadata.name === name);
  assert.ok(registered, `missing ${name}`);
  return registered;
}

describe("createMemoryModule", () => {
  for (const sourceQuote of [undefined, "记住我刚才说的那条。", "我喝咖啡不加糖。"] as const) {
    it(`current-source excerpt: rejects earlier facts with sourceQuote=${sourceQuote ?? "omitted"}`, async () => {
      const { store, calls } = createStore();
      const add = toolByName(setupTools(store, async () => [textMessage("earlier", "user", "我喝咖啡不加糖。")], {
        threadId: "thread-a", getCurrentUserMessage: () => textMessage("current", "user", "记住我刚才说的那条。"),
      }), "memory_add").tool;
      const result = await add.execute!({ text: "我喝咖啡不加糖。", ...(sourceQuote === undefined ? {} : { sourceQuote }) },
        { toolCallId: "reference-only", messages: [], context: {} });
      assert.equal(result.ok, false, "an earlier fact must not borrow the current request as evidence");
      assert.equal(result.error?.code, "INVALID_INPUT");
      assert.equal(calls.length, 0);
    });
  }

  it("host-bound memory_add ignores model source IDs and validates quotes against only the current user", async () => {
    const { store, calls } = createStore();
    let current: UIMessage | undefined = textMessage("real-current", "user", "请记住，我喝咖啡不加糖。");
    const add = toolByName(setupTools(store, async () => { throw new Error("must not read committed provenance"); }, {
      threadId: "thread-a", getCurrentUserMessage: () => current,
    }), "memory_add").tool;
    const schema = asSchema(add.inputSchema);
    assert.doesNotMatch(JSON.stringify(await schema.jsonSchema), /sourceMessageId/);
    const context = { toolCallId: "host-source", messages: [], context: {} };
    const result = await add.execute!({ text: "咖啡不加糖", sourceMessageId: "invented", sourceQuote: "咖啡不加糖" }, context);
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0]?.args[0], { text: "咖啡不加糖", source: {
      kind: "conversation", threadId: "thread-a", messageId: "real-current", quote: "咖啡不加糖",
    } });
    assert.equal((await add.execute!({ text: "咖啡加糖", sourceQuote: "咖啡加糖" }, context)).ok, false);
    assert.equal((await add.execute!({ text: "咖啡加糖" }, context)).ok, false, "a current source cannot support rewritten content");
    assert.equal((await add.execute!({ text: "咖啡不加糖", sourceQuote: "请记住" }, context)).ok, false, "the selected quote must contain the saved text");
    assert.equal(calls.length, 1, "a made-up quote must not write");
    current = textMessage("next-user", "user", "请记住，我住在北京。");
    assert.equal((await add.execute!({ text: "住在北京" }, context)).ok, true);
    assert.deepEqual(calls[1]?.args[0], { text: "住在北京", source: {
      kind: "conversation", threadId: "thread-a", messageId: "next-user", quote: "请记住，我住在北京。",
    } });
    for (const invalid of [
      undefined, textMessage("assistant", "assistant", "fact"), textMessage("empty", "user", " "),
      ...["auto-consolidation", "work-task", "automation-skill", "dreaming", "learned-skill-reference"].map(source => ({
        ...textMessage(source, "user", "fact"), metadata: { source },
      })),
    ]) {
      current = invalid;
      assert.equal((await add.execute!({ text: "fact" }, context)).ok, false);
    }
    assert.equal(calls.length, 2, "missing/synthetic sources never fall back to manual or a previous source");
    const cancelled = new AbortController(); cancelled.abort(new Error("cancelled"));
    await assert.rejects(add.execute!({ text: "fact" }, { ...context, abortSignal: cancelled.signal }), /cancelled/);
    assert.equal(calls.length, 2);
  });

  it("raises unknown outcome for non-idempotent writes but returns candidate commit uncertainty for safe receipt replay", async () => {
    const { store } = createStore();
    const uncertain = { ok: false as const, error: { code: "MEMORY_COMMIT_UNCERTAIN" as const, message: "Directory sync failed after rename" } };
    const uncertainStore: WorkspaceMemoryStore = {
      ...store,
      add: async () => uncertain,
      update: async () => uncertain,
      delete: async () => uncertain,
      resolveCandidate: async () => uncertain,
    };
    const tools = setupTools(uncertainStore, undefined, { threadId: "thread-a" });
    const context = { toolCallId: "uncertain-write", messages: [], context: {} };
    for (const [name, input] of [
      ["memory_add", { text: "save preference" }],
      ["memory_update", { id: "one", expectedRevision: 1, text: "corrected preference" }],
      ["memory_delete", { id: "one" }],
    ] as const) {
      await assert.rejects(toolByName(tools, name).tool.execute!(input, context), (error: unknown) => {
        assert.ok(error instanceof AgentError);
        assert.equal(error.data.code, "TOOL_OUTCOME_UNKNOWN");
        assert.equal(error.data.retryable, false);
        assert.equal(error.data.phase, "tool");
        assert.match(error.message, /Read the saved memory or candidate receipt/);
        return true;
      });
    }
    const accept = toolByName(tools, "memory_apply_candidate");
    assert.equal(accept.metadata.idempotent, true);
    assert.deepEqual(await accept.tool.execute!({ candidateId: "candidate", expectedCandidateRevision: 1 }, context), uncertain);
  });

  it("keeps definite Memory write rejections as ordinary structured failures", async () => {
    const { store } = createStore();
    const rejected = { ok: false as const, error: { code: "MEMORY_REVISION_CONFLICT" as const, message: "Revision changed before commit" } };
    const rejectingStore: WorkspaceMemoryStore = {
      ...store,
      add: async () => rejected,
      update: async () => rejected,
      delete: async () => rejected,
      resolveCandidate: async () => rejected,
    };
    const tools = setupTools(rejectingStore, undefined, { threadId: "thread-a" });
    const context = { toolCallId: "rejected-write", messages: [], context: {} };
    for (const [name, input] of [
      ["memory_add", { text: "save preference" }],
      ["memory_update", { id: "one", expectedRevision: 1, text: "corrected preference" }],
      ["memory_delete", { id: "one" }],
      ["memory_apply_candidate", { candidateId: "candidate", expectedCandidateRevision: 1 }],
    ] as const) assert.deepEqual(await toolByName(tools, name).tool.execute!(input, context), rejected);
  });

  it("binds current projection reads and fallback consolidation to the module Thread and clock", async () => {
    const { store } = createStore();
    const now = new Date("2026-10-01T00:00:00.000Z");
    const observed: Array<{ method: string; options: MemoryWriteOptions | undefined }> = [];
    const projectionStore: WorkspaceMemoryStore = {
      ...store,
      list: async (signal, options) => { observed.push({ method: "list", options }); return store.list(signal, options); },
      get: async (id, signal, options) => { observed.push({ method: "get", options }); return store.get(id, signal, options); },
    };
    const tools = setupTools(projectionStore, async () => [textMessage("source", "user", "pnpm")], { threadId: "thread-a", now: () => now });
    const context = { toolCallId: "projection-read", messages: [], context: {} };
    await toolByName(tools, "memory_list").tool.execute!({}, context);
    await toolByName(tools, "memory_get").tool.execute!({ id: "one" }, context);
    await toolByName(tools, "memory_prepare_consolidation").tool.execute!({}, context);
    assert.deepEqual(observed, [
      { method: "list", options: { boundThreadId: "thread-a", now } },
      { method: "get", options: { boundThreadId: "thread-a", now } },
      { method: "list", options: { boundThreadId: "thread-a", now } },
    ]);
  });

  it("routes stable candidate ids through the Store with the current Thread and clock", async () => {
    const { store } = createStore();
    const now = new Date("2026-10-01T00:00:00.000Z");
    const calls: unknown[][] = [];
    const candidateStore: WorkspaceMemoryStore = {
      ...store,
      listCandidates: async (input, _signal, options) => {
        calls.push(["list", input, options]);
        return { ok: true, value: { candidates: [], nextOffset: null, truncated: false } };
      },
      resolveCandidate: async (input, _signal, options) => {
        calls.push(["apply", input, options]);
        return { ok: true, value: { candidateId: input.candidateId, status: "accepted", memoryId: "saved", memoryRevision: 1, replayed: false } };
      },
    };
    const tools = setupTools(candidateStore, undefined, { threadId: "thread-a", now: () => now });
    const context = { toolCallId: "candidate-tool", messages: [], context: {} };
    await toolByName(tools, "memory_candidates_list").tool.execute!({ status: "pending", offset: 2, limit: 5 }, context);
    const applied = await toolByName(tools, "memory_apply_candidate").tool.execute!({ candidateId: "stable-id", expectedCandidateRevision: 1 }, context);
    assert.deepEqual(calls, [
      ["list", { status: "pending", offset: 2, limit: 5 }, { boundThreadId: "thread-a", now }],
      ["apply", { candidateId: "stable-id", expectedCandidateRevision: 1, decision: "accept" }, { boundThreadId: "thread-a", now }],
    ]);
    assert.equal(applied.ok && applied.value.memoryId, "saved");
  });

  it("stages through the run service and forbids model-owned state, Thread ids and pinned fields", async () => {
    const { store } = createStore();
    const calls: unknown[] = [];
    const consolidation = {
      stage: async (input: { batchId: string; proposals: unknown[] }) => {
        calls.push(input);
        return { ok: true, value: { staged: true, batchId: input.batchId, count: input.proposals.length } };
      },
    } as unknown as MemoryConsolidation;
    const tools = setupTools(store, async () => [], { threadId: "thread-a", consolidation });
    const stage = toolByName(tools, "memory_stage_candidates");
    assert.deepEqual(stage.metadata, { name: "memory_stage_candidates", version: "1", risk: "read", timeoutMs: 1_000, idempotent: false });
    const schema = asSchema(stage.tool.inputSchema);
    const proposal = { action: "add", text: "concise reports", sourceMessageId: "source", sourceQuote: "concise reports", reason: "Explicit preference", scope: { kind: "thread" } };
    assert.equal((await schema.validate?.({ batchId: "batch", proposals: [proposal] }))?.success, true);
    assert.equal((await schema.validate?.({ batchId: "batch", proposals: [] }))?.success, true);
    for (const invalid of [
      { batchId: "batch", proposals: [proposal], originThreadId: "other" },
      { batchId: "batch", proposals: [{ ...proposal, scope: { kind: "thread", threadId: "other" } }] },
      { batchId: "batch", proposals: [{ ...proposal, pinned: true }] },
      { batchId: "batch", proposals: [{ ...proposal, status: "accepted" }] },
      { batchId: "batch", proposals: [{ ...proposal, id: "chosen-by-model" }] },
      { batchId: "batch", proposals: Array.from({ length: 6 }, () => proposal) },
      { batchId: "batch", proposals: [{ ...proposal, action: "update", memoryId: "one" }] },
    ]) assert.equal((await schema.validate?.(invalid))?.success, false);
    const context = { toolCallId: "stage", messages: [], context: {} };
    const staged = await stage.tool.execute!({ batchId: "batch", proposals: [] }, context);
    assert.deepEqual(staged, { ok: true, value: { staged: true, batchId: "batch", count: 0 } });
    assert.deepEqual(calls, [{ batchId: "batch", proposals: [] }]);
    const applySchema = asSchema(toolByName(tools, "memory_apply_candidate").tool.inputSchema);
    for (const invalid of [
      { candidateId: "candidate", expectedCandidateRevision: 1, decision: "reject" },
      { candidateId: "candidate", expectedCandidateRevision: 1, threadId: "other" },
      { candidateId: "candidate" },
    ]) assert.equal((await applySchema.validate?.(invalid))?.success, false);
    const listSchema = asSchema(toolByName(tools, "memory_candidates_list").tool.inputSchema);
    assert.equal((await listSchema.validate?.({ threadId: "other" }))?.success, false);
    assert.equal((await listSchema.validate?.({ limit: 51 }))?.success, false);
  });

  it("paginates visible memories and keeps private current and historical versions out of model tools", async () => {
    const { store } = createStore();
    const privateEntry: MemoryEntry = { ...entry("private", "other Thread secret"), scope: { kind: "thread", threadId: "thread-b" } };
    const visibleEntry: MemoryEntry = {
      ...entry("visible", "current shared fact"), scope: { kind: "workspace" },
      history: [{ revision: 1, text: "old Thread secret", status: "active", scope: { kind: "thread", threadId: "thread-b" }, source: { kind: "manual" }, expiresAt: null, changedAt: "2026-09-01T00:00:00.000Z" }],
    };
    const readingStore: WorkspaceMemoryStore = {
      ...store,
      list: async () => ({ ok: true, entries: [privateEntry, visibleEntry, entry("last", "final shared fact")] }),
      get: async (id) => ({ ok: true, entry: id === "private" ? privateEntry : visibleEntry }),
    };
    const tools = setupTools(readingStore, undefined, { threadId: "thread-a" });
    const context = { toolCallId: "visible-list", messages: [], context: {} };
    const list = toolByName(tools, "memory_list").tool;
    const first = await list.execute!({ limit: 1 }, context);
    assert.deepEqual(first, { ok: true, entries: [{ ...entry("visible", "current shared fact"), scope: { kind: "workspace" } }], nextOffset: 1, truncated: true });
    assert.deepEqual(await list.execute!({ offset: 1, limit: 1 }, context), { ok: true, entries: [entry("last", "final shared fact")], nextOffset: null, truncated: false });
    const get = toolByName(tools, "memory_get").tool;
    const hidden = await get.execute!({ id: "private" }, context);
    assert.equal(!hidden.ok && hidden.error.code, "MEMORY_ENTRY_NOT_FOUND");
    const visible = await get.execute!({ id: "visible" }, context);
    assert.equal(JSON.stringify(visible).includes("old Thread secret"), false);
    assert.equal(visible.ok && visible.entry.history?.length, 0);
  });

  it("pages by final serialized bytes without truncating entries", async () => {
    const { store } = createStore();
    const entries = Array.from({ length: 20 }, (_, index) => entry(`memory-${index}`, "长".repeat(650)));
    const tools = setupTools({ ...store, list: async () => ({ ok: true, entries }) });
    const page = await toolByName(tools, "memory_list").tool.execute!({ limit: 20 }, { toolCallId: "byte-page", messages: [], context: {} });
    assert.equal(page.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 16 * 1024);
    assert.equal(page.truncated, true);
    assert.equal(page.nextOffset, page.entries.length);
    assert.equal(page.entries[0]?.text, entries[0]?.text);
    assert.ok(page.entries.length > 0 && page.entries.length < 20);
  });
  it("exposes a top-level object input schema for provider tool calling", async () => {
    const { store } = createStore();
    const prepare = toolByName(setupTools(store, async () => []), "memory_prepare_consolidation").tool;
    const providerSchema = await asSchema(prepare.inputSchema).jsonSchema;
    assert.equal(providerSchema.type, "object");
    const invalid = await asSchema(prepare.inputSchema).validate?.({ mode: "incremental", turns: 1 });
    assert.equal(invalid?.success, false);
  });

  it("registers the memory tools with the frozen metadata", () => {
    const { store } = createStore();
    const tools = setupTools(store);

    assert.deepEqual(
      tools.map(({ metadata }) => metadata),
      [
        {
          name: "memory_list",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "memory_get",
          version: "1",
          risk: "read",
          timeoutMs: 1_000,
          idempotent: true,
        },
        {
          name: "memory_add",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: false,
        },
        {
          name: "memory_update",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: false,
        },
        {
          name: "memory_delete",
          version: "1",
          risk: "write",
          timeoutMs: 1_000,
          idempotent: false,
        },
        { name: "memory_candidates_list", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
        { name: "memory_apply_candidate", version: "1", risk: "write", timeoutMs: 1_000, idempotent: true },
      ],
    );
  });

  it("validates the required add and update inputs", () => {
    const { store } = createStore();
    const tools = setupTools(store);
    const addInput = toolByName(tools, "memory_add").tool.inputSchema as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    const updateInput = toolByName(tools, "memory_update").tool.inputSchema as unknown as {
      safeParse(value: unknown): { success: boolean };
    };

    assert.equal(addInput.safeParse({ text: "   " }).success, false);
    assert.equal(addInput.safeParse({ text: "remember this" }).success, true);
    assert.equal(addInput.safeParse({ text: "thread memory", scope: { kind: "thread" } }).success, true);
    assert.equal(addInput.safeParse({ text: "thread memory", scope: { kind: "thread", threadId: "thread-a" } }).success, false);
    assert.equal(addInput.safeParse({ text: "remember this", sourceMessageId: "user-1" }).success, false);
    assert.equal(addInput.safeParse({ text: "remember this", sourceMessageId: "user-1", sourceQuote: "remember this" }).success, true);
    assert.equal(addInput.safeParse({ text: "remember this", sourceQuote: "remember this" }).success, false);
    assert.equal(addInput.safeParse({ text: "remember this", sourceMessageId: "" }).success, false);
    assert.equal(updateInput.safeParse({ id: "one" }).success, false);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, enabled: false }).success, true);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, scope: { kind: "thread" } }).success, true);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, scope: { kind: "thread", threadId: "other" } }).success, false);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, text: "new", sourceMessageId: "user-1" }).success, false);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, text: "new", sourceMessageId: "user-1", sourceQuote: "new" }).success, true);
    assert.equal(updateInput.safeParse({ id: "one", text: "   " }).success, false);
  });

  it("registers consolidation only when a bound message reader is supplied", () => {
    const { store } = createStore();
    const tools = setupTools(store, async () => []);
    assert.equal(tools.length, 8);
    assert.deepEqual(toolByName(tools, "memory_prepare_consolidation").metadata, {
      name: "memory_prepare_consolidation",
      version: "1",
      risk: "read",
      timeoutMs: 1_000,
      idempotent: true,
    });
  });

  it("validates consolidation turns and rejects unbound identifiers", () => {
    const { store } = createStore();
    const consolidation = toolByName(
      setupTools(store, async () => []),
      "memory_prepare_consolidation",
    ).tool;
    const input = consolidation.inputSchema as unknown as {
      safeParse(value: unknown): { success: boolean };
    };

    assert.equal(input.safeParse({}).success, true);
    assert.equal(input.safeParse({ turns: 1 }).success, true);
    assert.equal(input.safeParse({ turns: 8 }).success, true);
    assert.equal(input.safeParse({ mode: "incremental" }).success, true);
    assert.equal(input.safeParse({ mode: "incremental", turns: 1 }).success, false);
    assert.equal(input.safeParse({ turns: 0 }).success, false);
    assert.equal(input.safeParse({ turns: 9 }).success, false);
    assert.equal(input.safeParse({ turns: 1.5 }).success, false);
    assert.equal(input.safeParse({ turns: 1, threadId: "other" }).success, false);
    assert.equal(input.safeParse({ path: ".runloom/memory.json" }).success, false);

    const context = { toolCallId: "memory-invalid", messages: [], context: {} };
    return assert.doesNotReject(async () => {
      assert.deepEqual(await consolidation.execute!({ turns: 0 }, context), {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "turns must be an integer from 1 to 8",
        },
      });
    });
  });

  it("routes all CRUD calls through the same store instance", async () => {
    const { store, calls } = createStore();
    const tools = setupTools(store);
    const context = { toolCallId: "memory-test", messages: [], context: {} };

    assert.deepEqual(
      await toolByName(tools, "memory_list").tool.execute!({}, context),
      { ok: true, entries: [entry("one", "pnpm")], nextOffset: null, truncated: false },
    );
    assert.deepEqual(
      await toolByName(tools, "memory_add").tool.execute!({ text: "use vitest", enabled: false }, context),
      { ok: true, entry: entry("two", "use vitest", false) },
    );
    assert.deepEqual(
      await toolByName(tools, "memory_update").tool.execute!({ id: "one", expectedRevision: 1, enabled: false }, context),
      { ok: true, entry: entry("one", "pnpm", false) },
    );
    assert.deepEqual(
      await toolByName(tools, "memory_delete").tool.execute!({ id: "two" }, context),
      { ok: true, id: "two" },
    );

    assert.deepEqual(calls, [
      { method: "list", args: [] },
      { method: "add", args: [{ text: "use vitest", enabled: false }] },
      { method: "update", args: ["one", { expectedRevision: 1, enabled: false }] },
      { method: "delete", args: ["two"] },
    ]);
  });

  it("routes memory_get to store.get and passes MEMORY_ENTRY_NOT_FOUND through", async () => {
    const { store, calls } = createStore();
    const get = toolByName(setupTools(store), "memory_get").tool;
    const context = { toolCallId: "memory-get", messages: [], context: {} };

    assert.deepEqual(await get.execute!({ id: "one" }, context), {
      ok: true,
      entry: entry("one", "pnpm"),
    });
    assert.deepEqual(await get.execute!({ id: "missing" }, context), {
      ok: false,
      error: { code: "MEMORY_ENTRY_NOT_FOUND", message: "Memory not found" },
    });
    assert.deepEqual(calls, [
      { method: "get", args: ["one"] },
      { method: "get", args: ["missing"] },
    ]);
  });

  it("returns history and a conversation quote while list still omits history", async () => {
    const { store, calls } = createStore();
    const stored: MemoryEntry = {
      id: "one",
      text: "short plans",
      enabled: true,
      status: "active",
      scope: { kind: "workspace" },
      source: {
        kind: "conversation",
        threadId: "thread-a",
        messageId: "user-1",
        quote: "I prefer short plans",
      },
      revision: 2,
      history: [{
        revision: 1,
        text: "previous fact",
        status: "active",
        scope: { kind: "workspace" },
        expiresAt: null,
        source: { kind: "manual" },
        changedAt: "2026-09-01T00:00:00.000Z",
      }],
    };
    const readingStore = {
      ...store,
      list: async () => {
        calls.push({ method: "list", args: [] });
        return { ok: true as const, entries: [stored] };
      },
      get: async (id: string) => {
        calls.push({ method: "get", args: [id] });
        return id === stored.id
          ? { ok: true as const, entry: stored }
          : { ok: false as const, error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: "Memory not found" } };
      },
    } satisfies WorkspaceMemoryStore;
    const tools = setupTools(readingStore);
    const context = { toolCallId: "memory-get-history", messages: [], context: {} };

    assert.deepEqual(
      await toolByName(tools, "memory_get").tool.execute!({ id: "one" }, context),
      { ok: true, entry: stored },
    );
    assert.deepEqual(
      await toolByName(tools, "memory_list").tool.execute!({}, context),
      {
        ok: true,
        entries: [{
          id: "one",
          text: "short plans",
          enabled: true,
          status: "active",
          scope: { kind: "workspace" },
          source: stored.source,
          revision: 2,
        }],
        nextOffset: null,
        truncated: false,
      },
    );
    assert.deepEqual(calls, [
      { method: "get", args: ["one"] },
      { method: "list", args: [] },
    ]);
  });

  it("passes store failures through unchanged", async () => {
    const failure = new Error("memory storage unavailable");
    const { store } = createStore();
    const failingStore = {
      ...store,
      list: async () => { throw failure; },
    } satisfies WorkspaceMemoryStore;
    const list = toolByName(setupTools(failingStore), "memory_list").tool;

    await assert.rejects(
      list.execute!({}, { toolCallId: "memory-failure", messages: [], context: {} }),
      failure,
    );
  });

  it("prepares recent committed text turns and all memories without writing", async () => {
    const { store, calls } = createStore();
    const committed: UIMessage[] = [
      textMessage("prefix", "assistant", "ignore prefix"),
      textMessage("u1", "user", "old user"),
      textMessage("a1", "assistant", "old answer"),
      textMessage("u2", "user", "keep user"),
      textMessage("a2", "assistant", "keep answer"),
      textMessage("u3", "user", ""),
      toolOnlyMessage("a3"),
      textMessage("u4", "user", "latest user"),
      textMessage("a4", "assistant", "latest answer"),
    ];
    const consolidation = toolByName(
      setupTools(store, async () => committed),
      "memory_prepare_consolidation",
    ).tool;

    const result = await consolidation.execute!(
      { turns: 3 },
      { toolCallId: "memory-consolidation", messages: [], context: {} },
    );

    assert.deepEqual(result, {
      ok: true,
      turns: [
        {
          messages: [
            { id: "u2", role: "user", text: "keep user" },
          ],
        },
        {
          messages: [
            { id: "u4", role: "user", text: "latest user" },
          ],
        },
      ],
      memories: [{ id: "one", text: "pnpm", enabled: true }],
    });
    assert.deepEqual(calls, [{ method: "list", args: [] }]);
  });

  it("prepares incremental user, assistant, and tool evidence without writing", async () => {
    const { store, calls } = createStore();
    const committed: UIMessage[] = [
      textMessage("u1", "user", "keep one agent"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "I will compare the options." },
          {
            type: "dynamic-tool",
            toolName: "web_search",
            toolCallId: "search-1",
            state: "output-available",
            input: { query: "agent architecture" },
            output: { ok: true, results: ["multi-agent article"] },
          },
        ],
      } as UIMessage,
    ];
    const consolidation = toolByName(
      setupTools(store, async () => committed, { threadId: "thread-a" }),
      "memory_prepare_consolidation",
    ).tool;

    const result = await consolidation.execute!(
      { mode: "incremental" },
      {
        toolCallId: "memory-incremental",
        messages: [],
        context: { agentId: AUTO_CONSOLIDATION_AGENT_ID },
      },
    );

    assert.deepEqual(result, {
      ok: true,
      bootstrap: true,
      turns: [{
        user: { messageId: "u1", text: "keep one agent" },
        assistant: [{ messageId: "a1", text: "I will compare the options." }],
        tools: [{
          toolCallId: "search-1",
          toolName: "web_search",
          outcome: "success",
          content: JSON.stringify({ ok: true, results: ["multi-agent article"] }),
          truncated: false,
        }],
      }],
      memories: [{ id: "one", text: "pnpm", enabled: true }],
    });
    assert.deepEqual(calls, [{ method: "list", args: [] }]);
  });

  it("rejects incremental consolidation outside the automatic consolidator", async () => {
    const { store } = createStore();
    const consolidation = toolByName(
      setupTools(store, async () => [textMessage("u1", "user", "keep one agent")]),
      "memory_prepare_consolidation",
    ).tool;

    assert.deepEqual(
      await consolidation.execute!(
        { mode: "incremental" },
        { toolCallId: "memory-incremental-denied", messages: [], context: {} },
      ),
      {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message: "mode incremental is only allowed for the automatic consolidator",
        },
      },
    );
  });

  it("includes disabled memories and fails the run before sending oversized material", async () => {
    const { store } = createStore();
    const listedStore = {
      ...store,
      list: async () => ({
        ok: true as const,
        entries: [entry("one", "pnpm"), entry("disabled", "keep disabled", false)],
      }),
    } satisfies WorkspaceMemoryStore;
    const consolidation = toolByName(
      setupTools(listedStore, async () => [
        textMessage("large", "user", "x".repeat(CONSOLIDATION_RESULT_MAX_BYTES)),
      ]),
      "memory_prepare_consolidation",
    ).tool;

    await assert.rejects(
      () => consolidation.execute!(
        {},
        { toolCallId: "memory-too-large", messages: [], context: {} },
      ),
      (error: unknown) =>
        error instanceof AgentError &&
        error.data.code === "CONTEXT_PREPARE_FAILED" &&
        error.data.message.includes("exceed the consolidation input limit"),
    );
  });

  it("keeps disabled and expired current memories but excludes another thread during consolidation", async () => {
    const { store } = createStore();
    const listedStore = {
      ...store,
      list: async () => ({
        ok: true as const,
        entries: [
          {
            ...entry("workspace-disabled", "old workspace decision", false),
            status: "disabled" as const,
            scope: { kind: "workspace" as const },
          },
          {
            ...entry("workspace-expired", "expired workspace constraint"),
            status: "active" as const,
            scope: { kind: "workspace" as const },
            expiresAt: "2026-01-01T00:00:00.000Z",
          },
          {
            ...entry("current-thread", "current thread decision"),
            status: "active" as const,
            scope: { kind: "thread" as const, threadId: "thread-a" },
          },
          {
            ...entry("other-thread", "private other thread decision"),
            status: "active" as const,
            scope: { kind: "thread" as const, threadId: "thread-b" },
          },
        ],
      }),
    } satisfies WorkspaceMemoryStore;
    const consolidation = toolByName(
      setupTools(listedStore, async () => [textMessage("u1", "user", "new decision")], {
        threadId: "thread-a",
      }),
      "memory_prepare_consolidation",
    ).tool;

    const result = await consolidation.execute!(
      {},
      { toolCallId: "memory-scope-consolidation", messages: [], context: {} },
    );

    assert.equal(result.ok, true);
    if (!result.ok) assert.fail("expected consolidation to succeed");
    assert.deepEqual(result.memories.map(({ id }: MemoryEntry) => id), [
      "workspace-disabled",
      "workspace-expired",
      "current-thread",
    ]);
    assert.equal(result.memories[0]?.status, "disabled");
    assert.equal(result.memories[1]?.expiresAt, "2026-01-01T00:00:00.000Z");
    assert.equal(JSON.stringify(result).includes("private other thread decision"), false);
  });

  it("keeps the legacy 32-entry material fixture within its old context budget", async () => {
    const { store } = createStore();
    const listedStore = {
      ...store,
      list: async () => ({
        ok: true as const,
        entries: Array.from({ length: 32 }, (_, index) =>
          entry(`memory-${index}`, String.fromCharCode(97 + (index % 26)).repeat(MEMORY_ENTRY_MAX_BYTES)),
        ),
      }),
    } satisfies WorkspaceMemoryStore;
    const committed = Array.from({ length: MAX_CONSOLIDATION_TURNS }, (_, index) => [
      textMessage(`u${index}`, "user", "u".repeat(MEMORY_ENTRY_MAX_BYTES)),
      textMessage(`a${index}`, "assistant", "a".repeat(MEMORY_ENTRY_MAX_BYTES)),
    ]).flat();
    const consolidation = toolByName(
      setupTools(listedStore, async () => committed),
      "memory_prepare_consolidation",
    ).tool;

    const result = await consolidation.execute!(
      {},
      { toolCallId: "memory-near-context-limit", messages: [], context: {} },
    );

    assert.equal(result.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_CONTEXT_BYTES);
  });

  it("passes message-reader failures and cancellation through", async () => {
    const { store } = createStore();
    const readFailure = new Error("transcript unavailable");
    const consolidation = toolByName(
      setupTools(store, async () => { throw readFailure; }),
      "memory_prepare_consolidation",
    ).tool;
    assert.deepEqual(
      await consolidation.execute!({}, { toolCallId: "memory-read-failure", messages: [], context: {} }),
      { ok: false, error: { code: "READ_FAILED", message: readFailure.message } },
    );

    const abortController = new AbortController();
    const abortError = new Error("cancelled");
    abortController.abort(abortError);
    const cancelled = toolByName(
      setupTools(store, async () => []),
      "memory_prepare_consolidation",
    ).tool;
    await assert.rejects(
      cancelled.execute!(
        {},
        {
          toolCallId: "memory-cancelled",
          messages: [],
          context: {},
          abortSignal: abortController.signal,
        },
      ),
      abortError,
    );
  });

  it("binds thread scope to the active thread and omits revision history", async () => {
    const now = new Date("2026-09-22T00:00:00.000Z");
    const calls: unknown[][] = [];
    const listed = entry("one", "current");
    listed.history = [{
      revision: 1,
      text: "previous fact",
      status: "active",
      scope: { kind: "workspace" },
      expiresAt: null,
      source: { kind: "manual" },
      changedAt: "2026-09-01T00:00:00.000Z",
    }];
    const store = {
      ...candidateStubs,
      async list() {
        return { ok: true as const, entries: [listed] };
      },
      async get(id: string) {
        return {
          ok: false as const,
          error: { code: "MEMORY_ENTRY_NOT_FOUND" as const, message: id },
        };
      },
      async add(input: MemoryAddInput, _signal?: AbortSignal, options?: MemoryWriteOptions) {
        calls.push(["add", input, options]);
        return {
          ok: true as const,
          entry: {
            ...listed,
            id: "two",
            text: input.text,
            ...(input.scope === undefined ? {} : { scope: input.scope }),
          },
        };
      },
      async update() {
        return { ok: true as const, entry: listed };
      },
      async delete(id: string) {
        return { ok: true as const, id };
      },
    } satisfies WorkspaceMemoryStore;
    const context = { toolCallId: "bind", messages: [], context: {} };
    const tools = setupTools(store, async () => [], { threadId: "thread-a", now: () => now });

    const listedResult = await toolByName(tools, "memory_list").tool.execute!({}, context);
    assert.equal(JSON.stringify(listedResult).includes("previous fact"), false);
    const prepared = await toolByName(tools, "memory_prepare_consolidation").tool.execute!({}, context);
    assert.equal(JSON.stringify(prepared).includes("previous fact"), false);

    const saved = await toolByName(tools, "memory_add").tool.execute!(
      { text: "thread only", scope: { kind: "thread" } },
      context,
    );
    assert.deepEqual(calls, [[
      "add",
      { text: "thread only", scope: { kind: "thread", threadId: "thread-a" } },
      { boundThreadId: "thread-a", now },
    ]]);
    assert.equal(JSON.stringify(saved).includes("previous fact"), false);

    const unbound = await toolByName(setupTools(store), "memory_add").tool.execute!(
      { text: "thread only", scope: { kind: "thread" } },
      context,
    );
    assert.equal(unbound.ok, false);
    if (!unbound.ok) assert.equal(unbound.error.code, "INVALID_INPUT");
  });

  it("binds conversation provenance to a committed user message before writing", async () => {
    const { store, calls } = createStore();
    const committed: UIMessage[] = [
      textMessage("user-1", "user", "Remember that I prefer short plans"),
      textMessage("assistant-1", "assistant", "I suggest a short plan"),
      { ...textMessage("auto-1", "user", "自动整理"), metadata: { source: "auto-consolidation" } },
      textMessage("empty-1", "user", ""),
      toolOnlyMessage("tool-1"),
    ];
    const tools = setupTools(store, async () => committed, { threadId: "thread-a" });
    const context = { toolCallId: "provenance", messages: [], context: {} };
    const add = toolByName(tools, "memory_add").tool;
    const update = toolByName(tools, "memory_update").tool;

    const saved = await add.execute!({ text: "short plans", sourceMessageId: "user-1", sourceQuote: "short plans" }, context);
    assert.equal(saved.ok, true);
    assert.deepEqual(calls[0], {
      method: "add",
      args: [{ text: "short plans", source: { kind: "conversation", threadId: "thread-a", messageId: "user-1", quote: "short plans" } }],
    });
    await update.execute!({ id: "one", expectedRevision: 1, text: "concise plans", sourceMessageId: "user-1", sourceQuote: "I prefer short plans" }, context);
    assert.deepEqual(calls[1], {
      method: "update",
      args: ["one", { expectedRevision: 1, text: "concise plans", source: { kind: "conversation", threadId: "thread-a", messageId: "user-1", quote: "I prefer short plans" } }],
    });
    const mismatched = await add.execute!({ text: "concise plans", sourceMessageId: "user-1", sourceQuote: "concise plans" }, context);
    assert.deepEqual(mismatched, {
      ok: false,
      error: { code: "INVALID_INPUT", message: "sourceQuote must be an exact substring of that committed user message" },
    });

    for (const sourceMessageId of ["assistant-1", "auto-1", "empty-1", "tool-1", "missing"]) {
      const rejected = await add.execute!({ text: "wrong", sourceMessageId, sourceQuote: "wrong" }, context);
      assert.deepEqual(rejected, {
        ok: false,
        error: { code: "INVALID_INPUT", message: "sourceMessageId must identify a committed user message in the active thread" },
      });
    }
    assert.equal(calls.length, 2);
  });

  it("rejects unbound or unreadable conversation provenance without writing", async () => {
    const { store, calls } = createStore();
    const context = { toolCallId: "provenance", messages: [], context: {} };
    const unbound = toolByName(setupTools(store, async () => [textMessage("u", "user", "fact")]), "memory_add").tool;
    const result = await unbound.execute!({ text: "fact", sourceMessageId: "u", sourceQuote: "fact" }, context);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_INPUT");

    const unreadable = toolByName(setupTools(store, async () => { throw new Error("transcript unavailable"); }, { threadId: "thread-a" }), "memory_update").tool;
    assert.deepEqual(
      await unreadable.execute!({ id: "one", expectedRevision: 1, text: "fact", sourceMessageId: "u", sourceQuote: "fact" }, context),
      { ok: false, error: { code: "READ_FAILED", message: "transcript unavailable" } },
    );
    assert.deepEqual(calls, []);
  });
});
