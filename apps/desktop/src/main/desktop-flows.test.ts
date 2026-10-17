import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createRuntimeApp } from "@serika/example-cli/dist/app.js";
import { createAssistantController } from "@serika/example-cli/dist/assistant-controller.js";
import { EXECUTION_RECORD_FILE } from "@serika/example-cli/dist/execution-record-store.js";
import { createDemoModel } from "@serika/example-cli/dist/demo-model.js";
import type { MainToRenderer } from "../shared/ui-contract.js";
import { completedOutcome, runStatusLabel, toolStatusLabel } from "../shared/execution-records.js";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
  label = "desktop flow",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(20);
  }
}

async function prepareRoot(): Promise<{ root: string; workspace: string; transcripts: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "runloom-desktop-flow-"));
  const workspace = join(root, "workspace");
  const transcripts = join(root, "transcripts");
  await mkdir(workspace);
  await mkdir(transcripts);
  const configPath = join(root, "runloom.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    workspace: "./workspace",
    modules: {
      "read-file": { enabled: true },
      shell: { enabled: true, timeoutMs: 8_000 },
    },
    run: { totalTimeoutMs: 15_000 },
  }), "utf8");
  return { root, workspace, transcripts, configPath };
}

async function openDesktop(
  root: string,
  model: LanguageModel,
  thread = "desktop-preview",
) {
  const messages: MainToRenderer[] = [];
  const send = (message: MainToRenderer): void => {
    messages.push(message);
  };
  const output = new TeeOutput(send);
  const app = await createRuntimeApp({
    args: ["--tui", join(root, "transcripts"), "--thread", thread, "--config", join(root, "runloom.json")],
    modelAlias: "mock",
    model,
    output,
    env: {},
    cwd: root,
  });
  const controller = createAssistantController(app);
  output.attach(controller);
  const bridge = new RuntimeBridge(
    app,
    controller,
    { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false },
    output,
    send,
  );
  return { bridge, messages, app };
}

function textModel(text: string): LanguageModel {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "answer" },
          { type: "text-delta" as const, id: "answer", delta: text },
          { type: "text-end" as const, id: "answer" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ],
      }),
    }),
  });
}

describe("desktop frontend flows", { concurrency: false }, () => {
  it("starts a Run and treats run() as a start result, not the task outcome", async () => {
    const { root } = await prepareRoot();
    const { bridge } = await openDesktop(root, textModel("42"));
    try {
      const listed = await bridge.listRuns();
      assert.equal(listed.ok, true);
      if (listed.ok) assert.deepEqual(listed.runs, []);

      const started = await bridge.run("What is 20 + 22?");
      assert.equal(started.ok, true);
      if (started.ok) assert.equal(typeof started.runId, "string");
      await waitFor(() => bridge.snapshot().state.kind === "idle", 8_000, "idle after text run");
      assert.equal(bridge.snapshot().lastPrimaryResult?.status, "completed");
      const after = await bridge.listRuns();
      assert.equal(after.ok, true);
      if (after.ok) assert.equal(after.runs[0]?.phase, "primary");
    } finally {
      await bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a completed write_file receipt on a failed Run after restart", async () => {
    const { root, workspace } = await prepareRoot();
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          return { stream: simulateReadableStream({ chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: "write-1",
              toolName: "write_file",
              input: JSON.stringify({ path: "notes.md", content: "saved-before-fail" }),
            },
            { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
          ] }) };
        }
        throw new Error("forced failure after write");
      },
    });
    const first = await openDesktop(root, model);
    try {
      const started = await first.bridge.run("Write notes.md then fail");
      assert.equal(started.ok, true);
      await waitFor(() => first.bridge.snapshot().pendingApproval !== null, 8_000, "write_file approval");
      const pending = first.bridge.snapshot().pendingApproval;
      assert.ok(pending);
      assert.equal(first.bridge.confirm({ approvalId: "stale-id", decision: "allow" }).accepted, false);
      assert.equal(first.bridge.confirm({ approvalId: pending.approvalId, decision: "allow" }).accepted, true);
      assert.equal(first.bridge.confirm({ approvalId: pending.approvalId, decision: "allow" }).accepted, false);
      await waitFor(() => first.bridge.snapshot().state.kind === "idle", 8_000, "idle after failed write run");
      assert.equal(first.bridge.snapshot().lastPrimaryResult?.status, "failed");
      assert.equal(await readFile(join(workspace, "notes.md"), "utf8"), "saved-before-fail");
      const listed = await first.bridge.listRuns();
      assert.equal(listed.ok, true);
      if (!listed.ok) throw new Error("listRuns failed");
      const record = listed.runs[0];
      assert.equal(record?.status, "failed");
      assert.equal(record?.tools[0]?.toolName, "write_file");
      assert.equal(record?.tools[0]?.status, "completed");
      assert.equal(record && completedOutcome(record.tools[0]!), "ok:true");
    } finally {
      await first.bridge.shutdown();
    }

    const second = await openDesktop(root, createDemoModel());
    try {
      const listed = await second.bridge.listRuns();
      assert.equal(listed.ok, true);
      if (!listed.ok) throw new Error("reopen listRuns failed");
      const runId = listed.runs[0]?.runId;
      assert.ok(runId);
      const opened = await second.bridge.getRun(runId);
      assert.equal(opened.ok, true);
      if (!opened.ok || opened.run === null) throw new Error("getRun missing");
      assert.equal(opened.run.status, "failed");
      assert.equal(opened.run.tools[0]?.status, "completed");
      assert.equal(await readFile(join(workspace, "notes.md"), "utf8"), "saved-before-fail");
    } finally {
      await second.bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows live Shell progress, then unknown after a crash snapshot, without re-running the command", async () => {
    const { root, workspace, transcripts } = await prepareRoot();
    const marker = join(workspace, "starts.txt");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`const {appendFileSync}=require('fs'); appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('started'); setInterval(() => {}, 1000)`)}`;
    let calls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          return { stream: simulateReadableStream({ chunks: [
            { type: "stream-start" as const, warnings: [] },
            {
              type: "tool-call" as const,
              toolCallId: "shell-1",
              toolName: "shell_exec",
              input: JSON.stringify({ command }),
            },
            { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
          ] }) };
        }
        return { stream: simulateReadableStream({ chunks: [
          { type: "stream-start" as const, warnings: [] },
          { type: "text-start" as const, id: "answer" },
          { type: "text-delta" as const, id: "answer", delta: "still running" },
          { type: "text-end" as const, id: "answer" },
          { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
        ] }) };
      },
    });
    const first = await openDesktop(root, model);
    let snapshot = "";
    try {
      const started = await first.bridge.run("Hang in the shell");
      assert.equal(started.ok, true);
      if (!started.ok) throw new Error("run did not start");
      await waitFor(() => first.bridge.snapshot().pendingApproval !== null, 12_000, "shell_exec approval");
      const pending = first.bridge.snapshot().pendingApproval;
      assert.ok(pending);
      assert.equal(first.bridge.confirm({ approvalId: pending.approvalId, decision: "allow" }).accepted, true);
      await waitFor(
        () => first.messages.some((message) => message.type === "shell-progress"),
        8_000,
        "shell-progress event",
      );
      await waitFor(async () => {
        if (!started.ok) return false;
        const opened = await first.bridge.getRun(started.runId);
        return opened.ok && opened.run?.tools[0]?.status === "started";
      }, 8_000, "started shell receipt");
      snapshot = await readFile(join(transcripts, EXECUTION_RECORD_FILE), "utf8");
    } finally {
      await first.bridge.shutdown();
    }

    await writeFile(join(transcripts, EXECUTION_RECORD_FILE), snapshot);
    const beforeReopen = await readFile(marker, "utf8");
    const second = await openDesktop(root, createDemoModel());
    try {
      const listed = await second.bridge.listRuns();
      assert.equal(listed.ok, true);
      if (!listed.ok) throw new Error("crash reopen listRuns failed");
      assert.equal(runStatusLabel(listed.runs[0]!.status), "已中断");
      assert.equal(listed.runs[0]?.tools[0]?.status, "unknown");
      assert.equal(toolStatusLabel(listed.runs[0]!.tools[0]!.status), "需人工核对");
      await delay(400);
      assert.equal(await readFile(marker, "utf8"), beforeReopen);
    } finally {
      await second.bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels while state is running, including before runId is assigned", async () => {
    const { root } = await prepareRoot();
    const model = new MockLanguageModelV3({
      doStream: async () => {
        await delay(3_000);
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "answer" },
              { type: "text-delta" as const, id: "answer", delta: "too late" },
              { type: "text-end" as const, id: "answer" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
            ],
          }),
        };
      },
    });
    const { bridge } = await openDesktop(root, model);
    try {
      const startedPromise = bridge.run("slow start");
      await waitFor(() => bridge.snapshot().state.kind === "running", 1_000, "running before cancel");
      const duringStart = bridge.snapshot().state;
      assert.equal(duringStart.kind, "running");
      await bridge.cancel();
      const started = await startedPromise;
      await waitFor(() => bridge.snapshot().state.kind === "idle", 8_000, "idle after cancel");
      const result = bridge.snapshot().lastPrimaryResult;
      if (started.ok) {
        assert.equal(result?.status, "cancelled");
        const listed = await bridge.listRuns();
        assert.equal(listed.ok, true);
        if (listed.ok) assert.equal(listed.runs[0]?.status, "cancelled");
      } else {
        assert.equal(started.reason, "starting");
      }
    } finally {
      await bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces a corrupt execution file as unavailable, not an empty list", async () => {
    const { root, transcripts } = await prepareRoot();
    const first = await openDesktop(root, createDemoModel());
    await first.bridge.shutdown();
    await writeFile(join(transcripts, EXECUTION_RECORD_FILE), "{broken");
    const second = await openDesktop(root, createDemoModel());
    try {
      const listed = await second.bridge.listRuns();
      assert.equal(listed.ok, false);
      if (listed.ok) throw new Error("corrupt file should not look like empty history");
      assert.equal(listed.reason, "unavailable");
    } finally {
      await second.bridge.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
