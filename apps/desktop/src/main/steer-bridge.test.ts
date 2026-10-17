import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import { IPC, type MainToRenderer } from "../shared/ui-contract.js";
import { IPC_FORWARDS, forwardChannel } from "../shared/ipc-forwards.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } };
async function until(check: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Steer bridge timed out"); await delay(10); }
}
async function open(root: string, model: LanguageModel) {
  const messages: MainToRenderer[] = [];
  const send = (message: MainToRenderer) => { messages.push(message); };
  const output = new TeeOutput(send);
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { threadId: "steer", configPath: join(root, "config.json") },
    modelAlias: "mock", model, output, cwd: root, env: {} });
  const controller = createAssistantController(app);
  output.attach(controller);
  return { bridge: new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, send), messages };
}

it("wires a distinct typed Steer IPC route and strips renderer authority", async () => {
  const main = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const preload = await readFile(new URL("../preload/index.ts", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.handle\(IPC\.steer,.*drafts\.steer\(input\)/);
  assert.match(preload, /steer: input => ipcRenderer\.invoke\(IPC\.steer, input\)/);
  assert.equal(IPC_FORWARDS.current.run, 2);
  assert.notEqual(IPC.steer, forwardChannel("current", "run"));
});

it("supersedes pending approval in the same Run, persists statuses, and never authorizes the replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-steer-"));
  await mkdir(join(root, "workspace"));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, workspace: join(root, "workspace"), modules: { "read-file": { enabled: true } }, run: { totalTimeoutMs: 15_000 } }));
  let calls = 0;
  let observedSteer = false;
  const model = new MockLanguageModelV3({ doStream: async options => {
    calls++;
    observedSteer ||= JSON.stringify(options.prompt).includes("只追加两条行动");
    if (calls <= 2) return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: `write-${calls}`, toolName: "write_file", input: JSON.stringify({ path: "notes.md", content: calls === 1 ? "old proposal" : "一行结论\n1. 行动一\n2. 行动二" }) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
    ] }) };
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start" as const, warnings: [] },
      { type: "text-start" as const, id: "answer" }, { type: "text-delta" as const, id: "answer", delta: "done" }, { type: "text-end" as const, id: "answer" },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
    ] }) };
  } });
  let fixture = await open(root, model);
  try {
    const started = await fixture.bridge.run("Write notes.md");
    assert.ok(started.ok); if (!started.ok) return;
    await until(() => fixture.bridge.snapshot().pendingApproval !== null);
    const old = fixture.bridge.snapshot().pendingApproval!;
    assert.equal(fixture.bridge.snapshot().canSteer, true);
    const request = { expectedRunId: started.runId, id: "request-1", text: "保留原文，只追加两条行动" };
    const result = await fixture.bridge.steer({ ...request, permissions: ["write_file"], decision: "allow" } as typeof request);
    assert.ok(result.ok);
    await until(() => fixture.bridge.snapshot().pendingApproval !== null && fixture.bridge.snapshot().pendingApproval?.approvalId !== old.approvalId);
    assert.equal(fixture.bridge.confirm({ approvalId: old.approvalId, decision: "allow" }).accepted, false);
    await assert.rejects(readFile(join(root, "workspace", "notes.md")), { code: "ENOENT" });
    const current = fixture.bridge.snapshot();
    assert.equal(current.state.kind === "running" && current.state.runId, started.runId);
    assert.equal(current.steers[0]?.status, "applied");
    assert.equal(observedSteer, true);
    assert.equal((await fixture.bridge.steer(request)).ok, true);
    assert.equal(fixture.bridge.snapshot().steers.length, 1);
    assert.equal((await fixture.bridge.steer({ ...request, text: "different" })).ok, false);
    fixture.bridge.confirm({ approvalId: current.pendingApproval!.approvalId, decision: "allow" });
    await until(() => fixture.bridge.snapshot().state.kind === "idle");
    assert.equal(await readFile(join(root, "workspace", "notes.md"), "utf8"), "一行结论\n1. 行动一\n2. 行动二");
    const record = await fixture.bridge.getRun(started.runId);
    assert.ok(record.ok && record.run);
    if (record.ok && record.run) {
      assert.equal(record.run.tools[0]?.status, "not_started");
      assert.equal(record.run.tools[1]?.status, "completed");
      assert.equal(record.run.steers?.[0]?.status, "applied");
    }
    assert.ok(fixture.messages.some(message => message.type === "approval-cleared" && message.approvalId === old.approvalId));
    assert.ok(fixture.messages.some(message => message.type === "steer" && message.steer.status === "applied"));
    await fixture.bridge.shutdown();
    fixture = await open(root, model);
    const history = await fixture.bridge.history();
    assert.ok(history.some(message => message.role === "user" && JSON.stringify(message.parts).includes(request.text)));
    assert.equal(fixture.bridge.snapshot().steers[0]?.status, "applied");
    assert.equal(fixture.bridge.snapshot().canSteer, false);
    assert.equal(calls, 3, "recovery must not replay or invoke model");
    assert.equal((await fixture.bridge.steer({ ...request, id: "new-request" })).ok, false);
  } finally { await fixture.bridge.shutdown(); await rm(root, { recursive: true, force: true }); }
});
