import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";

async function settle(controller: AssistantController) {
  const deadline = Date.now() + 150_000;
  while (controller.getSnapshot().state.kind !== "idle") {
    const approval = controller.getSnapshot().pendingApproval;
    if (approval) throw new Error(`Automatic-memory chat unexpectedly requested approval for ${approval.toolName}`);
    if (Date.now() > deadline) throw new Error("Automatic memory did not settle within its budget");
    await delay(20);
  }
}

async function runPhase(root: string, phase: "save" | "reopen", signal: AbortSignal) {
  const env: NodeJS.ProcessEnv = { ...process.env, RUNLOOM_AUTO_MEMORY_PHASE: phase, RUNLOOM_AUTO_MEMORY_ROOT: root };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => {
    output = (output + chunk.toString()).slice(-128 * 1024);
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`${phase} process failed (${code ?? signal}):\n${output}`)));
  });
}

test("real configured model: ordinary preference auto-saves, restarts, recalls, corrects and retracts", {
  skip: process.env.RUNLOOM_AUTO_MEMORY_ACCEPTANCE !== "1", timeout: 480_000,
}, async context => {
  const phase = process.env.RUNLOOM_AUTO_MEMORY_PHASE;
  if (phase !== undefined && phase !== "save" && phase !== "reopen") throw new Error("Invalid memory acceptance phase");
  if (phase === undefined) {
    const root = await mkdtemp(join(tmpdir(), "serika-auto-memory-acceptance-"));
    try {
      await mkdir(join(root, "workspace"));
      await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace: join(root, "workspace"), modules: {
        memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic", queryRewrite: { enabled: true } },
      } }));
      await runPhase(root, "save", context.signal);
      await runPhase(root, "reopen", context.signal);
      const before = JSON.parse(await readFile(join(root, "save.json"), "utf8"));
      const after = JSON.parse(await readFile(join(root, "reopen.json"), "utf8"));
      assert.notEqual(before.pid, after.pid, "restart must cross a real process boundary");
      assert.equal(before.configHash, after.configHash, "restart must keep the exact configuration");
      assert.equal(before.receipt.memoryId, after.memoryId);
      console.log(JSON.stringify({ ...after, savePid: before.pid, autoSaved: true, processRestarted: true, nativeElectron: "not_run" }));
    } finally { await rm(root, { recursive: true, force: true }); }
    return;
  }
  const root = process.env.RUNLOOM_AUTO_MEMORY_ROOT;
  assert.ok(root, "worker phase needs the parent's isolated root");
  const config = join(root, "config.json");
  const configHash = createHash("sha256").update(await readFile(config)).digest("hex");
  const selected = configureCliModel(createDemoModel);
  assert.notEqual(selected.modelAlias, "mock/default", "real-model acceptance must never fall back to mock");
  let controller: AssistantController | undefined;
  const open = async (thread: string) => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: thread, configPath: config },
      ...selected, output, env: process.env, cwd: root });
    const next = createAssistantController(app);
    let approvals = 0;
    next.subscribe(event => { if (event.type === "approval") approvals += 1; });
    await next.listRuns();
    return { app, controller: next, approvalCount: () => approvals };
  };
  try {
    if (phase === "save") {
      const first = await open("origin"); controller = first.controller;
      assert.equal((await controller.run("我的长期写作偏好是：复盘先给一行结论，再列两条可执行步骤。此轮只回复收到。")).ok, true);
      await settle(controller);
      const maintenance = await controller.getMemoryMaintenance();
      if (!maintenance.ok) throw new Error(maintenance.error.message);
      assert.equal(maintenance.value.consolidation.lastAttempt?.status, "completed");
      const receipt = maintenance.value.consolidation.lastAttempt?.accepted?.[0];
      assert.ok(receipt, "no actual automatic-write receipt; model prose is not acceptance");
      assert.equal(first.approvalCount(), 0, "ordinary memory must not require tool approval");
      const memory = await first.app.memoryStore!.get(receipt.memoryId);
      assert.ok(memory.ok);
      if (memory.ok) assert.equal(memory.entry.source?.kind, "conversation");
      await writeFile(join(root, "save.json"), JSON.stringify({ pid: process.pid, configHash, receipt }));
      return;
    }
    const { receipt } = JSON.parse(await readFile(join(root, "save.json"), "utf8")) as {
      receipt: { memoryId: string; revision: number };
    };
    const reopened = await open("different-thread"); controller = reopened.controller;
    assert.equal((await controller.run("我做事后总结通常喜欢什么样的开头和行动清单？请回答格式，不要查询工具。", { memoryConsolidation: "exclude" })).ok, true);
    await settle(controller);
    const reference = controller.getMemoryReferences();
    assert.ok(JSON.stringify(reference).includes(receipt.memoryId), "recall must come from current prepared memory, not old transcript");
    const answer = controller.getSnapshot().lastPrimaryResult;
    assert.equal(answer?.status, "completed");
    assert.match(answer?.text ?? "", /结论/);
    assert.match(answer?.text ?? "", /两条|2\s*条|两[个项]|二条/);
    assert.equal(reopened.approvalCount(), 0);
    assert.equal((await controller.run("我更正之前关于复盘格式的长期偏好：不是先结论再列两条步骤，而是先列三条可执行步骤，最后给一行结论。请记住这条更正。")).ok, true);
    await settle(controller);
    const corrected = await reopened.app.memoryStore!.get(receipt.memoryId);
    assert.ok(corrected.ok);
    if ((corrected.entry.revision ?? 0) <= receipt.revision) {
      console.log(JSON.stringify({ correctionDiagnostic: await controller.getMemoryMaintenance(),
        consolidation: controller.getSnapshot().lastConsolidationResult,
        staged: (await controller.getHistory()).flatMap(message => message.parts.filter(part => JSON.stringify(part).includes("memory_stage_candidates"))),
        output: controller.getSnapshot().recentOutput }));
    }
    assert.ok((corrected.entry.revision ?? 0) > receipt.revision, "correction must version the same fact instead of adding a conflict");
    assert.match(corrected.entry.text, /三条|3\s*条/);
    const active = await reopened.app.memoryStore!.list(); assert.ok(active.ok);
    assert.equal(active.entries.filter(entry => entry.enabled !== false).length, 1);
    assert.equal((await controller.run("请撤回刚才那条复盘格式偏好，不要记住我的复盘偏好了；以后不再引用这条记忆。")).ok, true);
    await settle(controller);
    const retired = await reopened.app.memoryStore!.get(receipt.memoryId);
    assert.ok(retired.ok);
    if ((retired.entry.revision ?? 0) <= (corrected.entry.revision ?? 0)) {
      console.log(JSON.stringify({ withdrawalDiagnostic: await controller.getMemoryMaintenance(),
        consolidation: controller.getSnapshot().lastConsolidationResult,
        staged: (await controller.getHistory()).flatMap(message => message.parts.filter(part => JSON.stringify(part).includes("memory_stage_candidates"))),
        output: controller.getSnapshot().recentOutput }));
    }
    assert.ok((retired.entry.revision ?? 0) > (corrected.entry.revision ?? 0));
    await controller.shutdown(); controller = undefined;
    const withdrawn = await open("after-withdrawal"); controller = withdrawn.controller;
    assert.equal((await controller.run("我做复盘时的长期格式偏好是什么？不要查询工具。", { memoryConsolidation: "exclude" })).ok, true);
    await settle(controller);
    const currentReferences = controller.getMemoryReferences();
    assert.ok(!JSON.stringify(currentReferences).includes(receipt.memoryId), "withdrawn fact must no longer enter current references");
    assert.equal(reopened.approvalCount(), 0);
    assert.equal(withdrawn.approvalCount(), 0);
    await writeFile(join(root, "reopen.json"), JSON.stringify({ pid: process.pid, configHash, model: selected.modelAlias,
      memoryId: receipt.memoryId, crossThreadRecall: true, correctionVersioned: true, retractedNotInjected: true }));
  } finally {
    await controller?.shutdown();
  }
});
