import assert from "node:assert/strict";
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
import type { BeforeRunFinishInput } from "@aisdk-agent/core";

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
  task.acceptance = [{ ...task.acceptance[0]!, method: "human", verification: { kind: "human" } }];
  assert.deepEqual(await check(input), { kind: "stop", reason: "needs_information" });
  assert.equal(await check({ ...input, context: {} }), undefined);
});

for (const scenario of ["correct", "deny", "exhaust", "manual", "chat"] as const) {
  it(`WorkTask finish check: ${scenario}`, { timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-finish-check-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace,
      modules: { "read-file": { enabled: true } }, run: { maxSteps: 5 } }));
    let calls = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      calls++;
      const write = scenario === "correct" && calls === 2 || scenario === "deny" && calls === 1;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(write ? [{ type: "tool-call" as const, toolCallId: "write", toolName: "write_file",
          input: JSON.stringify({ path: "plan.md", content: "verified output\n" }) }] : [
          { type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "Done" }, { type: "text-end" as const, id: "text" },
        ]),
        { type: "finish" as const, finishReason: { unified: write ? "tool-calls" as const : "stop" as const, raw: undefined },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } } },
      ] }) };
    } });
    const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "thread", "--config", join(root, "config.json")],
      cwd: root, env: {}, modelAlias: "mock", model, output: new PassThrough() });
    const controller = createAssistantController(app);
    try {
      const approvals = new Set<string>();
      const checks: string[] = [];
      controller.subscribe(event => {
        if (event.type === "approval" && !approvals.has(event.approval.approvalId)) {
          approvals.add(event.approval.approvalId);
          controller.confirm({ approvalId: event.approval.approvalId, decision: scenario === "deny" ? "deny" : "allow" });
        }
        if (event.type === "run-event" && event.event.type === "run.completion.checked") checks.push(event.event.data.decision);
      });
      const created = await controller.createWorkTask({ goal: "Write plan.md", acceptance: [
        { id: "file", description: "file", required: true, method: "automatic", verification: { kind: "artifact_exists", path: "plan.md" } },
        { id: "quality", description: "quality", required: true, method: "human", verification: { kind: "human" } },
      ] });
      assert.ok(created.ok);
      const idle = new Promise<void>(resolve => { const off = controller.subscribe(event => {
        if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); }
      }); });
      const started = scenario === "chat" ? await controller.run("Hello") : await controller.runWorkTask({
        id: created.value.id, expectedRevision: created.value.revision, completionCheck: scenario !== "manual",
      });
      assert.ok(started.ok); await idle;
      const result = controller.getSnapshot().lastPrimaryResult!;
      assert.equal(result.status, "completed");
      const task = await controller.getWorkTask(created.value.id); assert.ok(task.ok);
      assert.equal(task.value.runIds.length, scenario === "chat" ? 0 : 1);
      assert.equal(task.value.acceptance[1]!.status, "not_run");
      if (scenario === "correct") {
        assert.equal(calls, 3); assert.equal(approvals.size, 1);
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
