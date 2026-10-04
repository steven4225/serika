import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import type { ContextCompactionRecord, ContextSummaryV2 } from "./context-compaction.js";
import type { CandidateDraft, MemoryResult } from "./memory-candidates.js";
import { createMemoryQueryRewriter } from "./memory-query-rewrite.js";
import { createRetrievedMemoryContextMessage, retrieveMemories } from "./memory-retrieval.js";
import { createMemoryStore, type MemoryEntryResult, type TemporalWorkspaceMemoryStore } from "./memory-store.js";

const threadId = "memory-owner";
const at = "2026-10-04T00:00:00.000Z";
const options = (time = at) => ({ boundThreadId: threadId, now: new Date(time) });
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
function value<T>(result: MemoryResult<T>): T {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function entry(result: MemoryEntryResult) {
  if (!result.ok) assert.fail(`${result.error.code}: ${result.error.message}`);
  return result.entry;
}
async function selected(store: TemporalWorkspaceMemoryStore, query: string, time = at, rewrittenQueries?: string[]) {
  const listed = await store.list(undefined, options(time));
  if (!listed.ok) assert.fail(`${listed.error.code}: ${listed.error.message}`);
  return retrieveMemories(listed.entries, { query, threadId, now: new Date(time), ...(rewrittenQueries ? { rewrittenQueries } : {}) });
}
function source(messageId: string, quote: string) {
  return { kind: "conversation" as const, threadId, messageId, quote };
}
async function commitAndAccept(store: TemporalWorkspaceMemoryStore, batchId: string, draft: CandidateDraft, time = at) {
  const batch = value(await store.commitCandidateBatch({ batchId, originThreadId: threadId, candidates: [draft], expectedCursor: null, nextCursor: null }, undefined, options(time)));
  assert.equal(batch.candidateIds.length, 1);
  const candidateId = batch.candidateIds[0]!;
  const preview = value(await store.getCandidate(candidateId, undefined, options(time)));
  assert.equal(preview.candidate.status, "pending");
  assert.equal(preview.applicable, true);
  // An explicit reviewer decision in the test, never a model-owned acceptance.
  const accepted = value(await store.resolveCandidate({ candidateId, expectedCandidateRevision: 1, decision: "accept" }, undefined, options(time)));
  assert.ok(accepted.memoryId);
  return { candidateId, memoryId: accepted.memoryId, memoryRevision: accepted.memoryRevision! };
}

describe("Memory recall through the real workspace file and fresh store instances", () => {
  for (const version of [1, 3] as const) {
    it(`reads v${version} without mutation, accepts approved terms/sources, then recalls after reopening`, async () => {
      const root = await mkdtemp(join(tmpdir(), "runloom-recall-migration-"));
      try {
        await mkdir(join(root, ".runloom"));
        const legacy = JSON.stringify({ version, entries: [{ id: "legacy", text: "咖啡选择浅烘焙", enabled: true,
          ...(version === 3 ? { revision: 1, status: "active", scope: { kind: "workspace" }, pinned: false, source: { kind: "legacy" }, expiresAt: null, createdAt: null, updatedAt: null, history: [] } : {}),
        }], ...(version === 3 ? { candidates: [], consolidationCursors: [] } : {}) });
        const file = join(root, ".runloom", "memory.json");
        await writeFile(file, legacy);
        const store = createMemoryStore(root);
        assert.deepEqual((await selected(store, "咖啡")).selected.map(({ id }) => id), ["legacy"]);
        assert.equal(await readFile(file, "utf8"), legacy, "retrieval does not migrate an old file");
        const quotes = [source("preference-one", "我复盘先写一行结论。"), source("preference-two", "结论后列两条可执行步骤。")];
        const accepted = await commitAndAccept(store, "accepted-writing", {
          change: { operation: "add", text: "复盘先给一行结论，再列两条可执行步骤。", kind: "preference", recallTerms: ["回顾内容组织"],
            validTime: { from: "2026-10-01T00:00:00.000Z", to: null, basis: "explicit" }, scope: { kind: "workspace" }, expiresAt: null },
          source: quotes[0]!, sources: quotes, reason: "两条明确的已提交写作偏好，供人工审核。",
        });
        const saved = await readFile(file, "utf8");
        assert.equal(JSON.parse(saved).version, 4);
        const reopened = createMemoryStore(root);
        const recalled = await selected(reopened, "回顾怎样组织内容？");
        assert.deepEqual(recalled.selected.map(({ id, reason }) => ({ id, reason })), [{ id: accepted.memoryId, reason: "recall_term" }]);
        assert.deepEqual(recalled.selected[0]?.assertion?.sourceIds, quotes.map(({ kind, threadId, messageId }) => ({ kind, threadId, messageId })));
        const inspected = value(await reopened.inspectMemory(accepted.memoryId));
        assert.deepEqual(inspected.assertions[0]?.sources, quotes, "exact source quotes remain in the persistent record");
        assert.doesNotMatch(JSON.stringify(createRetrievedMemoryContextMessage(recalled)), /我复盘先写一行结论。|结论后列两条可执行步骤。|回顾内容组织/);

        let requests = 0;
        const rewrite = createMemoryQueryRewriter(new MockLanguageModelV3({ doGenerate: async () => {
          requests += 1;
          return { content: [{ type: "text", text: '{"queries":["复盘格式"]}' }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        } }));
        const query = "brief retrospective layout";
        assert.deepEqual((await selected(reopened, query)).selected, []);
        const expanded = await rewrite("query-one", query, new AbortController().signal);
        assert.equal(expanded.state, "succeeded");
        assert.deepEqual((await selected(createMemoryStore(root), query, at, expanded.queries)).selected.map(({ id, reason }) => ({ id, reason })), [{ id: accepted.memoryId, reason: "rewritten" }]);
        await rewrite("query-one", query, new AbortController().signal);
        assert.equal(requests, 1);
        const replay = value(await reopened.resolveCandidate({ candidateId: accepted.candidateId, expectedCandidateRevision: 1, decision: "accept" }, undefined, options()));
        assert.equal(replay.replayed, true);
        assert.equal(await readFile(file, "utf8"), saved, "exact acceptance replay and recall make no new writes");
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }

  it("changes the current preference without recalling its old terms, then preserves disable/retract across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-recall-lifecycle-"));
    try {
      let store = createMemoryStore(root);
      const first = await commitAndAccept(store, "initial", {
        change: { operation: "add", text: "复盘用五段。", kind: "preference", recallTerms: ["retrospective layout"], scope: { kind: "workspace" }, expiresAt: null,
          validTime: { from: "2026-09-01T00:00:00.000Z", to: null, basis: "explicit" } },
        source: source("old-preference", "九月的复盘用五段。"), reason: "明确旧偏好。",
      });
      assert.equal((await selected(createMemoryStore(root), "retrospective layout")).selected[0]?.id, first.memoryId);
      const changedAt = "2026-10-04T00:00:01.000Z";
      await commitAndAccept(store, "changed", {
        change: { operation: "change", memoryId: first.memoryId, expectedRevision: 1, text: "复盘先结论再两步。", kind: "preference", recallTerms: ["brief review"], effectiveAt: "2026-10-01T00:00:00.000Z", expiresAt: null },
        source: source("changed-preference", "十月起我改成复盘先结论再两步。"), reason: "真实偏好变更及明确生效时间。",
      }, changedAt);
      store = createMemoryStore(root);
      assert.deepEqual((await selected(store, "五段", changedAt)).selected, []);
      assert.deepEqual((await selected(store, "retrospective layout", changedAt)).selected, []);
      const current = await selected(store, "brief review", changedAt);
      assert.equal(current.selected[0]?.revision, 2);
      assert.equal(current.entries[0]?.text, "复盘先结论再两步。");
      assert.deepEqual(value(await store.queryMemory(first.memoryId, { validAt: "2026-09-20T00:00:00.000Z", knownAt: changedAt }, undefined, options(changedAt))).assertions.map(({ text }) => text), ["复盘用五段。"], "old fact is retained only for explicit historical queries");

      const disabledAt = "2026-10-04T00:00:02.000Z";
      await commitAndAccept(store, "disabled", {
        change: { operation: "disable", memoryId: first.memoryId, expectedRevision: 2, text: "复盘先结论再两步。", expiresAt: null },
        source: source("disable-preference", "请停用这条复盘偏好。"), reason: "用户明确要求停用。",
      }, disabledAt);
      assert.deepEqual((await selected(createMemoryStore(root), "brief review", disabledAt)).selected, []);
      assert.equal(entry(await createMemoryStore(root).get(first.memoryId, undefined, options(disabledAt))).status, "disabled");

      const factAt = "2026-10-04T00:00:03.000Z";
      const fact = await commitAndAccept(createMemoryStore(root), "new-fact", {
        change: { operation: "add", text: "我住在杭州。", kind: "fact", recallTerms: ["home city"], scope: { kind: "workspace" }, expiresAt: null },
        source: source("city", "我住在杭州。"), reason: "明确居住地。",
      }, factAt);
      assert.equal((await selected(createMemoryStore(root), "home city", factAt)).selected[0]?.id, fact.memoryId);
      const retractedAt = "2026-10-04T00:00:04.000Z";
      await commitAndAccept(createMemoryStore(root), "retracted", {
        change: { operation: "retract", memoryId: fact.memoryId, expectedRevision: 1, text: "我住在杭州。", expiresAt: null },
        source: source("retract-city", "请撤回关于我住在杭州的事实。"), reason: "用户撤回已存事实。",
      }, retractedAt);
      store = createMemoryStore(root);
      assert.deepEqual((await selected(store, "home city", retractedAt)).selected, []);
      assert.deepEqual((await selected(store, "杭州", retractedAt)).selected, []);
      assert.deepEqual((await selected(store, "brief review", retractedAt)).selected, []);
      assert.equal(entry(await store.get(fact.memoryId, undefined, options(retractedAt))).text, "");
      assert.ok(value(await store.inspectMemory(fact.memoryId)).assertions.some(({ state }) => state === "retracted"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reopens a real app after saved compaction without reviving a disabled preference from the summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-memory-summary-reopen-"));
    const output = new PassThrough(); output.resume();
    let app: Awaited<ReturnType<typeof createRuntimeApp>> | undefined;
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const config = join(root, "config.json");
      await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true } }, contextCompaction: {
        enabled: true, contextWindowTokens: 30000, maxOutputTokens: 1024, safetyMarginTokens: 512, keepRecentTokens: 256, summaryMaxOutputTokens: 1024,
      } }));
      const oldPreference = "复盘用五段，不用一行结论。";
      const store = createMemoryStore(workspace);
      const preference = entry(await store.add({ text: oldPreference, kind: "preference", source: source("old-user", oldPreference) }));
      const history: UIMessage[] = [
        { id: "old-user", role: "user", parts: [{ type: "text", text: oldPreference + " 历史工作讨论。".repeat(400) }] },
        { id: "old-assistant", role: "assistant", parts: [{ type: "text", text: "了解旧格式。".repeat(100) }] },
        { id: "recent-user", role: "user", parts: [{ type: "text", text: "继续下一步项目工作。" }] },
        { id: "recent-assistant", role: "assistant", parts: [{ type: "text", text: "等你下一步任务。" }] },
      ];
      const summary: ContextSummaryV2 = {
        version: 2, goal: { text: "继续项目工作", evidenceMessageIds: ["old-user"] }, constraints: [],
        decisions: [{ text: oldPreference, evidenceMessageIds: ["old-user"], source: "user", status: "confirmed" }],
        actions: [], pending: [], files: [], nextStep: { text: "继续下一步", evidenceMessageIds: ["old-user"] },
      };
      let summaryRequests = 0;
      const primaryPrompts: unknown[] = [];
      const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
        const compactor = JSON.stringify(prompt).includes("You are a context compactor");
        if (compactor) summaryRequests += 1;
        else primaryPrompts.push(prompt);
        const text = compactor ? JSON.stringify(summary) : "当前没有正式复盘偏好。";
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "answer" },
          { type: "text-delta" as const, id: "answer", delta: text }, { type: "text-end" as const, id: "answer" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ] }) };
      } });
      const args = ["--tui", join(root, "transcripts"), "--thread", threadId, "--config", config];
      const openApp = () => createRuntimeApp({ args, modelAlias: "mock", model, output, env: {}, cwd: root });
      app = await openApp();
      await app.store.save(threadId, history);
      assert.ok(app.compaction);
      await app.compaction.compact(new AbortController().signal);
      const records = await app.store.getContextCompactions(threadId);
      assert.equal(records.length, 1, "this case must actually save a compaction record, not merely enable its config");
      assert.match(JSON.stringify((records[0] as unknown as ContextCompactionRecord).summary), /复盘用五段/);
      entry(await store.update(preference.id, { expectedRevision: 1, enabled: false }));
      app.dispose();
      app = await openApp();
      assert.equal(app.getMemoryReferences?.(), null, "process-local preparation is not restored from old references");
      const handle = await app.runtime.run({ agentId: app.agentId, threadId, messages: [{ id: "new-question", role: "user", parts: [{ type: "text", text: "我的复盘格式是什么？不要查询工具。" }] }] });
      const pump = (async () => { for await (const _event of handle.events) {} })();
      assert.equal((await handle.result).status, "completed"); await pump;
      assert.equal(summaryRequests, 1, "restart reuses the same saved transcript-prefix summary");
      assert.equal(primaryPrompts.length, 1);
      assert.match(JSON.stringify(primaryPrompts[0]), /复盘用五段/, "old statement genuinely remains in the historical summary");
      const references: string[] = [];
      const visit = (value: unknown): void => {
        if (typeof value !== "object" || value === null) return;
        if ("text" in value && typeof value.text === "string" && value.text.startsWith("Current Memory reference:")) references.push(value.text);
        for (const child of Object.values(value)) visit(child);
      };
      visit(primaryPrompts[0]);
      assert.equal(references.length, 1);
      assert.match(references[0]!, /No matching Memory entries/);
      assert.doesNotMatch(references[0]!, /复盘用五段/);
      assert.deepEqual(app.getMemoryReferences?.()?.selected, []);
      assert.equal((await createMemoryStore(workspace).get(preference.id)).ok, true, "disabled record remains available for explicit inspection");
    } finally { app?.dispose(); await rm(root, { recursive: true, force: true }); }
  });
});
