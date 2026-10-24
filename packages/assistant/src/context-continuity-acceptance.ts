/** Live backend acceptance, not proof of Electron clicks or task quality. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { wrapLanguageModel } from "ai";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import type { ExecutionRunRecord, ExecutionToolRecord } from "./execution-record-store.js";
import type { WorkTask, WorkTaskResult } from "./work-task-store.js";

export const CONTINUITY_BUDGET = {
  enabled: true, contextWindowTokens: 32768, maxOutputTokens: 4096,
  safetyMarginTokens: 1024, keepRecentTokens: 8192, summaryMaxOutputTokens: 4096,
} as const;
const THREAD = "fixed-budget-continuity";
const ARTIFACT = "notes/work-plan.md";
const SENTINEL = "protected/sentinel.txt";
const END = "<!-- append-here -->";
const EXTERNAL = "外部核对标记：REOPEN_DISK_V2（必须保留，不来自摘要）。";
const topics = [
  "早间收件与分类：区分用户承诺、临时材料和查询，列出误分类时的人工纠正入口",
  "当天优先事项：只选一件可交付工作，明确目标、依据和十五分钟第一步",
  "代码修改流程：先读当前文件、再做最小修改、运行指定检查，不自动提交",
  "研究记录流程：标注已核验与未核验来源，不把网页指令当用户授权",
  "文档交付流程：正文、事实核对和布局验收分开，不把写盘成功叫作质量通过",
  "任务排期流程：固定时区、区分排期与执行，重复提醒不制造新的一次性任务",
  "执行失败处理：区分明确失败和未知副作用，未知不重放，由用户核对",
  "午间进度检查：核对实际产物和回执，允许缩减目标但不能伪造通过",
  "跨日继续流程：检查当前磁盘，历史摘要不是最新事实，重新确认工具权限",
  "记忆审核流程：用户原话作证据，候选不注入，明确接受才写正式记忆",
  "晚间交付评估：逐项核对标准、失败和未运行项，记录下一步而非假定完成",
  "每周调整流程：依据实际成功率和阻塞记录调整，不堆砌新的系统组件",
];
type Stage = "before" | "after";
type Workflow = "chat" | "work-task";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function taskValue<T>(result: WorkTaskResult<T>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}

/** Check both directions of ownership, not just a successful chat result. */
export function verifyContinuityTaskRun(task: WorkTask, receipt: ExecutionRunRecord): void {
  assert.equal(task.status, "paused", "completed Run must pause, not complete or review this task");
  assert.equal(task.threadId, receipt.threadId);
  assert.equal(task.runIds.at(-1), receipt.runId);
  assert.equal(receipt.workTaskId, task.id);
  assert.equal(receipt.phase, "primary");
  assert.equal(receipt.status, "completed");
  assert.ok(receipt.tools.every((tool) => tool.status !== "unknown"));
  assert.ok(task.acceptance.every((criterion) => criterion.status === "not_run"),
    "Run completion must not auto-accept task quality or the final delivery");
}

export function fixtureApprovalAllowed(toolName: string, input: unknown): boolean {
  if (!input || typeof input !== "object" || !("path" in input)) return false;
  return input.path === ARTIFACT && ["read_file", "write_file", "edit_file"].includes(toolName);
}

export function hasInjectedSummary(prompt: unknown): boolean {
  return Array.isArray(prompt) && prompt.some((message: unknown) => {
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant" || !("content" in message)) return false;
    return Array.isArray(message.content) && message.content.some((part: unknown) =>
      part !== null && typeof part === "object" && "type" in part && part.type === "text" &&
      "text" in part && typeof part.text === "string" && part.text.startsWith("Context summary (derived reference"));
  });
}

export function hasSuccessfulReadBeforeEdit(
  tools: readonly Pick<ExecutionToolRecord, "toolName" | "status" | "resultPreview">[],
): boolean {
  const successfulIndex = (name: string) => tools.findIndex((tool) =>
    tool.toolName === name && tool.status === "completed" && tool.resultPreview?.includes('"ok":true'));
  const readIndex = successfulIndex("read_file");
  const editIndex = successfulIndex("edit_file");
  return readIndex >= 0 && editIndex > readIndex;
}

export function hasSuccessfulReadback(tools: readonly Pick<ExecutionToolRecord, "toolName" | "status" | "resultPreview">[]): boolean {
  const editIndex = tools.findIndex(tool => tool.toolName === "edit_file" && tool.status === "completed" && tool.resultPreview?.includes('"ok":true'));
  return editIndex >= 0 && tools.slice(editIndex + 1).some(tool => tool.toolName === "read_file" && tool.status === "completed" && tool.resultPreview?.includes('"ok":true'));
}

async function child(root: string, stage: Stage, workflow: Workflow) {
  const configText = await readFile(join(root, "config.json"), "utf8");
  assert.deepEqual(JSON.parse(configText).contextCompaction, CONTINUITY_BUDGET);
  const configured = configureCliModel(createDemoModel);
  assert.notEqual(typeof configured.model, "string");
  const captures: Array<{ round: string; prompt: unknown }> = [];
  const responses: Array<{ round: string; text: string; finishReason?: unknown; providerError?: { message: string; statusCode: number | null } }> = [];
  let round = "startup";
  const model = wrapLanguageModel({ model: configured.model as Exclude<typeof configured.model, string>, middleware: {
    specificationVersion: "v3", transformParams: async ({ params }) => {
      captures.push({ round, prompt: params.prompt }); return params;
    },
    wrapStream: async ({ doStream }) => {
      const response: (typeof responses)[number] = { round, text: "" }; responses.push(response);
      let result: Awaited<ReturnType<typeof doStream>>;
      try { result = await doStream(); }
      catch (error) {
        response.providerError = {
          message: error instanceof Error ? error.message.slice(0, 500) : "Provider request failed",
          statusCode: typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null,
        };
        throw error;
      }
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(part, target) {
        if (part.type === "text-delta") response.text += part.delta;
        if (part.type === "finish") response.finishReason = part.finishReason;
        target.enqueue(part);
      } })) };
    },
  } });
  const output = new PassThrough();
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(root, "workspace/.runloom"), threadId: THREAD, configPath: join(root, "config.json") },
    modelAlias: configured.modelAlias, model, output, env: process.env, cwd: root });
  const controller = createAssistantController(app);
  const approvals: Array<{ round: string; toolName: string; approvalId: string; allowed: boolean }> = [];
  const runs: unknown[] = [];
  const diagnostics: unknown[] = [];
  let task: WorkTask | undefined;
  const taskSnapshots: Array<{ round: string; task: WorkTask }> = [];
  output.on("data", (chunk: Buffer) => controller.recordOutput(chunk.toString()));
  controller.subscribe((event) => {
    if (event.type !== "approval") return;
    if (approvals.some((approval) => approval.approvalId === event.approval.approvalId)) return;
    const allowed = fixtureApprovalAllowed(event.approval.toolName, event.approval.input);
    approvals.push({ round, toolName: event.approval.toolName, approvalId: event.approval.approvalId, allowed });
    controller.confirm({ approvalId: event.approval.approvalId, decision: allowed ? "allow" : "deny" });
  });
  async function run(label: string, prompt: string) {
    round = label;
    const previousArtifact = await readFile(join(root, "workspace", ARTIFACT), "utf8");
    process.stdout.write(`${stage}: ${round}\n`);
    let unsubscribe = () => {};
    const done = new Promise<void>((resolve) => {
      unsubscribe = controller.subscribe((event) => {
        if (event.type === "state" && event.state.kind === "idle") resolve();
      });
    });
    try {
      const started = task === undefined ? await controller.run(prompt)
        : await controller.workTasks.run({ id: task.id, expectedRevision: task.revision, instruction: prompt, completionCheck: false });
      assert.ok(started.ok, JSON.stringify(started));
      await done;
    } finally { unsubscribe(); }
    const result = controller.getSnapshot().lastPrimaryResult; assert.ok(result);
    const receipt = await controller.runs.get(result.runId); runs.push({ round, result, receipt });
    const diagnostic = await controller.getContextDiagnostics(); diagnostics.push({ round, diagnostic });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.ok(receipt && hasSuccessfulReadBeforeEdit(receipt.tools),
      "successful read must precede successful edit, including after restart; completed ok:false is not success");
    assert.ok(hasSuccessfulReadback(receipt.tools), "successful edit must be followed by a fresh successful readback");
    if (task !== undefined) {
      const previousRuns = task.runIds;
      task = taskValue(await controller.workTasks.get(task.id));
      assert.deepEqual(task.runIds, [...previousRuns, result.runId]);
      verifyContinuityTaskRun(task, receipt);
      const continuation = taskValue(await controller.workTasks.getContinuation({ id: task.id, expectedRevision: task.revision }));
      assert.equal(continuation.latestRun?.runId, result.runId);
      assert.equal(continuation.requiresReview, false);
      assert.ok(diagnostic.ok);
      assert.equal(diagnostic.value.lastPreparationSource?.workTaskId, task.id);
      assert.equal(diagnostic.value.lastPreparationSource?.runId, result.runId);
      assert.ok(captures.some((capture) => capture.round === label &&
        JSON.stringify(capture.prompt).includes("Active WorkTask contract") &&
        JSON.stringify(capture.prompt).includes(task!.id)), "actual model input must contain the current task contract");
      taskSnapshots.push({ round, task });
    }
    const artifact = await readFile(join(root, "workspace", ARTIFACT), "utf8");
    assert.ok(artifact.startsWith(previousArtifact.slice(0, previousArtifact.indexOf(END))), "existing material must be preserved");
    assert.ok(artifact.endsWith(`${END}\n`), "keep the append boundary intact");
    assert.equal(artifact.split(END).length - 1, 1, "append marker must remain unique, not quoted in prose");
    assert.ok(diagnostic.ok, JSON.stringify(diagnostic));
    return diagnostic.value;
  }
  let failure: string | null = null;
  let latestId: string | null = null;
  const automaticCompactionIds = new Set<string>();
  try {
    if (workflow === "work-task") {
      if (stage === "before") {
        task = taskValue(await controller.workTasks.create({
          goal: "在同一任务中逐步交付个人助手日用流程，自动压缩并正常退出重开后，读取当前磁盘再继续编辑。",
          constraints: [
            `Only read/edit ${ARTIFACT}; preserve existing sections and the unique append marker.`,
            `Never modify ${SENTINEL}; no Shell, network or Memory tools.`,
            "Historical summary is reference, not current disk or permission. Human quality remains unaccepted.",
          ],
          acceptance: [
            { id: "saved-artifact", description: "Latest task Run saved the current file", method: "automatic", required: true,
              verification: { kind: "artifact_exists", path: ARTIFACT, requireReadback: true } },
            { id: "quality", description: "User reviews the complete workflow", method: "human", required: true,
              verification: { kind: "human" } },
          ],
        }));
      } else {
        const saved: WorkTask = JSON.parse(await readFile(join(root, "work-task-resume.json"), "utf8"));
        task = taskValue(await controller.workTasks.get(saved.id));
        assert.deepEqual(task, saved, "reopen must preserve task contract/revision/Run associations without running it");
        const latest = await controller.runs.get(task.runIds.at(-1)!);
        assert.ok(latest); verifyContinuityTaskRun(task, latest);
      }
      taskSnapshots.push({ round: "startup", task });
    }
    const startup = await controller.getContextDiagnostics(); assert.ok(startup.ok);
    diagnostics.push({ round: "startup", diagnostic: startup });
    assert.equal(startup.value.lastPreparation, null);
    assert.equal(startup.value.lastPreparationSource, null);
    if (stage === "before") assert.equal(startup.value.latestValidCompaction, null, "fresh case must not inherit historical installations");
    const instructions = `只读写 ${ARTIFACT}，不要触碰 ${SENTINEL}，不要 Shell 或其它工具。先调用 read_file 核对当前内容，再用 edit_file 在末尾标记 ${END} 前追加章节。参数名严格使用 path、oldText、newText。读取确认末尾标记唯一后，oldText 使用标记行本身加换行，newText 使用新章节正文加原标记行与换行；不要加入不存在的占位说明，不要整文件重写。标记文字只能在文件末尾出现一次，不要在正文引用它。保留所有已有章节；改完再次调用 read_file 读回核对，然后只简短报告，不把历史摘要当当前磁盘或权限。`;
    if (stage === "before") {
      for (const [index, topic] of topics.entries()) {
        const label = `section-${index + 1}`;
        const diagnostic = await run(label, `${instructions}为个人助手的日用工作流程补充“## ${label}”章节：${topic}。正文约650字，包含具体操作、检查方式、失败边界与完成条件，避免重复已有章节。`);
        assert.match(await readFile(join(root, "workspace", ARTIFACT), "utf8"), new RegExp(`## ${label}`));
        // AgentLoop prepares each step. A later reuse in this same Run can
        // replace lastPreparation.written, but cannot invent a new record ID.
        if (diagnostic.latestValidCompaction) {
          automaticCompactionIds.add(diagnostic.latestValidCompaction.id);
          latestId = diagnostic.latestValidCompaction.id;
        }
        if (automaticCompactionIds.size >= 2) break;
      }
      assert.ok(automaticCompactionIds.size >= 2, "bounded real workload must trigger at least two automatic compactions; no manual compact fallback");
      await run("continued", `${instructions}增加“## continued”章节，说明前三项最重要的落地检查，各写一句，不重写全文。`);
      assert.ok(captures.some((capture) => capture.round === "continued" && hasInjectedSummary(capture.prompt)));
      if (task !== undefined) {
        task = taskValue(await controller.workTasks.submitDelivery({ id: task.id, expectedRevision: task.revision,
          summary: "已形成日用流程草稿，下一轮需从当前磁盘核对并继续。",
          artifactRefs: [ARTIFACT], unresolved: ["核对重启后的外部标记并补充下一步"],
        }));
        task = taskValue(await controller.workTasks.requestChanges({ id: task.id, expectedRevision: task.revision }));
        const continuation = taskValue(await controller.workTasks.getContinuation({ id: task.id, expectedRevision: task.revision }));
        assert.equal(continuation.previousDelivery?.unresolved[0], "核对重启后的外部标记并补充下一步");
        await writeFile(join(root, "work-task-resume.json"), JSON.stringify(task, null, 2), { flag: "wx" });
      }
    } else {
      assert.ok(startup.value.latestValidCompaction, "persisted valid summary must survive full process restart");
      latestId = startup.value.latestValidCompaction.id;
      await run("reopened", `${instructions}这是进程重启后的继续任务。先从当前文件找到外部核对标记，再增加“## reopened”章节。将文件首行外部核对标记整行原样复制到新章节（包含“外部核对标记：”标签、括号与句号，不只截取标记值），并列出一个下一步。不得靠历史回忆猜标记。`);
      if (task !== undefined) assert.ok(captures.some(capture => capture.round === "reopened" &&
        JSON.stringify(capture.prompt).includes("核对重启后的外部标记并补充下一步")), "previous delivery must reach actual resumed model input");
      const artifact = await readFile(join(root, "workspace", ARTIFACT), "utf8");
      assert.match(artifact, /## reopened/);
      assert.ok(artifact.slice(artifact.indexOf("## reopened")).includes(EXTERNAL));
      assert.ok(captures.some((capture) => capture.round === "reopened" && hasInjectedSummary(capture.prompt)));
      assert.ok(approvals.some((approval) => approval.round === "reopened" && approval.toolName === "edit_file" && approval.allowed));
      if (task !== undefined) {
        const latestRunId = task.runIds.at(-1)!;
        const latest = await controller.runs.get(latestRunId); assert.ok(latest);
        task = taskValue(await controller.workTasks.submitDelivery({ id: task.id, expectedRevision: task.revision,
          summary: "Fixed-budget backend chain finished; final file saved after fresh read. Human quality not accepted.",
          artifactRefs: [ARTIFACT], unresolved: ["Human quality review and Electron interaction not run"],
        }));
        assert.equal(task.status, "awaiting_acceptance");
        assert.equal(task.acceptance.find((criterion) => criterion.id === "saved-artifact")?.status, "passed");
        assert.equal(task.acceptance.find((criterion) => criterion.id === "quality")?.status, "not_run");
        const evidence = task.delivery?.evidence; assert.ok(evidence && evidence.length === 1);
        const artifactEvidence = evidence[0]!; assert.equal(artifactEvidence.kind, "artifact");
        assert.equal(artifactEvidence.runId, latestRunId);
        if (artifactEvidence.kind === "artifact") {
          assert.equal(artifactEvidence.sha256, sha(artifact));
          const tool = latest.tools.find((item) => item.toolCallId === artifactEvidence.toolCallId);
          assert.equal(tool?.toolName, "edit_file");
          assert.equal(tool?.fileWrite?.sha256, artifactEvidence.sha256);
          assert.equal(tool?.fileWrite?.bytes, Buffer.byteLength(artifact));
        }
        taskSnapshots.push({ round: "delivery", task });
      }
    }
    assert.equal(await readFile(join(root, "workspace", SENTINEL), "utf8"), "DO_NOT_MODIFY\n");
    assert.equal(sha(await readFile(join(root, "config.json"), "utf8")), sha(configText));
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    await controller.shutdown();
    await writeFile(join(root, `${stage}-inputs.json`), JSON.stringify(captures, null, 2));
    await writeFile(join(root, `${stage}-responses.json`), JSON.stringify(responses, null, 2));
    await writeFile(join(root, `${stage}-report.json`), JSON.stringify({ pid: process.pid, stage, configHash: sha(configText), thread: THREAD,
      model: configured.modelAlias, workflow, passed: failure === null, failure, latestId, automaticCompactionIds: [...automaticCompactionIds], approvals, runs, diagnostics,
      ...(task === undefined ? {} : { workTask: task, taskSnapshots }) }, null, 2));
  }
  if (failure) throw new Error(failure);
}

export function continuityChildFailure(stage: Stage, exit: string, report: unknown): string {
  const message = `${stage} process exited ${exit}`;
  if (typeof report === "object" && report !== null && "stage" in report && report.stage === stage &&
    "passed" in report && report.passed === false && "failure" in report &&
    typeof report.failure === "string" && report.failure.trim().length > 0) {
    return `${message}: ${report.failure}`;
  }
  return message;
}

async function startChild(root: string, stage: Stage, workflow: Workflow) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", root, stage, workflow], { env: process.env, stdio: "inherit" });
    const timer = setTimeout(() => proc.kill("SIGTERM"), 20 * 60_000);
    proc.once("error", (error) => { clearTimeout(timer); reject(error); });
    proc.once("exit", async (code, signal) => {
      clearTimeout(timer);
      if (code === 0) { resolve(); return; }
      let report: unknown;
      try { report = JSON.parse(await readFile(join(root, `${stage}-report.json`), "utf8")); }
      catch { /* A startup failure or forced exit may leave no readable report. */ }
      reject(new Error(continuityChildFailure(stage, String(code ?? signal), report)));
    });
  });
}

export async function runContextContinuityAcceptance(options: { workTask?: boolean } = {}) {
  if (process.env.RUNLOOM_CONTEXT_CONTINUITY !== "1" || !["deepseek", "minimax-m3", "command-code"].includes(process.env.RUNLOOM_MODEL ?? "")) {
    throw new Error("Live opt-in required: RUNLOOM_CONTEXT_CONTINUITY=1 RUNLOOM_MODEL=deepseek (or minimax-m3 / command-code)");
  }
  const root = await mkdtemp(join(tmpdir(), "runloom-context-continuity-"));
  const workflow: Workflow = options.workTask ? "work-task" : "chat";
  await mkdir(join(root, "workspace", "notes"), { recursive: true });
  await mkdir(join(root, "workspace", "protected"));
  await writeFile(join(root, "workspace", ARTIFACT), `# 个人助手日用流程\n\n目标：让任务的行动、事实核对、交付和用户验收都有可执行的边界。\n\n${END}\n`);
  await writeFile(join(root, "workspace", SENTINEL), "DO_NOT_MODIFY\n");
  const config = JSON.stringify({ version: 2, authorizedDirectories: [{ path: join(root, "workspace"), access: "readwrite" }], modules: { "read-file": { enabled: true } },
    run: { totalTimeoutMs: 600000 }, contextCompaction: CONTINUITY_BUDGET }, null, 2);
  await writeFile(join(root, "config.json"), config);
  process.stdout.write(`Evidence directory: ${root}\n`);
  let failure: string | null = null;
  try {
    await startChild(root, "before", workflow); // Wait for real process exit and lease release.
    const artifactPath = join(root, "workspace", ARTIFACT);
    await writeFile(artifactPath, `${EXTERNAL}\n${await readFile(artifactPath, "utf8")}`);
    await startChild(root, "after", workflow);
    const before = JSON.parse(await readFile(join(root, "before-report.json"), "utf8"));
    const after = JSON.parse(await readFile(join(root, "after-report.json"), "utf8"));
    assert.ok(before.passed && after.passed);
    assert.ok(new Set(before.automaticCompactionIds).size >= 2, "before-restart report must prove two separate automatic installations");
    assert.equal(before.configHash, after.configHash); assert.equal(after.configHash, sha(config));
    assert.notEqual(before.pid, after.pid);
    assert.equal(before.workflow, workflow); assert.equal(after.workflow, workflow);
    if (workflow === "work-task") {
      assert.equal(before.workTask.id, after.workTask.id);
      assert.equal(before.workTask.status, "paused");
      assert.equal(after.workTask.status, "awaiting_acceptance");
      assert.deepEqual(after.workTask.runIds.slice(0, -1), before.workTask.runIds);
      assert.equal(after.workTask.acceptance.find((criterion: { id: string }) => criterion.id === "quality").status, "not_run");
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const report = { root, workflow, passed: failure === null, failure, configHash: sha(config), budget: CONTINUITY_BUDGET,
    evidence: "real-model backend; automatic compaction; two independent child processes; fixture-scoped programmatic approvals",
    electronAcceptance: "not_run", taskQuality: "not_evaluated" };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--child") {
    // Children are private to the opted-in parent; direct invocation remains opt-in.
    assert.equal(process.env.RUNLOOM_CONTEXT_CONTINUITY, "1");
    assert.ok(process.argv[4] === "before" || process.argv[4] === "after");
    assert.ok(process.argv[5] === "chat" || process.argv[5] === "work-task");
    await child(process.argv[3]!, process.argv[4], process.argv[5]);
  } else {
    const result = await runContextContinuityAcceptance({ workTask: process.argv.includes("--work-task") });
    process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.passed) process.exitCode = 1;
  }
}
