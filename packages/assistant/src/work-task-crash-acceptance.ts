import { dirname } from "node:path";
/** Fixed process-crash fixture. No production hooks, new tools or replay policy. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { simulateReadableStream, wrapLanguageModel, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { createDemoModel } from "./demo-model.js";
import { configureCliModel } from "./model-config.js";
import { createExecutionRecordStore, ExecutionRecordError } from "./execution-record-store.js";
import { createWorkTaskStore, type WorkTaskResult } from "./work-task-store.js";

export const CRASH_SCENARIOS = ["before-dispatch", "unrecorded-write", "recorded-write"] as const;
type Scenario = typeof CRASH_SCENARIOS[number];
type ModelMode = "real" | "scripted";
const THREAD = "process-crash-fixture";
const ARTIFACT = "notes/crash-note.md";
const SENTINEL = "protected/sentinel.txt";
const CONTENT = "# Crash fixture\n\n<!-- continue-here -->\n";
const RESUMED = "RESUMED_AFTER_REVIEW\n";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const save = (root: string, name: string, value: unknown) => writeFile(join(root, name), JSON.stringify(value, null, 2), { flag: "wx" });
const value = <T>(result: WorkTaskResult<T>): T => { assert.ok(result.ok, JSON.stringify(result)); return result.value; };

export function crashFixtureAllows(toolName: string, input: unknown, continuing: boolean): boolean {
  if (input === null || typeof input !== "object" || !("path" in input) || input.path !== ARTIFACT) return false;
  return continuing ? ["read_file", "edit_file"].includes(toolName) : toolName === "write_file";
}

export async function verifyCrashArtifactAbsent(workspace: string) {
  // lstat also rejects a dangling symlink; ENOENT from reading its target is not absence.
  await assert.rejects(lstat(join(workspace, ARTIFACT)), { code: "ENOENT" },
    "The undispatched write must not create an artifact during recovery");
  return { path: ARTIFACT, exists: false, checkedWith: "lstat" } as const;
}

/** Fixture-only barrier; pending UI notification is not a receipt-write acknowledgement. */
export async function gateAfterApprovalReceipt(receipt: Promise<void>, gate: () => Promise<void>) {
  await receipt;
  await gate();
}

function scriptedModel(recovering: boolean): LanguageModel {
  let step = 0;
  const calls = recovering ? [
    { name: "read_file", input: { path: ARTIFACT } },
    { name: "edit_file", input: { path: ARTIFACT, oldText: "<!-- continue-here -->\n", newText: RESUMED + "<!-- continue-here -->\n" } },
    { name: "read_file", input: { path: ARTIFACT } },
  ] : [{ name: "write_file", input: { path: ARTIFACT, content: CONTENT } }];
  return new MockLanguageModelV3({ doStream: async () => {
    const call = calls[step++];
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      ...(call ? [{ type: "tool-call" as const, toolCallId: `fixture-${step}`, toolName: call.name, input: JSON.stringify(call.input) }]
        : [{ type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "Saved and read back; human quality not accepted." }, { type: "text-end" as const, id: "answer" }]),
      { type: "finish" as const, finishReason: { unified: call ? "tool-calls" as const : "stop" as const, raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined } } },
    ] }) };
  } });
}

async function child(root: string, scenario: Scenario, mode: ModelMode, recovering: boolean) {
  assert.ok(process.send, "Private fixture children require IPC from the supervisor");
  const configPath = join(root, "config.json"), configBytes = await readFile(configPath);
  const config = JSON.parse(configBytes.toString());
  const configured = mode === "real" ? configureCliModel(createDemoModel)
    : { modelAlias: "scripted-fixture", model: scriptedModel(recovering) };
  assert.notEqual(typeof configured.model, "string");
  let modelRequests = 0;
  const prompts: unknown[] = [];
  const model = wrapLanguageModel({ model: configured.model as Exclude<LanguageModel, string>, middleware: {
    specificationVersion: "v3", transformParams: async ({ params }) => { prompts.push(params.prompt); return params; },
    wrapStream: async ({ doStream }) => { modelRequests++; return doStream(); },
  } });
  const output = new PassThrough();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(dirname(configPath), "workspace/.runloom"), threadId: THREAD, configPath },
    modelAlias: configured.modelAlias, model, env: process.env, output, cwd: root });
  let approvalReceipt = Promise.resolve();
  if (!recovering && scenario === "before-dispatch") {
    const recordApproval = app.executionRecords.recordApprovalRequested.bind(app.executionRecords);
    app.executionRecords.recordApprovalRequested = (...args) => {
      approvalReceipt = recordApproval(...args);
      return approvalReceipt;
    };
  }
  const controller = createAssistantController(app);
  output.on("data", (chunk: Buffer) => controller.recordOutput(chunk.toString()));
  const approvals: Array<{ id: string; toolName: string; decision: string; effective: boolean }> = [];
  let taskId = "", gateSent = false;
  async function gate(runId: string) {
    assert.ok(!gateSent); gateSent = true;
    const task = value(await controller.workTasks.get(taskId));
    const receipt = await controller.runs.get(runId); assert.ok(receipt);
    const disk = await readFile(join(config.authorizedDirectories[0].path, ARTIFACT)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null; throw error;
    });
    assert.equal(task.status, "running"); assert.equal(receipt.status, "running");
    assert.equal(receipt.workTaskId, taskId);
    assert.equal(receipt.tools.length, 1);
    assert.equal(receipt.tools[0]!.status, scenario === "before-dispatch" ? "requested" : scenario === "unrecorded-write" ? "started" : "completed");
    if (scenario === "before-dispatch") {
      assert.equal(disk, null);
      assert.ok(receipt.tools[0]!.approvalRequestedAt, "Approval receipt must be persisted before supervisor readiness");
    }
    else assert.equal(disk?.toString(), CONTENT);
    if (scenario === "recorded-write") assert.deepEqual(receipt.tools[0]!.fileWrite,
      { path: ARTIFACT, bytes: Buffer.byteLength(CONTENT), sha256: sha(CONTENT) });
    else assert.equal(receipt.tools[0]!.fileWrite, undefined);
    await save(root, "crash-boundary.json", { pid: process.pid, scenario, mode, configHash: sha(configBytes), task, receipt,
      diskHash: disk === null ? null : sha(disk), modelRequests, approvals, prompts,
      fault: "Fixture-only receipt boundary pause; production file tool actually executes. Supervisor will SIGKILL, not shutdown." });
    process.send!({ type: "gate", runId, taskId });
  }
  if (!recovering) {
    const record = app.executionRecords.recordToolEvent.bind(app.executionRecords);
    app.executionRecords.recordToolEvent = async (runId, event) => {
      if (event.type === "tool.call.completed" && event.data.toolName === "write_file" && scenario !== "before-dispatch") {
        assert.equal(await readFile(join(config.authorizedDirectories[0].path, ARTIFACT), "utf8"), CONTENT);
        assert.ok(event.data.output && typeof event.data.output === "object" && "ok" in event.data.output && event.data.output.ok === true);
        if (scenario === "recorded-write") await record(runId, event);
        await gate(runId);
        await new Promise<void>(() => {}); // Deliberately never acknowledge before the targeted kill.
        return;
      }
      await record(runId, event);
    };
  }
  const seen = new Set<string>();
  controller.subscribe((event) => {
    if (event.type !== "approval" || !event.approval.preview.trim() || seen.has(event.approval.approvalId)) return;
    const approval = event.approval; seen.add(approval.approvalId);
    if (!recovering && scenario === "before-dispatch" && crashFixtureAllows(approval.toolName, approval.input, false)) {
      const state = controller.getSnapshot().state; assert.ok(state.kind === "running" && state.runId !== null);
      const runId = state.runId;
      void gateAfterApprovalReceipt(approvalReceipt, () => gate(runId)).catch((error) => { process.stderr.write(String(error)); process.exit(1); });
      return; // Kill while the original per-call confirmation is still pending.
    }
    const decision = crashFixtureAllows(approval.toolName, approval.input, recovering) ? "allow" : "deny";
    const effective = controller.confirm({ approvalId: approval.approvalId, decision });
    approvals.push({ id: approval.approvalId, toolName: approval.toolName, decision, effective });
  });
  async function run(id: string, revision: number, instruction: string) {
    let off = () => {};
    const idle = new Promise<void>((resolve) => { off = controller.subscribe((e) => { if (e.type === "state" && e.state.kind === "idle") resolve(); }); });
    try { assert.ok((await controller.workTasks.run({ id, expectedRevision: revision, instruction })).ok); await idle; }
    finally { off(); }
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
  }
  try {
    if (!recovering) {
      const task = value(await controller.workTasks.create({ goal: "Save the isolated crash note; continue only after explicit effect reconciliation.",
        constraints: [`Only ${ARTIFACT}; no Shell, network or other files; task quality stays pending.`],
        acceptance: [
          { id: "artifact", description: "Latest owned Run saved the current file", method: "automatic", required: true,
            verification: { kind: "artifact_exists", path: ARTIFACT } },
          { id: "quality", description: "User reviews quality", method: "human", required: true, verification: { kind: "human" } },
        ] }));
      taskId = task.id;
      await run(task.id, task.revision, `立即且只调用一次 write_file，新建 ${ARTIFACT}，content 必须精确等于这个 JSON 字符串的值：${JSON.stringify(CONTENT)}。不要调用其他工具或先解释，不要自己验收。`);
      throw new Error("Expected supervisor SIGKILL at the fixed boundary, but Run finished");
    }
    const boundary = JSON.parse(await readFile(join(root, "crash-boundary.json"), "utf8"));
    taskId = boundary.task.id;
    let task = value(await controller.workTasks.get(taskId));
    const recovered = await controller.runs.get(boundary.receipt.runId); assert.ok(recovered);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.tools[0]!.status, scenario === "before-dispatch" ? "not_started" : scenario === "unrecorded-write" ? "unknown" : "completed");
    assert.equal(task.status, scenario === "unrecorded-write" ? "needs_review" : "paused");
    assert.deepEqual(task.runIds, boundary.task.runIds);
    assert.equal(controller.getSnapshot().pendingApproval, null);
    assert.equal(modelRequests, 0); assert.equal(approvals.length, 0);
    assert.deepEqual(await controller.getHistory(), [], "killed incomplete Run must not appear as committed success");
    const recoveredArtifactAbsence = scenario === "before-dispatch" ? await verifyCrashArtifactAbsent(config.authorizedDirectories[0].path) : null;
    await save(root, "recovered-state.json", { pid: process.pid, task, receipt: recovered, modelRequests, approvals,
      configHash: sha(configBytes), artifactAbsence: recoveredArtifactAbsence });
    if (scenario === "unrecorded-write") {
      assert.equal((await controller.workTasks.run({ id: task.id, expectedRevision: task.revision })).ok, false);
      assert.equal((await controller.workTasks.cancel({ id: task.id, expectedRevision: task.revision })).ok, false);
      const refused = await controller.workTasks.reconcile({ id: task.id, expectedRevision: task.revision,
        observedOutcome: "still_unknown", decision: "continue", note: "Fixture negative control: effect remains unknown." });
      assert.equal(refused.ok, false); assert.deepEqual(value(await controller.workTasks.get(taskId)), task);
      assert.equal(await readFile(join(config.authorizedDirectories[0].path, ARTIFACT), "utf8"), CONTENT);
      task = value(await controller.workTasks.reconcile({ id: task.id, expectedRevision: task.revision,
        observedOutcome: "applied", decision: "continue", note: "Fixture operator checked exact isolated disk bytes. Programmatic test of human-report API; not acceptance evidence or a real user GUI review." }));
      assert.equal(task.status, "paused"); assert.equal(modelRequests, 0);
      assert.equal((await controller.runs.get(recovered.runId))?.tools[0]?.status, "unknown", "human report must not repair the unknown receipt");
    }
    task = value(await controller.workTasks.submitDelivery({ id: task.id, expectedRevision: task.revision,
      summary: "Negative control: interrupted Run is not automatic acceptance evidence.", artifactRefs: [ARTIFACT] }));
    assert.equal(task.acceptance.find((c) => c.id === "artifact")!.status, "blocked");
    assert.equal(task.acceptance.find((c) => c.id === "quality")!.status, "not_run");
    assert.deepEqual(task.delivery!.evidence, []); assert.equal(modelRequests, 0);
    await save(root, "blocked-acceptance.json", task);
    task = value(await controller.workTasks.requestChanges({ id: task.id, expectedRevision: task.revision }));
    assert.equal(task.status, "paused"); assert.equal(modelRequests, 0);
    if (scenario === "unrecorded-write") {
      await run(task.id, task.revision, `这是人工核对报告之后显式开的新 Run。不要重放旧 write_file。先 read_file ${ARTIFACT} 核对当前磁盘，然后 edit_file 在唯一的 <!-- continue-here --> 标记前追加一行 RESUMED_AFTER_REVIEW，保留其余原文，最后 read_file 核对。只用 path/oldText/newText 参数。质量不得自己接受。`);
      task = value(await controller.workTasks.get(taskId)); assert.equal(task.status, "awaiting_acceptance");
      const latest = await controller.runs.get(task.runIds.at(-1)!); assert.ok(latest);
      assert.notEqual(latest.runId, recovered.runId); assert.equal(latest.workTaskId, taskId);
      assert.ok(latest.tools.every((tool) => tool.status !== "unknown" && tool.toolName !== "write_file"));
      assert.deepEqual(latest.tools.map((tool) => tool.toolName), ["read_file", "edit_file", "read_file"]);
      for (const tool of latest.tools) {
        assert.equal(tool.status, "completed"); assert.equal(tool.resultTruncated, false);
        const output = JSON.parse(tool.resultPreview!);
        assert.equal(output.ok, true); assert.equal(output.path, ARTIFACT);
      }
      assert.equal(JSON.parse(latest.tools[0]!.resultPreview!).content, CONTENT);
      assert.equal(approvals.length, 3); assert.ok(approvals.every((a) => a.decision === "allow" && a.effective));
      const disk = await readFile(join(config.authorizedDirectories[0].path, ARTIFACT));
      assert.equal(disk.toString(), CONTENT.replace("<!-- continue-here -->\n", RESUMED + "<!-- continue-here -->\n"));
      assert.equal(JSON.parse(latest.tools[2]!.resultPreview!).content, disk.toString());
      task = value(await controller.workTasks.submitDelivery({ id: task.id, expectedRevision: task.revision,
        summary: "Explicit new Run read, edited and read back current disk; quality still not accepted.", artifactRefs: [ARTIFACT] }));
      assert.equal(task.status, "awaiting_acceptance"); assert.equal(task.acceptance.find((c) => c.id === "artifact")!.status, "passed");
      assert.equal(task.acceptance.find((c) => c.id === "quality")!.status, "not_run");
      const delivered = value(await controller.workTasks.get(taskId));
      assert.ok(delivered.delivery!.evidence.length === 1 && delivered.delivery!.evidence.every((e) => e.kind === "artifact" && e.runId === latest.runId));
      assert.equal(latest.tools[1]!.fileWrite!.sha256, sha(disk));
      assert.equal((await controller.runs.get(recovered.runId))?.tools[0]?.status, "unknown");
    }
    assert.equal(await readFile(join(config.authorizedDirectories[0].path, SENTINEL), "utf8"), "DO_NOT_MODIFY\n");
    assert.equal(sha(await readFile(configPath)), sha(configBytes));
    const finalArtifactAbsence = scenario === "before-dispatch" ? await verifyCrashArtifactAbsent(config.authorizedDirectories[0].path) : null;
    await save(root, "after-report.json", { passed: true, task, oldReceipt: await controller.runs.get(recovered.runId),
      latestReceipt: await controller.runs.get(task.runIds.at(-1)!), modelRequests, approvals, prompts,
      artifactAbsence: finalArtifactAbsence,
      quality: "not_run", reconciliation: "Programmatic fixture operator report, not user acceptance or tool authorization" });
  } finally { await controller.shutdown(); }
}

/** Wait only for the two leases of the fixture child we have just killed. Never evict a holder. */
async function waitForKilledChildLeases(root: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    let workLease, executionLease;
    try {
      workLease = await createWorkTaskStore(join(root, "workspace"), { filePath: join(join(root, "workspace"), ".runloom/work-tasks.json") }).claimThread(THREAD);
      executionLease = await createExecutionRecordStore(join(root, "transcripts")).claimThread(THREAD);
      return;
    } catch (error) {
      const busy = error instanceof Error && "code" in error && error.code === "WORK_TASK_INVALID_STATE" && /already controlled/.test(error.message)
        || error instanceof ExecutionRecordError && error.code === "CONFLICT";
      if (!busy) throw error;
    } finally { await executionLease?.release(); await workLease?.release(); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Killed fixture child's leases did not release; no takeover or replay attempted");
}

async function scenario(root: string, fault: Scenario, mode: ModelMode) {
  await mkdir(join(root, "workspace/notes"), { recursive: true });
  await mkdir(join(root, "workspace/protected"));
  await writeFile(join(root, "workspace", SENTINEL), "DO_NOT_MODIFY\n");
  await save(root, "config.json", { version: 2, authorizedDirectories: [{ path: join(root, "workspace"), access: "readwrite" }], modules: { "read-file": { enabled: true } } });
  async function launch(recovering: boolean) {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", root, fault, mode, recovering ? "recover" : "crash"],
      { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let logs = "";
    for (const stream of [proc.stdout!, proc.stderr!]) stream.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-4096); });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject); proc.once("close", (code, signal) => resolve({ code, signal }));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const gate = new Promise<void>((resolve, reject) => {
        proc.on("message", (message) => { if (message && typeof message === "object" && "type" in message && message.type === "gate") resolve(); });
        closed.then((exit) => recovering && exit.code === 0 ? resolve() : reject(new Error(`Child exited before expected boundary: ${JSON.stringify(exit)} ${logs}`)), reject);
        timer = setTimeout(() => reject(new Error("Fixture child exceeded its boundary timeout")), mode === "real" ? 180_000 : 10_000);
      });
      await gate;
      if (!recovering) {
        // Different transcript directory cannot bypass the workspace/Thread lease.
        const output = new PassThrough();
        let contenderRequests = 0;
        const contenderModel = new MockLanguageModelV3({ doStream: async () => {
          contenderRequests++; throw new Error("Contender must never invoke a model");
        } });
        const app = await createRuntimeApp({ directory: join(root, "contender-transcripts"), assistant: { dataDirectory: join(root, "workspace/.runloom"), threadId: THREAD, configPath: join(root, "config.json") },
          modelAlias: "mock-never-run", model: contenderModel, env: {}, output, cwd: root });
        const contender = createAssistantController(app);
        try {
          const tasks = JSON.parse(await readFile(join(root, "workspace/.runloom/work-tasks.json"), "utf8"));
          const journal = await readFile(join(root, "transcripts/execution-records.json"));
          const blocked = await contender.workTasks.get(tasks.tasks[0].id); assert.equal(blocked.ok, false);
          assert.ok(!blocked.ok && blocked.error.message.includes("already controlled"));
          const stillRunning = JSON.parse(await readFile(join(root, "workspace/.runloom/work-tasks.json"), "utf8"));
          assert.deepEqual(stillRunning, tasks);
          assert.deepEqual(await readFile(join(root, "transcripts/execution-records.json")), journal);
          assert.equal(contenderRequests, 0);
          assert.equal((await app.executionRecords.listRuns(THREAD)).length, 0);
          await save(root, "contender-report.json", { blocked, modelRequests: contenderRequests,
            noRun: (await app.executionRecords.listRuns(THREAD)).length === 0, taskAndJournalUnchanged: true });
        } finally { await contender.shutdown(); }
        assert.ok(proc.kill("SIGKILL"), "only kill the exact fixture child created here");
        const exit = await closed; assert.equal(exit.signal, "SIGKILL");
        await save(root, "process-exit.json", { pid: proc.pid, ...exit });
      } else assert.equal((await closed).code, 0);
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await closed.catch(() => undefined);
      await save(root, recovering ? "recover-log.json" : "crash-log.json", { logs });
    }
  }
  await launch(false);
  await waitForKilledChildLeases(root);
  await launch(true);
  const boundary = JSON.parse(await readFile(join(root, "crash-boundary.json"), "utf8"));
  const recovered = JSON.parse(await readFile(join(root, "recovered-state.json"), "utf8"));
  assert.notEqual(boundary.pid, recovered.pid); assert.equal(boundary.configHash, recovered.configHash);
}

export async function runWorkTaskCrashAcceptance(options: { model?: ModelMode; scenario?: Scenario } = {}) {
  const mode = options.model ?? "real";
  if (options.scenario !== undefined) assert.ok(CRASH_SCENARIOS.includes(options.scenario), "Unknown crash scenario");
  const scenarios = options.scenario === undefined ? CRASH_SCENARIOS : [options.scenario];
  if (mode === "real") {
    assert.equal(process.env.RUNLOOM_WORK_TASK_CRASH_ACCEPTANCE, "1", "Explicit paid-model opt-in required");
    assert.ok(["deepseek", "minimax-m3", "command-code"].includes(process.env.RUNLOOM_MODEL ?? ""));
  }
  assert.ok(["darwin", "linux"].includes(process.platform), "POSIX SIGKILL fixture only");
  const root = await mkdtemp(join(tmpdir(), "runloom-work-task-crash-"));
  process.stdout.write(`Crash evidence directory: ${root}\n`);
  const results: Array<{ scenario: Scenario; passed: boolean; failure: string | null }> = [];
  for (const fault of scenarios) {
    process.stdout.write(`${mode}: ${fault}\n`);
    try { await scenario(join(root, fault), fault, mode); results.push({ scenario: fault, passed: true, failure: null }); }
    catch (error) { results.push({ scenario: fault, passed: false, failure: String(error) }); break; }
  }
  const report = { root, mode, scenarios, passed: results.length === scenarios.length && results.every((result) => result.passed), results,
    evidence: "Real SIGKILL of fixture-owned process; local receipt-boundary fault injection; production Controller/file tools/leases",
    electronAcceptance: "not_run", taskQuality: "not_accepted", retry: "No whole-case retry; original unknown receipt retained" };
  await save(root, "report.json", report);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--child") {
    assert.ok(CRASH_SCENARIOS.includes(process.argv[4] as Scenario));
    assert.ok(process.argv[5] === "real" || process.argv[5] === "scripted");
    assert.ok(process.argv[6] === "crash" || process.argv[6] === "recover");
    if (process.argv[5] === "real") assert.equal(process.env.RUNLOOM_WORK_TASK_CRASH_ACCEPTANCE, "1");
    await child(process.argv[3]!, process.argv[4] as Scenario, process.argv[5], process.argv[6] === "recover");
  } else {
    const scenario = process.argv[2] === "--scenario" ? process.argv[3] as Scenario : undefined;
    assert.ok(process.argv.length === 2 || (process.argv.length === 4 && scenario !== undefined && CRASH_SCENARIOS.includes(scenario)),
      "Usage: work-task-crash-acceptance.js [--scenario before-dispatch|unrecorded-write|recorded-write]");
    const report = await runWorkTaskCrashAcceptance(scenario === undefined ? {} : { scenario });
    process.stdout.write(JSON.stringify(report) + "\n"); if (!report.passed) process.exitCode = 1;
  }
}
