import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { UIMessage } from "ai";
import { MAX_CONSOLIDATION_TURNS } from "../consolidation.js";
import { MAX_CONTEXT_BYTES } from "../context-window.js";
import {
  MEMORY_ENTRY_MAX_BYTES,
  MEMORY_MAX_ENTRIES,
  type MemoryAddInput,
  type MemoryWriteOptions,
} from "../memory-store.js";
import {
  CONSOLIDATION_RESULT_MAX_BYTES,
  createMemoryModule,
  type MemoryEntry,
  type WorkspaceMemoryStore,
} from "./memory-module.js";

function entry(id: string, text: string, enabled = true): MemoryEntry {
  return { id, text, enabled };
}

function createStore(): {
  store: WorkspaceMemoryStore;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const entries = [entry("one", "pnpm")];
  const store = {
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
  options?: { threadId?: string; now?: () => Date },
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  createMemoryModule(store, getMessages, options).setup({
    registerTool: (registered) => tools.push(registered),
    registerCommand: () => {},
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
    assert.equal(tools.length, 6);
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
      { ok: true, entries: [entry("one", "pnpm")] },
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

  it("includes disabled memories and returns a business error before sending oversized material", async () => {
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

    assert.deepEqual(
      await consolidation.execute!(
        {},
        { toolCallId: "memory-too-large", messages: [], context: {} },
      ),
      {
        ok: false,
        error: {
          code: "CONSOLIDATION_INPUT_TOO_LARGE",
          message:
            "Selected conversation and workspace memories exceed the consolidation input limit; reduce the number of turns or shorten existing memories",
        },
      },
    );
  });

  it("accepts the full Stage 5-2 memory capacity together with recent turns", async () => {
    const { store } = createStore();
    const listedStore = {
      ...store,
      list: async () => ({
        ok: true as const,
        entries: Array.from({ length: MEMORY_MAX_ENTRIES }, (_, index) =>
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
