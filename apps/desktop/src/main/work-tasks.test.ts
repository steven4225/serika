import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "@serika/example-cli";
import { createAssistantController } from "@serika/example-cli";
import { createExecutionRecordStore } from "@serika/example-cli/testing";
import { createWorkTaskStore } from "@serika/example-cli/testing";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import type { MainToRenderer } from "../shared/ui-contract.js";
import { sanitizeWorkTaskInput, type WorkTaskInputs } from "../shared/work-tasks.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
const createInput: WorkTaskInputs["createWorkTask"] = { goal: "写报告并验收", acceptance: [
  { id: "file", description: "报告存在且有写入回执", method: "automatic", verification: { kind: "artifact_exists", path: "report.md" }, required: true },
  { id: "human", description: "我已核对报告内容", method: "human", verification: { kind: "human" }, required: true },
] };

function testModel(write: boolean) {
  let calls = 0;
  const model = new MockLanguageModelV3({ doStream: async () => {
    calls += 1;
    if (write && calls === 1) return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: "write-report", toolName: "write_file", input: JSON.stringify({ path: "report.md", content: "报告正文\n" }) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
    ] }) };
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "answer" },
      { type: "text-delta" as const, id: "answer", delta: "本轮结束，请另行验收。" }, { type: "text-end" as const, id: "answer" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
    ] }) };
  } });
  return { model, calls: () => calls };
}

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "runloom-desktop-worktask-"));
  await mkdir(join(root, "workspace"));
  await mkdir(join(root, "transcripts"));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace: "./workspace", modules: { "read-file": { enabled: true } } }));
  return root;
}
async function open(root: string, thread = "work-thread", writes = false, model?: LanguageModel) {
  const messages: MainToRenderer[] = [];
  const send = (message: MainToRenderer) => { messages.push(message); };
  const output = new TeeOutput(send);
  const fixture = testModel(writes);
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", join(root, "config.json")], modelAlias: "mock", model: model ?? fixture.model, output, env: {}, cwd: root });
  const controller = createAssistantController(app);
  output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, send);
  return { app, bridge, controller, messages, calls: fixture.calls };
}
async function waitFor(condition: () => boolean) {
  // These scenarios exercise several real flock/fsync barriers per Run. This
  // is a correctness wait, not the separate production timeout contract.
  const deadline = Date.now() + 30_000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.equal(condition(), true, "expected state within deadline");
}

describe("work task desktop boundary", () => {
  it("creation identity reaches the real Store through the desktop sanitizer and survives a reopened bridge", async () => {
    const root = await prepare();
    let desktop = await open(root);
    try {
      const input = { ...createInput, operationId: "desktop-create-replay" };
      const first = await desktop.bridge.createWorkTask(input); assert.ok(first.ok);
      assert.equal(first.value.creation?.operationId, input.operationId);
      assert.equal(desktop.calls(), 0, "creating a task must not start execution");
      await desktop.bridge.shutdown();
      desktop = await open(root);
      const replay = await desktop.bridge.createWorkTask(input); assert.ok(replay.ok);
      assert.equal(replay.value.id, first.value.id);
      const list = await desktop.bridge.listWorkTasks(); assert.ok(list.ok); assert.equal(list.value.length, 1);
      assert.equal((await desktop.bridge.createWorkTask({ ...input, goal: "changed goal" })).ok, false);
      assert.equal(sanitizeWorkTaskInput("createWorkTask", { ...input, operationId: "bad id" }).ok, false);
    } finally { await desktop.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("a real partial write whose cleanup fails stops the loop with an unknown receipt and task needs_review", async t => {
    const root = await prepare();
    const desktop = await open(root, "work-thread", true);
    const path = join(desktop.bridge.info().workspaceRoot!, "report.md");
    let faultReached = false;
    const originalOpen = fs.promises.open, originalUnlink = fs.promises.unlink;
    t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (args[0] === path) {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, "writeFile", async () => { faultReached = true; await write("partial"); throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); });
      }
      return handle;
    });
    t.mock.method(fs.promises, "unlink", async (...args: Parameters<typeof originalUnlink>) => {
      if (args[0] === path) throw Object.assign(new Error("cannot remove"), { code: "EACCES" });
      return originalUnlink(...args);
    });
    syncBuiltinESMExports();
    try {
      const created = await desktop.bridge.createWorkTask(createInput); assert(created.ok);
      const run = await desktop.bridge.runWorkTask({ id: created.value.id, expectedRevision: created.value.revision }); assert(run.ok);
      await waitFor(() => !!desktop.bridge.snapshot().pendingApproval);
      assert(desktop.bridge.confirm({ approvalId: desktop.bridge.snapshot().pendingApproval!.approvalId, decision: "allow" }).accepted);
      await waitFor(() => desktop.bridge.snapshot().state.kind === "idle");
      assert(faultReached, "fault injection must hit the canonical workspace file");
      assert.equal(desktop.calls(), 1, "unknown effects stop before another model step");
      assert.equal(await readFile(path, "utf8"), "partial");
      const task = await desktop.bridge.getWorkTask(created.value.id); assert(task.ok && task.value.status === "needs_review");
      const receipt = await desktop.bridge.getRun(task.value.runIds.at(-1)!); assert(receipt.ok);
      assert.equal(receipt.run?.tools[0]?.status, "unknown");
      assert.equal((await desktop.bridge.runWorkTask({ id: task.value.id, expectedRevision: task.value.revision })).ok, false);
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      await desktop.bridge.shutdown(); await rm(root, { recursive: true, force: true });
    }
  });
  it("checks real file readback and meaningful Shell tests, restores review, and reworks in a new Run", async () => {
    const root = await prepare();
    const content = "# Goal\nDeliver a plan.\n# Checks\nRead back and test.\n# Next\nReview the plan.\n# Preserved\nKEEP-THIS\n";
    const command = "node check-plan.mjs";
    await writeFile(join(root, "workspace", "check-plan.mjs"),
      'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; const text=readFileSync("report.md","utf8"); for(const part of ["# Goal","# Checks","# Next","KEEP-THIS"]) assert.ok(text.includes(part),part); console.log("plan checks passed");');
    await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace: "./workspace",
      modules: { "read-file": { enabled: true }, shell: { enabled: true, timeoutMs: 8000 } } }));
    function scripted(actions: Array<{ name: string; input: unknown }>) {
      let step = 0;
      return new MockLanguageModelV3({ doStream: async () => {
        const action = actions[step++];
        const chunks = action ? [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: `call-${step}`, toolName: action.name, input: JSON.stringify(action.input) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
        ] : [
          { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "answer" },
          { type: "text-delta" as const, id: "answer", delta: "Plan ready for your review." }, { type: "text-end" as const, id: "answer" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ];
        return { stream: simulateReadableStream<(typeof chunks)[number]>({ chunks }) };
      } });
    }
    let fixture = await open(root, "work-thread", false, scripted([
      { name: "write_file", input: { path: "report.md", content } },
      { name: "read_file", input: { path: "report.md" } },
      { name: "shell_exec", input: { command, cwd: "." } },
    ]));
    const approved: string[] = [];
    const run = async (task: import("../shared/work-tasks.js").WorkTask, completionCheck = true, decision: "allow" | "deny" = "allow") => {
      const off = fixture.controller.subscribe(event => {
        if (event.type !== "approval" || !event.approval.preview.trim()) return;
        approved.push(event.approval.toolName);
        fixture.bridge.confirm({ approvalId: event.approval.approvalId, decision });
      });
      try {
        assert.ok((await fixture.bridge.runWorkTask({ id: task.id, expectedRevision: task.revision, completionCheck })).ok);
        await waitFor(() => fixture.bridge.snapshot().state.kind === "idle");
      } finally { off(); }
      const found = await fixture.bridge.getWorkTask(task.id); assert.ok(found.ok); return found.value;
    };
    try {
      const created = await fixture.bridge.createWorkTask({ ...createInput, acceptance: [
        { ...createInput.acceptance[0]!, verification: { kind: "artifact_exists", path: "report.md", requireReadback: true } },
        { id: "test", description: "Sections and preserved text pass", method: "automatic", required: true, verification: { kind: "shell_exit_zero", command, cwd: "." } },
        createInput.acceptance[1]!,
      ] }); assert.ok(created.ok);
      const delivered = await run(created.value);
      assert.equal(delivered.status, "awaiting_acceptance");
      assert.deepEqual(delivered.acceptance.map(item => item.status), ["passed", "passed", "not_run"]);
      assert.deepEqual(approved, ["write_file", "read_file", "shell_exec"]);
      await fixture.bridge.shutdown();
      fixture = await open(root, "work-thread", false, scripted([
        { name: "read_file", input: { path: "report.md" } },
        { name: "edit_file", input: { path: "report.md", oldText: "Review the plan.", newText: "Review and ship the plan." } },
        { name: "read_file", input: { path: "report.md" } },
        { name: "shell_exec", input: { command, cwd: "." } },
      ]));
      const restored = await fixture.bridge.getWorkTask(delivered.id); assert.ok(restored.ok);
      assert.equal(restored.value.status, "awaiting_acceptance");
      assert.equal(fixture.bridge.snapshot().state.kind, "idle");
      const rejected = await fixture.bridge.requestWorkTaskChanges({ id: delivered.id, expectedRevision: restored.value.revision }); assert.ok(rejected.ok);
      assert.equal(rejected.value.status, "paused");
      assert.ok(rejected.value.acceptance.every(item => item.status === "not_run"));
      const next = await run(rejected.value);
      assert.equal(next.status, "awaiting_acceptance");
      assert.equal(next.runIds.length, 2);
      assert.deepEqual(next.acceptance.map(item => item.status), ["passed", "passed", "not_run"]);
      const text = await readFile(join(root, "workspace", "report.md"), "utf8");
      assert.match(text, /Review and ship/); assert.match(text, /KEEP-THIS/);
      assert.ok(next.delivery!.evidence.every(item => item.kind !== "human" && item.runId === next.runIds.at(-1)), "new delivery must not borrow earlier receipts");

      // The same real command must fail against invalid contents; Run completion is not test success.
      await fixture.bridge.shutdown();
      fixture = await open(root, "work-thread", false, scripted([
        { name: "edit_file", input: { path: "report.md", oldText: "# Next", newText: "# Later" } },
        { name: "read_file", input: { path: "report.md" } },
        { name: "shell_exec", input: { command, cwd: "." } },
      ]));
      const broken = await fixture.bridge.createWorkTask({ goal: "Demonstrate failed file checks", acceptance: created.value.acceptance.map(({ status, evidenceRefs, note, ...criterion }) => criterion) });
      assert.ok(broken.ok);
      const partial = await run(broken.value, false);
      assert.equal(fixture.bridge.snapshot().lastPrimaryResult?.status, "completed");
      const failed = await fixture.bridge.submitWorkTaskDelivery({ id: partial.id, expectedRevision: partial.revision, summary: "Invalid document; test failed", artifactRefs: ["report.md"] });
      assert.ok(failed.ok);
      assert.deepEqual(failed.value.acceptance.map(item => item.status), ["passed", "failed", "not_run"]);
      assert.notEqual(failed.value.status, "completed");

      await fixture.bridge.shutdown();
      fixture = await open(root, "work-thread", false, scripted([
        { name: "write_file", input: { path: "denied.md", content } },
      ]));
      const denied = await fixture.bridge.createWorkTask({ goal: "Demonstrate a refused write", acceptance: [
        { ...createInput.acceptance[0]!, verification: { kind: "artifact_exists", path: "denied.md", requireReadback: true } },
      ] }); assert.ok(denied.ok);
      const refused = await run(denied.value, false, "deny");
      await assert.rejects(readFile(join(root, "workspace", "denied.md")), { code: "ENOENT" });
      const refusedDelivery = await fixture.bridge.submitWorkTaskDelivery({ id: refused.id, expectedRevision: refused.revision, summary: "Write refused" });
      assert.ok(refusedDelivery.ok);
      assert.notEqual(refusedDelivery.value.acceptance[0]?.status, "passed");
      assert.deepEqual(refusedDelivery.value.delivery?.evidence, []);
    } finally { await fixture.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
  it("persists readback and test contracts without running or authorizing tools", async () => {
    const root = await prepare();
    const fixture = await open(root);
    try {
      const acceptance: WorkTaskInputs["createWorkTask"]["acceptance"] = [
        { ...createInput.acceptance[0]!, verification: { kind: "artifact_exists", path: "report.md", requireReadback: true } },
        { id: "test", description: "Tests pass", method: "automatic", required: true, verification: { kind: "shell_exit_zero", command: "pnpm test", cwd: "project" } },
      ];
      const created = await fixture.bridge.createWorkTask({ goal: "Check the report", acceptance });
      assert.ok(created.ok); if (!created.ok) return;
      assert.deepEqual(created.value.acceptance.map(item => item.verification), acceptance.map(item => item.verification));
      assert.equal(created.value.status, "ready");
      assert.deepEqual(created.value.runIds, []);
      assert.equal(fixture.calls(), 0);
      assert.equal(fixture.bridge.snapshot().pendingApproval, null);
      const store = createWorkTaskStore(join(root, "workspace"));
      const saved = await store.get(created.value.id);
      assert.ok(saved.ok && saved.value);
      if (saved.ok && saved.value) assert.deepEqual(saved.value.acceptance, created.value.acceptance);
    } finally {
      await fixture.bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("prefills only the current delivery and previews safe artifacts without model calls or acceptance writes", async () => {
    const root = await prepare();
    let fixture = await open(root, "work-thread", true);
    try {
      const created = await fixture.bridge.createWorkTask(createInput);
      assert.ok(created.ok); if (!created.ok) return;
      const id = created.value.id;
      assert.ok((await fixture.bridge.runWorkTask({ id, expectedRevision: created.value.revision })).ok);
      await waitFor(() => fixture.bridge.snapshot().pendingApproval !== null);
      fixture.bridge.confirm({ approvalId: fixture.bridge.snapshot().pendingApproval!.approvalId, decision: "allow" });
      await waitFor(() => fixture.bridge.snapshot().state.kind === "idle");
      const paused = await fixture.bridge.getWorkTask(id);
      assert.ok(paused.ok); if (!paused.ok) return;
      const input = { id, expectedRevision: paused.value.revision };
      const calls = fixture.calls();
      const draft = await fixture.bridge.getWorkTaskDeliveryDraft({ ...input, status: "completed", threadId: "forged" } as never);
      assert.ok(draft.ok); if (!draft.ok) return;
      assert.equal(draft.value.summary, "本轮结束，请另行验收。");
      assert.equal(draft.value.runId, paused.value.runIds.at(-1));
      assert.deepEqual(draft.value.artifacts.map(item => item.path), ["report.md"]);
      const continuation = await fixture.bridge.getWorkTaskContinuation({ ...input, threadId: "foreign", status: "completed" } as never);
      assert.ok(continuation.ok && continuation.value.latestRun?.runId === paused.value.runIds.at(-1));
      const context = await fixture.bridge.getContextDiagnostics();
      assert.ok(context.ok && context.value.lastPreparationSource?.workTaskId === id);
      assert.ok(context.ok && context.value.lastPreparationSource?.runId === paused.value.runIds.at(-1));
      assert.equal((await fixture.bridge.getWorkTaskContinuation({ ...input, expectedRevision: 1 })).ok, false);
      const preview = await fixture.bridge.getWorkTaskArtifact({ ...input, path: "report.md", evidence: ["forged"] } as never);
      assert.ok(preview.ok); if (!preview.ok) return;
      assert.equal(preview.value.content, "报告正文\n");
      assert.equal(preview.value.matchesReceipt, true);
      assert.equal(preview.value.receipt?.toolCallId, "write-report");
      await writeFile(join(root, "workspace", "report.md"), "外部修改\n");
      const changed = await fixture.bridge.getWorkTaskArtifact({ ...input, path: "report.md" });
      assert.ok(changed.ok && changed.value.matchesReceipt === false);
      await writeFile(join(root, "workspace", "private.txt"), "not a task artifact");
      assert.equal((await fixture.bridge.getWorkTaskArtifact({ ...input, path: "private.txt" })).ok, false);
      assert.equal((await fixture.bridge.getWorkTaskArtifact({ ...input, path: "../config.json" })).ok, false);
      assert.equal((await fixture.bridge.getWorkTaskArtifact({ ...input, path: "report.md", expectedRevision: 1 })).ok, false);
      for (const invalid of [null, {}, { id, expectedRevision: 0 }]) {
        assert.equal((await fixture.bridge.getWorkTaskDeliveryDraft(invalid as never)).ok, false);
        assert.equal((await fixture.bridge.getWorkTaskArtifact(invalid as never)).ok, false);
        assert.equal((await fixture.bridge.getWorkTaskContinuation(invalid as never)).ok, false);
      }
      assert.equal((await fixture.bridge.getWorkTaskArtifact({ ...input, path: "" })).ok, false);
      assert.equal(fixture.calls(), calls);
      assert.deepEqual(await fixture.bridge.getWorkTask(id), paused, "display must not submit or accept a delivery");
      await fixture.bridge.shutdown();
      fixture = await open(root);
      const restored = await fixture.bridge.getWorkTaskDeliveryDraft(input);
      assert.deepEqual(restored, draft);
      assert.deepEqual(await fixture.bridge.getWorkTaskContinuation(input), continuation);
      const restartedContext = await fixture.bridge.getContextDiagnostics();
      assert.ok(restartedContext.ok && restartedContext.value.lastPreparationSource === null);
      const restoredPreview = await fixture.bridge.getWorkTaskArtifact({ ...input, path: "report.md" });
      assert.ok(restoredPreview.ok && restoredPreview.value.matchesReceipt === false);
      assert.equal(fixture.calls(), 0);
    } finally { await fixture.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("returns an unsuccessful delivery without a model call and does not reuse old automatic proof", async () => {
    const root = await prepare();
    const fixture = await open(root, "work-thread", true);
    try {
      const created = await fixture.bridge.createWorkTask(createInput);
      assert.ok(created.ok); if (!created.ok) return;
      const id = created.value.id;
      assert.ok((await fixture.bridge.runWorkTask({ id, expectedRevision: created.value.revision })).ok);
      await waitFor(() => fixture.bridge.snapshot().pendingApproval !== null);
      fixture.bridge.confirm({ approvalId: fixture.bridge.snapshot().pendingApproval!.approvalId, decision: "allow" });
      await waitFor(() => fixture.bridge.snapshot().state.kind === "idle");
      const paused = await fixture.bridge.getWorkTask(id);
      assert.ok(paused.ok); if (!paused.ok) return;
      const delivered = await fixture.bridge.submitWorkTaskDelivery({ id, expectedRevision: paused.value.revision, summary: "first draft", artifactRefs: ["report.md"] });
      assert.ok(delivered.ok); if (!delivered.ok) return;
      assert.equal(delivered.value.acceptance[0]?.status, "passed");
      const failed = await fixture.bridge.recordHumanAcceptance({ id, expectedRevision: delivered.value.revision, criterionId: "human", decision: "failed", note: "needs revision" });
      assert.ok(failed.ok); if (!failed.ok) return;
      const calls = fixture.calls();
      const returned = await fixture.bridge.requestWorkTaskChanges({ id, expectedRevision: failed.value.revision });
      assert.ok(returned.ok); if (!returned.ok) return;
      assert.equal(fixture.calls(), calls);
      assert.equal(returned.value.status, "paused");
      assert.deepEqual(returned.value.delivery, failed.value.delivery);
      assert.ok(returned.value.acceptance.every(item => item.status === "not_run"));
      assert.equal((await fixture.bridge.requestWorkTaskChanges({ id, expectedRevision: failed.value.revision })).ok, false);
      assert.equal((await fixture.bridge.recordHumanAcceptance({ id, expectedRevision: returned.value.revision, criterionId: "human", decision: "passed" })).ok, false);
      assert.ok((await fixture.bridge.runWorkTask({ id, expectedRevision: returned.value.revision, instruction: "review only" })).ok);
      await waitFor(() => fixture.bridge.snapshot().state.kind === "idle");
      const next = await fixture.bridge.getWorkTask(id);
      assert.ok(next.ok); if (!next.ok) return;
      assert.equal(next.value.runIds.length, 2);
      const redelivered = await fixture.bridge.submitWorkTaskDelivery({ id, expectedRevision: next.value.revision, summary: "second draft" });
      assert.ok(redelivered.ok); if (!redelivered.ok) return;
      assert.notEqual(redelivered.value.acceptance[0]?.status, "passed");
      assert.deepEqual(redelivered.value.delivery?.evidence, []);
      assert.equal(redelivered.value.acceptance[1]?.status, "not_run");
    } finally { await fixture.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("explicit rework survives restart and a new human-only round can be accepted", async () => {
    const root = await prepare();
    let fixture = await open(root);
    try {
      const created = await fixture.bridge.createWorkTask({ goal: "write a plan", acceptance: [createInput.acceptance[1]!] });
      assert.ok(created.ok); if (!created.ok) return;
      const id = created.value.id;
      assert.ok((await fixture.bridge.runWorkTask({ id, expectedRevision: 1 })).ok);
      await waitFor(() => fixture.bridge.snapshot().state.kind === "idle");
      const first = await fixture.bridge.getWorkTask(id);
      assert.ok(first.ok); if (!first.ok) return;
      const delivered = await fixture.bridge.submitWorkTaskDelivery({ id, expectedRevision: first.value.revision, summary: "draft" });
      assert.ok(delivered.ok); if (!delivered.ok) return;
      const returned = await fixture.bridge.requestWorkTaskChanges({ id, expectedRevision: delivered.value.revision });
      assert.ok(returned.ok); if (!returned.ok) return;
      await fixture.bridge.shutdown();
      fixture = await open(root);
      const restored = await fixture.bridge.getWorkTask(id);
      assert.ok(restored.ok); if (!restored.ok) return;
      assert.equal(restored.value.status, "paused");
      assert.equal(restored.value.delivery?.summary, "draft");
      assert.equal(fixture.calls(), 0);
      assert.ok((await fixture.bridge.runWorkTask({ id, expectedRevision: restored.value.revision })).ok);
      await waitFor(() => fixture.bridge.snapshot().state.kind === "idle");
      const second = await fixture.bridge.getWorkTask(id);
      assert.ok(second.ok); if (!second.ok) return;
      const revised = await fixture.bridge.submitWorkTaskDelivery({ id, expectedRevision: second.value.revision, summary: "revised plan" });
      assert.ok(revised.ok); if (!revised.ok) return;
      const accepted = await fixture.bridge.recordHumanAcceptance({ id, expectedRevision: revised.value.revision, criterionId: "human", decision: "passed" });
      assert.ok(accepted.ok && accepted.value.status === "completed");
      assert.equal((await fixture.bridge.requestWorkTaskChanges({ id, expectedRevision: accepted.ok ? accepted.value.revision : 1 })).ok, false);
    } finally { await fixture.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("drops ownership and evidence and validates supported creation criteria", () => {
    const sanitized = sanitizeWorkTaskInput("createWorkTask", { ...createInput, threadId: "foreign", status: "completed", revision: 999 });
    assert.deepEqual(sanitized, { ok: true, value: createInput });
    for (const verification of [{ kind: "shell_exit_zero", command: "true", cwd: "" }, { kind: "artifact_exists", path: "report.md", requireReadback: "true" }]) {
      assert.equal(sanitizeWorkTaskInput("createWorkTask", { ...createInput, acceptance: [{ ...createInput.acceptance[0], verification }] }).ok, false);
    }
    assert.deepEqual(sanitizeWorkTaskInput("submitWorkTaskDelivery", { id: "task", expectedRevision: 2, summary: "交付", evidence: [{ kind: "artifact" }], status: "completed" }), { ok: true, value: { id: "task", expectedRevision: 2, summary: "交付" } });
    assert.equal(sanitizeWorkTaskInput("cancelWorkTask", { id: "task", expectedRevision: 0 }).ok, false);
    assert.equal(sanitizeWorkTaskInput("reconcileWorkTask", { id: "task", expectedRevision: 1, observedOutcome: "passed", decision: "continue", note: "x" }).ok, false);
  });

  it("runs, auto-submits checked delivery, requires human acceptance, and survives restart", async () => {
    const root = await prepare();
    const first = await open(root, "work-thread", true);
    let id = "";
    try {
      assert.equal(first.bridge.info().workTasks, true);
      const created = await first.bridge.createWorkTask({ ...createInput, threadId: "forged" } as never);
      assert.ok(created.ok); if (!created.ok) return;
      id = created.value.id;
      assert.equal(created.value.threadId, "work-thread");
      assert.equal(first.calls(), 0);
      const start = await first.bridge.runWorkTask({ id, expectedRevision: created.value.revision });
      assert.ok(start.ok); if (!start.ok) return;
      await waitFor(() => first.bridge.snapshot().pendingApproval !== null);
      const busy = await first.bridge.cancelWorkTask({ id, expectedRevision: 2 });
      assert.equal(busy.ok, false);
      const approval = first.bridge.snapshot().pendingApproval!;
      assert.equal(first.bridge.confirm({ approvalId: approval.approvalId, decision: "allow" }).accepted, true);
      await waitFor(() => first.bridge.snapshot().state.kind === "idle");
      const paused = await first.bridge.getWorkTask(id);
      assert.ok(paused.ok); if (!paused.ok) return;
      assert.equal(paused.value.status, "awaiting_acceptance");
      const run = await first.bridge.getRun(start.runId);
      assert.ok(run.ok && run.run?.workTaskId === id);
      assert.equal(await readFile(join(root, "workspace", "report.md"), "utf8"), "报告正文\n");
      const stale = await first.bridge.submitWorkTaskDelivery({ id, expectedRevision: 1, summary: "旧请求" });
      assert.equal(!stale.ok && stale.error.code, "WORK_TASK_REVISION_CONFLICT");
      const delivered = await first.bridge.submitWorkTaskDelivery({ id, expectedRevision: paused.value.revision, summary: "报告已写入", artifactRefs: ["report.md"] });
      assert.ok(delivered.ok); if (!delivered.ok) return;
      assert.equal(delivered.value.status, "awaiting_acceptance");
      assert.equal(delivered.value.acceptance[0]?.status, "passed");
      assert.equal(delivered.value.acceptance[1]?.status, "not_run");
      assert.equal(delivered.value.delivery?.evidence[0]?.kind, "artifact");
      const accepted = await first.bridge.recordHumanAcceptance({ id, expectedRevision: delivered.value.revision, criterionId: "human", decision: "passed" });
      assert.ok(accepted.ok && accepted.value.status === "completed");
      assert.equal(first.messages.some(message => message.type === "work-task-updated" && message.task.status === "completed"), true);
      const replay = await first.bridge.recordHumanAcceptance({ id, expectedRevision: delivered.value.revision, criterionId: "human", decision: "passed" });
      assert.equal(replay.ok, false);
    } finally { await first.bridge.shutdown(); }
    const restarted = await open(root);
    try {
      const record = await restarted.bridge.getWorkTask(id);
      assert.ok(record.ok && record.value.status === "completed");
      assert.equal(restarted.calls(), 0);
    } finally { await restarted.bridge.shutdown(); }
    const otherThread = await open(root, "another-thread");
    try {
      assert.deepEqual(await otherThread.bridge.listWorkTasks(), { ok: true, value: [] });
      assert.equal((await otherThread.bridge.getWorkTask(id)).ok, false);
      assert.ok((await otherThread.bridge.run("普通对话")).ok);
      await waitFor(() => otherThread.bridge.snapshot().state.kind === "idle");
      assert.deepEqual(await otherThread.bridge.listWorkTasks(), { ok: true, value: [] });
    } finally { await otherThread.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("never accepts a model claim as artifact proof", async () => {
    const root = await prepare();
    const desktop = await open(root);
    try {
      await writeFile(join(root, "workspace", "report.md"), "一个预先存在的文件");
      const created = await desktop.bridge.createWorkTask(createInput);
      assert.ok(created.ok); if (!created.ok) return;
      assert.ok((await desktop.bridge.runWorkTask({ id: created.value.id, expectedRevision: created.value.revision })).ok);
      await waitFor(() => desktop.bridge.snapshot().state.kind === "idle");
      const paused = await desktop.bridge.getWorkTask(created.value.id);
      assert.ok(paused.ok); if (!paused.ok) return;
      const delivered = await desktop.bridge.submitWorkTaskDelivery({ id: paused.value.id, expectedRevision: paused.value.revision, summary: "声称已写完" });
      assert.ok(delivered.ok && delivered.value.acceptance[0]?.status === "failed");
      assert.ok(delivered.ok && delivered.value.delivery?.evidence.length === 0);
      assert.ok(delivered.ok && delivered.value.status === "awaiting_acceptance");
    } finally { await desktop.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("recovers unknown receipts without a model call, prevents cancel bypass, and records human review without changing old receipts", async () => {
    const root = await prepare();
    const executions = createExecutionRecordStore(join(root, "transcripts"));
    const store = createWorkTaskStore(join(root, "workspace"), { executionRecords: executions });
    const created = await store.create({ ...createInput, threadId: "work-thread" });
    assert.ok(created.ok); if (!created.ok) return;
    const id = created.value.id;
    await store.beginRun(id, { expectedRevision: 1, runId: "abandoned-run" });
    await executions.startRun({ runId: "abandoned-run", threadId: "work-thread", workTaskId: id, phase: "primary" });
    await executions.recordToolEvent("abandoned-run", { id: "requested", type: "tool.call.requested", threadId: "work-thread", runId: "abandoned-run", sequence: 1, occurredAt: "2026-10-03T00:00:00.000Z", data: { toolCallId: "unknown-write", toolName: "write_file", input: { path: "report.md", content: "x" } } });
    await executions.recordToolEvent("abandoned-run", { id: "started", type: "tool.call.started", threadId: "work-thread", runId: "abandoned-run", sequence: 2, occurredAt: "2026-10-03T00:00:01.000Z", data: { toolCallId: "unknown-write", toolName: "write_file" } });
    const desktop = await open(root);
    try {
      const recovered = await desktop.bridge.getWorkTask(id);
      assert.ok(recovered.ok && recovered.value.status === "needs_review"); if (!recovered.ok) return;
      assert.equal(desktop.calls(), 0);
      assert.equal((await desktop.bridge.runWorkTask({ id, expectedRevision: recovered.value.revision })).ok, false);
      assert.equal((await desktop.bridge.cancelWorkTask({ id, expectedRevision: recovered.value.revision })).ok, false);
      assert.equal((await desktop.bridge.reconcileWorkTask({ id, expectedRevision: recovered.value.revision, observedOutcome: "still_unknown", decision: "continue", note: "没法判断" })).ok, false);
      const reconciled = await desktop.bridge.reconcileWorkTask({ id, expectedRevision: recovered.value.revision, observedOutcome: "not_applied", decision: "continue", note: "用户自行核对，报告未生效" });
      assert.ok(reconciled.ok && reconciled.value.status === "paused"); if (!reconciled.ok) return;
      assert.equal(desktop.calls(), 0);
      assert.equal(reconciled.value.reconciliations.length, 1);
      assert.equal(reconciled.value.acceptance[0]?.status, "not_run");
      const oldRun = await desktop.bridge.getRun("abandoned-run");
      assert.ok(oldRun.ok && oldRun.run?.status === "interrupted" && oldRun.run.tools[0]?.status === "unknown");
      const delivery = await desktop.bridge.submitWorkTaskDelivery({ id, expectedRevision: reconciled.value.revision, summary: "只有人工核对" });
      assert.ok(delivery.ok && delivery.value.acceptance[0]?.status === "blocked");
    } finally { await desktop.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("reports a corrupt task file instead of an empty task list", async () => {
    const root = await prepare();
    await mkdir(join(root, "workspace", ".runloom"));
    await writeFile(join(root, "workspace", ".runloom", "work-tasks.json"), "{bad");
    const desktop = await open(root);
    try { assert.equal((await desktop.bridge.listWorkTasks()).ok, false); }
    finally { await desktop.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
});
