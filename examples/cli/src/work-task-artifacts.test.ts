import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { workTaskDeliveryDraft, workTaskFileReceipts, readWorkTaskArtifact } from "./work-task-artifacts.js";
import type { ExecutionRunRecord, ExecutionToolRecord } from "./execution-record-store.js";
import type { WorkTask } from "./work-task-store.js";

const time = "2026-10-03T00:00:00.000Z";
const content = "结论：先验证再推进。\n";
const hash = createHash("sha256").update(content).digest("hex");
const task: WorkTask = { id: "task", revision: 2, threadId: "thread", goal: "写文档", constraints: [],
  acceptance: [{ id: "artifact", description: "文档", required: true, method: "automatic", verification: { kind: "artifact_exists", path: "notes/plan.md" }, status: "not_run", note: null, evidenceRefs: [] }],
  status: "paused", runIds: ["old", "run"], delivery: null, reconciliations: [], createdAt: time, updatedAt: time };
const tool: ExecutionToolRecord = { toolCallId: "write", toolName: "write_file", status: "completed", requestedAt: time, startedAt: time, finishedAt: time,
  inputPreview: "truncated", inputTruncated: true, resultPreview: null, resultTruncated: true, errorPreview: null, shell: null,
  fileInput: { path: "notes/plan.md", sha256: hash }, fileWrite: { path: "notes/plan.md", bytes: Buffer.byteLength(content), sha256: hash } };
const run: ExecutionRunRecord = { runId: "run", threadId: "thread", workTaskId: "task", phase: "primary", status: "completed", startedAt: time, finishedAt: time,
  resultTextPreview: "文档已保存，质量待审核。", resultTextTruncated: false, errorPreview: null, tools: [tool] };

it("delivery draft uses bounded successful receipts and only the latest owned primary Run", () => {
  const draft = workTaskDeliveryDraft(task, run);
  assert.equal(draft.artifacts[0]?.sha256, hash);
  assert.equal(draft.summary, run.resultTextPreview);
  for (const foreign of [{ ...run, runId: "old" }, { ...run, workTaskId: "other" }, { ...run, phase: "consolidation" as const }, { ...run, threadId: "other" }]) {
    assert.deepEqual(workTaskFileReceipts(task, foreign), []);
    assert.equal(workTaskDeliveryDraft(task, foreign).summary, "");
  }
  for (const status of ["failed", "unknown", "not_started"] as const) {
    const { fileWrite: _receipt, ...later } = tool;
    assert.deepEqual(workTaskFileReceipts(task, { ...run, tools: [tool, { ...later, toolCallId: "later", status }] }), []);
    assert.deepEqual(workTaskFileReceipts(task, { ...run, tools: [tool, { ...later, toolCallId: "alias", status, fileInput: { path: "./notes/plan.md" } }] }), []);
  }
  const interrupted = workTaskDeliveryDraft(task, { ...run, status: "interrupted" });
  assert.equal(interrupted.artifacts.length, 1);
  assert.equal(interrupted.summary, "");
  assert.ok(interrupted.warning);
  assert.equal(workTaskDeliveryDraft(task, { ...run, resultTextTruncated: true }).summaryTruncated, true);
});

it("artifact display is bounded, scoped, symlink-safe, and explicitly separate from acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-artifact-display-"));
  try {
    await mkdir(join(root, "notes"));
    await writeFile(join(root, "notes/plan.md"), content);
    const preview = await readWorkTaskArtifact(root, task, run, "notes/plan.md");
    assert.ok(preview.ok);
    assert.equal(preview.value.content, content);
    assert.equal(preview.value.matchesReceipt, true);
    await writeFile(join(root, "notes/plan.md"), "文件已改变\n");
    const changed = await readWorkTaskArtifact(root, task, run, "notes/plan.md");
    assert.ok(changed.ok);
    assert.equal(changed.value.matchesReceipt, false);
    assert.equal(task.acceptance[0]!.status, "not_run");
    const undeclared = await readWorkTaskArtifact(root, { ...task, delivery: { summary: "声明", artifactRefs: ["secret.txt"], unresolved: [], evidence: [] } }, run, "secret.txt");
    assert.ok(!undeclared.ok);
    assert.equal(undeclared.error.code, "WORK_TASK_INVALID_INPUT");
    assert.equal((await readWorkTaskArtifact(root, task, run, "../outside.txt")).ok, false);
    const missing = await readWorkTaskArtifact(root, task, run, "notes/absent.md");
    assert.ok(!missing.ok);
    await rm(join(root, "notes/plan.md"));
    await symlink(join(root, "outside.md"), join(root, "notes/plan.md"));
    const linked = await readWorkTaskArtifact(root, task, run, "notes/plan.md");
    assert.ok(!linked.ok);
    assert.equal(linked.error.code, "SYMLINK_NOT_ALLOWED");
    await rm(join(root, "notes/plan.md"));
    await writeFile(join(root, "notes/plan.md"), "x".repeat(65537));
    const large = await readWorkTaskArtifact(root, task, run, "notes/plan.md");
    assert.ok(!large.ok);
    assert.equal(large.error.code, "FILE_TOO_LARGE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("Controller display queries are read-only, version-bound, survive restart and do not call the model", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-artifact-controller-"));
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "notes"), { recursive: true });
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { "read-file": { enabled: true } } }));
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    ++calls;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...(calls === 1 ? [{ type: "tool-call" as const, toolCallId: "write", toolName: "write_file", input: JSON.stringify({ path: "notes/plan.md", content }) }] : [
        { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "文档已保存，待审核。" }, { type: "text-end" as const, id: "text" },
      ]),
      { type: "finish" as const, finishReason: { unified: calls === 1 ? "tool-calls" as const : "stop" as const, raw: undefined }, usage },
    ] }) };
  } });
  const options = { args: ["--tui", join(root, "transcripts"), "--thread", "thread", "--config", config], cwd: root, env: {}, modelAlias: "mock", model };
  let controller: ReturnType<typeof createAssistantController> | undefined;
  try {
    controller = createAssistantController(await createRuntimeApp({ ...options, output: new PassThrough() }));
    const current = controller;
    const seen = new Set<string>();
    current.subscribe(event => {
      if (event.type === "approval" && !seen.has(event.approval.approvalId)) {
        seen.add(event.approval.approvalId);
        current.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
      }
    });
    const created = await current.createWorkTask({ goal: "写文档", acceptance: [
      { id: "file", description: "文件", required: true, method: "automatic", verification: { kind: "artifact_exists", path: "notes/plan.md" } },
      { id: "quality", description: "质量", required: true, method: "human", verification: { kind: "human" } },
    ] });
    assert.ok(created.ok);
    const idle = new Promise<void>(resolve => { const off = current.subscribe(event => { if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); } }); });
    assert.ok((await current.runWorkTask({ id: created.value.id, expectedRevision: created.value.revision })).ok);
    await idle;
    const paused = await current.getWorkTask(created.value.id);
    assert.ok(paused.ok);
    assert.equal(paused.value.status, "paused");
    const input = { id: paused.value.id, expectedRevision: paused.value.revision };
    const beforeTasks = await readFile(join(workspace, ".runloom/work-tasks.json"));
    const beforeJournal = await readFile(join(root, "transcripts/execution-records.json"));
    const draft = await current.getWorkTaskDeliveryDraft(input);
    assert.ok(draft.ok);
    assert.equal(draft.value.artifacts[0]?.path, "notes/plan.md");
    const continuation = await current.getWorkTaskContinuation(input);
    assert.ok(continuation.ok);
    assert.equal(continuation.value.latestRun?.runId, paused.value.runIds.at(-1));
    assert.equal(continuation.value.latestRun?.tools[0]?.path, "notes/plan.md");
    assert.equal((await current.getWorkTaskContinuation({ ...input, expectedRevision: 1 })).ok, false);
    const diagnostics = await current.getContextDiagnostics();
    assert.ok(diagnostics.ok);
    assert.equal(diagnostics.value.lastPreparationSource?.workTaskId, paused.value.id);
    assert.equal(diagnostics.value.lastPreparationSource?.runId, paused.value.runIds.at(-1));
    const preview = await current.getWorkTaskArtifact({ ...input, path: "notes/plan.md" });
    assert.ok(preview.ok);
    assert.equal(preview.value.matchesReceipt, true);
    const stale = await current.getWorkTaskArtifact({ ...input, expectedRevision: 1, path: "notes/plan.md" });
    assert.ok(!stale.ok);
    assert.equal(stale.error.code, "WORK_TASK_REVISION_CONFLICT");
    assert.deepEqual(await readFile(join(workspace, ".runloom/work-tasks.json")), beforeTasks);
    assert.deepEqual(await readFile(join(root, "transcripts/execution-records.json")), beforeJournal);
    assert.equal(calls, 2);
    await writeFile(join(root, "transcripts/execution-records.json"), "broken receipt file");
    const brokenDraft = await current.getWorkTaskDeliveryDraft(input);
    const brokenPreview = await current.getWorkTaskArtifact({ ...input, path: "notes/plan.md" });
    assert.ok(!brokenDraft.ok && brokenDraft.error.code === "WORK_TASK_READ_FAILED");
    assert.ok(!brokenPreview.ok && brokenPreview.error.code === "WORK_TASK_READ_FAILED");
    const brokenContinuation = await current.getWorkTaskContinuation(input);
    assert.ok(!brokenContinuation.ok && brokenContinuation.error.code === "WORK_TASK_READ_FAILED");
    await writeFile(join(root, "transcripts/execution-records.json"), beforeJournal);
    await current.shutdown();
    controller = createAssistantController(await createRuntimeApp({ ...options, output: new PassThrough() }));
    assert.ok((await controller.getWorkTaskArtifact({ ...input, path: "notes/plan.md" })).ok);
    assert.deepEqual(await controller.getWorkTaskContinuation(input), continuation);
    const restartedDiagnostics = await controller.getContextDiagnostics();
    assert.ok(restartedDiagnostics.ok);
    assert.equal(restartedDiagnostics.value.lastPreparationSource, null);
    assert.equal(calls, 2);
    await controller.shutdown();
    const foreignArgs = [...options.args]; foreignArgs[3] = "other-thread";
    controller = createAssistantController(await createRuntimeApp({ ...options, args: foreignArgs, output: new PassThrough() }));
    const foreign = await controller.getWorkTaskArtifact({ ...input, path: "notes/plan.md" });
    assert.ok(!foreign.ok); assert.equal(foreign.error.code, "WORK_TASK_NOT_FOUND");
    assert.equal((await controller.getWorkTaskContinuation(input)).ok, false);
    assert.equal(calls, 2);
    await controller.shutdown();
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: {} }));
    controller = createAssistantController(await createRuntimeApp({ ...options, output: new PassThrough() }));
    const disabled = await controller.getWorkTaskArtifact({ ...input, path: "notes/plan.md" });
    assert.ok(!disabled.ok); assert.equal(disabled.error.code, "WORK_TASK_INVALID_STATE");
  } finally { await controller?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
