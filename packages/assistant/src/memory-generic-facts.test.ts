import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { UIMessage } from "ai";
import { createMemoryStore } from "./memory-store.js";
import { createMemoryConsolidation } from "./memory-consolidation.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { sameFactSlot, validateFactIdentity } from "./memory-fact-identity.js";

test("generic identities are bounded and distinguish subject, scene and legacy slots", () => {
  const a = validateFactIdentity({ version: 3, subject: "我", attribute: "主要用", scenario: "general", value: "VS Code" });
  assert.equal(a.value, "VS Code");
  assert.equal(sameFactSlot(a, validateFactIdentity({ ...a, value: "Neovim" })), true);
  assert.equal(sameFactSlot(a, validateFactIdentity({ ...a, subject: "项目A" })), false);
  assert.equal(sameFactSlot(a, validateFactIdentity({ ...a, scenario: "工作" })), false);
  assert.throws(() => validateFactIdentity({ ...a, attribute: "x".repeat(100) }));
  assert.throws(() => validateFactIdentity({ ...a, subject: "我\n你" }));
});

for (const mode of ["change", "conflict", "conditional", "bad_evidence", "different_scene", "stale", "thread", "implicit", "ambiguous_implicit"] as const) {
  test(`generic fact update: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "generic-fact-"));
    try {
      const store = createMemoryStore(root);
      const old = new Date("2026-10-15T00:00:00Z"), now = new Date("2026-10-16T00:00:00Z");
      const identity = { version: 3, subject: "我", attribute: "主要用", scenario: "general", value: "VS Code" };
      const seeded = await store.add({ text: "我主要用 VS Code。", kind: "fact", factIdentity: validateFactIdentity(identity),
        ...(mode === "thread" ? { scope: { kind: "thread" as const, threadId: "t" } } : {}) }, undefined, { now: old });
      assert.ok(seeded.ok);
      if (mode === "ambiguous_implicit") assert.ok((await store.add({ text: "项目A主要用 VS Code。", kind: "fact",
        factIdentity: validateFactIdentity({ ...identity, subject: "项目A" }) }, undefined, { now: old })).ok);
      const text = mode === "implicit" || mode === "ambiguous_implicit" ? "从现在起主要用 Neovim。" : mode === "conditional" ? "如果从现在起我主要用 Neovim，就好了。" : mode === "conflict" ? "我主要用 Neovim。"
        : mode === "different_scene" ? "在「休息日」场景，我主要用 Neovim。" : `${mode === "thread" ? "仅在当前对话里，" : ""}从现在起我主要用 Neovim。`;
      const messages: UIMessage[] = [{ id: "u", role: "user", parts: [{ type: "text", text }] }];
      const service = createMemoryConsolidation({ store, threadId: "t", getMessages: async () => messages, now: () => now, writePolicy: "automatic" });
      service.begin(AUTO_CONSOLIDATION_AGENT_ID);
      const prepared = await service.prepare({ mode: "incremental" }); assert.ok(prepared.ok);
      const adding = mode === "conflict" || mode === "different_scene";
      const proposal = { action: adding ? "add" : "change", text: mode === "different_scene" ? "在「休息日」场景，我主要用 Neovim。" : "我主要用 Neovim。", kind: "fact",
        factIdentity: { ...identity, scenario: mode === "different_scene" ? "休息日" : "general", value: "Neovim" },
        factEvidence: { statementQuote: mode === "bad_evidence" ? "我主要用 Emacs。" : text,
          ...(mode === "implicit" || mode === "ambiguous_implicit" ? { targetQuote: seeded.entry.text } : {}) },
        sourceMessageId: "u", sourceQuote: text, reason: "当前事实", eligibility: "explicit_request",
        ...(!adding ? { memoryId: seeded.entry.id, expectedRevision: mode === "stale" ? 99 : seeded.entry.revision,
          changeIntent: { type: "replace_from_now", sourceQuote: text } } : {}) };
      const staged = await service.stage({ batchId: prepared.value.batchId, proposals: [proposal], outcomes: [{ messageId: "u", status: "extracted" }] });
      if (mode === "stale") { assert.equal(staged.ok, false); return; }
      assert.ok(staged.ok, JSON.stringify(staged));
      const saved = await service.finalize({ status: "completed" }); assert.ok(saved.ok, JSON.stringify(saved));
      const list = await store.list(undefined, { now }); assert.ok(list.ok);
      const pending = await store.listCandidates({ status: "pending" }, undefined, { boundThreadId: "t", now }); assert.ok(pending.ok);
      if (["conflict", "conditional", "bad_evidence", "ambiguous_implicit"].includes(mode)) {
        assert.equal(list.entries.find(entry => entry.id === seeded.entry.id)!.text, "我主要用 VS Code。"); assert.equal(pending.value.candidates.length, 1);
      } else if (mode === "different_scene") assert.equal(list.entries.length, 2);
      else {
        assert.equal(pending.value.candidates.length, 0); assert.equal(list.entries[0]!.text, "我主要用 Neovim。");
        const history = await store.queryMemory(seeded.entry.id, { validAt: old.toISOString(), knownAt: now.toISOString() }, undefined, { now });
        assert.ok(history.ok); assert.equal(history.value.assertions[0]!.text, "我主要用 VS Code。");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
