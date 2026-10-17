/** Opt-in live backend evidence. Programmatic fixture reviews are not Electron clicks. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { wrapLanguageModel } from "ai";
import { createRuntimeApp, type RuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import type { MemoryAction } from "./memory-controls.js";
import type { MemoryResult } from "./memory-candidates.js";
import { createMemoryStore } from "./memory-store.js";
import { retrieveMemories } from "./memory-retrieval.js";

type Stage = "before" | "after";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const SOURCE_THREAD = "temporal-source-a";
const QUERY_THREAD = "temporal-question-b";
const THREE = "用户长期复盘写作偏好：先给一行结论，再列三条可执行步骤。";
const CORRECTED = "用户长期复盘写作偏好：先给一行结论，再列三项可执行行动。";
const DECLARATION = "我的长期复盘写作偏好是：先给一行结论，再列两条可执行步骤。";

function value<T>(result: MemoryResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

async function child(root: string, stage: Stage) {
  const configPath = join(root, "config.json");
  const configText = await readFile(configPath, "utf8");
  const workspace = join(root, "workspace");
  assert.equal(JSON.parse(configText).workspace, workspace);
  const configured = configureCliModel(createDemoModel);
  assert.notEqual(configured.modelAlias, "mock/default");
  if (typeof configured.model === "string") throw new Error("Acceptance requires an explicit provider model");
  const captures: Array<{ phase: string; prompt: unknown }> = [];
  const checks: Array<{ id: string; status: "passed"; note: string }> = [];
  const runs: unknown[] = [];
  const controls: unknown[] = [];
  const approvals: Array<{ phase: string; toolName: string; decision: "deny" }> = [];
  let phase = "startup", failure: string | null = null;
  let controller: AssistantController | undefined, app: RuntimeApp | undefined;
  const model = wrapLanguageModel({ model: configured.model, middleware: {
    specificationVersion: "v3", transformParams: async ({ params }) => {
      captures.push({ phase, prompt: params.prompt });
      return params;
    },
  } });
  const disk = createMemoryStore(workspace);
  const check = (id: string, note: string) => checks.push({ id, status: "passed", note });
  async function open(thread: string) {
    await controller?.shutdown();
    const output = new PassThrough();
    app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: thread, configPath },
      modelAlias: configured.modelAlias, model, output, env: process.env, cwd: root });
    controller = createAssistantController(app);
    output.on("data", (chunk: Buffer) => controller!.recordOutput(chunk.toString()));
    const seen = new Set<string>();
    controller.subscribe(event => {
      if (event.type !== "approval" || seen.has(event.approval.approvalId)) return;
      seen.add(event.approval.approvalId);
      // The only accepted writes are explicit review/control calls below, never model tool calls.
      approvals.push({ phase, toolName: event.approval.toolName, decision: "deny" });
      controller!.confirm({ approvalId: event.approval.approvalId, decision: "deny" });
    });
  }
  async function run(label: string, prompt: string, exclude = true) {
    phase = label;
    process.stdout.write(`${stage}: ${label}\n`);
    let unsubscribe = () => {};
    const done = new Promise<void>(resolve => {
      unsubscribe = controller!.subscribe(event => {
        if (event.type === "state" && event.state.kind === "idle") resolve();
      });
    });
    try {
      const started = await controller!.run(prompt, exclude ? { memoryConsolidation: "exclude" } : {});
      assert.ok(started.ok, JSON.stringify(started));
      await done;
    } finally { unsubscribe(); }
    const result = controller!.getSnapshot().lastPrimaryResult;
    assert.ok(result);
    const reference = controller!.getMemoryReferences();
    runs.push({ label, result, reference });
    assert.equal(result.status, "completed", JSON.stringify(result.error));
    return { result, reference };
  }
  async function current(id: string) { return value(await controller!.getMemory(id)); }
  async function apply(action: MemoryAction) {
    phase = action.operation;
    const count = captures.length;
    const before = await readFile(join(workspace, ".runloom/memory.json"), "utf8");
    const preview = value(await controller!.previewMemoryAction(action));
    assert.equal(await readFile(join(workspace, ".runloom/memory.json"), "utf8"), before, "preview must be write-free");
    assert.deepEqual(preview.input, action);
    const result = value(await controller!.applyMemoryAction(preview.input));
    assert.equal(captures.length, count, "control actions must not call a model");
    controls.push({ action, preview, result });
    if (result !== null) {
      const record = value(await disk.inspectMemory(action.id));
      assert.equal(record.revision, action.expectedRevision + 1);
      assert.equal(record.revision, result.revision);
    }
    return result;
  }
  async function eligible(id: string) {
    const listed = await disk.list(); assert.ok(listed.ok);
    return retrieveMemories(listed.entries, { query: "复盘写作偏好", threadId: QUERY_THREAD, now: new Date() }).selected.some(entry => entry.id === id);
  }
  try {
    if (stage === "before") {
      await open(SOURCE_THREAD);
      await run("ordinary-statement", `${DECLARATION}本轮只回复收到，不调用主任务工具。可以在对话结束后提出待审候选，但正式记忆必须等我另行审核。`, false);
      const formal = await disk.list(); assert.ok(formal.ok); assert.equal(formal.entries.length, 0);
      const candidate = value(await controller!.listMemoryCandidates({ status: "pending" })).candidates.find(item => item.change.text.includes("复盘"));
      assert.ok(candidate, "real automatic consolidation must produce the ordinary statement candidate; no synthetic fallback");
      const preview = value(await controller!.getMemoryCandidate(candidate.id));
      assert.ok(preview.applicable);
      assert.equal(preview.candidate.change.operation, "add");
      assert.equal(preview.proposed?.scope.kind, "workspace");
      assert.equal(preview.proposed?.kind, "preference");
      assert.ok((candidate.sources ?? [candidate.source]).some(source => DECLARATION.includes(source.quote) || source.quote.includes(DECLARATION)), "candidate must quote fixture user text");
      const messages = await app!.store.getMessages(SOURCE_THREAD);
      for (const source of candidate.sources ?? [candidate.source]) {
        const message = messages.find(item => item.id === source.messageId && item.role === "user");
        assert.ok(message && message.parts.some(part => part.type === "text" && part.text.includes(source.quote)));
      }
      check("ordinary-candidate", "real model staged exact committed user quotes; formal store unchanged before review");
      const accepted = value(await controller!.resolveMemoryCandidate({ candidateId: candidate.id, expectedCandidateRevision: preview.candidate.revision, decision: "accept" }));
      assert.ok(accepted.memoryId);
      const memoryId = accepted.memoryId;
      const saved = await current(memoryId);
      assert.equal(saved.revision, 1);
      const acceptedBytes = await readFile(join(workspace, ".runloom/memory.json"), "utf8");
      const replayed = value(await controller!.resolveMemoryCandidate({ candidateId: candidate.id, expectedCandidateRevision: preview.candidate.revision, decision: "accept" }));
      assert.ok(replayed.replayed);
      assert.equal(await readFile(join(workspace, ".runloom/memory.json"), "utf8"), acceptedBytes);
      await open(QUERY_THREAD);
      const recalled = await run("cross-thread-paraphrase", "我做阶段复盘时，应先写哪句话、之后拆几项行动？只依据本轮参考记忆回答，并说出记忆 ID；不要查询工具。");
      const selected = recalled.reference?.selected.find(item => item.id === memoryId);
      assert.equal(selected?.revision, 1);
      assert.ok(selected?.assertion?.assertionId);
      assert.ok(selected.assertion.sourceIds.some(source => source.kind === "conversation" && source.threadId === SOURCE_THREAD));
      assert.match(recalled.result.text, /结论/); assert.match(recalled.result.text, /两|二|2/);
      assert.ok(recalled.result.text.includes(memoryId));
      assert.ok(captures.filter(item => item.phase === "cross-thread-paraphrase").some(item => JSON.stringify(item.prompt).includes(selected.assertion!.assertionId)), "actual provider input must include selected assertion identity");
      check("cross-thread", `${memoryId} revision 1 with actual assertion and source identifiers selected and answered`);
      const effectiveAt = new Date(Date.now() - 86_400_000).toISOString();
      const changed = await apply({ id: memoryId, expectedRevision: saved.revision!, operation: "change", text: THREE, effectiveAt }); assert.ok(changed);
      const past = value(await controller!.queryMemory({ id: memoryId, validAt: new Date(Date.parse(effectiveAt) - 1000).toISOString() }));
      assert.ok(past.assertions.some(item => /两|二|2/.test(item.text)));
      assert.ok(past.assertions.every(item => item.text !== THREE));
      const now = value(await controller!.queryMemory({ id: memoryId }));
      assert.deepEqual(now.assertions.map(item => item.text), [THREE]);
      const record = value(await disk.inspectMemory(memoryId));
      assert.equal(record.id, memoryId); assert.equal(record.historyCoverage, "complete");
      assert.ok(record.assertions.length >= 3);
      await writeFile(join(root, "resume.json"), JSON.stringify({ memoryId, candidateId: candidate.id, originalAssertionId: saved.assertion!.assertionId, effectiveAt, changedRevision: changed.revision }, null, 2), { flag: "wx" });
      check("real-change", "same logical memory; prior-valid two steps and current three steps are independently queryable");
    } else {
      const resume: { memoryId: string; candidateId: string; originalAssertionId: string; effectiveAt: string; changedRevision: number } = JSON.parse(await readFile(join(root, "resume.json"), "utf8"));
      const id = resume.memoryId;
      await open(QUERY_THREAD);
      assert.equal(controller!.getMemoryReferences(), null, "process-local references do not survive restart");
      let memory = await current(id);
      assert.equal(memory.revision, resume.changedRevision); assert.equal(memory.text, THREE);
      const reopened = await run("reopened-current", "我的复盘写作偏好现在是什么？只依据本轮参考记忆回答，旧对话里的两条不代表当前版本。引用记忆 ID，不调用工具。");
      assert.equal(reopened.reference?.selected.find(item => item.id === id)?.revision, resume.changedRevision);
      assert.match(reopened.result.text, /三|3/);
      check("full-process-restart", "same config/workspace/transcripts reopened; current revision selected, old two-step preference not restored");
      const previousAssertion = memory.assertion!;
      assert.ok(previousAssertion.systemTime.from);
      const corrected = await apply({ id, expectedRevision: memory.revision!, operation: "correct", text: CORRECTED, validTime: previousAssertion.validTime }); assert.ok(corrected);
      const oldKnowledge = value(await controller!.queryMemory({ id, knownAt: previousAssertion.systemTime.from, validAt: new Date().toISOString() }));
      assert.deepEqual(oldKnowledge.assertions.map(item => item.text), [THREE]);
      const newKnowledge = value(await controller!.queryMemory({ id }));
      assert.deepEqual(newKnowledge.assertions.map(item => item.text), [CORRECTED]);
      assert.deepEqual(corrected.assertion!.validTime, previousAssertion.validTime, "correction preserves applicability instead of inventing a real transition");
      const correctionRecord = value(await disk.inspectMemory(id));
      assert.ok(correctionRecord.assertions.find(item => item.assertionId === corrected.assertion!.assertionId)?.sources.some(source => source.kind === "manual"));
      const historyBytes = await readFile(join(workspace, ".runloom/memory.json"), "utf8");
      const firstHistory = value(await controller!.getMemoryHistory({ id, limit: 1 }));
      assert.equal(firstHistory.historyCoverage, "complete");
      assert.equal(firstHistory.assertions[0]?.assertionId, corrected.assertion!.assertionId);
      assert.equal(firstHistory.nextOffset, 1);
      const secondHistory = value(await controller!.getMemoryHistory({ id, offset: firstHistory.nextOffset, limit: 1 }));
      assert.equal(secondHistory.revision, firstHistory.revision);
      assert.notEqual(secondHistory.assertions[0]?.assertionId, firstHistory.assertions[0]?.assertionId);
      assert.equal(await readFile(join(workspace, ".runloom/memory.json"), "utf8"), historyBytes);
      check("correct-knownAt", "old system knowledge differs from corrected knowledge; valid time preserved; manual edit provenance");
      const stale = { id, expectedRevision: corrected.revision!, operation: "metadata" as const, pinned: true };
      value(await controller!.previewMemoryAction(stale));
      memory = (await apply({ id, expectedRevision: corrected.revision!, operation: "retract" }))!;
      assert.equal((await controller!.applyMemoryAction(stale)).ok, false, "stale preview cannot overwrite newer revision");
      assert.equal(await eligible(id), false);
      assert.equal(value(await controller!.queryMemory({ id })).assertions.length, 0);
      memory = (await apply({ id, expectedRevision: memory.revision!, operation: "restore", targetAssertionId: corrected.assertion!.assertionId }))!;
      assert.equal(memory.text, CORRECTED); assert.notEqual(memory.assertion!.assertionId, corrected.assertion!.assertionId);
      assert.ok(memory.assertion!.validTime.from);
      assert.equal(memory.pinned, false, "old pinned preview was never applied");
      check("retract-restore-CAS", "withdrawal suppresses recall; restore creates new revision/assertion; stale preview rejected");
      memory = (await apply({ id, expectedRevision: memory.revision!, operation: "metadata", status: "disabled" }))!;
      assert.equal(await eligible(id), false);
      assert.equal((await controller!.previewMemoryAction({ id, expectedRevision: memory.revision!, operation: "restore", targetAssertionId: corrected.assertion!.assertionId })).ok, false, "disabled restoration requires explicit status choice");
      const disabled = await run("disabled-not-revived", "只检查本轮 Current Memory reference：如果没有选中复盘写作记忆，回复 NO_ACTIVE。不要用旧对话或历史摘要冒充本轮注入，不调用工具。");
      assert.equal(disabled.reference?.selected.some(item => item.id === id), false);
      assert.match(disabled.result.text, /NO_ACTIVE/);
      memory = (await apply({ id, expectedRevision: memory.revision!, operation: "restore", targetAssertionId: corrected.assertion!.assertionId, status: "active" }))!;
      memory = (await apply({ id, expectedRevision: memory.revision!, operation: "metadata", expiresAt: new Date(Date.now() - 1000).toISOString() }))!;
      assert.equal(await eligible(id), false);
      assert.equal((await controller!.previewMemoryAction({ id, expectedRevision: memory.revision!, operation: "restore", targetAssertionId: corrected.assertion!.assertionId })).ok, false, "expired restoration requires explicit expiry choice");
      memory = (await apply({ id, expectedRevision: memory.revision!, operation: "restore", targetAssertionId: corrected.assertion!.assertionId, status: "active", expiresAt: null }))!;
      assert.equal(await eligible(id), true);
      assert.equal(value(await controller!.getMemoryMaintenance()).expired, 0);
      check("disable-expiry", "disabled/expired memories excluded; explicit restore choices required; only content/status/expiry mutated");
      assert.equal(await apply({ id, expectedRevision: memory.revision!, operation: "delete" }), null);
      const finalDisk = JSON.parse(await readFile(join(workspace, ".runloom/memory.json"), "utf8"));
      assert.ok(!finalDisk.entries.some((entry: { id: string }) => entry.id === id));
      assert.ok(!finalDisk.candidates.some((entry: { id: string }) => entry.id === resume.candidateId));
      assert.equal((await controller!.previewMemoryAction({ id, expectedRevision: memory.revision!, operation: "restore", targetAssertionId: resume.originalAssertionId, status: "active" })).ok, false);
      const deleted = await run("deleted-not-revived", "只检查本轮 Current Memory reference：如果没有选中复盘写作记忆，回复 NO_ACTIVE。旧对话里可能有已删除的记忆 ID，不要当成本轮引用，不调用工具。");
      assert.equal(deleted.reference?.selected.some(item => item.id === id), false);
      assert.match(deleted.result.text, /NO_ACTIVE/);
      assert.ok(approvals.every(item => item.decision === "deny"));
      check("permanent-delete", "actual memory file omits logical record/history/related candidate; deleted content not revived in later model input");
    }
    assert.equal(hash(await readFile(configPath, "utf8")), hash(configText));
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    await controller?.shutdown();
    await writeFile(join(root, `${stage}-inputs.json`), JSON.stringify(captures, null, 2));
    await writeFile(join(root, `${stage}-report.json`), JSON.stringify({ stage, pid: process.pid, configHash: hash(configText), model: configured.modelAlias, passed: failure === null, failure, checks, runs, controls, approvals, electronAcceptance: "not_run", restoredToolAuthorizationProbe: "not_run" }, null, 2));
  }
  if (failure) throw new Error(failure);
}

async function startChild(root: string, stage: Stage) {
  await new Promise<void>((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [fileURLToPath(import.meta.url), "--child", root, stage], { env: globalThis.process.env, stdio: "inherit" });
    const timeout = setTimeout(() => process.kill("SIGTERM"), 8 * 60_000);
    process.once("error", error => { clearTimeout(timeout); reject(error); });
    process.once("exit", (code, signal) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${stage} exited ${code ?? signal}`)); });
  });
}

export async function runTemporalMemoryAcceptance() {
  if (process.env.RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE !== "1" || !["command-code", "deepseek", "minimax-m3"].includes(process.env.RUNLOOM_MODEL ?? "")) {
    throw new Error("Live opt-in required: RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE=1 RUNLOOM_MODEL=command-code (or deepseek / minimax-m3)");
  }
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-temporal-live-"));
  await mkdir(join(root, "workspace"));
  const config = JSON.stringify({ version: 1, workspace: join(root, "workspace"), modules: { memory: { enabled: true, autoConsolidate: true } }, run: { totalTimeoutMs: 180000 } }, null, 2);
  await writeFile(join(root, "config.json"), config);
  process.stdout.write(`Evidence directory: ${root}\n`);
  let failure: string | null = null;
  try {
    await startChild(root, "before");
    await startChild(root, "after");
    const before = JSON.parse(await readFile(join(root, "before-report.json"), "utf8"));
    const after = JSON.parse(await readFile(join(root, "after-report.json"), "utf8"));
    assert.ok(before.passed && after.passed);
    assert.equal(before.configHash, after.configHash); assert.equal(after.configHash, hash(config));
    assert.notEqual(before.pid, after.pid);
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const report = { root, passed: failure === null, failure, configHash: hash(config), evidence: "real model; source-backed candidate; explicit programmatic Controller reviews; two independent child processes", electronAcceptance: "not_run", restoredToolAuthorizationProbe: "not_run", wholePhaseAccepted: false };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--child") {
    if (process.env.RUNLOOM_MEMORY_TEMPORAL_ACCEPTANCE !== "1" || !["before", "after"].includes(process.argv[4] ?? "") || !process.argv[3]) throw new Error("Invalid or unauthorized acceptance child");
    await child(process.argv[3], process.argv[4] as Stage);
  } else {
    const result = await runTemporalMemoryAcceptance();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  }
}
