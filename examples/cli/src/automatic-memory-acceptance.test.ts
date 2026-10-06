import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
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

test("real configured model: ordinary preference auto-saves, reopens, recalls, corrects and retracts", {
  skip: process.env.RUNLOOM_AUTO_MEMORY_ACCEPTANCE !== "1", timeout: 480_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-auto-memory-acceptance-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace, modules: {
    memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic", queryRewrite: { enabled: true } },
  } }));
  const selected = configureCliModel(createDemoModel);
  assert.notEqual(selected.modelAlias, "mock/default", "real-model acceptance must never fall back to mock");
  let controller: AssistantController | undefined;
  const open = async (thread: string) => {
    const output = new PassThrough(); output.resume();
    const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", config],
      ...selected, output, env: process.env, cwd: root });
    const next = createAssistantController(app);
    let approvals = 0;
    next.subscribe(event => { if (event.type === "approval") approvals += 1; });
    await next.listRuns();
    return { app, controller: next, approvalCount: () => approvals };
  };
  try {
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
    await controller.shutdown(); controller = undefined;
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
        output: controller.getSnapshot().recentOutput }));
    }
    assert.ok((retired.entry.revision ?? 0) > (corrected.entry.revision ?? 0));
    assert.equal((await controller.run("我做复盘时的长期格式偏好是什么？不要查询工具。", { memoryConsolidation: "exclude" })).ok, true);
    await settle(controller);
    const currentReferences = controller.getMemoryReferences();
    assert.ok(!JSON.stringify(currentReferences).includes(receipt.memoryId), "withdrawn fact must no longer enter current references");
    assert.equal(reopened.approvalCount(), 0);
    console.log(JSON.stringify({ model: selected.modelAlias, autoSaved: true, reopened: true, crossThreadRecall: true,
      correctionVersioned: true, retractedNotInjected: true, nativeElectron: "not_run" }));
  } finally {
    await controller?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
