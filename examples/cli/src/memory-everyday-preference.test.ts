import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UIMessage } from "ai";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryConsolidation } from "./memory-consolidation.js";
import { createMemoryStore } from "./memory-store.js";
import type { MemoryFactIdentity } from "./memory-fact-identity.js";

const oldTime = new Date("2026-10-01T00:00:00Z"), now = new Date("2026-10-02T00:00:00Z");
const domains = [
  { attribute: "diet_spiciness", label: "饮食辣度", oldValue: "none", value: "mild", oldWord: "不辣", word: "微辣" },
  { attribute: "notification_channel", label: "通知渠道", oldValue: "in_app", value: "telegram", oldWord: "应用内", word: "Telegram" },
] as const;
for (const domain of domains) for (const mode of ["add", "repeat", "change", "conflict", "scene", "conditional", "scene_change", "thread_change"] as const) {
  test(`everyday ${domain.attribute}: ${mode} follows source, scene and transition boundaries`, async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-everyday-"));
    try {
      const store = createMemoryStore(root);
      const identity = (value: string, scenario = "general") => ({ version: 2, subject: "user", attribute: domain.attribute, scenario, value }) as unknown as MemoryFactIdentity;
      const scene = mode === "scene_change" ? "工作日早餐" : "general";
      const framed = (text: string) => mode === "scene_change" ? `在「${scene}」场景，${text}` : text;
      const oldText = framed(`我的${domain.label}是${domain.oldWord}。`);
      let target: { id: string; revision?: number } | undefined;
      if (mode !== "add") {
        const seeded = await store.add({ text: oldText, kind: "preference", factIdentity: identity(domain.oldValue, scene),
          ...(mode === "thread_change" ? { scope: { kind: "thread" as const, threadId: "thread" } } : {}) }, undefined, { now: oldTime });
        assert.ok(seeded.ok, JSON.stringify(seeded)); target = seeded.entry;
      }
      const word = mode === "repeat" ? domain.oldWord : domain.word;
      const body = mode === "scene" ? `在「休息日」场景，我的${domain.label}是${word}。` : framed(`我的${domain.label}是${word}。`);
      const changing = mode === "change" || mode === "scene_change" || mode === "thread_change";
      const input = changing ? `从现在起，${mode === "thread_change" ? "仅在当前对话里，" : ""}${framed(`我的${domain.label}改成${word}。`)}`
        : mode === "conditional" ? `如果从现在起，我的${domain.label}改成${word}，就好了。` : body;
      const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: input }] }];
      const service = createMemoryConsolidation({ store, threadId: "thread", getMessages: async () => messages, now: () => now, writePolicy: "automatic" });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      const proposal = { action: changing || mode === "conditional" ? "change" : "add", kind: "preference", text: body,
        factIdentity: identity(mode === "repeat" ? domain.oldValue : domain.value, mode === "scene" ? "休息日" : scene),
        sourceMessageId: "u1", sourceQuote: input, reason: "持续偏好", eligibility: changing || mode === "conditional" ? "explicit_request" : "durable_self_statement",
        ...(changing || mode === "conditional" ? { memoryId: target!.id, expectedRevision: target!.revision,
          changeIntent: { type: "replace_from_now", sourceQuote: input } } : {}) };
      const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [proposal], outcomes: [{ messageId: "u1", status: "extracted" }] });
      assert.ok(staged.ok, JSON.stringify(staged));
      const committed = await service.finalize({ status: "completed" }); assert.ok(committed.ok, JSON.stringify(committed));
      const formal = await store.list(undefined, { now }); assert.ok(formal.ok);
      const pending = await store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread", now }); assert.ok(pending.ok);
      if (mode === "conflict" || mode === "conditional") {
        assert.equal(formal.entries.length, 1); assert.equal(formal.entries[0]!.text, oldText);
        assert.equal(pending.value.candidates.length, 1);
      } else {
        assert.equal(pending.value.candidates.length, 0);
        assert.equal(formal.entries.length, mode === "scene" ? 2 : 1);
        if (changing) {
          const current = formal.entries.find(entry => entry.id === target!.id)!;
          assert.equal(current.revision, 2); assert.equal(current.assertion?.factIdentity?.value, domain.value);
          if (mode === "thread_change") assert.deepEqual(current.scope, { kind: "thread", threadId: "thread" });
          const history = await store.queryMemory(target!.id, { validAt: oldTime.toISOString(), knownAt: now.toISOString() }, undefined, { now });
          assert.ok(history.ok); assert.equal(history.value.assertions[0]?.text, oldText);
        }
        if (mode === "repeat") assert.equal(formal.entries[0]!.text, oldText);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

for (const domain of domains) test(`everyday ${domain.attribute}: forged evidence/CAS, unknown scene and incorrect value never overwrite`, async () => {
  for (const variant of ["source", "cas", "wrong_value", "unknown_scene", "negated", "future", "third_person"] as const) {
    const root = await mkdtemp(join(tmpdir(), "memory-everyday-safety-"));
    try {
      const store = createMemoryStore(root);
      const identity = (value: string): MemoryFactIdentity => ({ version: 2, subject: "user", attribute: domain.attribute, scenario: "general", value });
      const oldText = `我的${domain.label}是${domain.oldWord}。`;
      const seeded = await store.add({ text: oldText, kind: "preference", factIdentity: identity(domain.oldValue) }, undefined, { now: oldTime });
      assert.ok(seeded.ok);
      const ordinary = `我的${domain.label}是${domain.word}。`;
      const input = variant === "unknown_scene" ? `工作日早餐，${ordinary}`
        : variant === "negated" ? `不要把我的${domain.label}改成${domain.word}。`
        : variant === "future" ? `下个月我的${domain.label}改成${domain.word}。`
        : variant === "third_person" ? `朋友说${ordinary}` : `从现在起，我的${domain.label}改成${domain.word}。`;
      const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: input }] }];
      const service = createMemoryConsolidation({ store, threadId: "thread", getMessages: async () => messages, now: () => now, writePolicy: "automatic" });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: "change", kind: "preference", text: ordinary,
        factIdentity: identity(variant === "wrong_value" ? domain.oldValue : domain.value), memoryId: seeded.entry.id,
        expectedRevision: variant === "cas" ? 999 : seeded.entry.revision, sourceMessageId: "u1", sourceQuote: variant === "source" ? "伪造原话" : input,
        reason: "不能相信模型reason替代授权", eligibility: "explicit_request", changeIntent: { type: "replace_from_now", sourceQuote: input } }],
      outcomes: [{ messageId: "u1", status: "extracted" }] });
      if (variant === "source" || variant === "cas") assert.equal(staged.ok, false, variant);
      else {
        assert.ok(staged.ok, JSON.stringify(staged));
        const finalized = await service.finalize({ status: "completed" }); assert.ok(finalized.ok);
        assert.equal(finalized.value.accepted?.length ?? 0, 0, variant);
        const candidates = await store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread", now }); assert.ok(candidates.ok);
        assert.equal(candidates.value.candidates.length, 1, variant);
      }
      const current = await store.get(seeded.entry.id, undefined, { now }); assert.ok(current.ok);
      assert.equal(current.entry.revision, 1, variant); assert.equal(current.entry.text, oldText, variant);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("everyday identity survives store reopen, retraction and restoration without a migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-everyday-lifecycle-"));
  try {
    const store = createMemoryStore(root), identity: MemoryFactIdentity = { version: 2, subject: "user", attribute: "notification_channel", scenario: "general", value: "telegram" };
    const seeded = await store.add({ text: "我的通知渠道是Telegram。", kind: "preference", factIdentity: identity }, undefined, { now: oldTime }); assert.ok(seeded.ok);
    const original = await store.inspectMemory(seeded.entry.id); assert.ok(original.ok);
    const revised = await store.reviseMemory({ id: seeded.entry.id, expectedRevision: 1, operation: "retract" }, undefined, { now }); assert.ok(revised.ok);
    const restoredAt = new Date(now.getTime() + 1000);
    const restored = await createMemoryStore(root).restoreMemory({ id: seeded.entry.id, expectedRevision: 2,
      targetAssertionId: original.value.assertions[0]!.assertionId }, undefined, { now: restoredAt }); assert.ok(restored.ok);
    assert.equal(restored.entry.revision, 3); assert.deepEqual(restored.entry.assertion?.factIdentity, identity);
    const reopened = await createMemoryStore(root).get(seeded.entry.id, undefined, { now: restoredAt }); assert.ok(reopened.ok);
    assert.deepEqual(reopened.entry.assertion?.factIdentity, identity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const domain of domains) for (const threadOnly of [false, true]) test(`real proposal regression ${domain.attribute}: user-voiced body ${threadOnly ? "Thread" : "workspace"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-everyday-model-body-"));
  try {
    const store = createMemoryStore(root);
    const input = `${threadOnly ? "仅在当前对话里，" : "请记住，"}我的${domain.label}是${domain.word}。`;
    // Exact output shapes observed in ED01/ED05/EN01/EN05, including EN05 spacing.
    const body = `${threadOnly ? "仅在当前对话里，" : ""}用户的${domain.label}是${threadOnly && domain.attribute === "notification_channel" ? " " : ""}${domain.word}。`;
    const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: input }] }];
    const service = createMemoryConsolidation({ store, threadId: "thread", getMessages: async () => messages, now: () => now, writePolicy: "automatic" });
    service.begin(AUTO_CONSOLIDATION_AGENT_ID);
    const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
    const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [{ action: "add", kind: "preference", text: body,
      reason: "用户明确偏好", eligibility: threadOnly ? "durable_self_statement" : "explicit_request",
      sources: [{ sourceMessageId: "u1", sourceQuote: input }],
      ...(threadOnly ? { scope: { kind: "thread" } } : {}),
      factIdentity: { version: 2, subject: "user", attribute: domain.attribute, scenario: "general", value: domain.value } }],
    outcomes: [{ messageId: "u1", status: "extracted" }] }); assert.ok(staged.ok, JSON.stringify(staged));
    const finalized = await service.finalize({ status: "completed" }); assert.ok(finalized.ok);
    assert.equal(finalized.value.accepted?.length, 1, JSON.stringify(finalized));
    const current = await store.list(undefined, { now }); assert.ok(current.ok);
    assert.equal(current.entries[0]!.text, body);
    assert.deepEqual(current.entries[0]!.scope, threadOnly ? { kind: "thread", threadId: "thread" } : { kind: "workspace" });
    const pending = await store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "thread", now }); assert.ok(pending.ok);
    assert.equal(pending.value.candidates.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
