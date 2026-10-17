/** Explicit opt-in backend evidence. This is not an Electron/TUI UI test. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { wrapLanguageModel } from "ai";
import { createRuntimeApp, type RuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import { createMemoryStore } from "./memory-store.js";
import { retrieveMemories } from "./memory-retrieval.js";
import { JsonlAgentStore } from "@serika/core";
import { createTaskWorkerAgent } from "./task-worker-entry.js";
import { createTaskStore } from "./task-store.js";
import { runTaskWorker } from "./task-worker.js";
import { createTaskWorkerContextLoader } from "./task-worker-context.js";

interface Check { id: string; status: "passed" | "failed" | "not_run"; note: string }

export async function runNativeMemoryAcceptance(): Promise<{ root: string; passed: boolean }> {
  if (process.env.RUNLOOM_MEMORY_ACCEPTANCE !== "1" || !["deepseek", "minimax-m3", "command-code"].includes(process.env.RUNLOOM_MODEL ?? "")) {
    throw new Error("Explicit live opt-in required: RUNLOOM_MEMORY_ACCEPTANCE=1 RUNLOOM_MODEL=deepseek (or minimax-m3 / command-code)");
  }
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-native-live-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const configured = configureCliModel(createDemoModel);
  if (typeof configured.model === "string") throw new Error("Acceptance requires a configured provider model");
  const captures: Array<{ phase: string; prompt: unknown }> = [];
  let phase = "";
  const model = wrapLanguageModel({ model: configured.model, middleware: { specificationVersion: "v3", transformParams: async ({ params }) => {
    captures.push({ phase, prompt: params.prompt }); return params;
  } } });
  const checks: Check[] = [];
  const results: Array<{ phase: string; runId: string; status: string; text: string; error?: { code: string; message: string } }> = [];
  let controller: AssistantController | undefined;
  let app: RuntimeApp | undefined;
  const budget = { enabled: true, contextWindowTokens: 24000, maxOutputTokens: 1024, safetyMarginTokens: 512, keepRecentTokens: 1500, summaryMaxOutputTokens: 2048 };
  async function open(thread: string, automatic: boolean) {
    if (controller) await controller.shutdown();
    const configPath = join(root, `${thread}-${automatic ? "auto" : "manual"}.json`);
    await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: automatic } }, contextCompaction: budget }));
    const output = new PassThrough();
    output.on("data", (chunk: Buffer) => controller?.recordOutput(chunk.toString()));
    app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", configPath], modelAlias: configured.modelAlias, model, output, env: process.env, cwd: root });
    controller = createAssistantController(app);
    controller.subscribe((event) => {
      if (event.type === "approval") {
        // The operator opts into only this fixture's explicit update. No implicit active write approval.
        controller!.confirm({ approvalId: event.approval.approvalId, decision: phase === "update" && event.approval.toolName === "memory_update" ? "allow" : "deny" });
      }
    });
  }
  async function run(label: string, text: string) {
    phase = label;
    const done = new Promise<void>((resolve) => {
      const unsubscribe = controller!.subscribe((event) => {
        if (event.type === "state" && event.state.kind === "idle") { unsubscribe(); resolve(); }
      });
    });
    const started = await controller!.run(text); assert.ok(started.ok);
    await done;
    const result = controller!.getSnapshot().lastPrimaryResult; assert.ok(result);
    results.push({ phase: label, runId: result.runId, status: result.status, text: result.text,
      ...(result.error ? { error: { code: result.error.code, message: result.error.message } } : {}) });
    assert.equal(result.status, "completed", JSON.stringify(result.error ?? { status: result.status })); return result;
  }
  function check(id: string, note: string) { checks.push({ id, status: "passed", note }); }
  function actualMemory(label: string): Array<{ id: string; revision: number; text: string }> {
    const found: Array<{ id: string; revision: number; text: string }> = [];
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      if ("text" in value && typeof value.text === "string" && value.text.startsWith("Current Memory reference:")) {
        const start = value.text.indexOf("\n[");
        if (start >= 0) found.push(...JSON.parse(value.text.slice(start + 1)));
      }
      for (const child of Object.values(value)) visit(child);
    };
    for (const capture of captures.filter((item) => item.phase === label)) visit(capture.prompt);
    return found;
  }
  let failure: string | undefined;
  try {
    await open("source-a", true);
    await run("propose", "我的长期复盘写作偏好是：先给一行结论，再列两条可执行步骤。我的长期代码审查偏好是：先列风险，再列改进建议。这两条可以自动提出待审候选，但本轮不得写入正式记忆。只回复收到，不要调用主任务工具。");
    const empty = await app!.memoryStore!.list(); assert.ok(empty.ok); assert.equal(empty.entries.length, 0);
    let page = await controller!.listMemoryCandidates(); assert.ok(page.ok);
    assert.ok(page.value.candidates.length >= 2, "real extractor must propose both fixture facts");
    const writing = page.value.candidates.find((candidate) => candidate.change.text.includes("复盘")); assert.ok(writing);
    const other = page.value.candidates.find((candidate) => candidate.id !== writing.id); assert.ok(other);
    check("candidate", `entries empty; candidates ${page.value.candidates.map((c) => c.id).join(", ")}`);
    await open("source-a", false);
    page = await controller!.listMemoryCandidates(); assert.ok(page.ok); assert.ok(page.value.candidates.some((c) => c.id === writing.id));
    assert.ok((await controller!.resolveMemoryCandidate({ candidateId: other.id, expectedCandidateRevision: 1, decision: "reject" })).ok);
    const accepted = await controller!.resolveMemoryCandidate({ candidateId: writing.id, expectedCandidateRevision: 1, decision: "accept" }); assert.ok(accepted.ok);
    const replayed = await controller!.resolveMemoryCandidate({ candidateId: writing.id, expectedCandidateRevision: 1, decision: "accept" }); assert.ok(replayed.ok); assert.equal(replayed.value.replayed, true);
    const memoryId = accepted.value.memoryId!;
    check("restart-review", `reopened, rejected ${other.id}, accepted ${writing.id} -> ${memoryId}, replay no duplicate`);
    await open("question-b", false);
    const answer = await run("cross-thread", "我的复盘写作偏好是什么？引用记忆 ID，不要调用工具。");
    assert.ok(actualMemory("cross-thread").some((entry) => entry.id === memoryId && entry.revision === 1));
    assert.match(answer.text, /结论/); assert.match(answer.text, /两条|两步|2/);
    check("cross-thread", `${memoryId} revision 1 actually injected; model answered preference`);
    const changeQuote = "我的长期复盘写作偏好现在改为：先给一行结论，再列三条可执行步骤。";
    await run("declare-update", `${changeQuote}本轮只回复收到，不调用工具，下一轮我会确认更新。`);
    const committed = await app!.store.getMessages(app!.threadId);
    const changeMessage = committed.find((message) => message.role === "user" && message.parts.some((part) => part.type === "text" && part.text.includes(changeQuote)));
    assert.ok(changeMessage);
    await run("update", `我确认将复盘偏好由两条改为三条。请立即调用 memory_update 修改 ${memoryId}，expectedRevision 为 1，新文本是“用户长期复盘写作偏好：先给一行结论，再列三条可执行步骤。”。来源 sourceMessageId 为 ${changeMessage.id}，sourceQuote 精确使用“${changeQuote}”。这是明确更新授权，等待工具确认。`);
    const updated = await app!.memoryStore!.get(memoryId); assert.ok(updated.ok); assert.equal(updated.entry.revision, 2);
    assert.match(updated.entry.text, /三条/);
    await run("updated-answer", "我的复盘写作偏好是什么？不要调用工具，旧对话中的两条步骤不代表当前偏好。");
    assert.ok(actualMemory("updated-answer").some((entry) => entry.id === memoryId && entry.revision === 2));
    check("update", `${memoryId} revision 2 actually injected`);
    // Real ordinary turns supply meaningful compaction material, not a fabricated summary record.
    for (let index = 0; index < 3; index++) await run(`context-${index}`, `复盘写作验收约束 ${index + 1}：每个可执行步骤必须包括行动、检查方式和结束条件。参考用户偏好，解释如何写一个清晰的复盘步骤，约200字，不保存记忆、不调用工具。`);
    phase = "compact";
    const compacted = await controller!.command("/compact"); assert.ok(compacted.ok, JSON.stringify(compacted));
    const records = await app!.store.getContextCompactions(app!.threadId); assert.ok(records.length > 0);
    await open("question-b", false);
    const restored = await run("restored", "我的复盘写作偏好是什么？只按当前记忆回答，不要调用工具。旧对话可能还写着两条。");
    assert.ok(actualMemory("restored").some((entry) => entry.id === memoryId && entry.revision === 2));
    assert.match(restored.text, /三条|三步|3/);
    check("compact-restart", `compaction records ${records.length}; restored current revision 2, answered three steps`);
    const disabled = await app!.memoryStore!.update(memoryId, { expectedRevision: 2, enabled: false }); assert.ok(disabled.ok);
    const noMatch = await run("disabled", "本轮实际注入的复盘写作记忆有哪些？只看本轮的Current Memory reference，若selected entries为空只回复NO_MATCH。不要查询工具，不把旧对话里的ID或active当作本轮注入。");
    assert.equal(actualMemory("disabled").some((entry) => entry.id === memoryId), false);
    assert.match(noMatch.text, /NO_MATCH/);
    assert.doesNotMatch(noMatch.text, new RegExp(memoryId));
    check("disabled", "disabled entry absent from provider reference; real answer NO_MATCH instead of reviving old active claim");
    const storage = createMemoryStore(workspace);
    for (let index = 0; index < 10; index++) assert.ok((await storage.add({ text: `worker验收 ${index}：${"约束".repeat(250)}` })).ok);
    const listed = await storage.list(); assert.ok(listed.ok);
    const selected = retrieveMemories(listed.entries, { query: "worker验收", now: new Date() });
    assert.ok(selected.truncated); assert.ok(selected.bytes <= 8192);
    check("storage-budget", `eligible ${selected.eligibleCount}, selected ${selected.entries.length}, bytes ${selected.bytes}; actual worker execution still separate evidence`);
    assert.ok((await storage.add({ text: "worker验收私有标记NEVER_INJECT", scope: { kind: "thread", threadId: "source-a" } })).ok);
    let clock = Date.now();
    const tasks = createTaskStore(workspace, { now: () => clock });
    const scheduled = await tasks.create({ prompt: "worker验收：按本次所选正式记忆给一句约束概括，引用一条记忆ID；没有checkpoint就直说。不要查询工具。", runAt: new Date(clock + 1000).toISOString() }); assert.ok(scheduled.ok);
    clock += 2000;
    const worker = createTaskWorkerAgent({ modelAlias: configured.modelAlias, model, workspaceContext: true, store: new JsonlAgentStore({ directory: join(root, "worker-transcripts") }) });
    const stop = new AbortController();
    const timeout = setTimeout(() => stop.abort(new Error("Worker acceptance timeout")), 120000);
    let snapshotBytes = 0;
    phase = "worker";
    const load = createTaskWorkerContextLoader(workspace, tasks);
    try {
      await runTaskWorker({ store: tasks, runtime: worker.runtime, signal: stop.signal, pollIntervalMs: 10,
        loadWorkspaceContext: async (task, signal) => {
          const snapshot = await load(task, signal);
          const reference = snapshot.referenceMessages.find((message) => message.id === "runloom-workspace-memory"); assert.ok(reference);
          snapshotBytes = Buffer.byteLength(JSON.stringify(reference)); assert.ok(snapshotBytes <= 8192);
          assert.doesNotMatch(JSON.stringify(snapshot), /NEVER_INJECT/);
          return snapshot;
        },
        onTaskFinished: () => stop.abort("fixture delivered"),
      });
    } finally { clearTimeout(timeout); worker.dispose(); }
    const delivered = await tasks.get(scheduled.value.id); assert.ok(delivered.ok); assert.equal(delivered.value.status, "completed");
    const workerEntries = actualMemory("worker"); assert.ok(workerEntries.length > 0);
    assert.ok(workerEntries.every((entry) => !entry.text.includes("NEVER_INJECT")));
    assert.ok(workerEntries.some((entry) => delivered.value.resultText?.includes(entry.id)));
    check("worker", `task ${scheduled.value.id}, completed, run ${delivered.value.runId}, fixed selected reference ${snapshotBytes} bytes; notification not tested`);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    checks.push({ id: phase || "setup", status: "failed", note: failure });
  } finally { await controller?.shutdown(); }
  const passed = failure === undefined;
  await writeFile(join(root, "report.json"), JSON.stringify({ startedModel: configured.modelAlias, execution: "real-model backend Controller + worker (not Electron/TUI UI)", passed, checks, results, failure: failure ?? null, uiAcceptance: "not_run", fullWorkerExecution: checks.some((check) => check.id === "worker") ? "passed" : "not_run", notificationDelivery: "not_run" }, null, 2));
  await writeFile(join(root, "provider-inputs.json"), JSON.stringify(captures, null, 2));
  return { root, passed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runNativeMemoryAcceptance();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}
