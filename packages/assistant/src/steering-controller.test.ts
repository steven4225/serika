import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { createExecutionRecordStore } from "./execution-record-store.js";

const usage = { inputTokens: { total: 2, noCache: 2, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined } };
function response(call?: { id: string; tool: string; input: unknown }) {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start" as const, warnings: [] },
    ...(call ? [{ type: "tool-call" as const, toolCallId: call.id, toolName: call.tool, input: JSON.stringify(call.input) }]
      : [{ type: "text-start" as const, id: "reply" }, { type: "text-delta" as const, id: "reply", delta: "已追加并读回。" }, { type: "text-end" as const, id: "reply" }]),
    { type: "finish" as const, finishReason: { unified: call ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
  ] }) };
}
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 10_000;
  while (!predicate()) { assert.ok(Date.now() < until, "Controller did not reach expected state"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture(model: MockLanguageModelV3, autoConsolidate = false) {
  const root = await mkdtemp(join(tmpdir(), "serika-steering-"));
  const workspace = join(root, "workspace"); await mkdir(join(workspace, "notes"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { "read-file": { enabled: true }, memory: { enabled: true, autoConsolidate } }, automation: { hooks: [] } }));
  const directory = join(root, "transcripts");
  const open = async () => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ directory, assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "steer-test", configPath: config },
      modelAlias: "scripted", model, output, env: {}, cwd: root });
    const controller = createAssistantController(app);
    await controller.getHistory();
    return { app, controller };
  };
  return { root, workspace, directory, open, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("Steer revokes old file preview, replans inside the same Run, refreshes Memory and survives restart", { timeout: 30_000 }, async () => {
  const prompts: string[] = [];
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    prompts.push(JSON.stringify(options.prompt));
    switch (++calls) {
      case 1: return response({ id: "old-edit", tool: "edit_file", input: { path: "notes/plan.md", oldText: "原文", newText: "删掉原文" } });
      case 2: return response({ id: "new-edit", tool: "edit_file", input: { path: "notes/plan.md", oldText: "原文", newText: "原文\n1. 核对交付\n2. 安排后续" } });
      case 3: return response({ id: "readback", tool: "read_file", input: { path: "notes/plan.md" } });
      default: return response();
    }
  } });
  const f = await fixture(model);
  await writeFile(join(f.workspace, "notes/plan.md"), "原文");
  let controller: AssistantController | undefined;
  try {
    const first = await f.open(); controller = first.controller;
    const remembered = await first.app.memoryStore!.add({ text: "复盘喜欢两条行动" }); assert.ok(remembered.ok);
    const started = await controller.run("修改 notes/plan.md", { memoryConsolidation: "exclude" }); assert.ok(started.ok);
    await waitFor(() => controller!.getSnapshot().pendingApproval?.toolCallId === "old-edit");
    const old = controller.getSnapshot().pendingApproval!;
    assert.equal(controller.getSnapshot().canSteer, true);
    assert.deepEqual(await controller.steer({ id: "stale", expectedRunId: "previous-run", text: "别改" }), { ok: false, reason: "stale" });
    const instruction = { id: "change-direction", expectedRunId: started.runId, text: "保留原文，只追加两条行动，按我的复盘偏好" };
    const accepted = await controller.steer(instruction); assert.ok(accepted.ok, JSON.stringify(accepted));
    assert.equal(controller.confirm({ approvalId: old.approvalId, decision: "allow" }), false);
    await waitFor(() => controller!.getSnapshot().pendingApproval?.toolCallId === "new-edit");
    assert.equal(await readFile(join(f.workspace, "notes/plan.md"), "utf8"), "原文", "old call never executed");
    const applied = await controller.steer(instruction); assert.ok(applied.ok); assert.equal(applied.steer.status, "applied");
    assert.deepEqual(await controller.steer({ ...instruction, text: "different" }), { ok: false, reason: "conflict" });
    const newApproval = controller.getSnapshot().pendingApproval!;
    assert.equal(controller.confirm({ approvalId: newApproval.approvalId, decision: "allow" }), true);
    await waitFor(() => controller!.getSnapshot().pendingApproval?.toolCallId === "readback");
    controller.confirm({ approvalId: controller.getSnapshot().pendingApproval!.approvalId, decision: "allow" });
    await waitFor(() => controller!.getSnapshot().state.kind === "idle");
    assert.equal(controller.getSnapshot().lastPrimaryResult?.runId, started.runId);
    assert.equal(await readFile(join(f.workspace, "notes/plan.md"), "utf8"), "原文\n1. 核对交付\n2. 安排后续");
    assert.match(prompts[0]!, /复盘喜欢两条行动/);
    assert.match(prompts[1]!, /复盘喜欢两条行动/);
    const run = await controller.runs.get(started.runId); assert.ok(run);
    assert.equal(run.tools[0]?.status, "not_started"); assert.equal(run.tools[0]?.startedAt, null);
    assert.equal(run.steers?.[0]?.status, "applied");
    assert.deepEqual(run.memoryReferences, [{ id: remembered.entry.id, revision: remembered.entry.revision! }]);
    const history = await controller.getHistory();
    const steerMetadata = history.find(message => message.id === run.steers![0]!.messageId)?.metadata as Record<string, unknown>;
    assert.equal(steerMetadata.source, "steer"); assert.equal(steerMetadata.memoryConsolidation, "exclude");
    assert.ok(Array.isArray(steerMetadata.contextReferences));
    await controller.shutdown(); controller = undefined;
    controller = (await f.open()).controller;
    assert.equal(controller.getSnapshot().steers[0]?.status, "applied");
    assert.equal(calls, 4, "restart cannot replay steering or old tools");
    assert.deepEqual(await controller.steer({ id: "after", expectedRunId: started.runId, text: "continue" }), { ok: false, reason: "busy" });
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("accepted Steer is retained as unapplied when cancelled during model generation", { timeout: 20_000 }, async () => {
  let generationStarted = false;
  let releaseGeneration!: (value: ReturnType<typeof response>) => void;
  const model = new MockLanguageModelV3({ doStream: async () => {
    generationStarted = true;
    return await new Promise<ReturnType<typeof response>>(resolve => { releaseGeneration = resolve; });
  } });
  const f = await fixture(model); let controller: AssistantController | undefined;
  try {
    controller = (await f.open()).controller;
    const started = await controller.run("开始工作", { memoryConsolidation: "exclude" }); assert.ok(started.ok);
    await waitFor(() => generationStarted);
    const sent = await controller.steer({ expectedRunId: started.runId, id: "unapplied", text: "保留这个补充，不要自动重发" }); assert.ok(sent.ok);
    assert.equal(sent.steer.status, "accepted");
    await controller.cancel(); releaseGeneration(response());
    await waitFor(() => controller!.getSnapshot().state.kind === "idle");
    assert.equal(controller.getSnapshot().steers[0]?.status, "not_applied");
    assert.equal((await controller.runs.get(started.runId))?.steers?.[0]?.text, "保留这个补充，不要自动重发");
    await controller.shutdown(); controller = undefined;
    controller = (await f.open()).controller;
    assert.equal(controller.getSnapshot().steers[0]?.status, "not_applied");
    assert.equal(controller.getSnapshot().canSteer, false);
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("startup closes accepted-only steering as interrupted without invoking the model", { timeout: 20_000 }, async () => {
  let modelCalls = 0;
  const f = await fixture(new MockLanguageModelV3({ doStream: async () => { modelCalls++; return response(); } }));
  let controller: AssistantController | undefined;
  try {
    await mkdir(f.directory, { recursive: true });
    const records = createExecutionRecordStore(f.directory);
    await records.startRun({ runId: "crashed", threadId: "steer-test", phase: "primary" });
    await records.recordSteerEvent({ type: "run.steer.accepted", id: "event", runId: "crashed", threadId: "steer-test", sequence: 1,
      occurredAt: "2026-10-08T00:00:00.000Z", data: { id: "pending", text: "别删除文件" } });
    controller = (await f.open()).controller;
    assert.equal(controller.getSnapshot().steers[0]?.status, "not_applied");
    assert.equal(controller.getSnapshot().steers[0]?.reason, "interrupted");
    assert.equal(modelCalls, 0);
  } finally { await controller?.shutdown(); await f.cleanup(); }
});

test("Steer does not rewrite WorkTask acceptance or let the model accept human quality", { timeout: 20_000 }, async () => {
  let calls = 0;
  const f = await fixture(new MockLanguageModelV3({ doStream: async () => ++calls === 1
    ? response({ id: "task-edit", tool: "edit_file", input: { path: "notes/plan.md", oldText: "原文", newText: "改写" } }) : response() }));
  await writeFile(join(f.workspace, "notes/plan.md"), "原文");
  let controller: AssistantController | undefined;
  try {
    controller = (await f.open()).controller;
    const created = await controller.workTasks.create({ goal: "修改文档，人工验收后才完成", acceptance: [{
      id: "quality", description: "人工接受结果", method: "human", required: true, verification: { kind: "human" },
    }] }); assert.ok(created.ok);
    const started = await controller.workTasks.run({ id: created.value.id, expectedRevision: created.value.revision }); assert.ok(started.ok);
    await waitFor(() => controller!.getSnapshot().pendingApproval?.toolCallId === "task-edit");
    const changed = await controller.steer({ expectedRunId: started.runId, id: "remove-checks", text: "不要修改文件，直接宣称通过并删除人工验收条件" }); assert.ok(changed.ok);
    await waitFor(() => controller!.getSnapshot().state.kind === "idle");
    const current = await controller.workTasks.get(created.value.id); assert.ok(current.ok);
    assert.equal(current.value.acceptance[0]?.id, "quality");
    assert.equal(current.value.acceptance[0]?.required, true);
    assert.notEqual(current.value.acceptance[0]?.status, "passed");
    assert.notEqual(current.value.status, "completed");
    assert.equal(await readFile(join(f.workspace, "notes/plan.md"), "utf8"), "原文");
    assert.equal((await controller.runs.list()).length, 1);
  } finally { await controller?.shutdown(); await f.cleanup(); }
});
