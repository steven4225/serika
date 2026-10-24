import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { canSubmitComposer } from "../shared/composer.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for controller state");
    await delay(10);
  }
}

test("desktop chat preempts real background consolidation without approving tools or advancing its cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-background-chat-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "config.json"), JSON.stringify({
    version: 1, workspace,
    modules: { memory: { enabled: true, autoConsolidate: true } },
    run: { totalTimeoutMs: 15_000 },
  }));
  let calls = 0;
  let backgroundAborted = false;
  const model = new MockLanguageModelV3({
    doStream: async options => {
      calls += 1;
      if (calls === 2) {
        try { await delay(60_000, undefined, { signal: options.abortSignal }); }
        finally { backgroundAborted = options.abortSignal?.aborted === true; }
      }
      if (calls === 3) assert.equal(backgroundAborted, true, "foreground must wait for cancellation");
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: "收到" },
        { type: "text-end" as const, id: "text" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ] }) };
    },
  });
  const output = new TeeOutput(() => undefined);
  let bridge: RuntimeBridge | undefined;
  try {
    const app = await createRuntimeApp({
      args: ["--tui", join(root, "transcripts"), "--thread", "chat", "--config", join(root, "config.json")],
      model, modelAlias: "mock", output, cwd: root, env: {},
    });
    const controller = createAssistantController(app);
    output.attach(controller);
    bridge = new RuntimeBridge(app, controller, {
      modelAlias: "mock", temporaryThread: false, temporaryDirectory: false,
    }, output, () => undefined);
    assert.equal((await bridge.run("我习惯先看结论，再看行动步骤。")).ok, true);
    await until(() => calls === 2);
    const snapshot = bridge.snapshot();
    assert.equal(snapshot.canSubmit, true);
    assert.equal(canSubmitComposer(snapshot.state), true);
    assert.equal(canSubmitComposer(snapshot.state, "command"), false);
    assert.equal(snapshot.pendingApproval, null);
    assert.equal((await bridge.run("下一句马上发送", { memoryConsolidation: "exclude" })).ok, true);
    await until(() => bridge!.snapshot().state.kind === "idle");
    assert.equal(calls, 3);
    const cursor = await app.memoryStore!.getConsolidationCursor("chat");
    assert.equal(cursor.ok, true);
    if (cursor.ok) assert.equal(cursor.value, null);
    const history = await bridge.history();
    assert.equal(history.filter(message => message.role === "user").length, 2);
    const records = await controller.listRuns();
    assert.equal(records.filter(run => run.phase === "primary" && run.status === "completed").length, 2);
    assert.equal(records.some(run => run.phase === "consolidation" && run.status === "cancelled"), true);
    const maintenance = await controller.getMemoryMaintenance();
    assert.ok(maintenance.ok);
    assert.notEqual(maintenance.value.consolidation.state, "failed", "ordinary foreground priority is not a consolidation error");
  } finally {
    await bridge?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});


test("another Thread preempts the workspace background owner and deferred consolidation resumes only after foreground settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-cross-thread-background-"));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true } } }));
  let calls = 0, backgroundOwners = 0, peak = 0, firstBackgroundSettled = false;
  let release!: () => void;
  const foreground = new Promise<void>(resolve => { release = resolve; });
  const host = await DesktopRuntime.create({ userData: join(root, "profile"), cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", send: () => {},
    model: new MockLanguageModelV3({ doStream: async options => {
      const current = ++calls;
      if (current === 2 || current >= 4) {
        backgroundOwners++; peak = Math.max(peak, backgroundOwners);
        try { await delay(60_000, undefined, { signal: options.abortSignal }); }
        finally { backgroundOwners--; if (current === 2) firstBackgroundSettled = true; }
      }
      if (current === 3) { assert.equal(firstBackgroundSettled, true); await foreground; }
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] }, { type: "text-start" as const, id: "text" },
        { type: "text-delta" as const, id: "text", delta: "收到" }, { type: "text-end" as const, id: "text" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ] }) };
    } }),
  });
  try {
    const original = host.info().threadId;
    assert.equal((await host.current.run("我希望先看结论。")).ok, true);
    await until(() => calls === 2);
    const other = await host.channelCreateThread();
    await host.selectThread(other.threadId);
    const otherBridge = host.current;
    await host.selectThread(original);
    assert.equal((await otherBridge.run("另一个对话先回答", { memoryConsolidation: "exclude" })).ok, true);
    await until(() => calls === 3);
    assert.equal(backgroundOwners, 0);
    assert.equal(host.info().threadId, original);
    release();
    await until(() => calls >= 4);
    assert.equal(peak, 1, "only one workspace background owner can dispatch");
    assert.equal(host.channelSnapshot(other.threadId).snapshot.state.kind === "running", false);
    const records = await host.channelBridge(original).listRuns();
    assert.ok(records.ok);
    assert.ok(records.runs.some(run => run.phase === "consolidation" && run.status === "cancelled"));
  } finally { release(); await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
