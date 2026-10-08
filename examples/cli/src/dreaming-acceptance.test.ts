import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { EXECUTION_RECORD_MAX_RUNS } from "./execution-record-store.js";

function answer(text: string) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "answer" },
    { type: "text-delta" as const, id: "answer", delta: text },
    { type: "text-end" as const, id: "answer" },
    { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    } },
  ] }) };
}
function experiences(value: unknown): { source: { taskId: string } }[] | undefined {
  if (typeof value === "string") { try { return experiences(JSON.parse(value)); } catch { return undefined; } }
  if (typeof value !== "object" || value === null) return undefined;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.experiences)) return object.experiences as { source: { taskId: string } }[];
  for (const child of Object.values(object)) { const found = experiences(child); if (found) return found; }
  return undefined;
}
function method(ids: string[]) { return JSON.stringify({ skills: [{ key: "recap-method", title: "项目复盘", description: "整理项目复盘时使用", recallTerms: ["复盘", "总结"],
  instructions: "先写一行结论，再列两条可执行步骤。区分已验证结果和未核对事项。", sourceTaskIds: ids }] }); }
async function idle(controller: AssistantController, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    await delay(5);
    assert.ok(Date.now() < deadline, "Controller did not settle");
  } while (controller.getSnapshot().state.kind !== "idle");
}
async function fixture(model: MockLanguageModelV3) {
  const root = await mkdtemp(join(tmpdir(), "serika-dreaming-acceptance-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const config = join(root, "config.json");
  const configure = (enabled: boolean) => writeFile(config, JSON.stringify({ version: 1, workspace,
    modules: { memory: { enabled: true, autoConsolidate: false } }, automation: { hooks: [], dreaming: { enabled } } }));
  await configure(false);
  const open = async (thread: string, settle = true, selected: { model: LanguageModel; modelAlias: string } = { model, modelAlias: "scripted" }) => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", config],
      cwd: root, env: {}, ...selected, output });
    const controller = createAssistantController(app);
    await controller.listRuns();
    if (settle) await idle(controller, selected.modelAlias === "scripted" ? 10_000 : 75_000);
    return { app, controller };
  };
  const seed = async (controller: AssistantController) => {
    for (const topic of ["项目甲", "项目乙"]) {
      const created = await controller.createWorkTask({ goal: `${topic}复盘：先结论，再列两条行动`, acceptance: [{
        id: "quality", description: "复盘格式符合要求", method: "human", required: true, verification: { kind: "human" },
      }] }); assert.ok(created.ok);
      assert.ok((await controller.runWorkTask({ id: created.value.id, expectedRevision: created.value.revision, completionCheck: false })).ok);
      await idle(controller);
      const current = await controller.getWorkTask(created.value.id); assert.ok(current.ok);
      const delivery = await controller.submitWorkTaskDelivery({ id: current.value.id, expectedRevision: current.value.revision,
        summary: `${topic}结论与两条行动已交付` }); assert.ok(delivery.ok);
      const accepted = await controller.recordHumanAcceptance({ id: current.value.id, expectedRevision: delivery.value.revision,
        criterionId: "quality", decision: "passed", note: "测试操作员明确接受这份夹具的格式，不代表生产质量" }); assert.ok(accepted.ok);
      assert.equal(accepted.value.status, "completed");
    }
  };
  return { root, workspace, configure, open, seed, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("learned methods survive real journal retention and runtime reconstruction without replaying old tasks", { timeout: 30_000 }, async () => {
  let requests = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    requests++;
    const supplied = experiences(options.prompt);
    return answer(supplied ? method(supplied.map(item => item.source.taskId)) : "结论：已整理。\n1. 核对交付\n2. 安排后续");
  } });
  const f = await fixture(model);
  let controller: AssistantController | undefined;
  try {
    const original = await f.open("origin"); controller = original.controller;
    await f.seed(controller); await controller.shutdown(); controller = undefined;
    await f.configure(true);
    const learning = await f.open("learning"); controller = learning.controller;
    const overview = await controller.getDreamingOverview(); assert.ok(overview.ok);
    const learned = overview.value.skills[0]!; assert.ok(learned);
    for (let i = 0; i <= EXECUTION_RECORD_MAX_RUNS; i++) {
      const runId = `retention-${i}`, threadId = "retention";
      await learning.app.executionRecords.startRun({ runId, threadId, phase: "skill" });
      await learning.app.executionRecords.finishRun(runId, { runId, threadId, status: "completed", text: "retention fixture", steps: 1, usage: {} });
    }
    for (const source of learned.sources) assert.equal(await learning.app.executionRecords.getRun(source.threadId, source.runId), null);
    const before = requests;
    await controller.shutdown(); controller = undefined;
    const restored = await f.open("after-retention"); controller = restored.controller;
    const after = await controller.getDreamingOverview(); assert.ok(after.ok);
    assert.equal(after.value.skills[0]?.needsReview, false);
    assert.equal(requests, before, "reading and reopening archived experience never replay model or tools");
    assert.ok((await controller.run("为项目丙整理复盘", { memoryConsolidation: "exclude" })).ok);
    await idle(controller);
    assert.equal(controller.getLearnedSkillReferences()?.skills[0]?.id, learned.id);
    assert.equal(requests, before + 1);
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("approved experiences reflect through the one AgentLoop, survive restart, guide a new Thread, and stop after disable", { timeout: 30_000 }, async () => {
  let reflections = 0;
  const requests: string[] = [];
  const model = new MockLanguageModelV3({ doStream: async options => {
    const prompt = JSON.stringify(options.prompt); requests.push(prompt);
    if (prompt.includes("You extract reusable procedural methods")) {
      reflections++;
      assert.equal(options.tools?.length ?? 0, 0, "reflection has no tools");
      assert.doesNotMatch(prompt, /private-unrelated-chat/);
      const sources = experiences(options.prompt); assert.ok(sources);
      return answer(method(sources.map(item => item.source.taskId)));
    }
    return answer(prompt.includes("Host-selected learned procedural guidance") ? "结论：项目丙已完成。\n1. 核对交付\n2. 安排后续" : "普通回复");
  } });
  const f = await fixture(model);
  let controller: AssistantController | undefined;
  try {
    const initial = await f.open("origin"); controller = initial.controller;
    assert.ok((await controller.run("private-unrelated-chat", { memoryConsolidation: "exclude" })).ok); await idle(controller);
    await f.seed(controller);
    assert.equal((await controller.dream()).ok, false, "learning is explicit opt-in");
    assert.equal(reflections, 0);
    await controller.shutdown(); controller = undefined;
    await f.configure(true);
    const reopened = await f.open("new-thread"); controller = reopened.controller;
    const errors: string[] = [];
    controller.subscribe(event => { if (event.type === "error") errors.push(event.message); });
    let overview = await controller.getDreamingOverview(); assert.ok(overview.ok);
    assert.equal(overview.value.lastAttempt?.status, "completed");
    assert.equal(overview.value.skills.length, 1); assert.equal(overview.value.pendingExperiences, 0);
    const learned = overview.value.skills[0]!;
    assert.equal(learned.sources.length, 2); assert.equal(learned.revision, 1);
    assert.equal((await controller.dream()).ok, false, "processed batch does not open another model Run");
    assert.equal(reflections, 1);
    const launched = await controller.run("整理项目丙的复盘", { memoryConsolidation: "exclude" });
    assert.ok(launched.ok, JSON.stringify({ launched, errors })); await idle(controller);
    assert.deepEqual(controller.getLearnedSkillReferences()?.skills, [{ id: learned.id, revision: 1, title: learned.title }]);
    assert.match(controller.getSnapshot().lastPrimaryResult?.text ?? "", /结论.*\n1.*\n2/s);
    const history = await controller.getHistory();
    assert.equal(history.some(message => JSON.stringify(message).includes("sourceTaskIds")), false, "maintenance batches are not chat history");
    assert.equal((await controller.listRuns()).every(run => run.phase === "primary"), true);
    const disabled = await controller.changeLearnedSkill({ id: learned.id, expectedRevision: 1, action: "disable" }); assert.ok(disabled.ok);
    assert.equal(disabled.value.revision, 2);
    assert.equal((await controller.changeLearnedSkill({ id: learned.id, expectedRevision: 1, action: "enable" })).ok, false, "stale review cannot override disable");
    assert.ok((await controller.run("项目丁复盘", { memoryConsolidation: "exclude" })).ok); await idle(controller);
    assert.deepEqual(controller.getLearnedSkillReferences()?.skills, []);
    await controller.shutdown(); controller = undefined;
    const restart = await f.open("third-thread"); controller = restart.controller;
    overview = await controller.getDreamingOverview(); assert.ok(overview.ok);
    assert.equal(overview.value.skills[0]?.enabled, false);
    assert.equal(reflections, 1);
    const restored = await controller.changeLearnedSkill({ id: learned.id, expectedRevision: 2, action: "restore", restoreRevision: 1 }); assert.ok(restored.ok);
    assert.equal(restored.value.revision, 3); assert.equal(restored.value.enabled, false, "restore never revives authority or overrides disable");
    const enabled = await controller.changeLearnedSkill({ id: learned.id, expectedRevision: 3, action: "enable" }); assert.ok(enabled.ok);
    assert.ok((await controller.run("项目戊复盘", { memoryConsolidation: "exclude" })).ok); await idle(controller);
    assert.equal(controller.getLearnedSkillReferences()?.skills[0]?.revision, 4);
    assert.ok(requests.length > 0);
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("real configured model learns approved recap fixtures, reuses across Threads, and respects persistent disable", {
  skip: process.env.RUNLOOM_DREAMING_ACCEPTANCE !== "1", timeout: 240_000,
}, async () => {
  const selected = configureCliModel(() => { throw new Error("Real dreaming acceptance cannot use mock fallback"); });
  assert.notEqual(selected.modelAlias, "mock/default");
  // These are explicitly accepted deterministic test artifacts, not model self-approved production tasks.
  const f = await fixture(new MockLanguageModelV3({ doStream: async () => answer("结论：项目进度符合预期。\n1. 核对本次交付。\n2. 制定下一步行动。") }));
  let controller: AssistantController | undefined;
  try {
    controller = (await f.open("approved-fixtures")).controller;
    await f.seed(controller); await controller.shutdown(); controller = undefined;
    await f.configure(true);
    controller = (await f.open("real-learning", true, selected)).controller;
    const overview = await controller.getDreamingOverview(); assert.ok(overview.ok);
    assert.equal(overview.value.lastAttempt?.status, "completed", JSON.stringify(overview.value.lastAttempt));
    assert.ok(overview.value.skills.length, "real reflection did not produce a supported method");
    assert.equal(overview.value.processedExperiences, 2);
    const query = "请用你当前选用的经验方法写项目丙的复盘：本周迁移按期完成，遗留文档缺少负责人与截止日期，下周需要核对交付并安排补文档。只输出复盘正文，不调用工具。";
    assert.ok((await controller.run(query, { memoryConsolidation: "exclude" })).ok); await idle(controller, 75_000);
    const reference = controller.getLearnedSkillReferences(); assert.ok(reference?.skills.length, "host must select a persisted method, not rely on model self-report");
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    const recap = controller.getSnapshot().lastPrimaryResult?.text ?? "";
    assert.match(recap.split(/\r?\n/).find(line => line.trim()) ?? "", /结论|按期完成/, "real answer must start with the conclusion, not just claim Skill use");
    const actionLines = recap.split(/\r?\n/).filter(line => /^\s*(?:[-*]\s+|(?:\*\*)?(?:[0-9]+[.)、]|[一二][、.]|步骤[一二12])[\s：:])/.test(line));
    assert.equal(actionLines.length, 2, `the actual real-model answer must contain two actionable steps; observed answer: ${JSON.stringify(recap)}; selected methods: ${JSON.stringify(overview.value.skills.filter(skill => reference.skills.some(selected => selected.id === skill.id)).map(skill => skill.instructions))}`);
    const ids = reference.skills.map(skill => skill.id);
    for (const item of overview.value.skills) {
      const changed = await controller.changeLearnedSkill({ id: item.id, expectedRevision: item.revision, action: "disable" }); assert.ok(changed.ok);
    }
    await controller.shutdown(); controller = undefined;
    controller = (await f.open("real-after-disable", true, selected)).controller;
    assert.ok((await controller.run(query, { memoryConsolidation: "exclude" })).ok); await idle(controller, 75_000);
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    assert.deepEqual(controller.getLearnedSkillReferences()?.skills, []);
    const current = await controller.getDreamingOverview(); assert.ok(current.ok);
    assert.equal(current.value.skills.every(skill => !skill.enabled), true);
    console.log(JSON.stringify({ model: selected.modelAlias, reflection: "passed", selectedSkillIds: ids, newThreadReuse: "passed", runtimeReopenAndDisable: "passed", nativeElectron: "not_run", productionTaskQuality: "not_claimed" }));
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("foreground chat preempts reflection, waits for settlement, and cancelled experience remains retryable", { timeout: 30_000 }, async () => {
  let attempts = 0;
  let reflectionStarted!: () => void;
  const began = new Promise<void>(resolve => { reflectionStarted = resolve; });
  let controller: AssistantController | undefined;
  const model = new MockLanguageModelV3({ doStream: async options => {
    if (!JSON.stringify(options.prompt).includes("You extract reusable procedural methods")) return answer("正常对话回复");
    const sources = experiences(options.prompt); assert.ok(sources);
    if (++attempts === 1) {
      reflectionStarted();
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(options.abortSignal?.reason ?? new Error("aborted"));
        if (options.abortSignal?.aborted) aborted();
        else options.abortSignal?.addEventListener("abort", aborted, { once: true });
      });
    }
    return answer(method(sources.map(item => item.source.taskId)));
  } });
  const f = await fixture(model);
  try {
    controller = (await f.open("origin")).controller; await f.seed(controller); await controller.shutdown(); controller = undefined;
    await f.configure(true);
    controller = (await f.open("different", false)).controller;
    await began;
    const before = await controller.getDreamingOverview(); assert.ok(before.ok);
    assert.equal(before.value.processedExperiences, 0);
    assert.equal(controller.getSnapshot().canSubmit, true);
    assert.ok((await controller.run("现在先回答我的新问题", { memoryConsolidation: "exclude" })).ok);
    await idle(controller);
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    const history = await controller.getHistory();
    assert.equal(history.filter(message => message.role === "user").length, 1);
    const after = await controller.getDreamingOverview(); assert.ok(after.ok);
    assert.equal(attempts, 2, "one cancelled attempt plus one later idle retry, not a hidden loop");
    assert.equal(after.value.processedExperiences, 2); assert.equal(after.value.skills.length, 1);
    assert.equal(after.value.lastAttempt?.status, "completed");
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("invalid reflection stays pending and explicit retry commits once without turning inference into factual memory", { timeout: 30_000 }, async () => {
  let invalid = true;
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    if (!JSON.stringify(options.prompt).includes("You extract reusable procedural methods")) return answer("复盘已写");
    calls++;
    const sources = experiences(options.prompt); assert.ok(sources);
    return answer(invalid ? "looks successful but not JSON" : method(sources.map(item => item.source.taskId)));
  } });
  const f = await fixture(model); let controller: AssistantController | undefined;
  try {
    controller = (await f.open("origin")).controller; await f.seed(controller); await controller.shutdown(); controller = undefined;
    await f.configure(true);
    const active = await f.open("different"); controller = active.controller;
    let view = await controller.getDreamingOverview(); assert.ok(view.ok);
    assert.equal(view.value.lastAttempt?.status, "failed"); assert.equal(view.value.pendingExperiences, 2);
    assert.deepEqual(view.value.skills, []);
    invalid = false;
    assert.ok((await controller.dream()).ok); await idle(controller);
    view = await controller.getDreamingOverview(); assert.ok(view.ok);
    assert.equal(view.value.lastAttempt?.status, "completed"); assert.equal(view.value.skills.length, 1); assert.equal(calls, 2);
    const memories = await controller.listMemories(); assert.ok(memories.ok);
    assert.equal(memories.value.entries.length, 0, "procedural inference must not enter factual Memory");
    const doc = JSON.parse(await readFile(join(f.workspace, ".runloom/dreaming.json"), "utf8"));
    assert.equal(doc.batches.length, 1); assert.equal(doc.processed.length, 2);
  } finally { await controller?.shutdown(); await f.cleanup(); }
});
