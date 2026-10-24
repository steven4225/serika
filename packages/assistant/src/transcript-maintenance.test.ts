import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { hashCanonicalJson, JsonlAgentStore, type ThreadContextCompactionRecord } from "@serika/core";
import { acquireFlock } from "./flock.js";
import { createRuntimeApp } from "./app.js";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createMemoryStore } from "./memory-v7-store.js";
import { compactPrefixHash, type ContextCompactionRecord } from "./context-compaction.js";
import { readContextDiagnostics } from "./context-compactor.js";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "./context-budget.js";

it("physical compact preserves memory cursor, exact quotes and valid summary; reopen requires fresh tool approval", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-history-maintenance-"));
  const directory = join(root, "transcripts"), workspace = join(root, "workspace"), threadId = "maintenance";
  const file = join(directory, `${createHash("sha256").update(threadId).digest("hex")}.jsonl`);
  await mkdir(directory); await mkdir(workspace);
  const preference = "复盘先给结论，再给两条行动步骤";
  const messages: UIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: preference }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "旧输出 ".repeat(16_000) }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "之前批准过写文件" }] },
    { id: "a2", role: "assistant", parts: [{ type: "dynamic-tool", toolCallId: "old-write", toolName: "write_file",
      state: "output-available", input: { path: "old.md", content: "historical" }, output: { ok: true } }] },
  ];
  const summary: ContextCompactionRecord = {
    v: 2, type: "thread.context.compacted", threadId, id: "valid-summary", previousCompactionId: null,
    firstKeptMessageIndex: 2, firstKeptMessageId: "u2", sourcePrefixHash: compactPrefixHash(messages, 2),
    summary: { version: 2, goal: { text: "保留偏好", evidenceMessageIds: ["u1"] }, constraints: [], decisions: [],
      actions: [], pending: [], files: [], nextStep: null },
    strategyVersion: "summary-json/v2", modelId: "scripted", createdAt: "2026-10-10T00:00:00.000Z",
    metrics: { estimatedInputBefore: 100, estimatedInputAfter: 50, durationMs: 1, attempts: 1 },
  };
  const missingVersion = { ...summary, id: "invalid-summary", summary: { ...summary.summary, version: undefined } };
  const snapshot = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId, messages }) + "\n";
  await writeFile(file, snapshot.repeat(230) + JSON.stringify(summary) + "\n" + JSON.stringify(missingVersion) + "\n");
  const store = new JsonlAgentStore({ directory, snapshotCleanupThresholdBytes: 1,
    acquireTranscriptLock: path => acquireFlock(`${path}.append.lock`) });
  let app: Awaited<ReturnType<typeof createRuntimeApp>> | undefined;
  try {
    const before = (await stat(file)).size; assert.ok(before > 16 * 1024 * 1024);
    const memory = createMemoryStore(join(workspace, ".runloom/memory.json"), null);
    const prefixHash = hashCanonicalJson(JSON.parse(JSON.stringify(messages)));
    assert.ok((await memory.writeV7!([{ operation: "add", scope: { kind: "user" }, text: preference, category: "preference", source: { kind: "conversation", threadId, messageId: "u1", quote: preference, sentAt: null } }], undefined, { expectedProgress: null, progress: { projectId: null, threadId, throughMessageId: "u2", prefixHash, pending: [], retry: null } })).ok);
    const memoryFile = join(workspace, ".runloom/memory.json"), originalMemory = await readFile(memoryFile);
    const read = await memory.readV7!(); assert.ok(read.ok); const cursor = read.value.progress[0]!;
    const budget = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: true };
    const beforeSummary = await readContextDiagnostics(store, threadId, budget); assert(beforeSummary.ok);
    assert.equal(beforeSummary.value.latestValidCompaction?.id, summary.id);

    await store.compactThread(threadId);
    const after = (await stat(file)).size;
    assert.ok(after < before / 100);
    const reopened = new JsonlAgentStore({ directory });
    assert.deepEqual(await reopened.getMessages(threadId), messages);
    assert.deepEqual(await readFile(memoryFile), originalMemory, "physical cleanup never edits memory or its cursor");
    assert.equal(hashCanonicalJson(JSON.parse(JSON.stringify(await reopened.getMessages(threadId)))), cursor.prefixHash);
    assert.deepEqual((await memory.readV7!()), read);
    const afterSummary = await readContextDiagnostics(reopened, threadId, budget); assert(afterSummary.ok);
    assert.equal(afterSummary.value.latestValidCompaction?.id, summary.id, "missing summary.version remains invalid after cleanup");
    assert.equal(await reopened.getRun("old-write"), undefined);

    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { "read-file": { enabled: true } } }));
    await writeFile(join(workspace, "current.md"), "current disk truth");
    let calls = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined } };
    const model = new MockLanguageModelV3({ doStream: async () => {
      if (++calls === 1) return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: "new-read", toolName: "read_file", input: JSON.stringify({ path: "current.md" }) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ] }) };
      return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "continued" },
      { type: "text-end" as const, id: "answer" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ] }) };
    } });
    const output = new PassThrough(); output.resume();
    app = await createRuntimeApp({ directory, assistant: { dataDirectory: join(workspace, ".runloom"), threadId: threadId, configPath: config },
      modelAlias: "scripted", model, output, env: {}, cwd: root });
    app.enableExecutionRecords();
    assert.equal(calls, 0, "opening committed history never runs the model or old tools");
    const handle = await app.runtime.run({ agentId: app.agentId, threadId, messages: [{ id: "u3", role: "user", parts: [{ type: "text", text: "只读取 current.md" }] }] });
    const deadline = Date.now() + 3_000;
    while (!app.toolConfirmation?.getPending() && Date.now() < deadline) await delay(5);
    const approval = app.toolConfirmation?.getPending(); assert(approval);
    assert.equal(approval.toolCallId, "new-read"); assert.equal(calls, 1);
    const waiting = await app.executionRecords.getRun(threadId, handle.runId);
    assert.equal(waiting?.tools[0]?.status, "requested");
    assert.equal(waiting?.tools[0]?.startedAt, null);
    assert.equal(app.toolConfirmation!.resolveApproval({ approvalId: approval.approvalId, decision: "allow" }), true);
    assert.equal((await handle.result).status, "completed");
    assert.equal(app.toolConfirmation!.resolveApproval({ approvalId: approval.approvalId, decision: "allow" }), false);
    assert.equal(await readFile(join(workspace, "current.md"), "utf8"), "current disk truth");
    await assert.rejects(readFile(join(workspace, "old.md")), { code: "ENOENT" });
    const continued = await new JsonlAgentStore({ directory }).getMessages(threadId);
    assert.deepEqual(continued.slice(0, messages.length), messages);
    console.log(JSON.stringify({ historyBeforeBytes: before, historyAfterBytes: after, cursorPreserved: true,
      summaryPreserved: true, freshApprovalRequired: true, oldToolsReplayed: 0, model: "scripted", electron: "not_run" }));

    const changed = structuredClone(continued); changed[0]!.parts = [{ type: "text", text: "改过的来源" }];
    await store.save(threadId, changed);
    const invalidSummary = await readContextDiagnostics(store, threadId, budget); assert(invalidSummary.ok);
    assert.equal(invalidSummary.value.latestValidCompaction, null, "source mismatch does not become valid after physical cleanup");
  } finally { app?.dispose(); await rm(root, { recursive: true, force: true }); }
});
