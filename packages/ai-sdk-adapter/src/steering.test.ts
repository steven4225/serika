import assert from "node:assert/strict";
import { it } from "node:test";
import { simulateReadableStream, tool, convertToModelMessages } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { DefaultAgentRuntime, InMemoryAgentCatalog, InMemoryAgentStore, type AgentEvent, type BeforeToolExecute, type BeforeRunFinish } from "@serika/core";
import { AiSdkAgentLoop } from "./loop.js";
import { InMemoryModelRegistry, ToolRegistry } from "./registries.js";

function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const usage = { inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 2, text: 2, reasoning: undefined } };
function response(calls = 0) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(calls ? Array.from({ length: calls }, (_, index) => ({ type: "tool-call" as const, toolCallId: `call-${index}`, toolName: "change", input: '{"value":1}' })) : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "done" }, { type: "text-end" as const, id: "text" }]),
    { type: "finish" as const, finishReason: { unified: calls ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
  ] }) };
}
function fixture(options: { first: () => Promise<ReturnType<typeof response>>; execute?: () => Promise<{ ok: boolean }>;
  beforeToolExecute?: BeforeToolExecute; beforeRunFinish?: BeforeRunFinish; maxSteps?: number; store?: InMemoryAgentStore }) {
  let calls = 0, effects = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV3({ doStream: async request => { prompts.push(request.prompt); return ++calls === 1 ? options.first() : response(); } });
  const tools = new ToolRegistry([{ metadata: { name: "change", version: "1", risk: "write", idempotent: false, timeoutMs: 2000 }, tool: tool({ inputSchema: z.object({ value: z.number() }),
    execute: async () => { effects++; return options.execute ? options.execute() : { ok: true }; } }) }]);
  const store = options.store ?? new InMemoryAgentStore();
  const runtime = new DefaultAgentRuntime({ catalog: new InMemoryAgentCatalog([{ id: "test", version: "1", model: "test", instructions: "test", tools: ["change"],
    limits: { maxSteps: options.maxSteps ?? 4, totalTimeoutMs: 5000, stepTimeoutMs: 2000 } }]), store,
    loop: new AiSdkAgentLoop({ models: new InMemoryModelRegistry({ test: model }), tools }),
    ...(options.beforeToolExecute ? { beforeToolExecute: options.beforeToolExecute } : {}),
    ...(options.beforeRunFinish ? { beforeRunFinish: options.beforeRunFinish } : {}),
  });
  const start = () => runtime.run({ agentId: "test", threadId: "thread", enableSteering: true,
    messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "change file" }] }] });
  return { start, store, prompts, counts: () => ({ calls, effects }) };
}

it("steer waits for in-flight model, suppresses every stale call and preserves model tool pairing", async () => {
  const entered = gate(), release = gate();
  const f = fixture({ first: async () => { entered.resolve(); await release.promise; return response(2); } });
  const handle = await f.start(); await entered.promise;
  assert.equal((await handle.steer!({ id: "steer-1", text: "append only" })).status, "accepted");
  assert.deepEqual(f.counts(), { calls: 1, effects: 0 }); release.resolve();
  const result = await handle.result; assert.equal(result.status, "completed"); assert.equal(result.steps, 2);
  assert.deepEqual(f.counts(), { calls: 2, effects: 0 });
  const messages = await f.store.getMessages("thread");
  assert.equal(messages[2]?.role, "user"); assert.deepEqual(messages[2]?.metadata, { source: "steer", memoryConsolidation: "exclude" });
  const pairs = await convertToModelMessages(messages);
  assert.equal(pairs.filter(message => message.role === "tool").length, 1);
  const events = await f.store.list(handle.runId);
  assert.equal(events.filter(e => e.type === "tool.call.superseded").length, 2);
  assert.ok(events.every((e, index) => e.sequence === index + 1));
  assert.match(JSON.stringify(f.prompts[1]), /append only/);
});

it("steer revokes waiting approval without cancelling Run or granting the stale tool", async () => {
  const entered = gate(); let revoked = false;
  const f = fixture({ first: async () => response(1), beforeToolExecute: async input => {
    entered.resolve(); assert.ok(input.steerSignal); return new Promise((_, reject) => {
      input.steerSignal!.addEventListener("abort", () => { revoked = true; reject(input.steerSignal!.reason); }, { once: true });
    });
  } });
  const handle = await f.start(); await entered.promise;
  await handle.steer!({ id: "steer-1", text: "do not change" });
  assert.equal((await handle.result).status, "completed"); assert.equal(revoked, true); assert.equal(f.counts().effects, 0);
  assert.equal((await f.store.list(handle.runId)).filter(e => e.type === "tool.call.failed").length, 0);
});

it("steer lets dispatched tool settle then suppresses remaining stale batch", async () => {
  const entered = gate(), release = gate();
  const f = fixture({ first: async () => response(2), execute: async () => { entered.resolve(); await release.promise; return { ok: true }; } });
  const handle = await f.start(); await entered.promise;
  await handle.steer!({ id: "steer-1", text: "stop changing" }); assert.equal(f.counts().calls, 1);
  release.resolve(); assert.equal((await handle.result).status, "completed");
  assert.deepEqual(f.counts(), { calls: 2, effects: 1 });
  const events = await f.store.list(handle.runId);
  assert.ok(events.findIndex(e => e.type === "tool.call.completed") < events.findIndex(e => e.type === "run.steer.applied"));
  assert.equal(events.filter(e => e.type === "tool.call.superseded").length, 1);
});

it("steer during the awaited start persistence barrier cannot dispatch stale effect", async () => {
  const entered = gate(), release = gate();
  class BarrierStore extends InMemoryAgentStore {
    override async append(event: AgentEvent) { if (event.type === "tool.call.started") { entered.resolve(); await release.promise; } await super.append(event); }
  }
  const f = fixture({ first: async () => response(1), store: new BarrierStore() });
  const handle = await f.start(); await entered.promise;
  const accepted = handle.steer!({ id: "steer-1", text: "no write" }); release.resolve(); await accepted;
  assert.equal((await handle.result).status, "completed"); assert.equal(f.counts().effects, 0);
  const events = await f.store.list(handle.runId); assert.ok(events.some(e => e.type === "tool.call.started")); assert.ok(events.some(e => e.type === "tool.call.superseded"));
});

it("steer accepted during finish check is applied before terminal seal, late requests remain unapplied", async () => {
  const entered = gate(), release = gate(); let checks = 0;
  const f = fixture({ first: async () => response(), beforeRunFinish: async () => {
    if (++checks === 1) { entered.resolve(); await release.promise; } return { kind: "stop", reason: "delivered" };
  } });
  const handle = await f.start(); await entered.promise;
  await handle.steer!({ id: "steer-1", text: "different answer" }); release.resolve();
  assert.equal((await handle.result).steps, 2); assert.equal(checks, 2);
  assert.deepEqual(await handle.steer!({ id: "late", text: "late" }), { id: "late", status: "not_applied", reason: "closed" });
});

it("steer never increases step budget and exhausted request has not_applied receipt", async () => {
  const entered = gate(), release = gate();
  const f = fixture({ maxSteps: 1, first: async () => { entered.resolve(); await release.promise; return response(); } });
  const handle = await f.start(); await entered.promise;
  await handle.steer!({ id: "steer-1", text: "do more" }); release.resolve();
  assert.equal((await handle.result).steps, 1); assert.equal(f.counts().calls, 1);
  const events = await f.store.list(handle.runId);
  assert.equal(events.filter(e => e.type === "run.steer.applied").length, 0);
  assert.ok(events.some(e => e.type === "run.steer.not_applied" && e.data.reason === "budget_exhausted"));
});

it("cancellation retains an accepted not_applied receipt without dispatch or second model", async () => {
  const entered = gate(), release = gate();
  const f = fixture({ first: async () => { entered.resolve(); await release.promise; return response(1); } });
  const handle = await f.start(); await entered.promise;
  await handle.steer!({ id: "steer-1", text: "different action" }); await handle.cancel(); release.resolve();
  assert.equal((await handle.result).status, "cancelled"); assert.deepEqual(f.counts(), { calls: 1, effects: 0 });
  const events = await f.store.list(handle.runId);
  assert.equal(events.filter(e => e.type === "run.steer.applied").length, 0);
  assert.ok(events.some(e => e.type === "run.steer.not_applied" && e.data.reason === "cancelled"));
  assert.equal((await f.store.getMessages("thread")).length, 0);
});
