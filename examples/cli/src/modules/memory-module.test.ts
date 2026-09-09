import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import {
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
      input: { text?: string; enabled?: boolean },
    ) => {
      calls.push({ method: "update", args: [id, input] });
      const current = entries.find((value) => value.id === id);
      if (!current) {
        throw new Error("Memory not found");
      }
      Object.assign(current, input);
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

function setupTools(store: WorkspaceMemoryStore): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  createMemoryModule(store).setup({
    registerTool: (registered) => tools.push(registered),
    registerCommand: () => {},
    notify: () => {},
  });
  return tools;
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
    assert.equal(updateInput.safeParse({ id: "one" }).success, false);
    assert.equal(updateInput.safeParse({ id: "one", enabled: false }).success, true);
    assert.equal(updateInput.safeParse({ id: "one", text: "   " }).success, false);
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
      await toolByName(tools, "memory_update").tool.execute!({ id: "one", enabled: false }, context),
      { ok: true, entry: entry("one", "pnpm", false) },
    );
    assert.deepEqual(
      await toolByName(tools, "memory_delete").tool.execute!({ id: "two" }, context),
      { ok: true, id: "two" },
    );

    assert.deepEqual(calls, [
      { method: "list", args: [] },
      { method: "add", args: [{ text: "use vitest", enabled: false }] },
      { method: "update", args: ["one", { enabled: false }] },
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
});
