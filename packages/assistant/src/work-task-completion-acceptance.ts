/** Opt-in paired task evaluation. Program approvals are not Electron clicks or human quality acceptance. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import { getWorkTaskEvalCase, createPendingWorkTaskEvalChecks } from "./work-task-eval-cases.js";
import type { AcceptanceVerification, WorkTaskResult } from "./work-task-store.js";
import { CONTINUITY_BUDGET } from "./context-continuity-acceptance.js";
import { deriveCaseStatus, type AcceptanceCaseResult } from "./acceptance/contracts.js";
import { writeAcceptanceReport } from "./acceptance/report.js";
import { execFileSync } from "node:child_process";

const cases = ["WT01", "WT03", "WT04"] as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function value<T>(result: WorkTaskResult<T>): T { assert.ok(result.ok, JSON.stringify(result)); return result.value; }
async function workspaceFiles(workspace: string): Promise<string[]> {
  const entries = await readdir(workspace, { recursive: true, withFileTypes: true });
  return entries.filter(entry => !entry.isDirectory()).map(entry => join(entry.parentPath, entry.name).slice(workspace.length + 1))
    .filter(path => !path.startsWith(".runloom/")).sort();
}

export async function runCompletionAcceptance(label: "baseline" | "improved") {
  assert.equal(process.env.RUNLOOM_WORK_TASK_COMPLETION_ACCEPTANCE, "1", "Paid model evaluation must be explicitly enabled");
  const configured = configureCliModel(createDemoModel);
  assert.notEqual(configured.modelAlias, "mock");
  const modelId = typeof configured.model === "string" ? configured.model : configured.model.modelId;
  const root = await mkdtemp(join(tmpdir(), `runloom-task-completion-${label}-`));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const results: unknown[] = [];
  process.stdout.write(`Evidence directory: ${root}\n`);
  for (const caseId of cases) {
    const startedAt = new Date().toISOString();
    const definition = getWorkTaskEvalCase(caseId)!;
    const directory = join(root, caseId), workspace = join(directory, "workspace");
    await mkdir(workspace, { recursive: true });
    const fixture = fileURLToPath(new URL(`../fixtures/work-task-eval/${definition.fixtureId}/`, import.meta.url));
    let prompt: string;
    let readable: string[], writable: string[], verification: AcceptanceVerification[];
    if (caseId === "WT01") {
      await cp(join(fixture, "src"), join(workspace, "src"), { recursive: true });
      await cp(join(fixture, "test"), join(workspace, "test"), { recursive: true });
      prompt = await readFile(join(fixture, "request.md"), "utf8");
      readable = ["src/slug.mjs", "test/slug.test.mjs"];
      writable = ["src/slug.mjs"];
      verification = [{ kind: "artifact_exists", path: "src/slug.mjs", requireReadback: true }, { kind: "shell_exit_zero", command: "node --test test/slug.test.mjs", cwd: "." }];
    } else if (caseId === "WT03") {
      await mkdir(join(workspace, "inputs"));
      await cp(join(fixture, "notes.md"), join(workspace, "inputs/notes.md"));
      await cp(join(fixture, "manifest.schema.json"), join(workspace, "inputs/manifest.schema.json"));
      prompt = "读取 inputs/notes.md 和 inputs/manifest.schema.json，按材料完成两份交付。只新增 handoff.md 和 manifest.json，不改输入。分别读回核对。";
      readable = ["inputs/notes.md", "inputs/manifest.schema.json", "handoff.md", "manifest.json"];
      writable = ["handoff.md", "manifest.json"];
      verification = writable.map(path => ({ kind: "artifact_exists", path, requireReadback: true }));
    } else {
      await cp(join(fixture, "brief.md"), join(workspace, "brief.md"));
      prompt = await readFile(join(fixture, "update.md"), "utf8");
      readable = writable = ["brief.md"];
      verification = [{ kind: "artifact_exists", path: "brief.md", requireReadback: true }];
    }
    await writeFile(join(workspace, "unrelated.txt"), "保留：与本次开发任务无关。\n");
    const initialFiles = await workspaceFiles(workspace);
    const originals = new Map<string, string>();
    for (const path of readable) {
      try { originals.set(path, await readFile(join(workspace, path), "utf8")); } catch { /* New outputs do not exist yet. */ }
    }
    const config = { version: 1, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { "read-file": { enabled: true }, shell: { enabled: caseId === "WT01", timeoutMs: 60000 } },
      run: { maxSteps: 12, totalTimeoutMs: 600000 }, contextCompaction: CONTINUITY_BUDGET };
    await writeFile(join(directory, "config.json"), JSON.stringify(config));
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ directory: join(directory, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: caseId, configPath: join(directory, "config.json") },
      model: configured.model, modelAlias: configured.modelAlias, output, env: process.env, cwd: workspace });
    const controller = createAssistantController(app);
    output.on("data", chunk => controller.recordOutput(String(chunk)));
    const approvals = new Map<string, { tool: string; allowed: boolean }>();
    const outputs: string[] = [];
    controller.subscribe(event => {
      if (event.type === "output") outputs.push(event.text);
      if (event.type !== "approval" || approvals.has(event.approval.approvalId)) return;
      const input = event.approval.input as { path?: string; command?: string; cwd?: string };
      const allowed = event.approval.toolName === "read_file" ? readable.includes(input.path ?? "") :
        ["write_file", "edit_file"].includes(event.approval.toolName) ? writable.includes(input.path ?? "") :
        event.approval.toolName === "shell_exec" && caseId === "WT01" && input.command === "node --test test/slug.test.mjs" && (input.cwd ?? ".") === ".";
      approvals.set(event.approval.approvalId, { tool: event.approval.toolName, allowed });
      controller.confirm({ approvalId: event.approval.approvalId, decision: allowed ? "allow" : "deny" });
    });
    let failure: string | null = null;
    let task = value(await controller.workTasks.create({ goal: definition.goal, constraints: [...definition.constraints],
      acceptance: [...verification.map((item, i) => ({ id: `program-${i}`, description: JSON.stringify(item), method: "automatic" as const, required: true, verification: item })),
        { id: "quality", description: "Human reviews task content and scope", method: "human", required: true, verification: { kind: "human" } }] }));
    try {
      const done = new Promise<void>(resolve => { const unsubscribe = controller.subscribe(event => {
        if (event.type === "state" && event.state.kind === "idle") { unsubscribe(); resolve(); }
      }); });
      const started = await controller.workTasks.run({ id: task.id, expectedRevision: task.revision, instruction: prompt, completionCheck: label === "improved" });
      assert.ok(started.ok); await done;
      task = value(await controller.workTasks.get(task.id));
      const primary = controller.getSnapshot().lastPrimaryResult; assert.ok(primary);
      assert.equal(task.runIds.length, 1, "no new Run may be created to correct the task");
      assert.equal(primary.status, "completed", JSON.stringify(primary));
      if (task.status === "paused") task = value(await controller.workTasks.submitDelivery({ id: task.id, expectedRevision: task.revision,
        summary: primary.text || "Evaluation delivery", artifactRefs: verification.filter(item => item.kind === "artifact_exists").map(item => item.path) }));
      assert.ok(task.acceptance.filter(item => item.method === "automatic").every(item => item.status === "passed"));
      assert.equal(task.acceptance.find(item => item.id === "quality")?.status, "not_run");
      assert.equal(await readFile(join(workspace, "unrelated.txt"), "utf8"), "保留：与本次开发任务无关。\n");
      assert.deepEqual(await workspaceFiles(workspace), [...new Set([...initialFiles, ...writable])].sort());
      for (const [path, original] of originals) if (!writable.includes(path)) assert.equal(await readFile(join(workspace, path), "utf8"), original);
      if (caseId === "WT03") {
        const manifest = JSON.parse(await readFile(join(workspace, "manifest.json"), "utf8"));
        const schema = JSON.parse(originals.get("inputs/manifest.schema.json")!);
        assert.deepEqual(Object.keys(manifest).sort(), schema.required.slice().sort());
        for (const [key, property] of Object.entries(schema.properties)) assert.deepEqual(manifest[key], (property as { const: unknown }).const);
        const handoff = await readFile(join(workspace, "handoff.md"), "utf8");
        for (const heading of ["项目", "已完成", "验证依据", "未决事项", "下一步"]) assert.match(handoff, new RegExp(`^## ${heading}\\s*$`, "m"));
        for (const token of ["F01", "offline-read-20261003", "U01", "not_verified", "U02", "not_run"]) assert.ok(handoff.includes(token));
      }
      if (caseId === "WT04") {
        const brief = await readFile(join(workspace, "brief.md"), "utf8"), original = originals.get("brief.md")!;
        const receipt = await controller.runs.get(primary.runId); assert.ok(receipt);
        assert.ok(receipt.tools.some(tool => tool.toolName === "edit_file" && tool.status === "completed"));
        assert.ok(receipt.tools.every(tool => tool.toolName !== "write_file"));
        assert.deepEqual(brief.match(/^## .*$/gm), original.match(/^## .*$/gm));
        assert.equal(brief.slice(0, brief.indexOf("## 进度")), original.slice(0, original.indexOf("## 进度")));
        assert.equal(brief.slice(brief.indexOf("## 下一步")), original.slice(original.indexOf("## 下一步")));
        const progress = brief.slice(brief.indexOf("## 进度"), brief.indexOf("## 未决事项"));
        const unresolved = brief.slice(brief.indexOf("## 未决事项"), brief.indexOf("## 下一步"));
        for (const token of ["F01", "offline-read-20261003"]) assert.ok(progress.includes(token));
        for (const token of ["U01", "not_verified", "U02", "not_run"]) assert.ok(unresolved.includes(token));
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally {
      const primary = controller.getSnapshot().lastPrimaryResult;
      const receipt = primary ? await controller.runs.get(primary.runId) : null;
      const corrections = primary?.completion?.corrections ?? 0;
      const evalChecks = createPendingWorkTaskEvalChecks(definition).map(check => check.method === "human" ? check : {
        ...check, status: failure === null ? "passed" as const : "blocked" as const,
        evidenceIds: failure === null ? ["observations"] : [],
        note: failure === null ? "Frozen fixture assertions and current task receipts passed; no human quality acceptance." : `Fixture evaluation stopped: ${failure}`,
      });
      const result = { caseId, label, passed: failure === null, failure, primary, task, receipt, approvals: [...approvals.values()],
        corrections, outcome: failure !== null ? "failed" : corrections > 0 ? "corrected_completion" : "first_pass_completion",
        approvedToolCalls: [...approvals.values()].filter(item => item.allowed).length,
        deniedToolCalls: [...approvals.values()].filter(item => !item.allowed).length,
        operatorFollowups: 0, quality: "not_accepted", evalChecks, configDigest: sha(JSON.stringify({ ...config, authorizedDirectory: "<isolated-workspace>" })) };
      results.push(result);
      try {
        await writeFile(join(directory, "report.json"), JSON.stringify(result, null, 2));
        await writeFile(join(directory, "output.json"), JSON.stringify(outputs));
        // Existing Eval format remains not_run overall until its human quality checks are accepted.
        const attempt = join(root, "eval", caseId, label);
        await mkdir(attempt, { recursive: true });
        await cp(join(directory, "report.json"), join(attempt, "observations.json"));
        const evaluation: AcceptanceCaseResult = { schemaVersion: 1, caseId, attemptId: label,
          baseline: { commit, dirty: true, modelId, configDigest: result.configDigest },
          execution: { entry: "runtime_test", model: "real", network: "live" }, startedAt,
          finishedAt: new Date().toISOString(), runIds: task.runIds, threadIds: [caseId],
          status: deriveCaseStatus(evalChecks), checks: evalChecks,
          evidence: [{ id: "observations", kind: "store_snapshot", path: "observations.json" }],
          durationMs: Date.now() - Date.parse(startedAt), usage: primary?.usage ?? null };
        await writeAcceptanceReport(evaluation, join(root, "eval"));
      } finally { await controller.shutdown(); }
      process.stdout.write(`${caseId}: ${result.passed ? "passed" : "failed"}\n`);
    }
  }
  const report = { root, label, results, passed: results.every(result => (result as { passed: boolean }).passed), quality: "not_accepted", electronAcceptance: "not_run", model: configured.modelAlias, modelId, budget: { maxSteps: 12, maxCorrections: label === "improved" ? 2 : 0, totalTimeoutMs: 600000 },
    evidence: "real-model task fixtures; program-scoped tool approvals; no human quality acceptance or Electron clicks" };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2)); return report;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const label = process.argv[2]; assert.ok(label === "baseline" || label === "improved");
  const report = await runCompletionAcceptance(label); process.stdout.write(`${report.root}\n`);
  if (!report.passed) process.exitCode = 1;
}
