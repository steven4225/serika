import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { configureCliModel, inspectCliModelConfig } from "./model-config.js";
import { createMemoryStore } from "./memory-store.js";

const SKILL_ID = "personal-memory";
const RULE_ID = "personal-memory-after-chat";
const PREFERENCE = "我的长期写作偏好是：复盘先给一行结论，再列两条可执行步骤。此轮只回复收到，不调用工具。";

async function settle(controller: AssistantController, signal: AbortSignal) {
  while (controller.getSnapshot().state.kind !== "idle") {
    signal.throwIfAborted();
    assert.equal(controller.getSnapshot().pendingApproval, null, "Ordinary automatic memory must not request tool approval");
    await delay(20, undefined, { signal });
  }
}

/** No credentials/files are discovered here: the caller supplies its normal process environment. */
function selectedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.RUNLOOM_MODEL ??= env.COMMAND_CODE_API_KEY?.trim() ? "command-code"
    : env.DEEPSEEK_API_KEY?.trim() ? "deepseek"
      : env.MINIMAX_API_KEY?.trim() ? "minimax-m3" : "command-code";
  assert.notEqual(env.RUNLOOM_MODEL, "mock", "Real acceptance must select a non-mock provider");
  const inspected = inspectCliModelConfig(env);
  assert.equal(inspected.credential, "present", "A configured real-provider API key is required");
  return env;
}

test("opt-in real model: external memory Skill hook saves exact user provenance and a new Thread recalls current references", {
  skip: process.env.RUNLOOM_HOOK_SKILL_ACCEPTANCE !== "1", timeout: 120_000,
}, async context => {
  // AI SDK's default error logger can include provider request details. This
  // isolated opt-in test reports bounded status instead of dumping that object.
  context.mock.method(console, "error", () => {
    console.log("Real-model provider diagnostic omitted; see the isolated acceptance report.");
  });
  const env = selectedEnvironment();
  const inspected = inspectCliModelConfig(env);
  let requests = 0;
  const dispatched = new Set<string>();
  // Bound actual external dispatch, including any adapter retry. A duplicate
  // request fails before dispatch instead of silently repeating paid inference.
  const boundedFetch: typeof fetch = async (input, init) => {
    context.signal.throwIfAborted();
    const request = new Request(input, init);
    const fingerprint = createHash("sha256").update(request.method).update(request.url)
      .update(await request.clone().text()).digest("hex");
    if (dispatched.has(fingerprint)) throw new Error("Real acceptance forbids model-request retries");
    if (requests >= 5) throw new Error("Real acceptance allows at most five external model requests");
    dispatched.add(fingerprint); requests += 1;
    return fetch(request, { signal: AbortSignal.any([context.signal, request.signal]) });
  };
  const configured = configureCliModel(() => { throw new Error("Mock fallback is forbidden"); }, env, { fetch: boundedFetch });
  assert.ok(!configured.modelAlias.startsWith("mock"));
  const root = await mkdtemp(join(tmpdir(), "runloom-hook-skill-real-"));
  const workspace = join(root, "workspace");
  const directory = join(root, "trusted-personal-memory");
  await Promise.all([mkdir(workspace), mkdir(directory)]);
  const configPath = join(root, "config.json");
  const reportPath = join(root, "report.json");
  const modules = { memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic" } };
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules, automation: { hooks: [] } }));
  const output = () => { const stream = new PassThrough(); stream.resume(); return stream; };
  const appOptions = (thread: string) => ({
    args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", configPath],
    ...configured, output: output(), env, cwd: root,
  });
  const controllers: AssistantController[] = [];
  const report: Record<string, unknown> = { modelId: inspected.modelId, modelAlias: configured.modelAlias,
    status: "failed", Electron: "not_run", processRestart: "not_run", controllerReopen: false };
  const cancelOnTimeout = () => { for (const controller of controllers) void controller.cancel(); };
  context.signal.addEventListener("abort", cancelOnTimeout, { once: true });
  try {
    // Copy the actual production default instructions, not a shortened test-only prompt.
    // App construction invokes no model; no Controller/default hooks are started here.
    const bootstrap = await createRuntimeApp(appOptions("descriptor-bootstrap"));
    try {
      const builtin = bootstrap.automation?.getSkill("memory-consolidate");
      assert.ok(builtin, "Production default memory descriptor must be available");
      await writeFile(join(directory, "skill.json"), JSON.stringify({ version: 1, id: SKILL_ID,
        description: "Personal memory using the production committed-source protocol", kind: "memory-consolidate",
        tools: [...builtin.tools], limits: { ...builtin.limits } }));
      await writeFile(join(directory, "SKILL.md"), builtin.instructions);
    } finally { bootstrap.dispose(); }
    await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules, automation: {
      skills: [{ id: SKILL_ID, directory }],
      hooks: [{ id: RULE_ID, event: "primary.completed", handler: { type: "skill", id: SKILL_ID } }],
    } }));
    const configHash = createHash("sha256").update(await readFile(configPath)).digest("hex");
    const firstApp = await createRuntimeApp(appOptions("origin"));
    const first = createAssistantController(firstApp); controllers.push(first);
    await first.listRuns();
    const primary = await first.run(PREFERENCE); assert.ok(primary.ok);
    await settle(first, context.signal);
    assert.equal(first.getSnapshot().lastPrimaryResult?.status, "completed");
    const hook = first.getAutomationDiagnostics().recent.find(item => item.ruleId === RULE_ID && item.event === "primary.completed");
    assert.ok(hook?.runId, "Configured external hook must start a real auxiliary Run");
    assert.equal(hook.skillId, SKILL_ID);
    assert.equal(hook.source, "hook");
    assert.equal(hook.status, "completed", "A completed model Run alone is not a memory commit");
    const execution = await first.getRun(hook.runId);
    assert.equal(execution?.phase, "consolidation");
    assert.equal(execution?.status, "completed");
    for (const name of ["memory_prepare_consolidation", "memory_stage_candidates"]) {
      assert.ok(execution?.tools.some(tool => tool.toolName === name && tool.status === "completed"), `${name} must have a real completed tool receipt`);
    }
    const maintenance = await first.getMemoryMaintenance(); assert.ok(maintenance.ok);
    const accepted = maintenance.value.consolidation.lastAttempt?.accepted?.[0];
    assert.ok(accepted, "Require an actual host automatic-write receipt, not model prose");
    const memories = await createMemoryStore(workspace).list(); assert.ok(memories.ok);
    const memory = memories.entries.find(entry => entry.id === accepted.memoryId); assert.ok(memory);
    const source = (await first.getHistory()).find(message => message.role === "user" && message.parts.some(part => part.type === "text" && part.text === PREFERENCE));
    assert.ok(source, "Source must be the actual Controller-committed ordinary user message");
    assert.equal(memory.source?.kind, "conversation");
    if (memory.source?.kind !== "conversation") throw new Error("Missing conversation provenance");
    assert.equal(memory.source.threadId, "origin");
    assert.equal(memory.source.messageId, source.id);
    assert.ok(memory.source.quote && PREFERENCE.includes(memory.source.quote), "Saved quote must be an exact nonempty substring of the committed user source");
    const cursor = await firstApp.memoryStore!.getConsolidationCursor("origin"); assert.ok(cursor.ok && cursor.value);
    assert.equal(cursor.value.throughMessageId, source.id);
    report.primaryRunId = primary.runId; report.hookRunId = hook.runId; report.memoryId = memory.id;
    report.memoryRevision = memory.revision; report.hookStatus = hook.status;
    await first.shutdown();
    assert.equal(createHash("sha256").update(await readFile(configPath)).digest("hex"), configHash);
    const nextApp = await createRuntimeApp(appOptions("different-thread"));
    const next = createAssistantController(nextApp); controllers.push(next);
    await next.listRuns();
    assert.equal((await next.getHistory()).length, 0, "Recall Thread must not inherit the prior transcript");
    const recalled = await next.run("我写复盘通常先怎么开头，后面列几条具体行动？只回答我的偏好，不调用工具。", { memoryConsolidation: "exclude" });
    assert.ok(recalled.ok); await settle(next, context.signal);
    const reference = next.getMemoryReferences();
    assert.ok(reference?.selected.some(entry => entry.id === memory.id && entry.text === memory.text), "Program-owned current references must contain the persisted memory");
    const answer = next.getSnapshot().lastPrimaryResult;
    assert.equal(answer?.status, "completed");
    assert.ok(/结论/.test(answer.text) && /两条|2\s*条|两[个项]|二条/.test(answer.text), "Actual model answer must respond with the saved format");
    assert.equal((await next.listRuns()).length, 1, "Excluded recall must not start another memory Run");
    assert.ok(requests <= 5);
    Object.assign(report, { status: "passed", configHash, recallRunId: recalled.runId, recallStatus: answer.status,
      requests, controllerReopen: true, referenceMatched: true, sourceQuoteValidated: true });
  } finally {
    context.signal.removeEventListener("abort", cancelOnTimeout);
    for (const controller of controllers) await controller.shutdown();
    report.requests = requests;
    // Retain only isolated test artifacts and bounded metadata for human inspection.
    // No API keys, full prompts or provider error objects enter this report/output.
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, reportPath, modelAlias: configured.modelAlias, requests, Electron: "not_run" }));
  }
});
