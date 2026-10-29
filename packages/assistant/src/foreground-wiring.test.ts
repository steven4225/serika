import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { hashCanonicalJson } from "@serika/core";
import { createRuntimeApp } from "./app.js";
import { createAssistantController } from "./assistant-controller.js";
import { formatCapabilitySummary } from "./capability-status.js";
import { FOREGROUND_INSTRUCTIONS, AUTONOMOUS_INSTRUCTIONS } from "./foreground-autonomy.js";
import { createCompactionChecklist } from "./compaction-records.js";
import { createExecutionRecordStore } from "./execution-record-store.js";

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined } };
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

for (const source of ["desktop", "telegram"] as const) test(`${source} ordinary foreground captures its request, discovers through Shell with terminal disabled and continues after approval`, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-foreground-wiring-"));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json");
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }],
    modules: { shell: { enabled: true }, terminal: { enabled: false } } }));
  const systems: string[] = [], observed: string[] = [];
  let calls = 0;
  const app = await createRuntimeApp({ cwd: root, env: {}, directory: join(root, "transcripts"), output: new PassThrough(),
    assistant: { configPath, threadId: "thread", dataDirectory: join(workspace, ".runloom") }, modelAlias: "scripted",
    model: new MockLanguageModelV3({ doStream: async options => {
      systems.push(JSON.stringify(options.prompt.filter(message => message.role === "system")));
      observed.push(JSON.stringify(options.prompt));
      assert.ok(options.tools?.some(tool => tool.name === "shell_exec"));
      assert.ok(!options.tools?.some(tool => tool.name === "terminal_exec"));
      const first = calls++ === 0;
      return { stream: simulateReadableStream({ chunks: [{ type: "stream-start" as const, warnings: [] },
        ...(first ? [{ type: "tool-call" as const, toolCallId: "discover", toolName: "shell_exec",
          input: JSON.stringify({ command: `${quote(process.execPath)} --version` }) }] : []),
        { type: "finish" as const, finishReason: { unified: first ? "tool-calls" as const : "stop" as const, raw: undefined }, usage }] }) };
    } }) });
  const controller = createAssistantController(app), approvals: string[] = [];
  controller.subscribe(event => {
    if (event.type === "approval" && event.approval.preview) {
      approvals.push(event.approval.toolName);
      controller.confirm({ approvalId: event.approval.approvalId, decision: "allow" });
    }
  });
  const run = async (text: string) => {
    const done = new Promise<void>(resolve => { const off = controller.subscribe(event => {
      if (event.type === "state" && event.state.kind === "idle") { off(); resolve(); }
    }); });
    const started = await controller.run(text, source === "telegram" ? { source } : { desktopEntry: true });
    assert.ok(started.ok); await done;
    assert.equal(controller.getSnapshot().lastPrimaryResult?.status, "completed");
    return started.runId;
  };
  try {
    const firstRun = await run("查本机 Node 版本，查到就交付");
    assert.equal(calls, 2);
    assert.match(observed[1]!, new RegExp(process.version.replaceAll(".", "\\.")));
    assert.deepEqual(approvals, ["shell_exec"]);
    assert.match(systems[0]!, /command -v/);
    assert.ok(systems.every(system => system.includes(JSON.stringify(FOREGROUND_INSTRUCTIONS).slice(1, -1))));
    assert.ok(systems.every(system => !system.includes(AUTONOMOUS_INSTRUCTIONS.slice(0, 65))));
    assert.equal(systems[0], systems[1], "unchanged registration and authorization keep the complete system bytes stable");
    const receipt = await controller.runs.get(firstRun);
    assert.equal(receipt?.tools[0]?.shell?.exitCode, 0);
    const messages = await app.store.getMessages("thread");
    const first = messages.find(message => message.role === "user")!;
    assert.match(JSON.stringify(first.metadata), /runloom-foreground-task/);
    assert.equal(app.getCapabilities!().execution.files, "scoped_grants_or_confirmation");
    const block = formatCapabilitySummary(app.getCapabilities!());
    assert.equal(hashCanonicalJson(block), hashCanonicalJson(formatCapabilitySummary(app.getCapabilities!())));
    assert.equal(app.getCapabilities!().execution.shell.authorization, "per_call_confirmation");
    await run("这是下一轮任务");
    const next = (await app.store.getMessages("thread")).filter(message => message.role === "user").at(-1)!;
    assert.doesNotMatch(JSON.stringify(next.metadata), /查本机 Node/);
    app.beginForegroundExecution?.("desktop");
    const handle = await app.runtime.run({ agentId: app.agentId, threadId: "thread", messages: [{ id: "no-request", role: "user", parts: [{ type: "text", text: "无任务锚" }] }] });
    assert.equal((await handle.result).status, "completed");
    assert.doesNotMatch(JSON.stringify((await app.store.getMessages("thread")).find(message => message.id === "no-request")?.metadata ?? {}), /runloom-foreground-task/);
    await app.endForegroundExecution?.();
  } finally { await controller.shutdown(); app.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("bounded compaction checklist retains successful CLI evidence and failed/unknown status from real host receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-discovery-receipts-"));
  try {
    const records = createExecutionRecordStore(root);
    await records.startRun({ runId: "run", threadId: "thread", phase: "primary" });
    let sequence = 0;
    for (const [id, outcome] of [["version", "completed"], ["help", "completed"], ["bad", "failed"], ["uncertain", "unknown"]] as const) {
      await records.recordToolEvent("run", {
        id: `${id}-tool.call.requested`, type: "tool.call.requested", runId: "run", threadId: "thread", sequence: ++sequence, occurredAt: new Date(0).toISOString(),
        data: { toolCallId: id, toolName: "shell_exec", input: { command: `pi --${id}`, cwd: "." } },
      });
      await records.recordToolEvent("run", {
        id: `${id}-tool.call.started`, type: "tool.call.started", runId: "run", threadId: "thread", sequence: ++sequence, occurredAt: new Date(0).toISOString(),
        data: { toolCallId: id, toolName: "shell_exec" },
      });
      if (outcome === "unknown") continue;
      await records.recordToolEvent("run", outcome === "completed" ? {
        id, type: "tool.call.completed", runId: "run", threadId: "thread", sequence: ++sequence, occurredAt: new Date(0).toISOString(),
        data: { toolCallId: id, toolName: "shell_exec", output: { ok: true, exitCode: 0, output: id === "version" ? "pi fixture 1.0" : "Usage: pi [options]" } },
      } : { id, type: "tool.call.failed", runId: "run", threadId: "thread", sequence: ++sequence, occurredAt: new Date(0).toISOString(),
        data: { toolCallId: id, toolName: "shell_exec", error: { code: "TOOL_EXECUTION_FAILED", message: "fixture failure", retryable: false, phase: "tool" } } });
    }
    await records.recoverInterrupted("thread");
    const checklist = createCompactionChecklist({ messages: [], permissions: undefined, runs: await records.listRuns("thread"), maxTokens: 2000 });
    const text = JSON.stringify(checklist);
    assert.match(text, /pi fixture 1.0/); assert.match(text, /Usage: pi/); assert.match(text, /pi --version/);
    assert.match(text, /uncertain.*unknown/); assert.match(text, /bad.*failed/); assert.match(text, /exitCode/);
    assert.equal((await records.listRuns("thread"))[0]?.tools.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
