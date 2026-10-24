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
import type { WorkTask, WorkTaskResult } from "./work-task-store.js";

function value<T>(result: WorkTaskResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

it("explicit rework uses a fresh approved Run and never accepts a prior write as the new delivery", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-research-rework-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }],
    modules: { "read-file": { enabled: true } },
  }));
  const before = "A and B both omit the API.\nB documents the API.\n";
  const longBefore = before + "原始参考材料。".repeat(200);
  const corrected = "A omits the API; B documents it. This is a version difference, not a runtime test.\n" + "保留参考材料。".repeat(200);
  await writeFile(join(workspace, "unrelated.txt"), "User content stays unchanged.\n");
  const script = [
    { name: "write_file", input: { path: "comparison.md", content: longBefore } },
    { text: "Draft saved; factual quality still awaits review." },
    // A text-only claim must not reuse the first Run's write evidence.
    { name: "read_file", input: { path: "comparison.md" } },
    { text: "The report is ready." },
    { name: "read_file", input: { path: "comparison.md" } },
    { name: "edit_file", input: { path: "comparison.md", oldText: longBefore, newText: corrected } },
    { name: "read_file", input: { path: "comparison.md" } },
    { text: "Saved and read back the corrected report; user review remains pending." },
  ];
  let modelCalls = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = new MockLanguageModelV3({ doStream: async () => {
    const step = script[modelCalls++];
    assert.ok(step, "Unexpected model call, including possible automatic rework");
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...(step.name ? [{ type: "tool-call" as const, toolCallId: `call-${modelCalls}`,
        toolName: step.name, input: JSON.stringify(step.input) }] : [
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: step.text! },
        { type: "text-end" as const, id: "answer" },
      ]),
      { type: "finish" as const, finishReason: {
        unified: step.name ? "tool-calls" as const : "stop" as const, raw: undefined,
      }, usage },
    ] }) };
  } });
  const appOptions = { directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "rework", configPath },
    modelAlias: "mock", model, env: {}, cwd: root };
  let controller: ReturnType<typeof createAssistantController> | undefined;
  try {
    const output = new PassThrough();
    const app = await createRuntimeApp({ ...appOptions, output });
    controller = createAssistantController(app);
    const currentController = controller;
    output.on("data", (chunk: Buffer) => currentController.recordOutput(chunk.toString()));
    const approvals: string[] = [];
    const confirmations: boolean[] = [];
    const seen = new Set<string>();
    currentController.subscribe((event) => {
      if (event.type !== "approval" || !event.approval.preview.trim() || seen.has(event.approval.approvalId)) return;
      seen.add(event.approval.approvalId);
      const pending = event.approval;
      approvals.push(pending.approvalId);
      const input = pending.input as { path?: string };
      confirmations.push(currentController.confirm({ approvalId: pending.approvalId,
        decision: input.path === "comparison.md" ? "allow" : "deny" }));
    });
    let task = value(await currentController.workTasks.create({
      goal: "Write a source comparison and fix factual issues only when asked.",
      constraints: ["Only comparison.md may be created or edited. Read back after editing."],
      acceptance: [
        { id: "artifact", description: "Report saved", method: "automatic", required: true,
          verification: { kind: "artifact_exists", path: "comparison.md" } },
        { id: "quality", description: "User accepts facts", method: "human", required: true,
          verification: { kind: "human" } },
      ],
    }));
    async function run(instruction: string): Promise<WorkTask> {
      const idle = new Promise<void>((resolve) => {
        const unsubscribe = currentController.subscribe((event) => {
          if (event.type === "state" && event.state.kind === "idle") { unsubscribe(); resolve(); }
        });
      });
      assert.ok((await currentController.workTasks.run({ id: task.id, expectedRevision: task.revision, instruction, completionCheck: false })).ok);
      await idle;
      assert.equal(currentController.getSnapshot().lastPrimaryResult?.status, "completed");
      return value(await currentController.workTasks.get(task.id));
    }
    async function deliver(): Promise<WorkTask> {
      return value(await currentController.workTasks.submitDelivery({ id: task.id,
        expectedRevision: task.revision, summary: "Report saved, human review required.",
        artifactRefs: ["comparison.md"], unresolved: ["Facts await user review"],
      }));
    }
    task = await run("Prepare the initial draft.");
    const firstRunId = task.runIds[0]!;
    task = await deliver();
    assert.equal(task.status, "awaiting_acceptance");
    assert.equal(task.acceptance[0]?.status, "passed");
    const firstDelivery = task.delivery;
    task = value(await currentController.workTasks.recordHumanAcceptance({ id: task.id, expectedRevision: task.revision,
      criterionId: "quality", decision: "failed", note: "The report contradicts itself." }));
    const stale = await currentController.workTasks.requestChanges({ id: task.id, expectedRevision: task.revision - 1 });
    assert.equal(stale.ok, false);
    task = value(await currentController.workTasks.requestChanges({ id: task.id, expectedRevision: task.revision }));
    assert.equal(task.status, "paused");
    assert.equal(modelCalls, 2);
    assert.deepEqual(task.delivery, firstDelivery);
    assert.ok(task.acceptance.every((criterion) => criterion.status === "not_run" &&
      criterion.evidenceRefs.length === 0 && criterion.note === null));
    assert.equal(await readFile(join(workspace, "comparison.md"), "utf8"), longBefore);
    const premature = await currentController.workTasks.recordHumanAcceptance({ id: task.id, expectedRevision: task.revision,
      criterionId: "quality", decision: "passed" });
    assert.equal(premature.ok, false);
    assert.equal(modelCalls, 2);

    task = await run("Read the draft, but do not change it in this negative control.");
    task = await deliver();
    assert.equal(task.acceptance[0]?.status, "failed");
    assert.deepEqual(task.delivery?.evidence, []);
    assert.equal(task.status, "awaiting_acceptance");
    task = value(await currentController.workTasks.requestChanges({ id: task.id, expectedRevision: task.revision }));
    assert.equal(modelCalls, 4);

    task = await run("Correct the contradictory claim, then read back the actual saved report. Do not accept on my behalf.");
    const latestRunId = task.runIds.at(-1)!;
    task = await deliver();
    assert.equal(task.acceptance[0]?.status, "passed");
    assert.equal(task.acceptance[1]?.status, "not_run");
    assert.equal(task.status, "awaiting_acceptance");
    assert.ok(task.delivery?.evidence.every((item) => item.kind === "artifact" && item.runId === latestRunId));
    const receipt = await currentController.runs.get(latestRunId);
    assert.equal(receipt?.workTaskId, task.id);
    assert.deepEqual(receipt?.tools.map((tool) => [tool.toolName, tool.status]), [
      ["read_file", "completed"], ["edit_file", "completed"], ["read_file", "completed"],
    ]);
    assert.equal(receipt?.tools[1]?.inputTruncated, true);
    assert.equal(receipt?.tools[1]?.fileWrite?.sha256, createHash("sha256").update(corrected).digest("hex"));
    // A current file, even with a freshly forged candidate hash, is not the written artifact.
    const tampered = corrected.replace("A omits", "C omits");
    await writeFile(join(workspace, "comparison.md"), tampered);
    const rejected = await app.workTasks!.recordAcceptance(task.id, {
      expectedRevision: task.revision, criterionId: "artifact", actor: "automatic", status: "passed",
      evidence: [{ id: "forged-current-hash", kind: "artifact", runId: latestRunId,
        toolCallId: receipt!.tools[1]!.toolCallId, path: "comparison.md",
        sha256: createHash("sha256").update(tampered).digest("hex"), verifiedAt: new Date().toISOString() }],
    });
    assert.equal(rejected.ok, false);
    assert.equal(!rejected.ok && rejected.error.code, "WORK_TASK_INVALID_INPUT");
    task = await deliver();
    assert.equal(task.acceptance[0]?.status, "failed");
    assert.match(task.acceptance[0]?.note ?? "", /content no longer matches/);
    await writeFile(join(workspace, "comparison.md"), corrected);
    task = await deliver();
    assert.equal(task.acceptance[0]?.status, "passed");
    assert.equal(approvals.length, 5);
    assert.equal(new Set(approvals).size, 5);
    assert.deepEqual(confirmations, [true, true, true, true, true]);
    assert.equal(modelCalls, 8);
    assert.equal(await readFile(join(workspace, "comparison.md"), "utf8"), corrected);
    assert.equal(await readFile(join(workspace, "unrelated.txt"), "utf8"), "User content stays unchanged.\n");
    await currentController.shutdown();
    controller = createAssistantController(await createRuntimeApp({ ...appOptions, output: new PassThrough() }));
    assert.deepEqual(value(await controller.workTasks.get(task.id)), task);
    assert.equal((await controller.runs.get(firstRunId))?.status, "completed");
    assert.equal((await controller.runs.get(latestRunId))?.status, "completed");
    assert.equal(modelCalls, 8, "Reopening must not run the model or accept quality");
  } finally { await controller?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
