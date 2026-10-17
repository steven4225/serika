import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import {
  createReferenceAssembler,
  latestInvocation,
  preparePrimaryContext,
  REFERENCE_SLOTS,
  routeModelContext,
  type ModelContextRoutes,
  type PrimaryContextObserver,
  type ReferenceSlot,
  type ReferenceSource,
} from "./context-assembler.js";
import { AUTO_CONSOLIDATION_SOURCE } from "./consolidation.js";

const text = (id: string, role: "user" | "assistant", body = id, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role, parts: [{ type: "text", text: body }], ...(metadata ? { metadata } : {}) }) as UIMessage;
const ref = (slot: ReferenceSlot): UIMessage => text(`ref:${slot}`, "user", slot, { source: slot });
const signal = new AbortController().signal;
const ids = (messages: readonly UIMessage[]) => messages.map(message => message.id);

function routes(calls: string[]): ModelContextRoutes {
  return {
    primaryAgentId: "calculator",
    dreamingAgentId: "dreaming",
    consolidationAgentId: "consolidation",
    isTextSkill: agentId => agentId === "skill:text",
    primary: async messages => { calls.push("primary"); return messages; },
  };
}

describe("routeModelContext", () => {
  const history = [
    text("u1", "user", "old", { source: "dreaming" }), text("a1", "assistant"),
    text("u2", "user", "invoke", { source: "automation-skill" }), text("a2", "assistant"),
    text("u3", "user", "batch", { source: "dreaming" }), text("a3", "assistant"),
    text("u4", "user", "current"),
  ];

  it("gives dreaming only its latest batch and a text Skill only its current invocation", async () => {
    const calls: string[] = [];
    assert.deepEqual(ids(await routeModelContext(routes(calls), { messages: history, signal, agentId: "dreaming" })), ["u3", "a3", "u4"]);
    assert.deepEqual(ids(await routeModelContext(routes(calls), { messages: history, signal, agentId: "skill:text" })), ["u2", "a2", "u3", "a3", "u4"]);
    assert.deepEqual(calls, []);
  });

  it("gives automatic consolidation only the current user message", async () => {
    assert.deepEqual(ids(await routeModelContext(routes([]), { messages: history, signal, agentId: "consolidation" })), ["u4"]);
    assert.deepEqual(await routeModelContext(routes([]), { messages: [text("a", "assistant")], signal, agentId: "consolidation" }), []);
  });

  it("returns nothing when the isolated invocation is missing", () => {
    assert.deepEqual(latestInvocation([text("u", "user")], "dreaming"), []);
  });

  it("sends only the primary agent to the primary pipeline", async () => {
    const calls: string[] = [];
    await routeModelContext(routes(calls), { messages: history, signal, agentId: "calculator" });
    await routeModelContext(routes(calls), { messages: history, signal, agentId: "other-skill" });
    assert.deepEqual(calls, ["primary"]);
  });
});

describe("createReferenceAssembler", () => {
  it("collects in source order and emits in the fixed slot order", async () => {
    const collected: string[] = [];
    const source = (name: string, slots: ReferenceSlot[]): ReferenceSource => ({
      name, slots, collect: () => { collected.push(name); return { messages: Object.fromEntries(slots.map(slot => [slot, ref(slot)])) }; },
    });
    const assemble = createReferenceAssembler([
      source("checkpoint", ["resume", "checkpoint"]),
      source("learned", ["learned-skills"]),
      source("memory", ["memory", "memory-context-view"]),
      source("time", ["task-time"]),
      source("work", ["work-task"]),
      source("foreground", ["foreground-task"]),
    ]);
    const result = await assemble([text("u", "user")], signal, true);
    assert.deepEqual(collected, ["checkpoint", "learned", "memory", "time", "work", "foreground"]);
    assert.deepEqual(ids(result.prefix), REFERENCE_SLOTS.map(slot => `ref:${slot}`));
    assert.equal(result.memoryReference, null);
  });

  it("skips empty slots and passes one shared request to every source", async () => {
    const requests: unknown[] = [];
    const assemble = createReferenceAssembler([
      { name: "a", slots: ["checkpoint"], collect: request => { requests.push(request); return { messages: { checkpoint: undefined } }; } },
      { name: "b", slots: ["work-task"], collect: request => { requests.push(request); return { messages: { "work-task": ref("work-task") } }; } },
    ]);
    const consolidation = text("c", "user", "sources", { source: AUTO_CONSOLIDATION_SOURCE });
    const result = await assemble([text("u1", "user", "hello"), consolidation], signal);
    assert.deepEqual(ids(result.prefix), ["ref:work-task"]);
    assert.equal(requests[0], requests[1]);
    // The current user is the latest non-consolidation message.
    const request = requests[0] as { primary: boolean; query: string; user: UIMessage };
    assert.equal(request.primary, false);
    assert.equal(request.user.id, "u1");
    assert.equal(request.query, "hello");
  });

  it("fails the whole preparation when one source throws", async () => {
    const assemble = createReferenceAssembler([
      { name: "a", slots: ["checkpoint"], collect: () => { throw new Error("checkpoint unreadable"); } },
      { name: "b", slots: ["work-task"], collect: () => assert.fail("later sources must not run") },
    ]);
    await assert.rejects(assemble([], signal, true), /checkpoint unreadable/);
  });

  it("rejects a slot claimed twice and a slot filled without a claim", async () => {
    assert.throws(() => createReferenceAssembler([
      { name: "a", slots: ["memory"], collect: () => ({}) },
      { name: "b", slots: ["memory"], collect: () => ({}) },
    ]), /a and b both claim memory/);
    const assemble = createReferenceAssembler([{ name: "a", slots: ["memory"], collect: () => ({ messages: { checkpoint: ref("checkpoint") } }) }]);
    await assert.rejects(assemble([], signal), /a filled unclaimed checkpoint/);
  });
});

describe("preparePrimaryContext", () => {
  const memory = text("runloom-workspace-memory", "user", "memory", { source: "workspace-memory" });
  const time = ref("task-time");
  const conversation = [text("u1", "user"), text("a1", "assistant"), text("u2", "user")];
  const snapshot = { messageId: "u2" } as never;

  function observer(events: string[]): PrimaryContextObserver {
    return {
      passthrough: () => events.push("passthrough"),
      referencesFailed: error => events.push(`references-failed:${(error as Error).message}`),
      compactionFailed: error => events.push(`compaction-failed:${(error as Error).message}`),
      published: reference => events.push(`published:${reference === null ? "null" : "reference"}`),
    };
  }

  it("without a compactor places the memory reference right before the current user message", async () => {
    const events: string[] = [];
    const result = await preparePrimaryContext({
      messages: conversation, signal, currentUserId: "u2", compactor: undefined, observer: observer(events),
      references: async () => ({ prefix: [time, memory], memoryReference: snapshot }),
    });
    assert.deepEqual(ids(result), ["ref:task-time", "u1", "a1", "runloom-workspace-memory", "u2"]);
    assert.deepEqual(events, ["passthrough", "published:reference"]);
  });

  it("with a compactor uses its effective prefix and conversation", async () => {
    const events: string[] = [];
    const prefixes: unknown[] = [];
    const result = await preparePrimaryContext({
      messages: conversation, signal, currentUserId: "u2", observer: observer(events),
      references: async () => ({ prefix: [time, memory], memoryReference: null }),
      compactor: {
        prepare: async (_messages, _signal, force, prefix) => { prefixes.push([force, ids(prefix ?? [])]); return [conversation[2]!]; },
        effectiveReferencePrefix: [time, memory],
      },
    });
    assert.deepEqual(prefixes, [[false, ["ref:task-time", "runloom-workspace-memory"]]]);
    assert.deepEqual(ids(result), ["ref:task-time", "runloom-workspace-memory", "u2"]);
    assert.deepEqual(events, ["published:null"]);
  });

  it("appends the foreground task reference only when its original request is gone", async () => {
    const foreground = text("runloom-foreground-task", "user", "task", { source: "foreground-task", originalMessageId: "u0" });
    const kept = await preparePrimaryContext({
      messages: conversation, signal, currentUserId: "u2", compactor: undefined, observer: observer([]),
      references: async () => ({ prefix: [foreground], memoryReference: null }),
    });
    assert.equal(ids(kept).at(-1), "runloom-foreground-task");
    const present = text("runloom-foreground-task", "user", "task", { source: "foreground-task", originalMessageId: "u1" });
    const dropped = await preparePrimaryContext({
      messages: conversation, signal, currentUserId: "u2", compactor: undefined, observer: observer([]),
      references: async () => ({ prefix: [present], memoryReference: null }),
    });
    assert.equal(ids(dropped).includes("runloom-foreground-task"), false);
  });

  it("reports reference and compaction failures separately and rethrows them", async () => {
    const events: string[] = [];
    await assert.rejects(preparePrimaryContext({
      messages: conversation, signal, currentUserId: "u2", compactor: undefined, observer: observer(events),
      references: async () => { throw new Error("memory unreadable"); },
    }), /memory unreadable/);
    await assert.rejects(preparePrimaryContext({
      messages: conversation, signal, currentUserId: "u2", observer: observer(events),
      references: async () => ({ prefix: [], memoryReference: snapshot }),
      compactor: { prepare: async () => { throw new Error("summary failed"); }, effectiveReferencePrefix: [] },
    }), /summary failed/);
    assert.deepEqual(events, ["references-failed:memory unreadable", "compaction-failed:summary failed"]);
  });
});
