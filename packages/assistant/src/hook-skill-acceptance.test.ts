import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { JsonlAgentStore } from "@serika/core";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import type { HookRule } from "./automation-hooks.js";
import { createCheckpointStore } from "./checkpoint-store.js";
import { createMemoryStore } from "./memory-v7-store.js";

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
    action: "add", text: SAVED_PREFERENCE, kind: "preference",
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
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: {
    memory: { enabled: true, autoConsolidate: true }, checkpoint: { enabled: true },
  }, ...(compact ? { contextCompaction: { enabled: true, contextWindowTokens: 30000, maxOutputTokens: 1024,
    safetyMarginTokens: 512, keepRecentTokens: 256, summaryMaxOutputTokens: 1024 } } : {}),
  automation: { skills: withExternalSkill ? [{ id: skillId, directory }] : [], ...(hooks === null ? {} : { hooks }) } }));
  const controllers: AssistantController[] = [];
  const open = async (model: MockLanguageModelV3, thread = "origin") => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: thread, configPath },
      modelAlias: "scripted", model, output, env: {}, cwd: root });
    const controller = createAssistantController(app); controllers.push(controller);
    await controller.runs.list(); // Wait for real Thread leases/recovery, not a startup timing guess.
    return { app, controller };
  };
  return { root, workspace, directory, configPath, open, cleanup: async () => {
    for (const controller of controllers) await controller.shutdown();
    await rm(root, { recursive: true, force: true });
  } };
}

async function skillHash(controller: AssistantController, id: string) {
  const diagnostics = await controller.automation.getDiagnostics();
  const skill = diagnostics.skills.find(skill => skill.id === id);
  assert.ok(skill, `registered Skill ${id} must appear in diagnostics`);
  assert.match(skill.hash, /^[a-f0-9]{64}$/);
  return skill.hash;
}





test("config hook dispatches an external text Skill with its instructions and no inherited tools/history/Memory/checkpoint", async () => {
  const hooks: HookRule[] = [{ id: "brief-after-chat", event: "primary.completed", handler: { type: "skill", id: "brief" } }];
  const f = await fixture(hooks, true);
  const observations: ModelOptions[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => { observations.push(options); return response(); } });
  try {
    const { app, controller } = await f.open(model);
    assert.ok((await app.memoryStore!.add({ scope: { kind: "user" }, text: "MEMORY_PRIVATE_MARKER", pinned: true })).ok);
    assert.ok((await createCheckpointStore(join(f.workspace, ".runloom/checkpoint.json")).saveNextVersion({ expectedVersion: null, sourceThreadId: app.threadId,
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
    const runs = await controller.runs.list();
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.status === "completed"));
    const diagnostics = controller.automation.getDiagnostics();
    assert.equal(diagnostics.recent.length, 1);
    assert.equal(diagnostics.recent[0]?.source, "hook");
    assert.equal(diagnostics.recent[0]?.ruleId, "brief-after-chat");
    assert.equal(diagnostics.recent[0]?.event, "primary.completed");
    assert.equal(diagnostics.recent[0]?.status, "completed");
    assert.doesNotMatch(JSON.stringify(diagnostics.skills), /CUSTOM_TEXT_SKILL/, "diagnostics expose metadata, not instruction contents");
    const saved = await app.memoryStore!.list(); assert.ok(saved.ok);
    assert.equal(saved.entries.length, 1, "text Skill must not perform implicit memory consolidation");
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
    const mismatch = await controller.automation.runSkill({ id: "brief", expectedHash: wrongHash, input: "Summarize this" });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "SKILL_CHANGED");
    await writeFile(join(f.directory, "SKILL.md"), TEXT_INSTRUCTIONS + "\nChanged after startup.");
    const changed = await controller.automation.runSkill({ id: "brief", expectedHash: hash, input: "Summarize this" });
    assert.equal(changed.ok, false);
    if (!changed.ok) assert.equal(changed.error.code, "SKILL_CHANGED");
    assert.equal(calls, 0);
    assert.deepEqual(await controller.runs.list(), []);
    assert.deepEqual(await controller.getHistory(), []);
    assert.equal(controller.getSnapshot().state.kind, "idle");
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
    const runs = await controller.runs.list();
    assert.equal(runs.filter(run => run.phase === "primary" && run.status === "completed").length, 2);
    assert.equal(runs.filter(run => run.phase === "skill" && run.status === "cancelled").length, 1,
      JSON.stringify({ runs: runs.map(run => ({ runId: run.runId, phase: run.phase, status: run.status })),
        recent: controller.automation.getDiagnostics().recent, abortObserved }));
    assert.equal(runs.filter(run => run.status === "running").length, 0);
    const recent = controller.automation.getDiagnostics().recent;
    assert.equal(recent.filter(item => item.skillId === "brief" && item.status === "cancelled").length, 1);
    assert.deepEqual(await app.memoryStore!.list(), { ok: true, entries: [] });
  } finally { await f.cleanup(); }
});
