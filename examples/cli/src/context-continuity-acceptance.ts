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
import type { ExecutionToolRecord } from "./execution-record-store.js";

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
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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

async function child(root: string, stage: Stage) {
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
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", THREAD, "--config", join(root, "config.json")],
    modelAlias: configured.modelAlias, model, output, env: process.env, cwd: root });
  const controller = createAssistantController(app);
  const approvals: Array<{ round: string; toolName: string; approvalId: string; allowed: boolean }> = [];
  const runs: unknown[] = [];
  const diagnostics: unknown[] = [];
  output.on("data", (chunk: Buffer) => controller.recordOutput(chunk.toString()));
  controller.subscribe((event) => {
    if (event.type !== "approval") return;
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
      const started = await controller.run(prompt); assert.ok(started.ok, JSON.stringify(started));
      await done;
    } finally { unsubscribe(); }
    const result = controller.getSnapshot().lastPrimaryResult; assert.ok(result);
    const receipt = await controller.getRun(result.runId); runs.push({ round, result, receipt });
    const diagnostic = await controller.getContextDiagnostics(); diagnostics.push({ round, diagnostic });
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.ok(receipt && hasSuccessfulReadBeforeEdit(receipt.tools),
      "successful read must precede successful edit, including after restart; completed ok:false is not success");
    const artifact = await readFile(join(root, "workspace", ARTIFACT), "utf8");
    assert.ok(artifact.startsWith(previousArtifact.slice(0, previousArtifact.indexOf(END))), "existing material must be preserved");
    assert.ok(artifact.endsWith(`${END}\n`), "keep the append boundary intact");
    assert.equal(artifact.split(END).length - 1, 1, "append marker must remain unique, not quoted in prose");
    assert.ok(diagnostic.ok, JSON.stringify(diagnostic));
    return diagnostic.value;
  }
  let failure: string | null = null;
  let latestId: string | null = null;
  try {
    const startup = await controller.getContextDiagnostics(); assert.ok(startup.ok);
    diagnostics.push({ round: "startup", diagnostic: startup });
    assert.equal(startup.value.lastPreparation, null);
    const instructions = `只读写 ${ARTIFACT}，不要触碰 ${SENTINEL}，不要 Shell 或其它工具。先调用 read_file 核对当前内容，再用 edit_file 在末尾标记 ${END} 前追加章节。oldText 使用末尾标记的完整独立行及相邻空行，不唯一时允许用更长的末尾上下文定位；不要整文件重写。标记文字只能在文件末尾出现一次，不要在正文引用它。保留所有已有章节；工具成功后只简短报告，不把历史摘要当当前磁盘或权限。`;
    if (stage === "before") {
      for (const [index, topic] of topics.entries()) {
        const label = `section-${index + 1}`;
        const diagnostic = await run(label, `${instructions}为个人助手的日用工作流程补充“## ${label}”章节：${topic}。正文约650字，包含具体操作、检查方式、失败边界与完成条件，避免重复已有章节。`);
        assert.match(await readFile(join(root, "workspace", ARTIFACT), "utf8"), new RegExp(`## ${label}`));
        if (diagnostic.latestValidCompaction) { latestId = diagnostic.latestValidCompaction.id; break; }
      }
      assert.ok(latestId, "bounded real workload did not trigger automatic compaction; no manual compact fallback");
      await run("continued", `${instructions}增加“## continued”章节，说明前三项最重要的落地检查，各写一句，不重写全文。`);
      assert.ok(captures.some((capture) => capture.round === "continued" && hasInjectedSummary(capture.prompt)));
    } else {
      assert.ok(startup.value.latestValidCompaction, "persisted valid summary must survive full process restart");
      latestId = startup.value.latestValidCompaction.id;
      await run("reopened", `${instructions}这是进程重启后的继续任务。先从当前文件找到外部核对标记，再增加“## reopened”章节，逐字写入找到的标记并列出一个下一步。不得靠历史回忆猜标记。`);
      const artifact = await readFile(join(root, "workspace", ARTIFACT), "utf8");
      assert.match(artifact, /## reopened/);
      assert.ok(artifact.slice(artifact.indexOf("## reopened")).includes(EXTERNAL));
      assert.ok(captures.some((capture) => capture.round === "reopened" && hasInjectedSummary(capture.prompt)));
      assert.ok(approvals.some((approval) => approval.round === "reopened" && approval.toolName === "edit_file" && approval.allowed));
    }
    assert.equal(await readFile(join(root, "workspace", SENTINEL), "utf8"), "DO_NOT_MODIFY\n");
    assert.equal(sha(await readFile(join(root, "config.json"), "utf8")), sha(configText));
  } catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
  finally {
    await controller.shutdown();
    await writeFile(join(root, `${stage}-inputs.json`), JSON.stringify(captures, null, 2));
    await writeFile(join(root, `${stage}-responses.json`), JSON.stringify(responses, null, 2));
    await writeFile(join(root, `${stage}-report.json`), JSON.stringify({ pid: process.pid, stage, configHash: sha(configText), thread: THREAD,
      model: configured.modelAlias, passed: failure === null, failure, latestId, approvals, runs, diagnostics }, null, 2));
  }
  if (failure) throw new Error(failure);
}

async function startChild(root: string, stage: Stage) {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", root, stage], { env: process.env, stdio: "inherit" });
    const timer = setTimeout(() => proc.kill("SIGTERM"), 20 * 60_000);
    proc.once("error", (error) => { clearTimeout(timer); reject(error); });
    proc.once("exit", (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${stage} process exited ${code ?? signal}`)); });
  });
}

export async function runContextContinuityAcceptance() {
  if (process.env.RUNLOOM_CONTEXT_CONTINUITY !== "1" || !["deepseek", "minimax-m3"].includes(process.env.RUNLOOM_MODEL ?? "")) {
    throw new Error("Live opt-in required: RUNLOOM_CONTEXT_CONTINUITY=1 RUNLOOM_MODEL=deepseek (or minimax-m3)");
  }
  const root = await mkdtemp(join(tmpdir(), "runloom-context-continuity-"));
  await mkdir(join(root, "workspace", "notes"), { recursive: true });
  await mkdir(join(root, "workspace", "protected"));
  await writeFile(join(root, "workspace", ARTIFACT), `# 个人助手日用流程\n\n目标：让任务的行动、事实核对、交付和用户验收都有可执行的边界。\n\n${END}\n`);
  await writeFile(join(root, "workspace", SENTINEL), "DO_NOT_MODIFY\n");
  const config = JSON.stringify({ version: 1, workspace: join(root, "workspace"), modules: { "read-file": { enabled: true } },
    run: { totalTimeoutMs: 600000 }, contextCompaction: CONTINUITY_BUDGET }, null, 2);
  await writeFile(join(root, "config.json"), config);
  process.stdout.write(`Evidence directory: ${root}\n`);
  let failure: string | null = null;
  try {
    await startChild(root, "before"); // Wait for real process exit and lease release.
    const artifactPath = join(root, "workspace", ARTIFACT);
    await writeFile(artifactPath, `${EXTERNAL}\n${await readFile(artifactPath, "utf8")}`);
    await startChild(root, "after");
    const before = JSON.parse(await readFile(join(root, "before-report.json"), "utf8"));
    const after = JSON.parse(await readFile(join(root, "after-report.json"), "utf8"));
    assert.ok(before.passed && after.passed);
    assert.equal(before.configHash, after.configHash); assert.equal(after.configHash, sha(config));
    assert.notEqual(before.pid, after.pid);
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const report = { root, passed: failure === null, failure, configHash: sha(config), budget: CONTINUITY_BUDGET,
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
    await child(process.argv[3]!, process.argv[4]);
  } else {
    const result = await runContextContinuityAcceptance();
    process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.passed) process.exitCode = 1;
  }
}
