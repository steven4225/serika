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
  it("registers the four memory tools with the frozen metadata", () => {
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
    assert.equal(updateInput.safeParse({ id: "one" }).success, false);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, enabled: false }).success, true);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, scope: { kind: "thread" } }).success, true);
    assert.equal(updateInput.safeParse({ id: "one", expectedRevision: 1, scope: { kind: "thread", threadId: "other" } }).success, false);
    assert.equal(updateInput.safeParse({ id: "one", text: "   " }).success, false);
  });

  it("registers consolidation only when a bound message reader is supplied", () => {
    const { store } = createStore();
    const tools = setupTools(store, async () => []);
    assert.equal(tools.length, 5);
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
            { id: "a2", role: "assistant", text: "keep answer" },
          ],
        },
        {
          messages: [
            { id: "u4", role: "user", text: "latest user" },
            { id: "a4", role: "assistant", text: "latest answer" },
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
});
