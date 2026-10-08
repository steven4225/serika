import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { JsonlAgentStore } from "@aisdk-agent/core";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { configureCliModel, inspectCliModelConfig } from "./model-config.js";
import { loadScheduledSkillAutomation, prepareScheduledSkillTask } from "./scheduled-skill.js";
import { createTaskStore } from "./task-store.js";
import { createTaskWorkerAgent } from "./task-worker-entry.js";
import { runTaskWorker } from "./task-worker.js";

const INPUT = "将「读书20分钟、散步10分钟」写成一行中文计划，不增加事项；行末写入 SERIKA-SKILL-OK。";
function boundedModelDispatch(signal: AbortSignal, dispatch: typeof fetch = fetch) {
  let phase = "manual";
  let requests = 0;
  const dispatched = new Set<string>();
  const boundedFetch: typeof fetch = async (input, init) => {
    signal.throwIfAborted();
    const request = new Request(input, init);
    // Equal manual/scheduled input is intentional: these are two distinct
    // accepted invocations, not retries. Reject duplicates within each Run.
    const fingerprint = createHash("sha256").update(phase).update(request.method).update(request.url)
      .update(await request.clone().text()).digest("hex");
    if (dispatched.has(fingerprint)) throw new Error("Paid acceptance forbids model-request replay within one invocation");
    if (requests >= 3) throw new Error("Paid acceptance permits at most three external requests");
    dispatched.add(fingerprint); requests += 1;
    return dispatch(request, { signal: AbortSignal.any([signal, request.signal]) });
  };
  return { fetch: boundedFetch, phase: (value: "manual" | "scheduled") => { phase = value; }, requests: () => requests };
}

test("paid dispatch guard permits equal input in separate manual/scheduled invocations, but refuses same-invocation retry", async () => {
  let actual = 0;
  const guard = boundedModelDispatch(new AbortController().signal, async () => { actual += 1; return new Response("ok"); });
  const send = () => guard.fetch("https://provider.invalid/model", { method: "POST", body: "the same request" });
  await send();
  await assert.rejects(send(), /replay within one invocation/);
  guard.phase("scheduled");
  await send();
  await assert.rejects(send(), /replay within one invocation/);
  assert.equal(actual, 2);
  assert.equal(guard.requests(), 2);
  await guard.fetch("https://provider.invalid/model", { method: "POST", body: "distinct third request" });
  await assert.rejects(guard.fetch("https://provider.invalid/model", { method: "POST", body: "distinct fourth request" }), /at most three/);
  assert.equal(actual, 3);
});

test("opt-in real model: manual and scheduled registered Skill use the production loop and persist a truthful inbox result", {
  skip: process.env.RUNLOOM_SCHEDULED_SKILL_ACCEPTANCE !== "1", timeout: 90_000,
}, async context => {
  context.mock.method(console, "error", () => console.log("Provider diagnostic omitted; inspect isolated acceptance report."));
  const env = { ...process.env };
  env.RUNLOOM_MODEL ??= env.COMMAND_CODE_API_KEY?.trim() ? "command-code" : env.DEEPSEEK_API_KEY?.trim() ? "deepseek" : "command-code";
  assert.notEqual(env.RUNLOOM_MODEL, "mock", "No mock fallback is permitted");
  const inspected = inspectCliModelConfig(env);
  assert.equal(inspected.credential, "present", "Configured real provider credentials are required");
  const dispatch = boundedModelDispatch(context.signal);
  const configured = configureCliModel(() => { throw new Error("Mock fallback is forbidden"); }, env, { fetch: dispatch.fetch });
  const root = await mkdtemp(join(tmpdir(), "runloom-scheduled-skill-real-"));
  const workspace = join(root, "workspace");
  const directory = join(root, "trusted-planning-skill");
  await Promise.all([mkdir(workspace), mkdir(directory)]);
  await writeFile(join(directory, "SKILL.md"), "仅按用户给出的文本整理成一行计划，不加新事项，不执行工具、不声称查询了其他来源。保留用户给出的识别词。");
  await writeFile(join(directory, "skill.json"), JSON.stringify({ version: 1, id: "simple-plan", kind: "text",
    description: "整理提供的事项为一行计划", tools: [], limits: { maxSteps: 1 } }));
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { task: { enabled: true } },
    automation: { skills: [{ id: "simple-plan", directory }], hooks: [] } }));
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "origin", "--config", configPath],
    ...configured, output, env, cwd: root });
  const controller = createAssistantController(app);
  const stopped = new AbortController();
  const report: Record<string, unknown> = { status: "failed", modelAlias: configured.modelAlias, modelId: inspected.modelId,
    Electron: "not_run", workerProcess: "not_run", worker: "in_process_production_loop", service: "not_run", notification: "not_run" };
  let agent: ReturnType<typeof createTaskWorkerAgent> | undefined;
  const cancel = () => { stopped.abort(); void controller.cancel(); };
  context.signal.addEventListener("abort", cancel, { once: true });
  try {
    await controller.listRuns();
    const skill = controller.getAutomationDiagnostics().skills.find(item => item.id === "simple-plan"); assert.ok(skill);
    const manual = await controller.runSkill({ id: skill.id, expectedHash: skill.hash, input: INPUT }); assert.ok(manual.ok);
    while (controller.getSnapshot().state.kind !== "idle") {
      context.signal.throwIfAborted();
      assert.equal(controller.getSnapshot().pendingApproval, null);
      await delay(10, undefined, { signal: context.signal });
    }
    const manualReceipt = await controller.getRun(manual.value.runId);
    assert.equal(manualReceipt?.status, "completed"); assert.equal(manualReceipt?.phase, "skill");
    const manualText = (await controller.getHistory()).filter(message => message.role === "assistant")
      .flatMap(message => message.parts.filter(part => part.type === "text").map(part => part.text)).join("\n");
    assert.ok(manualText.includes("读书") && manualText.includes("散步") && manualText.includes("SERIKA-SKILL-OK"), "Actual manual paid answer must reflect the declared input");
    const due = Date.now() + 1_000;
    const saved = await controller.scheduleSkill({ id: skill.id, expectedHash: skill.hash, input: INPUT, runAt: new Date(due).toISOString() });
    assert.ok(saved.ok && saved.value.task);
    const id = saved.value.task.id;
    assert.equal(saved.value.service.enabled, false, "Acceptance must not install a daily background service");
    await delay(Math.max(0, due - Date.now() + 5), undefined, { signal: context.signal });
    const automation = await loadScheduledSkillAutomation({ configPath, workspaceRoot: workspace });
    const taskStore = createTaskStore(workspace);
    const transcripts = new JsonlAgentStore({ directory: join(workspace, ".runloom", "task-transcripts") });
    agent = createTaskWorkerAgent({ ...configured, store: transcripts, skills: automation.skills });
    dispatch.phase("scheduled");
    await runTaskWorker({ store: taskStore, runtime: agent.runtime, signal: AbortSignal.any([context.signal, stopped.signal]),
      pollIntervalMs: 5, prepareSkillTask: task => prepareScheduledSkillTask(automation, task),
      onTaskFinished: task => { if (task.id === id) stopped.abort(); },
    });
    const task = await taskStore.get(id); assert.ok(task.ok);
    assert.equal(task.value.status, "completed", `Task terminal status must be completed; error code=${task.value.error?.code ?? "none"}`);
    assert.ok(task.value.runId && task.value.threadId);
    const text = task.value.resultText; assert.ok(text);
    assert.ok(text.includes("读书") && text.includes("散步") && text.includes("SERIKA-SKILL-OK"), "Actual paid answer must reflect the declared input");
    const history = await transcripts.getMessages(task.value.threadId);
    assert.ok(history.some(message => message.role === "assistant"));
    const inbox = await controller.getTaskInbox(); assert.ok(inbox.ok && inbox.value.tasks.some(item => item.id === id));
    assert.ok((await taskStore.acknowledge(id)).ok);
    const reopened = await createTaskStore(workspace).get(id); assert.ok(reopened.ok && reopened.value.acknowledgedAt);
    const afterAck = await createTaskStore(workspace).list({ inbox: true }); assert.ok(afterAck.ok && !afterAck.value.tasks.some(item => item.id === id));
    const beforeReplayCheck = dispatch.requests();
    const aborted = new AbortController(); aborted.abort();
    await runTaskWorker({ store: createTaskStore(workspace), runtime: { run: async () => { throw new Error("Completed task cannot replay"); } }, signal: aborted.signal });
    const afterRecoveryClaim = await createTaskStore(workspace).claimNextDue(); assert.ok(afterRecoveryClaim.ok);
    assert.equal(afterRecoveryClaim.value, null, "A terminal completed schedule is not claimable again");
    assert.equal(dispatch.requests(), beforeReplayCheck);
    Object.assign(report, { status: "passed", configHash: createHash("sha256").update(await readFile(configPath)).digest("hex"),
      skillId: skill.id, skillHash: skill.hash, taskId: id, manualRunId: manual.value.runId, workerRunId: task.value.runId,
      terminalStatus: task.value.status, declaredInputAnswered: true, inboxPersisted: true, acknowledgementPersisted: true, replayRequests: 0 });
  } finally {
    context.signal.removeEventListener("abort", cancel);
    stopped.abort(); agent?.dispose(); await controller.shutdown();
    const requests = dispatch.requests();
    report.requests = requests;
    const reportPath = join(root, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ status: report.status, reportPath, modelAlias: configured.modelAlias, requests,
      Electron: "not_run", workerProcess: "not_run", notification: "not_run" }));
  }
});
