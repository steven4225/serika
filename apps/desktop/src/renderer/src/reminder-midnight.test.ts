import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createTaskStore } from "@serika/assistant";
import { ApprovalCard } from "./approval.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function waitFor(condition: () => boolean) {
  // Date is frozen; leave timers real and bound polling by attempts instead.
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail("Controller did not reach the expected reminder state");
}

for (const [relative, expectedRunAt] of [
  ["今天", "2026-10-13T07:00:00.000Z"],
  ["明天", "2026-10-14T07:00:00.000Z"],
] as const) {
  test(`Beijing midnight: ${relative}15:00 reaches the rendered approval and persisted task`, { timeout: 15_000 }, async (t) => {
    const previousTZ = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-12T16:30:00.000Z") });
    t.after(() => {
      t.mock.timers.reset();
      if (previousTZ === undefined) delete process.env.TZ;
      else process.env.TZ = previousTZ;
    });
    const root = await mkdtemp(join(tmpdir(), "serika-reminder-midnight-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { task: { enabled: true } } }));
    let calls = 0;
    const model = new MockLanguageModelV3({ doStream: async ({ prompt }) => {
      calls++;
      if (calls > 1) return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ] }) };
      const delivered = JSON.stringify(prompt);
      const local = /The current local time is (\d{4}-\d{2}-\d{2})T[^ ]+([+-]\d{2}:\d{2}) and the local timezone is Asia\/Shanghai/.exec(delivered);
      assert.ok(local, "provider must receive a local calendar date with its offset");
      const request = /(今天|明天)下午3点提醒我开会/.exec(delivered);
      assert.ok(request);
      // Deliberately derive the tool input from the delivered context, not the
      // expected timestamp. This tests plumbing, not real-model comprehension.
      const date = new Date(`${local[1]}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + (request[1] === "明天" ? 1 : 0));
      const runAt = `${date.toISOString().slice(0, 10)}T15:00:00${local[2]}`;
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId: "midnight-create", toolName: "task_create", input: JSON.stringify({
          prompt: "开会", runAt,
          arrangement: { kind: "reminder", source: "none", notification: "always", declarationVersion: 1 },
        }) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ] }) };
    } });
    const output = new PassThrough();
    const app = await createRuntimeApp({
      directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "midnight", configPath: config },
      modelAlias: "mock", model, output, env: {}, cwd: root,
    });
    const controller = createAssistantController(app);
    output.on("data", (chunk: Buffer) => controller.recordOutput(chunk.toString()));
    try {
      assert.ok((await controller.run(`${relative}下午3点提醒我开会`)).ok);
      await waitFor(() => !!controller.getSnapshot().pendingApproval?.preview.includes("时间："));
      const approval = controller.getSnapshot().pendingApproval!;
      assert.equal(approval.toolName, "task_create");
      const before = await createTaskStore(join(workspace, ".runloom/tasks.json")).list({});
      assert.ok(before.ok);
      assert.equal(before.value.tasks.length, 0, "approval preview must not save the reminder");
      const html = renderToStaticMarkup(createElement(ApprovalCard, {
        approval, deciding: false,
        onDecision: () => assert.fail("server rendering must not authorize a tool"),
      }));
      assert.match(html, new RegExp(`<h3>设置提醒：${relative} 15:00 开会</h3>`));
      assert.match(html, new RegExp(`<dt>时间</dt><dd>${relative} 15:00</dd>`));
      assert.doesNotMatch(html, /class="allow" disabled=""/);
      assert.equal(controller.confirm({ approvalId: approval.approvalId, decision: "allow" }), true);
      await waitFor(() => controller.getSnapshot().state.kind === "idle");
      assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
      assert.equal(calls, 2);
      const reopened = createTaskStore(join(workspace, ".runloom/tasks.json"));
      const listed = await reopened.list({});
      assert.ok(listed.ok);
      assert.equal(listed.value.tasks.length, 1);
      const saved = await reopened.get(listed.value.tasks[0]!.id);
      assert.ok(saved.ok);
      assert.equal(saved.value.runAt, expectedRunAt);
      assert.equal(saved.value.prompt, "开会");
      assert.equal(saved.value.arrangement?.kind, "reminder");
      assert.equal(saved.value.status, "scheduled");
      assert.ok((await readFile(join(workspace, ".runloom/tasks.json"), "utf8")).includes(expectedRunAt));
    } finally {
      await controller.shutdown();
    }
  });
}
