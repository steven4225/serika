import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import type { HookRule } from "./automation-hooks.js";
import { createCheckpointStore } from "./checkpoint-store.js";
import { createMemoryStore } from "./memory-store.js";

type ModelOptions = Parameters<MockLanguageModelV3["doStream"]>[0];
const PREFERENCE = "我的长期复盘偏好是先结论，再给两条步骤。";
const SAVED_PREFERENCE = "复盘先结论，再给两条步骤。";
const TEXT_INSTRUCTIONS = "CUSTOM_TEXT_SKILL: Return one concise sentence for supplied input only.";
const MEMORY_INSTRUCTIONS = "CUSTOM_MEMORY_SKILL: Prepare committed incremental sources once; stage only exact user quotes once, then finish.";

function response(toolName?: string, input?: unknown, text = "完成。") {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(toolName ? [{ type: "tool-call" as const, toolCallId: toolName, toolName, input: JSON.stringify(input) }] : [
      { type: "text-start" as const, id: "answer" },
      { type: "text-delta" as const, id: "answer", delta: text },
      { type: "text-end" as const, id: "answer" },
    ]),
    { type: "finish" as const, finishReason: { unified: toolName ? "tool-calls" as const : "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}

interface PreparedMaterial { batchId: string; turns: Array<{ user: { messageId: string; text: string } }> }
function preparedMaterial(value: unknown): PreparedMaterial | undefined {
  if (typeof value === "string" && value.includes('"turns":')) {
    try { return preparedMaterial(JSON.parse(value.slice(value.indexOf("\n{") + 1))); } catch { return undefined; }
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.batchId === "string" && Array.isArray(record.turns)) return record as unknown as PreparedMaterial;
  // A failed finalized Run may already have committed an older prepare result.
  // Choose the latest real tool output, never the first batch in Thread history.
  for (const child of Object.values(record).reverse()) {
    const found = preparedMaterial(child);
    if (found) return found;
  }
  return undefined;
}

function stageResponse(options: ModelOptions, sourceText = PREFERENCE, override = {}) {
  const material = preparedMaterial(options.prompt);
  assert.ok(material, "actual prepare tool output must reach the next model step");
  const source = material.turns.find(turn => turn.user.text === sourceText)?.user;
  assert.ok(source, "proposal must use a committed user source from the prepared material");
  const payload = { batchId: material.batchId, outcomes: material.turns.map(turn => ({ messageId: turn.user.messageId,
    status: turn.user.messageId === source.messageId ? "extracted" : "no_memory" })), proposals: [{
    action: "add", text: SAVED_PREFERENCE, kind: "preference", scope: { kind: "workspace" },
    sourceMessageId: source.messageId, sourceQuote: sourceText, reason: "用户明确长期偏好",
    eligibility: "durable_self_statement", ...override,
  }] };
  return options.tools?.length ? response("memory_stage_candidates", payload) : response(undefined, undefined, JSON.stringify(payload));
}

async function settle(controller: AssistantController) {
  const deadline = Date.now() + 5_000;
  while (controller.getSnapshot().state.kind !== "idle") {
    const approval = controller.getSnapshot().pendingApproval;
    assert.equal(approval, null, "host-owned Skill tools must not request user approval");
    assert.ok(Date.now() < deadline, "Controller did not settle");
    await delay(1);
  }
}

async function fixture(hooks: HookRule[] | null = [], withExternalSkill = false, kind: "text" | "memory-consolidate" = "text", compact = false) {
  const root = await mkdtemp(join(tmpdir(), "runloom-hook-skill-acceptance-"));
  const workspace = join(root, "workspace");
  const directory = join(root, "external-skill");
  const skillId = kind === "text" ? "brief" : "memory-custom";
  await mkdir(workspace);
  if (withExternalSkill) {
    await mkdir(directory);
    await writeFile(join(directory, "skill.json"), JSON.stringify({ version: 1, id: skillId, description: "Trusted external acceptance Skill",
      kind, tools: kind === "text" ? [] : ["memory_prepare_consolidation", "memory_stage_candidates"],
      limits: { maxSteps: kind === "text" ? 1 : 3 } }));
    await writeFile(join(directory, "SKILL.md"), kind === "text" ? TEXT_INSTRUCTIONS : MEMORY_INSTRUCTIONS);
  }
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: {
    memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" }, checkpoint: { enabled: true },
  }, ...(compact ? { contextCompaction: { enabled: true, contextWindowTokens: 30000, maxOutputTokens: 1024,
    safetyMarginTokens: 512, keepRecentTokens: 256, summaryMaxOutputTokens: 1024 } } : {}),
  automation: { skills: withExternalSkill ? [{ id: skillId, directory }] : [], ...(hooks === null ? {} : { hooks }) } }));
  const controllers: AssistantController[] = [];
  const open = async (model: MockLanguageModelV3, thread = "origin") => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", configPath],
      modelAlias: "scripted", model, output, env: {}, cwd: root });
    const controller = createAssistantController(app); controllers.push(controller);
    await controller.listRuns(); // Wait for real Thread leases/recovery, not a startup timing guess.
    return { app, controller };
  };
  return { root, workspace, directory, configPath, open, cleanup: async () => {
    for (const controller of controllers) await controller.shutdown();
    await rm(root, { recursive: true, force: true });
  } };
}

async function skillHash(controller: AssistantController, id: string) {
  const diagnostics = await controller.getAutomationDiagnostics();
  const skill = diagnostics.skills.find(skill => skill.id === id);
  assert.ok(skill, `registered Skill ${id} must appear in diagnostics`);
  assert.match(skill.hash, /^[a-f0-9]{64}$/);
  return skill.hash;
}

for (const compact of [false, true]) test(`Demo: synonymous observation attaches a source and extraction JSON stays out of primary chat (compaction=${compact})`, async () => {
  const f = await fixture(null, false, "text", compact);
  let observations = 0;
  const primaryPrompts: string[] = [];
  const primaryReplies: string[] = [];
  const extractionInstructions: string[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => {
    const instructions = JSON.stringify(options.prompt.filter(message => message.role === "system"));
    if (instructions.includes("Perform ONE extraction")) {
      const material = preparedMaterial(options.prompt); assert.ok(material);
      // Exercise the actual production instructions, not a semantic heuristic in the host.
      extractionInstructions.push(instructions);
      observations++;
      const source = material.turns[0]!.user;
      return response(undefined, undefined, JSON.stringify({ batchId: material.batchId,
        outcomes: [{ messageId: source.messageId, status: "extracted" }], proposals: [{
          action: "add", text: "用户喝咖啡不加糖。", kind: "preference", scope: { kind: "workspace" },
          factIdentity: { attribute: "coffee", scenario: "general", value: "unsweetened" },
          sourceMessageId: source.messageId, sourceQuote: source.text,
          reason: "新的同义观察", eligibility: "durable_self_statement",
        }] }));
    }
    const prompt = JSON.stringify(options.prompt);
    primaryPrompts.push(prompt);
    return response(undefined, undefined, "了解。");
  } });
  try {
    const { app, controller } = await f.open(model);
    controller.subscribe(event => { if (event.type === "run-result" && event.phase === "primary") primaryReplies.push(event.result.text); });
    for (const text of ["我喝咖啡不加糖。", "我喝咖啡不放糖。", "咖啡偏好是什么？"]) {
      assert.ok((await controller.run(text, text.includes("是什么") ? { memoryConsolidation: "exclude" } : {})).ok);
      await settle(controller);
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    }
    assert.equal(observations, 2);
    assert.equal(primaryPrompts.length, 3);
    assert.equal(primaryPrompts.some(prompt => /Extract only from this host-prepared material|\\"batchId\\"/.test(prompt)), false,
      "primary model input must exclude consolidation request and JSON response");
    assert.equal(extractionInstructions.some(prompt => prompt.includes("no_memory when nothing new needs retention, including information already fully covered")), false,
      "new synonymous sources must not be instructed to disappear as no_memory");
    assert.doesNotMatch(primaryReplies.join(""), /batchId|outcomes/);
    const saved = await app.memoryStore!.list(); assert.ok(saved.ok);
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0]!.text, "用户喝咖啡不加糖。");
    const inspected = await createMemoryStore(f.workspace).inspectMemory(saved.entries[0]!.id); assert.ok(inspected.ok);
    assert.equal(inspected.value.assertions.at(-1)!.sources.length, 2);
    const coverage = await app.memoryStore!.getConsolidationReceipt!(app.threadId); assert.ok(coverage.ok);
    assert.equal(coverage.value?.outcomes[0]?.status, "extracted");
  } finally { await f.cleanup(); }
});

test("explicit hooks: [] disables followups but manual memory Skill saves, persists and recalls in another Thread", async () => {
  const f = await fixture();
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls += 1;
    if (calls === 2) {
      assert.equal(options.tools?.length ?? 0, 0);
      assert.equal(options.prompt.filter(message => message.role === "assistant").length, 0);
      assert.equal(options.prompt.filter(message => message.role === "user").length, 1);
      return stageResponse(options);
    }
    return response();
  } });
  try {
    const { app, controller } = await f.open(model);
    assert.deepEqual((await controller.getAutomationDiagnostics()).hooks, []);
    assert.ok((await controller.run(PREFERENCE)).ok);
    await settle(controller);
    assert.equal(calls, 1, "disabled hooks must not create a second Run");
    assert.equal((await controller.listRuns()).length, 1);
    assert.equal(controller.getSnapshot().lastConsolidationResult, null);
    const disabledMaintenance = await controller.getMemoryMaintenance(); assert.ok(disabledMaintenance.ok);
    assert.equal(disabledMaintenance.value.consolidation.enabled, false);
    const hash = await skillHash(controller, "memory-consolidate");
    const started = await controller.runSkill({ id: "memory-consolidate", expectedHash: hash });
    assert.ok(started.ok);
    await settle(controller);
    assert.equal((await controller.getRun(started.value.runId))?.status, "completed", "Run admission is not completion evidence");
    const execution = controller.getAutomationDiagnostics().recent.find(item => item.runId === started.value.runId);
    assert.equal(execution?.source, "manual");
    assert.equal(execution?.skillId, "memory-consolidate");
    assert.equal(execution?.hash, hash);
    assert.equal(execution?.status, "completed");
    const manualMaintenance = await controller.getMemoryMaintenance(); assert.ok(manualMaintenance.ok);
    assert.equal(manualMaintenance.value.consolidation.enabled, false, "manual availability must not silently re-enable lifecycle hooks");
    const saved = await createMemoryStore(f.workspace).list();
    assert.ok(saved.ok);
    assert.equal(saved.entries.length, 1);
    assert.equal(saved.entries[0]!.text, SAVED_PREFERENCE);
    assert.equal(saved.entries[0]!.source?.kind, "conversation");
    const cursor = await app.memoryStore!.getConsolidationCursor(app.threadId);
    assert.ok(cursor.ok && cursor.value);
    assert.equal(calls, 2, "one extraction must not recursively fire primary.completed or request a second model step");
    const document = JSON.parse(await readFile(join(f.workspace, ".runloom", "memory.json"), "utf8"));
    assert.equal(document.version, 4);
    await controller.shutdown();
    const next = await f.open(model, "different-thread");
    assert.deepEqual(await next.controller.getHistory(), []);
    assert.ok((await next.controller.run("复盘时我喜欢什么格式？", { memoryConsolidation: "exclude" })).ok);
    await settle(next.controller);
    assert.equal(next.controller.getMemoryReferences()?.selected[0]?.id, saved.entries[0]!.id);
    assert.equal(next.controller.getMemoryReferences()?.selected[0]?.text, SAVED_PREFERENCE);
    assert.equal((await next.controller.getHistory()).filter(message => message.role === "user").length, 1);
  } finally { await f.cleanup(); }
});

test("empty startup backlog emits no running state or model request and admits immediate manual and primary Runs", async () => {
  const f = await fixture(null);
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls += 1;
    if (calls === 1) {
      const batch = preparedMaterial(options.prompt); assert.ok(batch);
      assert.deepEqual(batch.turns, []);
      return response(undefined, undefined, JSON.stringify({ batchId: batch.batchId, proposals: [], outcomes: [] }));
    }
    return response();
  } });
  let controller: AssistantController | undefined;
  try {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(f.root, "transcripts"), "--thread", "empty-startup", "--config", f.configPath],
      modelAlias: "scripted", model, output, env: {}, cwd: f.root });
    const originalBacklog = app.getMemoryConsolidationBacklog!;
    let markChecked!: () => void;
    const startupChecked = new Promise<void>(resolve => { markChecked = resolve; });
    app.getMemoryConsolidationBacklog = async () => {
      const result = await originalBacklog();
      assert.ok(result.ok && result.value === 0);
      markChecked(); return result;
    };
    controller = createAssistantController(app);
    const states: string[] = [];
    controller.subscribe(event => { if (event.type === "state") states.push(event.state.kind); });
    await controller.listRuns();
    await startupChecked; // Observe the actual readiness/backlog boundary, not a fixed delay.
    assert.equal(calls, 0);
    assert.equal(controller.getSnapshot().state.kind, "idle");
    assert.ok(!states.includes("running"), "empty ready hook must not flash a phantom running state");
    assert.deepEqual(await controller.listRuns(), []);
    const manual = await controller.runSkill({ id: "memory-consolidate", expectedHash: await skillHash(controller, "memory-consolidate") });
    assert.ok(manual.ok, "manual Skill must be admitted immediately after empty readiness");
    await settle(controller);
    assert.equal((await controller.getRun(manual.value.runId))?.status, "completed");
    assert.ok((await controller.run("A new ordinary chat", { memoryConsolidation: "exclude" })).ok);
    await settle(controller);
    assert.equal(calls, 2);
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("config hook dispatches an external text Skill with its instructions and no inherited tools/history/Memory/checkpoint", async () => {
  const hooks: HookRule[] = [{ id: "brief-after-chat", event: "primary.completed", handler: { type: "skill", id: "brief" } }];
  const f = await fixture(hooks, true);
  const observations: ModelOptions[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => { observations.push(options); return response(); } });
  try {
    const { app, controller } = await f.open(model);
    assert.ok((await app.memoryStore!.add({ text: "MEMORY_PRIVATE_MARKER", pinned: true })).ok);
    assert.ok((await createCheckpointStore(f.workspace).saveNextVersion({ expectedVersion: null, sourceThreadId: app.threadId,
      draft: { status: "active", goal: "CHECKPOINT_PRIVATE_MARKER", summary: "CHECKPOINT_PRIVATE_MARKER", completed: [],
        inProgress: [], nextActions: [], blockers: [], artifacts: [] } })).ok);
    await app.store.save(app.threadId, [{ id: "prior-user", role: "user", parts: [{ type: "text", text: "HISTORY_PRIVATE_MARKER" }] }]);
    assert.ok((await controller.run("Ordinary primary chat")).ok);
    await settle(controller);
    assert.equal(observations.length, 2, "one primary completion should run the configured Skill once");
    assert.ok(JSON.stringify(observations[0]!.prompt).includes("MEMORY_PRIVATE_MARKER"), "fixture must actually inject primary Memory");
    const skillPrompt = JSON.stringify(observations[1]!.prompt);
    assert.match(skillPrompt, /CUSTOM_TEXT_SKILL/);
    assert.doesNotMatch(skillPrompt, /HISTORY_PRIVATE_MARKER|MEMORY_PRIVATE_MARKER|CHECKPOINT_PRIVATE_MARKER/);
    assert.deepEqual(observations[1]!.tools ?? [], []);
    const runs = await controller.listRuns();
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.status === "completed"));
    const diagnostics = controller.getAutomationDiagnostics();
    assert.equal(diagnostics.recent.length, 1);
    assert.equal(diagnostics.recent[0]?.source, "hook");
    assert.equal(diagnostics.recent[0]?.ruleId, "brief-after-chat");
    assert.equal(diagnostics.recent[0]?.event, "primary.completed");
    assert.equal(diagnostics.recent[0]?.status, "completed");
    assert.doesNotMatch(JSON.stringify(diagnostics.skills), /CUSTOM_TEXT_SKILL/, "diagnostics expose metadata, not instruction contents");
    const saved = await app.memoryStore!.list(); assert.ok(saved.ok);
    assert.equal(saved.entries.length, 1, "text Skill must not perform implicit memory consolidation");
    const cursor = await app.memoryStore!.getConsolidationCursor(app.threadId); assert.ok(cursor.ok);
    assert.equal(cursor.value, null);
  } finally { await f.cleanup(); }
});

test("hash mismatch and changed external Skill bytes fail before a Run or transcript is created", async () => {
  const f = await fixture([], true);
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => { calls += 1; return response(); } });
  try {
    const { controller } = await f.open(model);
    const hash = await skillHash(controller, "brief");
    const wrongHash = (hash[0] === "0" ? "1" : "0") + hash.slice(1);
    const mismatch = await controller.runSkill({ id: "brief", expectedHash: wrongHash, input: "Summarize this" });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "SKILL_CHANGED");
    await writeFile(join(f.directory, "SKILL.md"), TEXT_INSTRUCTIONS + "\nChanged after startup.");
    const changed = await controller.runSkill({ id: "brief", expectedHash: hash, input: "Summarize this" });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.error.code, "SKILL_CHANGED");
    assert.equal(calls, 0);
    assert.deepEqual(await controller.listRuns(), []);
    assert.deepEqual(await controller.getHistory(), []);
    assert.equal(controller.getSnapshot().state.kind, "idle");
  } finally { await f.cleanup(); }
});

test("external memory Skill hook and manual execution share exact-source validation and automatic commit", async () => {
  const hooks: HookRule[] = [{ id: "custom-memory-after-chat", event: "primary.completed", handler: { type: "skill", id: "memory-custom" } }];
  const f = await fixture(hooks, true, "memory-consolidate");
  const manualPreference = "我的长期沟通偏好是先一句结论，再列两条步骤。";
  const manualSaved = "沟通先一句结论，再列两条步骤。";
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls += 1;
    if (calls > 1) {
      assert.match(JSON.stringify(options.prompt.filter(message => message.role === "system")), /CUSTOM_MEMORY_SKILL/);
      assert.deepEqual(options.tools?.flatMap(tool => tool.type === "function" ? [tool.name] : []).sort(),
        ["memory_prepare_consolidation", "memory_stage_candidates"]);
    }
    if (calls === 2 || calls === 5 || calls === 8) return response("memory_prepare_consolidation", { mode: "incremental" });
    if (calls === 3) return stageResponse(options);
    if (calls === 6 || calls === 9) return stageResponse(options, manualPreference, { text: manualSaved,
      ...(calls === 6 ? { sourceQuote: "A fabricated quote that no user committed" } : {}) });
    return response();
  } });
  try {
    const { app, controller } = await f.open(model);
    assert.ok((await controller.run(PREFERENCE)).ok); await settle(controller);
    const first = await createMemoryStore(f.workspace).list(); assert.ok(first.ok);
    assert.equal(first.entries.length, 1, "external memory hook must actually save, not just complete its Run");
    const user = (await controller.getHistory()).find(message => message.role === "user")!;
    assert.deepEqual(first.entries[0]?.source, { kind: "conversation", threadId: app.threadId, messageId: user.id, quote: PREFERENCE });
    const originalCursor = await app.memoryStore!.getConsolidationCursor(app.threadId); assert.ok(originalCursor.ok && originalCursor.value);
    assert.equal(originalCursor.value.throughMessageId, user.id);
    const hookRecord = controller.getAutomationDiagnostics().recent.find(item => item.ruleId === hooks[0]!.id);
    assert.equal(hookRecord?.status, "completed");
    assert.equal(hookRecord?.source, "hook");
    assert.ok(hookRecord?.runId);
    assert.equal((await controller.getRun(hookRecord.runId))?.phase, "consolidation");
    // A real committed backlog lets manual admission exercise the same Skill without firing a second primary hook.
    await app.store.save(app.threadId, [...await app.store.getMessages(app.threadId), {
      id: "manual-current-source", role: "user", parts: [{ type: "text", text: manualPreference }],
    }]);
    const hash = await skillHash(controller, "memory-custom");
    const invalid = await controller.runSkill({ id: "memory-custom", expectedHash: hash }); assert.ok(invalid.ok);
    await settle(controller);
    assert.equal(controller.getAutomationDiagnostics().recent.find(item => item.runId === invalid.value.runId)?.status, "failed");
    assert.deepEqual(await app.memoryStore!.getConsolidationCursor(app.threadId), originalCursor);
    const unchanged = await app.memoryStore!.list(); assert.ok(unchanged.ok); assert.equal(unchanged.entries.length, 1);
    const valid = await controller.runSkill({ id: "memory-custom", expectedHash: hash }); assert.ok(valid.ok);
    await settle(controller);
    const saved = await createMemoryStore(f.workspace).list(); assert.ok(saved.ok);
    assert.equal(saved.entries.length, 2);
    const manual = saved.entries.find(entry => entry.text === manualSaved); assert.ok(manual);
    assert.deepEqual(manual.source, { kind: "conversation", threadId: app.threadId, messageId: "manual-current-source", quote: manualPreference });
    const record = await controller.getRun(valid.value.runId); assert.equal(record?.phase, "consolidation");
    assert.equal(record?.status, "completed");
    assert.equal(controller.getAutomationDiagnostics().recent.find(item => item.runId === valid.value.runId)?.source, "manual");
    const cursor = await app.memoryStore!.getConsolidationCursor(app.threadId); assert.ok(cursor.ok && cursor.value);
    assert.equal(cursor.value.throughMessageId, "manual-current-source");
    assert.equal(calls, 10, "auxiliary memory completions do not recursively dispatch the primary hook");
  } finally { await f.cleanup(); }
});

test("ordinary chat preempts a real background text Skill without overlapping model calls or inheriting approval bypass", { timeout: 8_000 }, async () => {
  const hooks: HookRule[] = [{ id: "brief-after-chat", event: "primary.completed", handler: { type: "skill", id: "brief" } }];
  const f = await fixture(hooks, true);
  let textCalls = 0, primaryCalls = 0, activeText = false, abortObserved = false;
  let markStarted!: () => void;
  const textStarted = new Promise<void>(resolve => { markStarted = resolve; });
  const model = new MockLanguageModelV3({ doStream: async options => {
    const textSkill = JSON.stringify(options.prompt.filter(message => message.role === "system")).includes("CUSTOM_TEXT_SKILL");
    if (textSkill) {
      textCalls += 1;
      assert.deepEqual(options.tools ?? [], []);
      if (textCalls === 1) {
        assert.ok(options.abortSignal, "the real AgentLoop must supply its cancellation signal");
        activeText = true; markStarted();
        await new Promise<never>((_resolve, reject) => options.abortSignal!.addEventListener("abort", () => {
          abortObserved = true; activeText = false; reject(options.abortSignal!.reason);
        }, { once: true }));
      }
      return response();
    }
    assert.equal(activeText, false, "foreground model must start only after the background invocation stopped");
    primaryCalls += 1;
    if (primaryCalls === 2) {
      assert.equal(abortObserved, true);
      return response("checkpoint_prepare", {});
    }
    return response();
  } });
  try {
    const { app, controller } = await f.open(model);
    assert.ok((await controller.run("Start an ordinary chat")).ok);
    await textStarted;
    const background = controller.getSnapshot().state;
    assert.ok(background.kind === "running" && background.background === true);
    assert.equal(controller.getSnapshot().canSubmit, true);
    const next = await controller.run("Interrupt the background brief; read the checkpoint only after my approval");
    assert.ok(next.ok);
    const deadline = Date.now() + 2_000;
    while (controller.getSnapshot().pendingApproval === null) {
      assert.ok(Date.now() < deadline, "foreground checkpoint tool did not request normal approval");
      await delay(1);
    }
    const approval = controller.getSnapshot().pendingApproval!;
    assert.equal(approval.toolName, "checkpoint_prepare", "Skill admission does not authorize the next primary tool");
    assert.equal(controller.confirm({ approvalId: approval.approvalId, decision: "deny" }), true);
    await settle(controller);
    assert.equal(abortObserved, true);
    assert.equal(primaryCalls, 3, "two primary Runs plus the denied-tool followup remain in the existing AgentLoop");
    assert.equal(textCalls, 2, "each primary completion dispatches once, auxiliary completion never recurses");
    const runs = await controller.listRuns();
    assert.equal(runs.filter(run => run.phase === "primary" && run.status === "completed").length, 2);
    assert.equal(runs.filter(run => run.phase === "skill" && run.status === "cancelled").length, 1,
      JSON.stringify({ runs: runs.map(run => ({ runId: run.runId, phase: run.phase, status: run.status })),
        recent: controller.getAutomationDiagnostics().recent, abortObserved }));
    assert.equal(runs.filter(run => run.status === "running").length, 0);
    const recent = controller.getAutomationDiagnostics().recent;
    assert.equal(recent.filter(item => item.skillId === "brief" && item.status === "cancelled").length, 1);
    assert.deepEqual(await app.memoryStore!.list(), { ok: true, entries: [] });
  } finally { await f.cleanup(); }
});

test("program opt-out survives JSONL and an invalid excluded source cannot advance the memory Skill cursor", async () => {
  const f = await fixture();
  let calls = 0, invalidSource = true, excludedId = "";
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls += 1;
    if (calls > 2) {
      const material = preparedMaterial(options.prompt); assert.ok(material);
      assert.equal(material.turns.some(turn => turn.user.text.includes("OPT_OUT_PRIVATE")), false);
      return stageResponse(options, PREFERENCE, invalidSource ? { sourceMessageId: excludedId, sourceQuote: "OPT_OUT_PRIVATE" } : {});
    }
    return response();
  } });
  try {
    const { app, controller } = await f.open(model);
    assert.ok((await controller.run("OPT_OUT_PRIVATE", { memoryConsolidation: "exclude" })).ok);
    await settle(controller);
    const excluded = (await controller.getHistory()).find(message => message.role === "user")!;
    excludedId = excluded.id;
    // Use the actual Controller-generated source ID, not an invented fixture ID.
    const history = await new JsonlAgentStore({ directory: join(f.root, "transcripts") }).getMessages(app.threadId);
    assert.deepEqual(excluded.metadata, { memoryConsolidation: "exclude" });
    assert.deepEqual(history[0]?.metadata, excluded.metadata);
    assert.ok((await controller.run(PREFERENCE)).ok);
    await settle(controller);
    const hash = await skillHash(controller, "memory-consolidate");
    assert.ok((await controller.runSkill({ id: "memory-consolidate", expectedHash: hash })).ok);
    await settle(controller);
    const maintenance = await controller.getMemoryMaintenance(); assert.ok(maintenance.ok);
    assert.equal(maintenance.value.consolidation.lastAttempt?.status, "failed");
    const cursor = await createMemoryStore(f.workspace).getConsolidationCursor(app.threadId); assert.ok(cursor.ok);
    assert.equal(cursor.value, null);
    const candidates = await controller.listMemoryCandidates(); assert.ok(candidates.ok);
    assert.deepEqual(candidates.value.candidates, []);
    invalidSource = false;
    assert.ok((await controller.runSkill({ id: "memory-consolidate", expectedHash: hash })).ok);
    await settle(controller);
    const retried = await createMemoryStore(f.workspace).list(); assert.ok(retried.ok);
    assert.equal(retried.entries.length, 1);
    assert.equal(retried.entries[0]?.source?.kind, "conversation");
    assert.doesNotMatch(JSON.stringify(retried.entries), /OPT_OUT_PRIVATE/);
  } finally { await f.cleanup(); }
});

test("model failure after staging is not a successful memory Skill commit; retry still processes the source", async () => {
  const f = await fixture([], true, "memory-consolidate");
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls += 1;
    if (calls === 2 || calls === 5) return response("memory_prepare_consolidation", { mode: "incremental" });
    if (calls === 3 || calls === 6) return stageResponse(options);
    if (calls === 4) throw new Error("SCRIPTED_MODEL_FAILURE_AFTER_STAGE");
    return response();
  } });
  try {
    const { app, controller } = await f.open(model);
    assert.ok((await controller.run(PREFERENCE)).ok); await settle(controller);
    const hash = await skillHash(controller, "memory-custom");
    const failed = await controller.runSkill({ id: "memory-custom", expectedHash: hash }); assert.ok(failed.ok);
    await settle(controller);
    assert.equal((await controller.getRun(failed.value.runId))?.status, "failed");
    assert.equal(controller.getAutomationDiagnostics().recent.find(item => item.runId === failed.value.runId)?.status, "failed");
    const reopened = createMemoryStore(f.workspace);
    const cursor = await reopened.getConsolidationCursor(app.threadId); assert.ok(cursor.ok);
    assert.equal(cursor.value, null);
    assert.deepEqual(await reopened.list(), { ok: true, entries: [] });
    const candidates = await controller.listMemoryCandidates(); assert.ok(candidates.ok);
    assert.deepEqual(candidates.value.candidates, []);
    const retry = await controller.runSkill({ id: "memory-custom", expectedHash: hash }); assert.ok(retry.ok);
    await settle(controller);
    assert.equal((await controller.getRun(retry.value.runId))?.status, "completed");
    const saved = await reopened.list(); assert.ok(saved.ok);
    assert.equal(saved.entries.length, 1);
    const advanced = await reopened.getConsolidationCursor(app.threadId); assert.ok(advanced.ok && advanced.value);
    assert.equal(calls, 7);
  } finally { await f.cleanup(); }
});
