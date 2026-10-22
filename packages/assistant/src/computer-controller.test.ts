import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "./app.js";
import { createAssistantController, type AssistantController } from "./assistant-controller.js";

const target = { bundleId: "com.apple.TextEdit", pid: 123, windowId: 456 };
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
function observationId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if ("observationId" in value && typeof value.observationId === "string") return value.observationId;
  for (const child of Object.values(value)) {
    const id = observationId(child);
    if (id) return id;
  }
  return undefined;
}
async function waitFor(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for fixture");
    await delay(5);
  }
}

describe("Computer Controller fault boundaries (controlled driver, not native desktop)", () => {
  for (const mode of ["deny", "cancel-approval", "disconnect", "cancel-dispatched"] as const) {
    it(`retains honest receipts and never replays after ${mode}`, { skip: process.platform !== "darwin" }, async () => {
      const root = await mkdtemp(join(tmpdir(), "runloom-computer-controller-"));
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const executable = join(root, "driver.cjs");
      const callsPath = join(root, "calls.jsonl");
      const effectPath = join(root, "effect.txt");
      await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
let text = '';
process.stdin.on('data', c => text += c);
process.stdin.on('end', () => {
  const name = process.argv[3];
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({name}) + '\\n');
  if (name === 'list_apps') return console.log(JSON.stringify({apps:[{pid:123,bundle_id:'com.apple.TextEdit',running:true}]}));
  if (name === 'list_windows') return console.log(JSON.stringify({windows:[{pid:123,window_id:456,title:'fixture'}]}));
  if (name === 'get_window_state') return console.log(JSON.stringify({pid:123,window_id:456,elements:[{element_index:0,role:'AXWindow'},{element_index:1,parent_index:0,role:'AXTextArea',element_token:'fixture-text',value:'before'}]}));
  fs.writeFileSync(${JSON.stringify(effectPath)}, JSON.parse(text).text);
  if (${JSON.stringify(mode)} === 'disconnect') return console.log('broken receipt after effect');
  setInterval(() => {}, 1000);
});
`);
      await chmod(executable, 0o700);
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: {
        computer: { enabled: true, executable, allowedBundleIds: [target.bundleId] },
      } }));
      let modelCalls = 0;
      const model = new MockLanguageModelV3({ doStream: async (params) => {
        const step = modelCalls++;
        const toolName = step === 0 ? "computer_observe" : "computer_action";
        const input = step === 0 ? target : { ...target, observationId: observationId(params.prompt),
          elementToken: "fixture-text", action: "type_text", text: "controlled-effect" };
        const chunks = step < 2 ? [
          { type: "stream-start" as const, warnings: [] },
          { type: "tool-call" as const, toolCallId: `fixture-${step}`, toolName, input: JSON.stringify(input) },
          { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
        ] : [
          { type: "stream-start" as const, warnings: [] },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ];
        return { stream: simulateReadableStream<(typeof chunks)[number]>({ chunks }) };
      } });
      const output = new PassThrough();
      let controller: AssistantController | undefined;
      output.on("data", (chunk: Buffer) => controller?.recordOutput(chunk.toString()));
      const options = { directory: join(root, "transcripts"), assistant: { dataDirectory: join(workspace, ".runloom"), threadId: "computer-fault", configPath },
        modelAlias: "mock", model, output, env: process.env, cwd: root };
      controller = createAssistantController(await createRuntimeApp(options));
      const approvals = new Set<string>();
      let cancelled: Promise<void> | undefined;
      let oldApproval: string | undefined;
      controller.subscribe(event => {
        if (event.type !== "approval" || !event.approval.preview.trim() || approvals.has(event.approval.approvalId)) return;
        approvals.add(event.approval.approvalId);
        if (event.approval.toolName === "computer_action") {
          oldApproval = event.approval.approvalId;
          if (mode === "cancel-approval") { cancelled = controller!.cancel(); return; }
        }
        controller!.confirm({ approvalId: event.approval.approvalId,
          decision: event.approval.toolName === "computer_action" && mode === "deny" ? "deny" : "allow" });
      });
      try {
        const created = await controller.workTasks.create({ goal: "Controlled Computer effect",
          constraints: [], acceptance: [{ id: "review", description: "Human checks the document",
            method: "human", verification: { kind: "human" }, required: true }] });
        assert.ok(created.ok);
        const started = await controller.workTasks.run({ id: created.value.id, expectedRevision: created.value.revision });
        assert.ok(started.ok);
        if (mode === "cancel-dispatched") {
          await waitFor(async () => readFile(effectPath, "utf8").then(() => true, () => false));
          await controller.cancel();
        }
        await waitFor(() => controller!.getSnapshot().state.kind === "idle");
        await cancelled;
        assert.equal(controller.confirm({ approvalId: oldApproval!, decision: "allow" }), false);
        const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
        const dispatched = mode === "disconnect" || mode === "cancel-dispatched";
        assert.equal(calls.filter(call => call.name === "type_text").length, dispatched ? 1 : 0);
        if (dispatched) assert.equal(await readFile(effectPath, "utf8"), "controlled-effect");
        else await assert.rejects(readFile(effectPath), { code: "ENOENT" });
        const run = await controller.runs.get(started.runId);
        const action = run?.tools.find(tool => tool.toolName === "computer_action");
        const expected = dispatched ? "unknown" : mode === "deny" ? "failed" : "not_started";
        assert.equal(action?.status, expected);
        assert.equal(run?.status, mode === "deny" ? "completed" : mode === "disconnect" ? "failed" : "cancelled");
        if (mode === "disconnect") {
          assert.equal(controller.getSnapshot().lastPrimaryResult?.error?.code, "TOOL_OUTCOME_UNKNOWN");
          assert.equal(controller.getSnapshot().toolActivity.find(tool => tool.toolName === "computer_action")?.outcomeUnknown, true);
        }
        assert.equal(modelCalls, mode === "deny" ? 3 : 2);
        const task = await controller.workTasks.get(created.value.id);
        assert.equal(task.ok && task.value.status, dispatched ? "needs_review" : "paused");
        await controller.shutdown();
        controller = createAssistantController(await createRuntimeApp(options));
        assert.equal((await controller.runs.get(started.runId))?.tools.find(tool => tool.toolName === "computer_action")?.status, expected);
        assert.equal(modelCalls, mode === "deny" ? 3 : 2);
      } finally {
        await controller.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
