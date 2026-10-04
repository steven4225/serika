import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { discoverThreadDirectory } from "./thread-history.js";
import type { MainToRenderer } from "../shared/ui-contract.js";

function findMaterial(value: unknown): { batchId: string; turns: Array<{ user: { messageId: string; text: string } }> } | undefined {
  if (typeof value !== "object" || value === null) return;
  const object = value as Record<string, unknown>;
  if (typeof object.batchId === "string" && Array.isArray(object.turns)) return object as ReturnType<typeof findMaterial>;
  for (const child of Object.values(object).reverse()) { const result = findMaterial(child); if (result) return result; }
}
function response(toolName?: string, input?: unknown) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(toolName ? [{ type: "tool-call" as const, toolCallId: toolName, toolName, input: JSON.stringify(input) }] : [
      { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "收到。" }, { type: "text-end" as const, id: "text" },
    ]),
    { type: "finish" as const, finishReason: { unified: toolName ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
async function idle(host: DesktopRuntime) {
  const deadline = Date.now() + 10_000;
  while (host.current.snapshot().state.kind !== "idle") {
    if (Date.now() > deadline) throw new Error("Desktop remained busy");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("normal desktop memory and history entry", () => {
  it("explicitly enables an old disabled config while keeping the selected Thread and committed history", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-enable-test-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const configPath = join(root, "custom.json");
    await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: false }, shell: { enabled: false } } }));
    const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root,
      env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} });
    try {
      const identity = host.info(); assert.equal(identity.memory.enabled, false);
      assert.ok((await host.current.run("保留这条旧对话")).ok); await idle(host);
      await host.enableMemory();
      assert.equal(host.info().threadId, identity.threadId); assert.equal(host.info().directory, identity.directory);
      assert.equal(host.info().memory.enabled, true); assert.equal(host.info().memory.autoConsolidate, true);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === "保留这条旧对话")));
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("uses generated daily identity, reviews/rejects proposals, recalls in a new Thread, and reopens either history", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-daily-test-"));
    let step = 0, failStage = false;
    const events: MainToRenderer[] = [];
    const model = new MockLanguageModelV3({ doStream: async options => {
      if (options.tools?.length !== 2) return response();
      step++;
      if (step % 3 === 1) return response("memory_prepare_consolidation", { mode: "incremental" });
      if (step % 3 === 2) {
        const material = findMaterial(options.prompt); assert.ok(material);
        const user = material.turns[0]?.user;
        return response("memory_stage_candidates", { batchId: material.batchId, proposals: user ? [{ action: "add",
          text: user.text, scope: { kind: "workspace" }, recallTerms: ["总结报告"], kind: "preference", reason: "明确偏好",
          sourceMessageId: user.messageId, sourceQuote: failStage ? "forged quote" : user.text }] : [] });
      }
      return response();
    } });
    const options = { userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock", model, send: (event: MainToRenderer) => events.push(event) };
    let host = await DesktopRuntime.create(options);
    try {
      const initial = host.info();
      assert.equal(initial.memory.enabled, true); assert.equal(initial.memory.autoConsolidate, true);
      assert.equal(initial.workspaceRoot, await realpath(join(root, "profile", "workspaces", "personal")));
      assert.ok((await host.current.run("我的复盘长期偏好：先结论，再两条步骤。")).ok);
      await assert.rejects(host.createThread(), /等待/);
      await idle(host);
      const candidates = await host.current.listMemoryCandidates({ status: "pending" }); assert.ok(candidates.ok); assert.equal(candidates.value.candidates.length, 1);
      const candidate = candidates.value.candidates[0]!;
      assert.ok((await host.current.resolveMemoryCandidate({ candidateId: candidate.id, expectedCandidateRevision: candidate.revision, decision: "accept" })).ok);
      const files = await host.listThreads(); assert.equal(files[0]!.messageCount! > 0, true);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().threadId, initial.threadId); assert.equal(host.info().directory, initial.directory);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text.includes("复盘长期偏好"))));
      await host.createThread();
      const other = host.info().threadId;
      assert.notEqual(other, initial.threadId);
      assert.ok((await host.current.run("总结报告怎么写？", { memoryConsolidation: "exclude" })).ok);
      await idle(host);
      const reference = await host.current.getMemoryReferences(); assert.equal(reference?.selected.length, 1); assert.equal(reference?.selected[0]?.reason, "recall_term");
      assert.equal((await host.current.listMemoryCandidates()).ok, true);
      await host.selectThread(initial.threadId);
      assert.equal(host.info().threadId, initial.threadId);
      await host.selectThread(other);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().threadId, other);
      assert.equal((await host.listThreads()).length, 2);
      assert.ok(events.some(event => event.type === "identity-changed"));
      failStage = true;
      assert.ok((await host.current.run("长期排版偏好：使用大标题。")).ok); await idle(host);
      const health = await host.current.getMemoryMaintenance(); assert.ok(health.ok); assert.equal(health.value.consolidation.state, "failed");
      failStage = false;
      assert.ok((await host.current.consolidateMemory({ mode: "incremental" })).ok); await idle(host);
      const retry = await host.current.listMemoryCandidates(); assert.ok(retry.ok); assert.equal(retry.value.candidates.length, 1);
      const rejected = retry.value.candidates[0]!;
      assert.ok((await host.current.resolveMemoryCandidate({ candidateId: rejected.id, expectedCandidateRevision: rejected.revision, decision: "reject" })).ok);
      const memories = await host.current.listMemories(); assert.ok(memories.ok); assert.equal(memories.value.entries.length, 1);
      const sources = await host.current.listMemoryConsolidationSources(); assert.ok(sources.ok);
      const excluded = sources.value.sources.find(source => source.preview === "总结报告怎么写？"); assert.equal(excluded?.excluded, true);
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("discovers legacy transcripts without tail repair and registers only after workspace confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-import-test-"));
    const directory = join(root, "legacy"); await mkdir(directory);
    const file = join(directory, `${createHash("sha256").update("personal").digest("hex")}.jsonl`);
    const transcript = JSON.stringify({ v: 1, type: "thread.messages.committed", threadId: "personal", messages: [{ id: "u", role: "user", parts: [{ type: "text", text: "旧对话" }] }] }) + "\n";
    await writeFile(file, transcript + "unfinished");
    const found = await discoverThreadDirectory(directory); assert.equal(found[0]?.messageCount, 1); assert.ok(found[0]?.error);
    assert.equal(await readFile(file, "utf8"), transcript + "unfinished");
    await writeFile(file, transcript);
    const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock", model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} });
    try {
      await assert.rejects(host.registerThread({ threadId: "personal", transcriptDirectory: directory, confirmedWorkspace: false } as never), /确认/);
      assert.equal((await host.listThreads()).length, 1);
      await host.registerThread({ threadId: "personal", transcriptDirectory: directory, confirmedWorkspace: true });
      await host.selectThread("personal");
      assert.equal((await host.current.history())[0]?.id, "u");
      assert.equal(await readFile(file, "utf8"), transcript);
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("upgrades memory only on explicit request and preserves daily history across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-legacy-setup-"));
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    await mkdir(profile); await mkdir(workspace);
    const configPath = join(profile, "runloom.json");
    const legacy = { version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true }, shell: { enabled: false, timeoutMs: 45000 } }, run: { totalTimeoutMs: 600000 } };
    await writeFile(configPath, JSON.stringify(legacy));
    const options = { userData: profile, cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} };
    let host = await DesktopRuntime.create(options);
    try {
      const initial = host.info();
      assert.equal(initial.configPath, configPath);
      assert.equal(initial.memory.queryRewriteEnabled, false);
      assert.equal(await readFile(configPath, "utf8"), JSON.stringify(legacy));
      assert.ok((await host.current.run("保留这条日用历史", { memoryConsolidation: "exclude" })).ok);
      await idle(host);
      const file = join(initial.directory, `${createHash("sha256").update(initial.threadId).digest("hex")}.jsonl`);
      const transcript = await readFile(file, "utf8");
      await host.enableMemory();
      assert.equal(host.info().threadId, initial.threadId);
      assert.equal(host.info().directory, initial.directory);
      assert.equal(host.info().memory.queryRewriteEnabled, true);
      assert.equal(await readFile(file, "utf8"), transcript);
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(saved.modules.shell, legacy.modules.shell);
      const memories = await host.current.listMemories();
      assert.ok(memories.ok); assert.equal(memories.value.entries.length, 0);
      await host.shutdown();
      host = await DesktopRuntime.create(options);
      assert.equal(host.info().memory.queryRewriteEnabled, true);
      assert.equal(host.info().threadId, initial.threadId);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === "保留这条日用历史")));
    } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("restores the previous conversation when the chosen Thread is owned by another controller", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-switch-lock-"));
    const options = { userData: join(root, "profile"), cwd: root, env: {}, modelAlias: "mock",
      model: new MockLanguageModelV3({ doStream: async () => response() }), send: () => {} };
    const host = await DesktopRuntime.create(options);
    let owner: DesktopRuntime | undefined;
    try {
      const previous = host.info();
      assert.ok((await host.current.run("切换失败后仍能看到的旧消息", { memoryConsolidation: "exclude" })).ok); await idle(host);
      await host.createThread(); const target = host.info();
      await host.selectThread(previous.threadId);
      owner = await DesktopRuntime.create({ ...options, userData: join(root, "other-profile"),
        env: { RUNLOOM_CONFIG: previous.configPath!, RUNLOOM_THREAD: target.threadId, RUNLOOM_TRANSCRIPTS: target.directory } });
      await assert.rejects(host.selectThread(target.threadId));
      assert.equal(host.info().threadId, previous.threadId);
      assert.ok((await host.current.history()).some(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === "切换失败后仍能看到的旧消息")));
      const registry = JSON.parse(await readFile(join(root, "profile", "desktop-identity.json"), "utf8"));
      assert.equal(registry.profiles[0].activeThreadId, previous.threadId);
    } finally { await owner?.shutdown(); await host.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
});
