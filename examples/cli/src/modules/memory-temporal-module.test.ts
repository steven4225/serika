import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { asSchema, type UIMessage } from "ai";
import { AgentError } from "@aisdk-agent/core";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import { createMemoryStore, type MemoryEntryResult } from "../memory-store.js";
import { createMemoryModule } from "./memory-module.js";
import { createMemoryConsolidation } from "../memory-consolidation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup(messages: UIMessage[] = []) {
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-tools-b-")); roots.push(root);
  const store = createMemoryStore(root);
  const now = new Date("2026-10-04T00:00:00Z");
  const tools: RegisteredTool[] = [];
  const consolidation = createMemoryConsolidation({ store, threadId: "thread-a", now: () => now, getMessages: async () => messages });
  createMemoryModule(store, async () => messages, { threadId: "thread-a", now: () => now, consolidation }).setup({ registerTool: tool => tools.push(tool), registerCommand: () => {}, notify: () => {} });
  const tool = (name: string) => { const found = tools.find(tool => tool.metadata.name === name); assert.ok(found); return found; };
  return { root, store, tool, now, consolidation };
}
const context = { toolCallId: "temporal-test", messages: [], context: {} };
const user = (id: string, text: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });

it("exposes temporal tools only through existing Memory module; revisions retain write confirmation metadata", async () => {
  const { store, tool, now } = await setup([user("first", "原偏好是简洁"), user("second", "现在偏好详细")]);
  assert.deepEqual(tool("memory_revise").metadata, { name: "memory_revise", version: "1", risk: "write", timeoutMs: 1_000, idempotent: false });
  assert.equal(tool("memory_query").metadata.risk, "read");
  const added = await tool("memory_add").tool.execute!({ text: "简洁偏好", kind: "preference", recallTerms: ["答复风格"], sourceMessageId: "first", sourceQuote: "原偏好是简洁" }, context) as MemoryEntryResult;
  assert.ok(added.ok);
  assert.deepEqual(added.entry.assertion?.recallTerms, ["答复风格"]);
  const revised = await tool("memory_revise").tool.execute!({ id: added.entry.id, expectedRevision: 1, operation: "change", text: "详细偏好", effectiveAt: "2026-10-03T00:00:00Z", sources: [{ sourceMessageId: "second", sourceQuote: "现在偏好详细" }] }, context) as MemoryEntryResult;
  assert.ok(revised.ok);
  const queried = await tool("memory_query").tool.execute!({ id: added.entry.id, validAt: "2026-10-02T00:00:00Z" }, context);
  assert.equal((await asSchema(tool("memory_query").tool.outputSchema!).validate!(queried)).success, true);
  assert.match(JSON.stringify(queried), /简洁偏好/);
  const inspected = await store.inspectMemory(added.entry.id, undefined, { boundThreadId: "thread-a", now });
  assert.ok(inspected.ok); assert.equal(inspected.value.assertions.at(-1)?.sources[0]?.kind, "conversation");
});

it("fails forged source and private target before a mutation, and rejects invalid revise input shapes", async () => {
  const { store, tool, now } = await setup([user("proof", "准确原文")]);
  const added = await store.add({ text: "真实偏好", kind: "preference" }, undefined, { now }); assert.ok(added.ok);
  const bad = await tool("memory_revise").tool.execute!({ id: added.entry.id, expectedRevision: 1, operation: "correct", text: "伪造", sources: [{ sourceMessageId: "proof", sourceQuote: "编造原文" }] }, context) as MemoryEntryResult;
  assert.equal(bad.ok, false);
  const unchanged = await store.get(added.entry.id, undefined, { now }); assert.ok(unchanged.ok); assert.equal(unchanged.entry.revision, 1);
  const privateEntry = await store.add({ text: "private", scope: { kind: "thread", threadId: "other" } }, undefined, { boundThreadId: "other", now }); assert.ok(privateEntry.ok);
  const privateRead = await tool("memory_query").tool.execute!({ id: privateEntry.entry.id }, context);
  assert.equal((privateRead as { ok: boolean }).ok, false); assert.doesNotMatch(JSON.stringify(privateRead), /"private"/);
  const schema = asSchema(tool("memory_revise").tool.inputSchema);
  for (const input of [
    { id: added.entry.id, expectedRevision: 1, operation: "change", text: "x" },
    { id: added.entry.id, expectedRevision: 1, operation: "retract", text: "x" },
    { id: added.entry.id, expectedRevision: 1, operation: "correct", text: "x", systemTime: now.toISOString() },
    { id: added.entry.id, expectedRevision: 1, operation: "correct", text: "x", pinned: true },
  ]) assert.equal((await schema.validate!(input)).success, false);
});

it("new proposal and result schemas preserve multi-source/time/recall metadata without partial commits", async () => {
  const { tool, consolidation, store } = await setup([user("one", "复盘要先结论"), user("two", "复盘再列两步")]);
  consolidation.begin("primary");
  const prepared = await consolidation.prepare({}); assert.ok(prepared.ok);
  const input = { batchId: prepared.value.batchId, proposals: [{ action: "add", text: "复盘先结论再两步", kind: "preference", recallTerms: ["总结格式"], sources: [{ sourceMessageId: "one", sourceQuote: "复盘要先结论" }, { sourceMessageId: "two", sourceQuote: "复盘再列两步" }], reason: "明确一致偏好" }] };
  assert.equal((await asSchema(tool("memory_stage_candidates").tool.inputSchema).validate!(input)).success, true);
  const stageSchema = asSchema(tool("memory_stage_candidates").tool.inputSchema);
  const target = { memoryId: "target", expectedRevision: 1, reason: "explicit", sources: input.proposals[0]!.sources };
  for (const proposal of [
    { action: "change", ...target, text: "new", effectiveAt: "2026-10-03T00:00:00Z", validTime: { from: null, to: null, basis: "unknown" } },
    { action: "correct", ...target, text: "new", effectiveAt: "2026-10-03T00:00:00Z" },
    { action: "disable", ...target, expiresAt: null },
    { action: "retract", ...target, expiresAt: null },
  ]) assert.equal((await stageSchema.validate!({ batchId: input.batchId, proposals: [proposal] })).success, false);
  const staged = await tool("memory_stage_candidates").tool.execute!(input, context); assert.equal((staged as { ok: boolean }).ok, true);
  assert.deepEqual(await store.list(), { ok: true, entries: [] });
  const finalized = await consolidation.finalize({ status: "completed" }); assert.ok(finalized.ok);
  const listed = await tool("memory_candidates_list").tool.execute!({}, context);
  assert.equal((await asSchema(tool("memory_candidates_list").tool.outputSchema!).validate!(listed)).success, true);
  assert.match(JSON.stringify(listed), /总结格式/); assert.match(JSON.stringify(listed), /"sources"/);
  const receipt = await tool("memory_apply_candidate").tool.execute!({ candidateId: finalized.value.candidateIds[0], expectedCandidateRevision: 1 }, context);
  assert.equal((await asSchema(tool("memory_apply_candidate").tool.outputSchema!).validate!(receipt)).success, true);
});

it("non-idempotent temporal commit uncertainty escapes as unknown, not an ordinary false result", async () => {
  const { store, now } = await setup();
  store.reviseMemory = async () => ({ ok: false, error: { code: "MEMORY_COMMIT_UNCERTAIN", message: "rename already happened" } });
  const tools: RegisteredTool[] = [];
  createMemoryModule(store, undefined, { threadId: "thread-a", now: () => now }).setup({ registerTool: tool => tools.push(tool), registerCommand: () => {}, notify: () => {} });
  const revise = tools.find(tool => tool.metadata.name === "memory_revise")!;
  await assert.rejects(revise.tool.execute!({ id: "memory", expectedRevision: 1, operation: "correct", text: "new" }, context), error => error instanceof AgentError && error.data.code === "TOOL_OUTCOME_UNKNOWN");
});
