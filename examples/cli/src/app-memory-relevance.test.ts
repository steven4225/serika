import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createMemoryStore } from "./memory-store.js";

const usage = { inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined } };
function response(tool = false) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(tool ? [{ type: "tool-call" as const, toolName: "add", toolCallId: "sum", input: '{"left":1,"right":2}' }] : [
      { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "隔离验收回答" }, { type: "text-end" as const, id: "answer" },
    ]),
    { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
  ] }) };
}
interface RelevanceInput { question: string; candidates: Array<{ id: string; text: string }> }
function referenceText(prompt: string): string {
  const messages = JSON.parse(prompt) as Array<{ content: string | Array<{ type: string; text?: string }> }>;
  return messages.flatMap(message => typeof message.content === "string" ? [message.content]
    : message.content.flatMap(part => part.type === "text" && part.text ? [part.text] : []))
    .filter(text => text.startsWith("Current Memory reference:") || text.startsWith("Fresh derived reference:"))
    .join("\n");
}
async function fixture(options: { enabled?: boolean; malformed?: boolean; empty?: boolean; embeddingFailure?: boolean; tools?: boolean; onSelect?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memory-relevance-app-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { task: { enabled: true }, memory: {
    enabled: true, queryRewrite: { enabled: true }, contextView: { enabled: true },
    semantic: { enabled: true, relevance: { enabled: options.enabled !== false } },
  } } }));
  const memory = createMemoryStore(workspace);
  const target = await memory.add({ text: "复盘先给一行结论，再列两条可执行步骤。", kind: "fact" }); assert.ok(target.ok);
  const irrelevantProfile = await memory.add({ text: "我喝咖啡不加糖。", kind: "preference", factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" } }); assert.ok(irrelevantProfile.ok);
  const pin = await memory.add({ text: "显式固定的验收说明。", pinned: true }); assert.ok(pin.ok);
  const foreign = await memory.add({ text: "复盘：其他对话私有格式。", scope: { kind: "thread", threadId: "foreign" } }); assert.ok(foreign.ok);
  const disabled = await memory.add({ text: "复盘：停用格式。", enabled: false }); assert.ok(disabled.ok);
  const expired = await memory.add({ text: "复盘：过期格式。", expiresAt: "2020-01-01T00:00:00.000Z" }); assert.ok(expired.ok);
  const generated: Array<{ kind: "relevance" | "rewrite"; input: string }> = [], prompts: string[] = [];
  let streams = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async options => {
      const system = options.prompt.find(message => message.role === "system");
      const relevant = system && typeof system.content === "string" && system.content.startsWith('Return ONLY JSON {"selectedIds":');
      const input = options.prompt.find(message => message.role === "user");
      const raw = input && Array.isArray(input.content) ? input.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : "";
      generated.push({ kind: relevant ? "relevance" : "rewrite", input: raw });
      if (relevant) await optionsFixture.onSelect?.();
      const body = relevant ? JSON.parse(raw) as RelevanceInput : undefined;
      const selected = body?.candidates.filter(candidate => candidate.id === target.entry.id).map(candidate => candidate.id) ?? [];
      return { content: [{ type: "text", text: optionsFixture.malformed ? '{"selectedIds":["invented-id"],"queries":[]}'
        : relevant ? JSON.stringify({ selectedIds: optionsFixture.empty ? [] : selected, queries: ["复盘"] }) : '{"queries":["复盘"]}' }],
      finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
    doStream: async options => { prompts.push(JSON.stringify(options.prompt)); return response(optionsFixture.tools && ++streams === 1); },
  });
  const optionsFixture = options;
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "current", "--config", configPath],
    modelAlias: "fixture/original-primary", model, output, env: {}, cwd: root,
    // The target falls below the old hard threshold; relevance may inspect the
    // eligible diagnostic pool without silently lowering that threshold.
    memoryEmbedding: { modelId: "fixture/embedding", embed: async texts => {
      if (options.embeddingFailure) throw new Error("fixture embedding unavailable");
      return texts.map(text => text.includes("回顾") ? [0.4, 1] : [1, 0]);
    } },
  });
  app.enableExecutionRecords();
  const run = async (message: UIMessage) => {
    const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [message] });
    const pump = (async () => { for await (const _event of handle.events) {} })();
    assert.equal((await handle.result).status, "completed"); await pump;
    return app.getMemoryReferences!();
  };
  return { app, memory, target: target.entry, irrelevantProfile: irrelevantProfile.entry, pin: pin.entry,
    forbidden: [foreign.entry, disabled.entry, expired.entry], generated, prompts, run,
    cleanup: async () => { app.dispose(); await rm(root, { recursive: true, force: true }); } };
}
const message = (id: string, metadata?: Record<string, unknown>): UIMessage => ({ id, role: "user",
  parts: [{ type: "text", text: "回顾过去一周应该怎样组织内容？" }], ...(metadata ? { metadata } : {}) });

test("relevance opt-in recovers a below-threshold fact without an irrelevant profile or a second rewrite call", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.run(message("relevance")); assert.ok(snapshot);
    assert.deepEqual(f.generated.map(call => call.kind), ["relevance"]);
    assert.equal(snapshot.relevance?.state, "succeeded");
    assert.deepEqual(new Set(snapshot.selected.map(item => item.id)), new Set([f.target.id, f.pin.id]));
    assert.equal(snapshot.selected.find(item => item.id === f.target.id)?.reason, "relevance");
    assert.equal(snapshot.contextView?.profileCount, 0, "derived profiles cannot bypass the relevance allowlist");
    assert.ok(f.prompts[0]?.includes(f.target.text)); assert.equal(f.prompts[0]?.includes(f.irrelevantProfile.text), false);
    const material = JSON.parse(f.generated[0]!.input) as RelevanceInput;
    assert.ok(material.candidates.some(item => item.id === f.target.id), "score below 0.5 remains inspectable, not an automatic hit");
    assert.equal(material.candidates.some(item => item.id === f.pin.id), false, "explicit pins are not model authority");
    for (const entry of f.forbidden) assert.equal(JSON.stringify(material).includes(entry.text), false);
    const recorded = await f.app.executionRecords.listModelUsage(f.app.threadId);
    assert.equal(recorded.calls.filter(call => call.purpose === "query_rewrite").length, 1);
    assert.equal(recorded.calls.find(call => call.purpose === "query_rewrite")?.usage.inputTokens, 7);
  } finally { await f.cleanup(); }
});

test("same-message tool steps do not rejudge changed facts or inject unreviewed revisions/new profiles", async () => {
  const f = await fixture({ tools: true });
  let handled = false;
  f.app.toolConfirmation!.subscribePending(pending => {
    if (pending && !handled) void (async () => {
      handled = true;
      assert.ok((await f.memory.update(f.target.id, { expectedRevision: 1, text: "复盘新版本：先三条步骤。" })).ok);
      assert.ok((await f.memory.add({ text: "我希望回答先结论。", kind: "preference", factIdentity: { attribute: "review_format", scenario: "general", value: "conclusion_first" } })).ok);
      f.app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: "allow" });
    })();
  });
  try {
    const snapshot = await f.run(message("steps")); assert.ok(snapshot);
    assert.deepEqual(f.generated.map(call => call.kind), ["relevance"]);
    assert.ok(f.prompts[0]?.includes(f.target.text));
    assert.equal(f.prompts[1]?.includes(f.target.text), false);
    assert.doesNotMatch(referenceText(f.prompts[1]!), /复盘新版本|我希望回答先结论|咖啡不加糖/);
    assert.deepEqual(snapshot.selected.map(item => item.id), [f.pin.id]);
  } finally { await f.cleanup(); }
});

test("a valid empty relevance verdict excludes stable-profile fallback while keeping explicit pins", async () => {
  const f = await fixture({ empty: true });
  try {
    const snapshot = await f.run(message("empty-verdict")); assert.ok(snapshot);
    assert.equal(snapshot.relevance?.state, "succeeded");
    assert.deepEqual(f.generated.map(call => call.kind), ["relevance"]);
    assert.equal(snapshot.contextView?.profileCount, 0);
    assert.deepEqual(snapshot.selected.map(item => item.id), [f.pin.id]);
    assert.equal(referenceText(f.prompts[0]!).includes(f.irrelevantProfile.text), false);
    assert.equal(referenceText(f.prompts[0]!).includes(f.target.text), false);
  } finally { await f.cleanup(); }
});

test("ordinary input with an empty candidate pool cannot inject an unrelated derived profile", async () => {
  const f = await fixture({ embeddingFailure: true });
  try {
    const snapshot = await f.run({ id: "empty-pool", role: "user", parts: [{ type: "text", text: "月球重力是多少？" }] }); assert.ok(snapshot);
    assert.equal(snapshot.relevance?.state, "not_applicable");
    assert.equal(snapshot.relevance?.candidateCount, 0);
    assert.equal(f.generated.length, 0);
    assert.equal(snapshot.contextView?.profileCount, 0);
    assert.deepEqual(snapshot.selected.map(item => item.id), [f.pin.id]);
    assert.equal(referenceText(f.prompts[0]!).includes(f.irrelevantProfile.text), false);
  } finally { await f.cleanup(); }
});

test("fresh lifecycle checks discard an allowed fact disabled while relevance inference is running", async () => {
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ onSelect: async () => { assert.ok((await f.memory.update(f.target.id, { expectedRevision: 1, enabled: false })).ok); } });
  try {
    const snapshot = await f.run(message("race")); assert.ok(snapshot);
    assert.equal(snapshot.relevance?.state, "succeeded");
    assert.deepEqual(snapshot.selected.map(item => item.id), [f.pin.id]);
    assert.equal(f.prompts[0]?.includes(f.target.text), false);
  } finally { await f.cleanup(); }
});

test("invalid relevance output explicitly degrades to the old lexical/semantic fallback without a second query call", async () => {
  const f = await fixture({ malformed: true });
  try {
    const snapshot = await f.run(message("malformed")); assert.ok(snapshot);
    assert.equal(snapshot.relevance?.state, "degraded");
    assert.deepEqual(f.generated.map(call => call.kind), ["relevance"]);
    assert.ok(snapshot.selected.some(item => item.id === f.pin.id));
    assert.ok(snapshot.selected.some(item => item.id === f.irrelevantProfile.id), "degradation retains the explicitly configured existing profile fallback");
  } finally { await f.cleanup(); }
});

test("legacy disabled relevance retains the original single query-rewrite path", async () => {
  const f = await fixture({ enabled: false });
  try {
    const snapshot = await f.run(message("legacy")); assert.ok(snapshot);
    assert.deepEqual(f.generated.map(call => call.kind), ["rewrite"]);
    assert.equal(snapshot.relevance, undefined);
    assert.equal(snapshot.rewrite, "succeeded");
  } finally { await f.cleanup(); }
});

test("excluded/scheduled/WorkTask input does not call relevance or the displaced rewriter", async () => {
  const f = await fixture();
  try {
    for (const [id, metadata] of [["excluded", { memoryConsolidation: "exclude" }], ["scheduled", { source: "scheduled-task" }]] as const) {
      const snapshot = await f.run(message(id, metadata)); assert.ok(snapshot);
      assert.equal(snapshot.relevance?.state, "not_applicable");
    }
    const created = await f.app.workTasks!.create({ threadId: f.app.threadId, goal: "隔离任务", acceptance: [
      { id: "human", description: "人工验收", required: true, method: "human", verification: { kind: "human" } },
    ] }); assert.ok(created.ok);
    f.app.workTaskContext.begin(created.value);
    try { const snapshot = await f.run(message("task")); assert.equal(snapshot?.relevance?.state, "not_applicable"); }
    finally { f.app.workTaskContext.end(); }
    assert.equal(f.generated.length, 0);
  } finally { await f.cleanup(); }
});
