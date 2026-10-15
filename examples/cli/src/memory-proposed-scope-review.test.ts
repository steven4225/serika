import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import type { UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryConsolidation, type MemoryProposal } from "./memory-consolidation.js";
import { createMemoryStore } from "./memory-store.js";
import { statedThreadScope } from "./memory-observation-policy.js";

const before = new Date("2026-10-01T00:00:00.000Z");
const now = new Date("2026-10-02T00:00:00.000Z");
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), "memory-proposed-scope-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const store = createMemoryStore(workspace);
  const seed = await store.add({ text: "我喝咖啡不加糖。", kind: "preference",
    factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }, undefined, { now: before });
  assert.ok(seed.ok);
  const message: UIMessage = { id: "source", role: "user", parts: [{ type: "text", text }] };
  const service = createMemoryConsolidation({ store, threadId: "origin", getMessages: async () => [message],
    now: () => now, writePolicy: "automatic" });
  return { root, workspace, store, service, seed: seed.entry, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function coffee(quote: string): MemoryProposal {
  return { action: "add", kind: "preference", text: "我喝咖啡加糖。", reason: "模型声称是当前对话偏好",
    eligibility: "durable_self_statement", scope: { kind: "thread" },
    sources: [{ sourceMessageId: "source", sourceQuote: quote }],
    factIdentity: { attribute: "coffee", scenario: "general", value: "sweetened" } };
}
async function commit(f: Awaited<ReturnType<typeof fixture>>, proposals: MemoryProposal[]) {
  f.service.begin(AUTO_CONSOLIDATION_AGENT_ID);
  const prepared = await f.service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
  assert.ok((await f.service.stage({ batchId: prepared.value.batchId, proposals,
    outcomes: [{ messageId: "source", status: "extracted" }] })).ok);
  const result = await f.service.finalize({ status: "completed" }); assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

test("direct current-conversation declarations remain explicit, but discussing/negating a limit does not authorize it", () => {
  for (const text of ["本会话咖啡加糖。", "本对话，咖啡不加糖。", "当前聊天里用中文回复。"])
    assert.equal(statedThreadScope(text), "explicit", text);
  for (const text of ["本会话讨论咖啡，不代表仅本会话有效。", "本会话讨论咖啡加糖。", "本会话他喝咖啡加糖。", "本会话咖啡加糖吗？"])
    assert.notEqual(statedThreadScope(text), "explicit", text);
});

test("an existing short-form Thread declaration remains eligible for its separate Thread fact", async () => {
  const f = await fixture("本会话咖啡加糖。");
  try {
    const result = await commit(f, [coffee("本会话咖啡加糖。")]);
    assert.equal(result.accepted?.length, 1);
    assert.equal(result.pendingCandidateIds?.length, 0);
  } finally { await f.cleanup(); }
});

test("recorded MT05 cannot invent Thread scope to bypass an existing workspace conflict", async () => {
  const f = await fixture("我喝咖啡加糖。");
  try {
    const result = await commit(f, [coffee("我喝咖啡加糖。")]);
    assert.equal(result.accepted?.length ?? 0, 0, "unsupported scope is not authority for an independent automatic add");
    assert.equal(result.pendingCandidateIds?.length, 1);
    const reopened = createMemoryStore(f.workspace);
    const formal = await reopened.list(undefined, { now }); assert.ok(formal.ok);
    assert.equal(formal.entries.length, 1);
    assert.equal(formal.entries[0]?.id, f.seed.id);
    assert.equal(formal.entries[0]?.revision, 1);
    assert.equal(formal.entries[0]?.text, f.seed.text);
    const pending = await reopened.getCandidate(result.pendingCandidateIds![0]!, undefined, { boundThreadId: "origin", now }); assert.ok(pending.ok);
    assert.equal(pending.value.candidate.status, "pending");
    assert.equal(pending.value.applicable, true);
    assert.equal(pending.value.candidate.change.operation, "add");
    assert.deepEqual(pending.value.candidate.change.operation === "add" && pending.value.candidate.change.scope,
      { kind: "thread", threadId: "origin" }, "do not fabricate a replacement workspace scope");
    assert.match(pending.value.candidate.reason, /范围.*原话|原话.*范围/);
  } finally { await f.cleanup(); }
});

test("the unsupported Thread-scope guard also applies without a known conflict or coffee identity", async () => {
  const f = await fixture("我是一名设计师。");
  try {
    const result = await commit(f, [{ action: "add", kind: "fact", text: "我是一名设计师。", reason: "明确自述",
      eligibility: "durable_self_statement", scope: { kind: "thread" },
      sources: [{ sourceMessageId: "source", sourceQuote: "我是一名设计师。" }] }]);
    assert.equal(result.accepted?.length ?? 0, 0);
    assert.equal(result.pendingCandidateIds?.length, 1);
  } finally { await f.cleanup(); }
});

test("an explicitly Thread-limited source still saves a separate Thread preference without editing shared memory", async () => {
  const f = await fixture("仅在当前对话里，我喝咖啡加糖。");
  try {
    // Scope support comes from the full committed source, even when the exact
    // fact excerpt excludes its leading qualifier.
    const result = await commit(f, [coffee("我喝咖啡加糖。")]);
    assert.equal(result.accepted?.length, 1);
    assert.equal(result.pendingCandidateIds?.length, 0);
    const formal = await createMemoryStore(f.workspace).list(undefined, { now }); assert.ok(formal.ok);
    assert.equal(formal.entries.length, 2);
    const shared = formal.entries.find(entry => entry.id === f.seed.id)!;
    assert.equal(shared.revision, 1);
    assert.equal(shared.text, f.seed.text);
    const currentThread = formal.entries.find(entry => entry.id !== f.seed.id)!;
    assert.deepEqual(currentThread.scope, { kind: "thread", threadId: "origin" });
    assert.equal(currentThread.assertion?.factIdentity?.value, "sweetened");
  } finally { await f.cleanup(); }
});

test("reviewing an unsupported scope does not block an independently valid fact from the same source", async () => {
  const f = await fixture("我喝咖啡加糖；我住在杭州。");
  try {
    const result = await commit(f, [coffee("我喝咖啡加糖"), { action: "add", kind: "fact", text: "我住在杭州。",
      reason: "明确居住事实", eligibility: "durable_self_statement",
      sources: [{ sourceMessageId: "source", sourceQuote: "我住在杭州。" }],
      factIdentity: { attribute: "residence", scenario: "general", value: "杭州" } }]);
    assert.equal(result.accepted?.length, 1);
    assert.equal(result.pendingCandidateIds?.length, 1);
    const formal = await createMemoryStore(f.workspace).list(undefined, { now }); assert.ok(formal.ok);
    assert.equal(formal.entries.length, 2);
    assert.ok(formal.entries.some(entry => entry.assertion?.factIdentity?.attribute === "residence"));
    assert.equal(formal.entries.some(entry => entry.assertion?.factIdentity?.value === "sweetened"), false);
  } finally { await f.cleanup(); }
});

test("unsupported-scope review retains the exact source and can be inspected/rejected through Controller after restart", async () => {
  const text = "我喝咖啡加糖。";
  const f = await fixture(text);
  try {
    const result = await commit(f, [coffee(text)]);
    assert.equal(result.pendingCandidateIds?.length, 1);
    const config = join(f.root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace: f.workspace, modules: { memory: { enabled: true } } }));
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(f.root, "transcripts"), "--thread", "origin", "--config", config],
      modelAlias: "fixture/no-model-call", model: new MockLanguageModelV3({ doStream: async () => assert.fail("Idle review must not call a model") }),
      output, env: {}, cwd: f.root });
    const controller = createAssistantController(app);
    try {
      const candidateId = result.pendingCandidateIds![0]!;
      const preview = await controller.getMemoryCandidate(candidateId); assert.ok(preview.ok);
      assert.equal(preview.value.applicable, true);
      assert.equal(preview.value.candidate.source.quote, text);
      assert.equal(preview.value.candidate.source.threadId, "origin");
      const rejected = await controller.resolveMemoryCandidate({ candidateId,
        expectedCandidateRevision: preview.value.candidate.revision, decision: "reject" });
      assert.ok(rejected.ok, JSON.stringify(rejected));
      const after = await controller.getMemoryCandidate(candidateId); assert.ok(after.ok);
      assert.equal(after.value.candidate.status, "rejected");
      const old = await controller.getMemory(f.seed.id); assert.ok(old.ok);
      assert.equal(old.value.revision, 1);
      assert.equal(old.value.text, f.seed.text);
    } finally { await controller.shutdown(); }
  } finally { await f.cleanup(); }
});
