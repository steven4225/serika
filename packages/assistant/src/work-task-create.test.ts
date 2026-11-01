import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { InMemoryAgentStore } from "@serika/core";
import { createRuntimeApp } from "./app.js";
import { createTaskStore } from "./task-store.js";
import { createTaskWorkerAgent } from "./task-worker-entry.js";
import { verifyAutomaticCriterion } from "./work-task-verification.js";
import { workTaskPhase } from "./work-task-store.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const command = "node --test slug.test.js";
const proposal = {
  goal: "修复这个项目的 slug 空格处理",
  constraints: ["保留已有行为"],
  acceptance: [
    { id: "file", description: "交付 src/slug.ts", method: "automatic" as const, required: true, verification: { kind: "artifact_exists" as const, path: "src/slug.ts", requireReadback: true } },
    { id: "test", description: "回归测试", method: "automatic" as const, required: true, verification: { kind: "shell_exit_zero" as const, command, cwd: "." } },
    { id: "human", description: "改动范围可接受", method: "human" as const, required: true, verification: { kind: "human" as const } },
  ],
};
const userText = "记录一个任务：修复这个项目的 slug 空格处理。约束：保留已有行为。交付 src/slug.ts。人工项：改动范围可接受。";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "serika-work-task-create-"));
  const projectDirectory = join(root, "project");
  const other = join(root, "other");
  await mkdir(join(projectDirectory, "scripts"), { recursive: true });
  await mkdir(other);
  await writeFile(join(projectDirectory, "scripts/check.sh"), `${command}\n`);
  const projectReal = await realpath(projectDirectory);
  const otherReal = await realpath(other);
  const project = { id: "project-a", directory: projectReal, name: "project", kind: "folder" as const };
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 2, projectDirectory: projectReal, authorizedDirectories: [
    { path: otherReal, access: "readwrite" }, { path: projectReal, access: "readwrite" },
  ], modules: { task: { enabled: true }, "read-file": { enabled: true }, shell: { enabled: true } } }));
  let steps: { name: string; input: unknown; toolCallId?: string }[] = [];
  let index = 0;
  const offered: string[][] = [];
  let modelCalls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    modelCalls += 1;
    offered.push((options.tools ?? []).flatMap(tool => tool.type === "function" ? [tool.name] : []));
    const step = steps[index++];
    if (!step) {
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ] }) };
    }
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: step.toolCallId ?? (step.name === "work_task_create" ? "create-1" : `read-${index}`), toolName: step.name, input: JSON.stringify(step.input) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
    ] }) };
  } });
  const app = await createRuntimeApp({
    directory: join(root, "transcripts"), assistant: { dataDirectory: join(root, "data"), threadId: "chat-1", configPath },
    modelAlias: "scripted", model, output: new PassThrough(), env: {}, cwd: root, project,
  });
  app.enableExecutionRecords();
  const cards: string[] = [];
  let allowCreate = true;
  const unsubscribe = app.toolConfirmation!.subscribePending(pending => {
    if (!pending?.preview.trim()) return;
    if (pending.toolName === "work_task_create") cards.push(pending.preview);
    app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: pending.toolName === "work_task_create" && !allowCreate ? "deny" : "allow" });
  });
  const file = join(root, "data/tasks.json");
  return {
    app, project, file, cards, offered, root,
    modelCalls: () => modelCalls,
    async bytes() { return readFile(file); },
    async tasks() {
      const listed = await app.workTasks!.list();
      assert.ok(listed.ok);
      return listed.value;
    },
    async run(messageId: string, text: string, plan: typeof steps, expected = "completed") {
      steps = plan; index = 0; cards.length = 0; modelCalls = 0;
      app.toolConfirmation!.beginRun();
      try {
        const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId, messages: [{ id: messageId, role: "user", parts: [{ type: "text", text }] }] });
        const result = await handle.result;
        assert.equal(result.status, expected, JSON.stringify(result.error ?? result));
        return result;
      } finally { app.toolConfirmation!.endRun(); }
    },
    set allow(value: boolean) { allowCreate = value; },
    async dispose() { unsubscribe(); app.workTaskContext.end(); app.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

it("saves a pending work task from an ordinary primary tool round and does not start it", async () => {
  const fx = await fixture();
  try {
    assert.equal(fx.offered.length, 0);
    await fx.run("m-save", userText, [
      { name: "read_file", input: { path: "scripts/check.sh", directory: fx.project.directory } },
      { name: "work_task_create", input: proposal },
    ]);
    assert.ok(fx.offered[0]?.includes("work_task_create"));
    assert.equal(fx.offered[0]?.includes("shell_exec"), true);
    const card = fx.cards[0] ?? "";
    assert.match(card, /修复这个项目的 slug 空格处理/);
    assert.match(card, /保留已有行为/);
    assert.match(card, /src\/slug\.ts/);
    assert.match(card, /node --test slug\.test\.js/);
    assert.match(card, /改动范围可接受/);
    assert.match(card, /未开始/);
    assert.match(card, /不会启动任务/);
    const [task] = await fx.tasks();
    assert.ok(task);
    assert.equal(task.status, "pending");
    assert.equal(workTaskPhase(task), "ready");
    assert.deepEqual(task.runIds, []);
    assert.equal(task.threadId, "chat-1");
    assert.ok(task.acceptance.every(item => item.status === "not_run"));
    assert.equal(task.acceptance.find(item => item.id === "file")?.verification.kind, "artifact_exists");
    const shell = await verifyAutomaticCriterion({ workspaceRoot: fx.project.directory, executionRecords: fx.app.executionRecords }, task, task.acceptance[1]!);
    const human = await verifyAutomaticCriterion({ workspaceRoot: fx.project.directory, executionRecords: fx.app.executionRecords }, task, task.acceptance[2]!);
    assert.notEqual(shell.status, "passed");
    assert.notEqual(human.status, "passed");
    const runs = await fx.app.executionRecords.listRuns(fx.app.threadId, 10);
    const receipt = await fx.app.executionRecords.getRun(fx.app.threadId, runs[0]!.runId);
    assert.equal(receipt?.workTaskId, undefined);
    assert.deepEqual(receipt?.tools.map(tool => tool.toolName), ["read_file", "work_task_create"]);
    const arrangements = await createTaskStore(fx.file).list();
    assert.ok(arrangements.ok);
    assert.equal(arrangements.value.tasks.some(item => item.promptPreview.includes(proposal.goal)), false);
    const transcript = JSON.stringify(await fx.app.store.getMessages(fx.app.threadId));
    assert.match(transcript, /已创建，尚未执行/);
    assert.match(transcript, /"started":false/);
    const saved = await fx.bytes();
    await fx.run("m-save", userText, [{ name: "work_task_create", input: proposal }]);
    assert.equal(fx.modelCalls(), 2);
    assert.deepEqual((await fx.tasks()).map(item => item.id), [task.id]);
    assert.deepEqual(await fx.bytes(), saved);
    await fx.run("m-save", userText, [{ name: "work_task_create", input: { ...proposal, goal: "另一个目标" } }]);
    assert.match(JSON.stringify(await fx.app.store.getMessages(fx.app.threadId)), /同一创建操作的内容已变化/);
    assert.equal((await fx.tasks())[0]?.goal, proposal.goal);
    assert.deepEqual(await fx.bytes(), saved);
    fx.project.id = "project-b";
    await fx.run("m-save", userText, [{ name: "work_task_create", input: proposal }]);
    assert.match(JSON.stringify(await fx.app.store.getMessages(fx.app.threadId)), /同一创建操作的内容已变化/);
    assert.deepEqual(await fx.bytes(), saved);
    fx.project.id = "project-a";
    await fx.run("m-again", `${userText}\n${command}`, [{ name: "work_task_create", input: proposal }]);
    const again = await fx.tasks();
    assert.equal(again.length, 2);
    assert.notEqual(again[0]?.id, again[1]?.id);
    assert.equal(fx.cards.length, 1);
  } finally { await fx.dispose(); }
});

it("rejects a denied save, an ungrounded command, a foreign path, model-supplied identity, and a missing project", async () => {
  const fx = await fixture();
  try {
    fx.allow = false;
    await fx.run("m-deny", `${userText}\n${command}`, [{ name: "work_task_create", input: proposal }]);
    assert.equal((await fx.tasks()).length, 0);
    fx.allow = true;
    await fx.run("m-ungrounded", userText, [{ name: "work_task_create", input: proposal }]);
    assert.match(JSON.stringify(await fx.app.store.getMessages(fx.app.threadId)), /不会编造可执行测试/);
    assert.equal((await fx.tasks()).length, 0);
    await fx.run("m-outside", `${userText}\n${command}`, [{ name: "work_task_create", input: { ...proposal, acceptance: [
      { id: "file", description: "交付 src/slug.ts", method: "automatic" as const, required: true, verification: { kind: "artifact_exists" as const, path: "../other/secret.txt" } },
      { id: "human", description: "改动范围可接受", method: "human" as const, required: true, verification: { kind: "human" as const } },
    ] } }]);
    assert.match(JSON.stringify(await fx.app.store.getMessages(fx.app.threadId)), /Path is outside the workspace/);
    assert.equal((await fx.tasks()).length, 0);
    await fx.run("m-identity", `${userText}\n${command}`, [{ name: "work_task_create", input: { ...proposal, threadId: "other-thread", projectId: "forged" } }]);
    assert.match(JSON.stringify(await fx.app.store.getMessages(fx.app.threadId)), /TOOL_INVALID_INPUT/);
    assert.equal((await fx.tasks()).length, 0);
    fx.project.id = "";
    await fx.run("m-no-project", `${userText}\n${command}`, [{ name: "work_task_create", input: proposal }]);
    assert.match(JSON.stringify(await fx.app.store.getMessages(fx.app.threadId)), /不能默认选择目录/);
    assert.equal((await fx.tasks()).length, 0);
    const runs = await fx.app.executionRecords.listRuns(fx.app.threadId, 10);
    for (const run of runs) {
      const receipt = await fx.app.executionRecords.getRun(fx.app.threadId, run.runId);
      assert.equal(receipt?.tools.some(tool => tool.toolName === "shell_exec"), false);
      assert.equal(receipt?.workTaskId, undefined);
    }
  } finally { await fx.dispose(); }
});

it("does not retry an uncertain save and a later read sees the current task", async (t) => {
  const fx = await fixture();
  const probe = await open(join(fx.root, "config.json"), "r");
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const original = prototype.sync;
  const injected = t.mock.method(prototype, "sync", async function (this: { fd: number; stat(): Promise<{ isDirectory(): boolean }> }) {
    if ((await this.stat()).isDirectory() && (await readlink(`/proc/self/fd/${this.fd}`)).endsWith("/data")) throw new Error("directory sync fault");
    return original.call(this);
  });
  try {
    const result = await fx.run("m-unknown", `${userText}\n${command}`, [{ name: "work_task_create", input: proposal }], "failed");
    assert.equal(result.status === "failed" ? result.error?.code : undefined, "TOOL_OUTCOME_UNKNOWN");
    assert.equal(fx.modelCalls(), 1);
    injected.mock.restore();
    const tasks = await fx.tasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "pending");
    assert.deepEqual(tasks[0]?.runIds, []);
    const before = await fx.bytes();
    const again = await fx.app.workTasks!.create({ ...proposal, threadId: fx.app.threadId, operationId: "manual-retry" });
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error.code, "WORK_TASK_COMMIT_UNCERTAIN");
    assert.deepEqual(await fx.bytes(), before);
    const reread = await fx.app.workTasks!.get(tasks[0]!.id);
    assert.ok(reread.ok && reread.value.goal === proposal.goal && reread.value.runIds.length === 0);
  } finally { injected.mock.restore(); await fx.dispose(); }
});

it("does not offer work_task_create to the worker or to a run already bound to a work task", async () => {
  let workerTools: string[] = [];
  const worker = createTaskWorkerAgent({ modelAlias: "worker", store: new InMemoryAgentStore(), model: new MockLanguageModelV3({ doStream: async options => {
    workerTools = (options.tools ?? []).flatMap(tool => tool.type === "function" ? [tool.name] : []);
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
    ] }) };
  } }) });
  try {
    const handle = await worker.runtime.run({ agentId: "scheduled-responder", threadId: "worker", messages: [{ id: "w", role: "user", parts: [{ type: "text", text: "run" }] }] });
    assert.equal((await handle.result).status, "completed");
    assert.equal(workerTools.includes("work_task_create"), false);
  } finally { worker.dispose(); }

  const fx = await fixture();
  try {
    const created = await fx.app.workTasks!.create({ threadId: fx.app.threadId, goal: "已经在执行的合同", acceptance: [
      { id: "human", description: "改动范围可接受", method: "human", required: true, verification: { kind: "human" } },
    ] });
    assert.ok(created.ok);
    fx.app.workTaskContext.begin(created.value, undefined);
    const result = await fx.run("m-bound", "继续这个任务", [{ name: "work_task_create", input: proposal }], "failed");
    assert.equal(result.status === "failed" ? result.error?.code : undefined, "TOOL_NOT_FOUND");
    assert.equal(fx.offered.at(-1)?.includes("work_task_create"), false);
    const current = await fx.app.workTasks!.get(created.value.id);
    assert.ok(current.ok);
    assert.deepEqual(current.value.runIds, []);
    assert.equal(current.value.status, "pending");
  } finally { await fx.dispose(); }
});
