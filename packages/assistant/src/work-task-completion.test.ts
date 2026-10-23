import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { ExecutionRecordStore } from "./execution-record-store.js";
import type { ExecutionRunRecord, ExecutionToolRecord } from "./execution-record-store.js";
import type { WorkTask, WorkTaskStore } from "./work-task-store.js";
import { createWorkTaskFinishCheck } from "./work-task-completion.js";
import { verifyAutomaticCriterion } from "./work-task-verification.js";
import { workTaskTestBatch } from "./work-task-shell-evidence.js";
import { createWorkTaskStore } from "./work-task-store.js";
import type { BeforeRunFinishInput } from "@serika/core";

it("corrects missing multiple tests in the same Run using one confirmed batch and persists both checks", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-finish-batch-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, authorizedDirectory: workspace, modules: { shell: { enabled: true } }, run: { maxSteps: 5 } }));
  const acceptance = ["node -e 'if(2+2!==4)process.exit(1)'", "node -e 'if(3*3!==9)process.exit(1)'"].map((command, index) => ({
    id: `test-${index}`, description: "check", required: true, method: "automatic" as const,
    verification: { kind: "shell_exit_zero" as const, command, cwd: "." },
  }));
  const batch = workTaskTestBatch({ acceptance: acceptance.map(item => ({ ...item, status: "not_run", note: null, evidenceRefs: [] })) })!;
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls++;
    const tool = calls === 2;
    if (tool) assert.match(JSON.stringify(options.prompt), /execute this exact Shell batch/);
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...(tool ? [{ type: "tool-call" as const, toolCallId: "batch", toolName: "shell_exec", input: JSON.stringify(batch) }] : [
        { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "done" }, { type: "text-end" as const, id: "text" },
      ]),
      { type: "finish" as const, finishReason: { unified: tool ? "tool-calls" as const : "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
    ] }) };
  } });
  const output = new PassThrough(); output.resume();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "thread", configPath: join(root, "config.json") }, cwd: root, env: {}, modelAlias: "mock", model, output });
  const controller = createAssistantController(app);
  try {
    const approvals = new Set<string>();
    controller.subscribe(event => {
      if (event.type === "approval" && event.approval.preview.trim() && !approvals.has(event.approval.approvalId)) {
        approvals.add(event.approval.approvalId);
        assert.equal(event.approval.toolName, "shell_exec");
        assert.deepEqual(event.approval.input, batch);
        controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
      }
    });
    const created = await controller.workTasks.create({ goal: "check both conditions", acceptance }); assert.ok(created.ok);
    const idle = new Promise<void>(resolve => { const off = controller.subscribe(event => {
      if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); }
    }); });
    assert.ok((await controller.workTasks.run({ id: created.value.id, expectedRevision: 1 })).ok);
    await idle;
    const result = await controller.workTasks.get(created.value.id); assert.ok(result.ok);
    assert.equal(calls, 3); assert.equal(approvals.size, 1); assert.equal(result.value.runIds.length, 1);
    assert.equal(result.value.status, "completed");
    assert.deepEqual(result.value.acceptance.map(item => item.status), ["passed", "passed"]);
    assert.deepEqual(controller.getSnapshot().lastPrimaryResult?.completion, { reason: "delivered", corrections: 1 });
    assert.equal(result.value.delivery?.evidence.filter(item => item.kind === "tool").length, 2);
  } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
});

it("explicit readback criteria reject missing, pre-write, stale and denied reads without weakening legacy tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-readback-"));
  try {
    const content = "current artifact\n";
    await writeFile(join(root, "plan.md"), content);
    const digest = createHash("sha256").update(content).digest("hex");
    const time = "2026-10-04T00:00:00.000Z";
    const task: WorkTask = { id: "task", revision: 1, threadId: "thread", goal: "test", constraints: [], status: "paused", runIds: ["run"], delivery: null, reconciliations: [], createdAt: time, updatedAt: time, acceptance: [] };
    const write: ExecutionToolRecord = { toolCallId: "write", toolName: "write_file", status: "completed", requestedAt: time, startedAt: time, finishedAt: time,
      inputPreview: "{}", inputTruncated: true, resultPreview: null, resultTruncated: true, errorPreview: null, shell: null,
      fileInput: { path: "plan.md", sha256: digest }, fileWrite: { path: "plan.md", bytes: Buffer.byteLength(content), sha256: digest } };
    const { fileWrite: _written, ...baseRead } = write;
    const read: ExecutionToolRecord = { ...baseRead, toolCallId: "read", toolName: "read_file", fileInput: { path: "plan.md" },
      fileRead: { path: "plan.md", bytes: Buffer.byteLength(content), sha256: digest } };
    const run: ExecutionRunRecord = { runId: "run", threadId: "thread", workTaskId: "task", phase: "primary", status: "completed", startedAt: time, finishedAt: time,
      resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [write] };
    const env = { workspaceRoot: root, executionRecords: { getRun: async () => run } as unknown as ExecutionRecordStore };
    const criterion: WorkTask["acceptance"][number] = { id: "file", description: "read back", required: true, method: "automatic", status: "not_run", note: null, evidenceRefs: [], verification: { kind: "artifact_exists", path: "plan.md", requireReadback: true } };
    assert.equal((await verifyAutomaticCriterion(env, task, criterion)).status, "failed");
    assert.equal((await verifyAutomaticCriterion(env, task, { ...criterion, verification: { kind: "artifact_exists", path: "plan.md" } })).status, "passed");
    const { fileRead: _read, ...legacyRead } = read;
    for (const tools of [[read, write], [write, legacyRead], [write, { ...read, status: "failed" as const }],
      [write, { ...read, fileRead: { ...read.fileRead!, sha256: "0".repeat(64) } }], [write, read, { ...write, toolCallId: "edit", toolName: "edit_file" }]]) {
      run.tools = tools;
      assert.equal((await verifyAutomaticCriterion(env, task, criterion)).status, "failed");
    }
    run.tools = [write, read];
    const verified = await verifyAutomaticCriterion(env, task, criterion);
    assert.equal(verified.status, "passed");
    const store = createWorkTaskStore(root, { filePath: join(root, ".runloom/work-tasks.json"), generateId: () => "task", executionRecords: env.executionRecords  });
    const created = await store.create({ threadId: "thread", goal: "read back", acceptance: [{ id: "file", description: "file", method: "automatic", required: true, verification: criterion.verification }] });
    assert.ok(created.ok);
    assert.ok((await store.beginRun("task", { expectedRevision: 1, runId: "run" })).ok);
    assert.ok((await store.pause("task", 2)).ok);
    assert.ok((await store.submitDelivery("task", { expectedRevision: 3, delivery: { summary: "done", artifactRefs: ["plan.md"], unresolved: [], evidence: [] } })).ok);
    run.tools = [write];
    const blocked = await store.recordAcceptance("task", { expectedRevision: 4, criterionId: "file", actor: "automatic", status: "passed", evidence: verified.evidence });
    assert.equal(blocked.ok, false, "direct store acceptance cannot bypass readback");
    run.tools = [write, read];
    const accepted = await store.recordAcceptance("task", { expectedRevision: 4, criterionId: "file", actor: "automatic", status: "passed", evidence: verified.evidence });
    assert.ok(accepted.ok); assert.equal(accepted.value.status, "completed");
    const reopened = await createWorkTaskStore(root, { filePath: join(root, ".runloom/work-tasks.json") }).get("task");
    assert.ok(reopened.ok); assert.deepEqual(reopened.value.acceptance[0]!.verification, criterion.verification);
    await writeFile(join(root, "plan.md"), "externally changed");
    assert.equal((await verifyAutomaticCriterion(env, task, criterion)).status, "failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("completion checks reject unknown/foreign receipts, human-only contracts and unavailable tools", async () => {
  const time = "2026-10-04T00:00:00.000Z";
  const task: WorkTask = { id: "task", revision: 2, threadId: "thread", goal: "test", constraints: [],
    status: "running", runIds: ["run"], delivery: null, reconciliations: [], createdAt: time, updatedAt: time,
    acceptance: [{ id: "test", description: "test", required: true, method: "automatic", status: "not_run", note: null, evidenceRefs: [], verification: { kind: "shell_exit_zero", command: "node --test", cwd: "." } }] };
  const run: ExecutionRunRecord = { runId: "run", threadId: "thread", workTaskId: "task", phase: "primary", status: "running",
    startedAt: time, finishedAt: null, resultTextPreview: null, resultTextTruncated: false, errorPreview: null, tools: [] };
  const tool: ExecutionToolRecord = { toolCallId: "test", toolName: "shell_exec", status: "completed", requestedAt: time, startedAt: time, finishedAt: time,
    inputPreview: JSON.stringify({ command: "node --test", cwd: "." }), inputTruncated: false, resultPreview: null, resultTruncated: false, errorPreview: null,
    shell: { exitCode: 0, timedOut: false, cancelled: false } };
  const records = { getRun: async () => run } as unknown as ExecutionRecordStore;
  const store = { get: async () => ({ ok: true, value: task }) } as unknown as WorkTaskStore;
  const check = createWorkTaskFinishCheck({ executionRecords: records, workTasks: store, workspaceRoot: undefined });
  const input: BeforeRunFinishInput = { runId: "run", threadId: "thread", context: { workTaskId: "task" },
    definition: { id: "test", version: "1", model: "test", instructions: "test", tools: ["shell_exec"], limits: { maxSteps: 4, totalTimeoutMs: 1000, stepTimeoutMs: 1000 } },
    messages: [], text: "done", steps: 1, remainingSteps: 3, corrections: 0, signal: new AbortController().signal };
  assert.equal((await check(input))?.kind, "continue");
  run.tools = [{ ...tool, status: "unknown" }];
  assert.deepEqual(await check(input), { kind: "stop", reason: "needs_review" });
  run.tools = []; run.workTaskId = "foreign";
  assert.deepEqual(await check(input), { kind: "stop", reason: "needs_review" });
  run.workTaskId = "task";
  assert.deepEqual(await check({ ...input, definition: { ...input.definition, tools: [] } }), { kind: "stop", reason: "needs_information" });
  assert.deepEqual(await check({ ...input, corrections: 2 }), { kind: "stop", reason: "budget_exhausted" });
  run.tools = [tool];
  assert.deepEqual(await check(input), { kind: "stop", reason: "delivered" });
  run.tools.push({ ...tool, toolCallId: "edit", toolName: "edit_file" });
  assert.equal((await verifyAutomaticCriterion({ executionRecords: records, workspaceRoot: undefined }, task, task.acceptance[0]!, { runId: "run", signal: input.signal })).status, "failed");
  run.tools.push({ ...tool, toolCallId: "retest" });
  assert.equal((await verifyAutomaticCriterion({ executionRecords: records, workspaceRoot: undefined }, task, task.acceptance[0]!, { runId: "run", signal: input.signal })).status, "passed");
  const root = await mkdtemp(join(tmpdir(), "runloom-test-order-"));
  try {
    const store = createWorkTaskStore(root, { filePath: join(root, ".runloom/work-tasks.json"), generateId: () => "task", executionRecords: records  });
    assert.ok((await store.create({ threadId: "thread", goal: "test", acceptance: [{ id: "test", description: "test", required: true, method: "automatic", verification: { kind: "shell_exit_zero", command: "node --test", cwd: "." } }] })).ok);
    assert.ok((await store.beginRun("task", { expectedRevision: 1, runId: "run" })).ok);
    assert.ok((await store.pause("task", 2)).ok);
    assert.ok((await store.submitDelivery("task", { expectedRevision: 3, delivery: { summary: "done", artifactRefs: [], evidence: [], unresolved: [] } })).ok);
    run.status = "completed"; run.tools = [tool, { ...tool, toolCallId: "later-edit", toolName: "edit_file" }];
    const evidence = [{ id: "test-evidence", kind: "tool" as const, runId: "run", toolCallId: "test", toolName: "shell_exec" as const, command: "node --test", cwd: ".", verifiedAt: time, outcome: "succeeded" as const }];
    assert.equal((await store.recordAcceptance("task", { expectedRevision: 4, criterionId: "test", actor: "automatic", status: "passed", evidence })).ok, false);
    run.tools = [tool];
    assert.ok((await store.recordAcceptance("task", { expectedRevision: 4, criterionId: "test", actor: "automatic", status: "passed", evidence })).ok);
  } finally { run.status = "running"; await rm(root, { recursive: true, force: true }); }
  task.acceptance = [{ ...task.acceptance[0]!, method: "human", verification: { kind: "human" } }];
  assert.deepEqual(await check(input), { kind: "stop", reason: "needs_information" });
  assert.equal(await check({ ...input, context: {} }), undefined);
});

for (const scenario of ["correct", "readback", "deny", "exhaust", "manual", "chat"] as const) {
  it(`WorkTask finish check: ${scenario}`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-finish-check-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, authorizedDirectory: workspace,
      modules: { "read-file": { enabled: true } }, run: { maxSteps: 5 } }));
    let calls = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      calls++;
      const write = scenario === "correct" && calls === 2 || (scenario === "deny" || scenario === "readback") && calls === 1;
      const read = scenario === "readback" && calls === 3;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(write || read ? [{ type: "tool-call" as const, toolCallId: read ? "readback" : "write", toolName: read ? "read_file" : "write_file",
          input: JSON.stringify(read ? { path: "plan.md" } : { path: "plan.md", content: "verified output\n" }) }] : [
          { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "Done" }, { type: "text-end" as const, id: "text" },
        ]),
        { type: "finish" as const, finishReason: { unified: write || read ? "tool-calls" as const : "stop" as const, raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
      ] }) };
    } });
    const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "thread", configPath: join(root, "config.json") },
      cwd: root, env: {}, modelAlias: "mock", model, output: new PassThrough() });
    const controller = createAssistantController(app);
    try {
      const approvals = new Set<string>();
      const checks: string[] = [];
      controller.subscribe(event => {
        if (event.type === "approval" && event.approval.preview.trim() && !approvals.has(event.approval.approvalId)) {
          approvals.add(event.approval.approvalId);
          controller.confirm({ approvalId: event.approval.approvalId, decision: scenario === "deny" ? "deny" : "allow" });
        }
        if (event.type === "run-event" && event.event.type === "run.completion.checked") checks.push(event.event.data.decision);
      });
      const created = await controller.workTasks.create({ goal: "Write plan.md", acceptance: [
        { id: "file", description: "file", required: true, method: "automatic", verification: { kind: "artifact_exists", path: "plan.md", ...(scenario === "readback" ? { requireReadback: true } : {}) } },
        { id: "quality", description: "quality", required: true, method: "human", verification: { kind: "human" } },
      ] });
      assert.ok(created.ok);
      const idle = new Promise<void>(resolve => { const off = controller.subscribe(event => {
        if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); }
      }); });
      const started = scenario === "chat" ? await controller.run("Hello") : await controller.workTasks.run({
        id: created.value.id, expectedRevision: created.value.revision, completionCheck: scenario !== "manual",
      });
      assert.ok(started.ok); await idle;
      const result = controller.getSnapshot().lastPrimaryResult!;
      assert.equal(result.status, "completed");
      const task = await controller.workTasks.get(created.value.id); assert.ok(task.ok);
      assert.equal(task.value.runIds.length, scenario === "chat" ? 0 : 1);
      assert.equal(task.value.acceptance[1]!.status, "not_run");
      if (scenario === "correct" || scenario === "readback") {
        assert.equal(calls, scenario === "readback" ? 4 : 3); assert.equal(approvals.size, scenario === "readback" ? 2 : 1);
        assert.deepEqual(checks, ["continue", "stop"]);
        assert.deepEqual(result.completion, { reason: "delivered", corrections: 1 });
        assert.equal(task.value.status, "awaiting_acceptance");
        assert.equal(task.value.acceptance[0]!.status, "passed");
        assert.equal(await readFile(join(workspace, "plan.md"), "utf8"), "verified output\n");
      } else if (scenario === "deny") {
        assert.equal(calls, 2); assert.equal(approvals.size, 1);
        assert.deepEqual(result.completion, { reason: "needs_confirmation", corrections: 0 });
        assert.deepEqual(checks, ["stop"]);
        assert.equal(task.value.status, "paused");
        await assert.rejects(readFile(join(workspace, "plan.md")), { code: "ENOENT" });
      } else if (scenario === "exhaust") {
        assert.equal(calls, 3); assert.equal(approvals.size, 0);
        assert.deepEqual(result.completion, { reason: "budget_exhausted", corrections: 2 });
        assert.equal(task.value.status, "paused");
      } else {
        assert.equal(calls, 1); assert.deepEqual(checks, []); assert.equal(result.completion, undefined);
      }
      const reopened = new ExecutionRecordStore(join(root, "transcripts"));
      assert.deepEqual((await reopened.getRun("thread", result.runId))?.completion, result.completion);
      if (scenario === "correct") {
        const file = join(root, "transcripts/execution-records.json");
        const original = await readFile(file, "utf8");
        const malformed = JSON.parse(original);
        malformed.runs[0].completion.reason = "model_says_passed";
        await writeFile(file, JSON.stringify(malformed));
        await assert.rejects(reopened.getRun("thread", result.runId), { code: "FILE_INVALID" });
        await writeFile(file, original);
      }
    } finally { await controller.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
}
