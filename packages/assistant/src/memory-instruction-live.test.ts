import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";

it("opt-in real-model consolidation distinguishes task format from lasting preference", {
  skip: process.env.RUNLOOM_MEMORY_INSTRUCTION_ACCEPTANCE !== "1", timeout: 250_000,
}, async () => {
  const configured = configureCliModel(createDemoModel);
  assert.ok(!configured.modelAlias.startsWith("mock"), "Select a real provider");
  const root = await mkdtemp(join(tmpdir(), "runloom-memory-instruction-"));
  try {
    const cases = [
      { id: "one-off", text: "这次帮我拟一份简短的 Serika 验证计划，分 Goal、Checks、Next 三段。允许自动提出候选，但不要写入正式记忆；本轮直接回复计划，不调用工具。", expected: false },
      { id: "durable", text: "我的长期复盘写作偏好是：先给一行结论，再列两条可执行步骤。可以自动提出待审候选，但不要写入正式记忆。本轮只回复收到，不调用工具。", expected: true },
    ];
    for (const test of cases) {
      const workspace = join(root, test.id); await mkdir(workspace);
      const config = join(root, `${test.id}.json`);
      await writeFile(config, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true } } }));
      const output = new PassThrough(); output.resume();
      const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: test.id, configPath: config }, ...configured, output, env: process.env, cwd: root });
      const controller = createAssistantController(app);
      const phases: string[] = [];
      const statuses: string[] = [];
      const unsubscribe = controller.subscribe(event => {
        if (event.type === "approval") controller.confirm({ approvalId: event.approval.approvalId, decision: "deny" });
        if (event.type === "run-result") {
          phases.push(event.phase);
          statuses.push(event.result.status);
        }
      });
      try {
        const idle = new Promise<void>(resolve => {
          const off = controller.subscribe(event => {
            if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); }
          });
        });
        assert.equal((await controller.run(test.text)).ok, true);
        await idle;
        assert.deepEqual(phases, ["primary", "consolidation"], "both phases must actually run");
        assert.deepEqual(statuses, ["completed", "completed"]);
        const page = await app.memoryStore!.listCandidates({}, undefined, { boundThreadId: app.threadId }); assert.ok(page.ok);
        const texts = page.value.candidates.map(candidate => candidate.change.text);
        console.log(JSON.stringify({ case: test.id, modelAlias: configured.modelAlias, candidates: texts, electronAcceptance: "not_run" }));
        if (test.expected) {
          assert.ok(texts.some(text => text.includes("结论") && text.includes("两条")));
        } else assert.equal(texts.length, 0, "one-off format must not become a lasting preference");
        const memory = await app.memoryStore!.list(); assert.ok(memory.ok);
        assert.equal(memory.entries.length, 0, "no active writes are authorized");
      } finally { unsubscribe(); await controller.shutdown(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
