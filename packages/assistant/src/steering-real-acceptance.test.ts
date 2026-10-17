import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";
import { hasMatchingFileReadback } from "./execution-record-store.js";
import { configureCliModel } from "./model-config.js";

test("real configured model accepts Steer at file confirmation and preserves the original within one Run", {
  skip: process.env.RUNLOOM_STEERING_ACCEPTANCE !== "1", timeout: 120_000,
}, async () => {
  const selected = configureCliModel(() => { throw new Error("Real Steer acceptance cannot fall back to mock"); });
  assert.notEqual(selected.modelAlias, "mock/default");
  const root = await mkdtemp(join(tmpdir(), "serika-steering-real-"));
  const workspace = join(root, "workspace");
  const path = "notes/plan.md";
  const original = "# 原始计划\n\n这段原文必须原样保留。\n";
  const addition = "## 下一步\n1. 核对已交付文件。\n2. 记录后续负责人。\n";
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, path), original);
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ version: 1, workspace,
    run: { maxSteps: 8, totalTimeoutMs: 90_000 },
    modules: { "read-file": { enabled: true } }, automation: { hooks: [] },
  }));
  const output = new PassThrough(); output.resume();
  let controller: AssistantController | undefined;
  let corrected = false;
  let supersededCallId: string | undefined;
  const errors: string[] = [];
  const until = Date.now() + 105_000;
  const waitFor = async (condition: () => boolean) => {
    while (!condition()) {
      assert.ok(Date.now() < until, "Real Steer acceptance exceeded its fixed deadline");
      await delay(10);
    }
  };
  try {
    const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "real-steer", configPath: config },
      ...selected, output, env: process.env, cwd: root });
    controller = createAssistantController(app);
    await controller.getHistory();
    controller.subscribe(event => {
      if (event.type === "error") errors.push(event.message);
      if (event.type !== "approval") return;
      const approval = event.approval;
      if (approval.toolCallId === supersededCallId) return;
      const input = approval.input as { path?: unknown } | null;
      const allowed = input?.path === path && (approval.toolName === "read_file" || approval.toolName === "edit_file");
      if (!allowed) { controller!.confirm({ approvalId: approval.approvalId, decision: "deny" }); return; }
      if (approval.toolName === "read_file" || corrected) controller!.confirm({ approvalId: approval.approvalId, decision: "allow" });
    });
    const start = await controller.run(`请实际修改 ${path}：先用 read_file 读取当前内容，再用 edit_file 将整个文件替换为“准备替换\n”。不要只给文字建议，不要使用 write_file 或 Shell。`,
      { memoryConsolidation: "exclude" });
    assert.ok(start.ok, JSON.stringify(start));
    await waitFor(() => controller!.getSnapshot().pendingApproval?.toolName === "edit_file" || controller!.getSnapshot().state.kind === "idle");
    const oldApproval = controller.getSnapshot().pendingApproval;
    assert.ok(oldApproval?.toolName === "edit_file", `Model did not propose the initial edit: ${JSON.stringify({ result: controller.getSnapshot().lastPrimaryResult, errors })}`);
    assert.equal(await readFile(join(workspace, path), "utf8"), original, "initial edit is pending, not applied");
    supersededCallId = oldApproval.toolCallId;
    corrected = true;
    const sent = await controller.steer({ expectedRunId: start.runId, id: "preserve-original", text:
      `更正刚才要求：取消替换全文，保留 ${path} 的所有原文，只在文件末尾追加以下精确文本。请重新用 read_file 读取当前文件，再用 edit_file 追加（参数 path、oldText、newText），完成后必须再次 read_file 读回核对；不要使用 write_file、Shell 或其他路径。追加文本的 JSON 字符串是 ${JSON.stringify(addition)}。最后简短报告结果。` });
    assert.ok(sent.ok, JSON.stringify(sent));
    assert.equal(controller.confirm({ approvalId: oldApproval.approvalId, decision: "allow" }), false, "superseded approval cannot execute the old edit");
    await waitFor(() => controller!.getSnapshot().state.kind === "idle");
    const result = controller.getSnapshot().lastPrimaryResult;
    assert.equal(result?.runId, start.runId);
    assert.equal(result?.status, "completed", JSON.stringify({ result, errors }));
    assert.equal(await readFile(join(workspace, path), "utf8"), original + addition, "real model must preserve the original and append the two exact actions");
    const receipt = await controller.getRun(start.runId); assert.ok(receipt);
    const oldCall = receipt.tools.find(tool => tool.toolCallId === oldApproval.toolCallId); assert.ok(oldCall);
    assert.equal(oldCall.status, "not_started"); assert.equal(oldCall.startedAt, null);
    const edit = receipt.tools.filter(tool => tool.toolName === "edit_file" && tool.status === "completed" && tool.fileWrite?.path === path).at(-1);
    assert.ok(edit?.fileWrite, "new edit needs an actual successful file receipt");
    assert.ok(hasMatchingFileReadback(receipt.tools, edit, path, edit.fileWrite.sha256, edit.fileWrite.bytes), "successful readback must follow the new edit");
    assert.equal(receipt.steers?.[0]?.status, "applied");
    assert.equal((await controller.listRuns()).length, 1, "Steer must not launch a second Run");
    const history = await controller.getHistory();
    assert.deepEqual(history.find(message => message.id === receipt.steers?.[0]?.messageId)?.metadata,
      { source: "steer", memoryConsolidation: "exclude" });
    await controller.shutdown(); controller = undefined;
    const reopened = createAssistantController(await createRuntimeApp({
      directory: join(root, "transcripts"), assistant: { threadId: "real-steer", configPath: config },
      ...selected, output, env: process.env, cwd: root,
    }));
    controller = reopened; await controller.getHistory();
    assert.equal(controller.getSnapshot().steers[0]?.status, "applied");
    assert.equal((await controller.listRuns()).length, 1, "runtime reconstruction cannot replay steering");
  } finally { await controller?.shutdown(); await rm(root, { recursive: true, force: true }); }
});
