import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { DesktopRuntime } from "./desktop-runtime.js";
import { ResidentClient, createResidentPaths, startResidentServer } from "./resident-transport.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for resident execution boundary");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const detachAt of ["executing", "awaiting-approval"] as const) {
  test(`detaching while ${detachAt} preserves the same approval and approved Shell Run without cancellation or replay`, async () => {
    const root = await mkdtemp(`${process.platform === "darwin" ? "/private/tmp" : "/tmp"}/serika-inflight-`);
    const workspace = join(root, "workspace"), applicationHome = join(root, "profile"), configPath = join(root, "config.json");
    await mkdir(workspace);
    await writeFile(configPath, JSON.stringify({ version: 1, authorizedDirectory: workspace,
      modules: { shell: { enabled: true, timeoutMs: 2_000 }, memory: { enabled: false } }, run: { totalTimeoutMs: 5_000 } }));
    const paths = createResidentPaths(applicationHome, join(root, "socket", "host.sock"));
    const scope = { applicationHome, configPath };
    let modelCalls = 0, hostCreates = 0;
    const model = new MockLanguageModelV3({ doStream: async () => {
      modelCalls++;
      if (modelCalls === 1) return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId: "resident-sleep-once", toolName: "shell_exec", input: JSON.stringify({ command: "/bin/sleep 0.2" }) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ] }) };
      assert.equal(modelCalls, 2, "reconnect must not repeat a model step");
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "result" },
        { type: "text-delta" as const, id: "result", delta: "已完成这次已批准的等待。" },
        { type: "text-end" as const, id: "result" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ] }) };
    } });
    const server = await startResidentServer({ paths, scope, createRuntime: send => {
      hostCreates++;
      return DesktopRuntime.create({ applicationHome, cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock", model, send });
    } });
    const client = await ResidentClient.connect({ paths, scope, send: () => undefined });
    try {
      const launched = await client.current.run("只执行这一次 /bin/sleep 0.2", { memoryConsolidation: "exclude" });
      assert.equal(launched.ok, true);
      if (!launched.ok) throw new Error("Run did not start");
      await until(() => server.runtime.current.snapshot().pendingApproval !== null);
      const approval = server.runtime.current.snapshot().pendingApproval;
      assert.ok(approval);
      assert.equal(approval.toolName, "shell_exec");
      assert.deepEqual(approval.input, { command: "/bin/sleep 0.2" });
      const requested = await server.runtime.current.getRun(launched.runId);
      assert.ok(requested.ok && requested.run);
      assert.match(requested.run.tools[0]!.inputPreview, /\/bin\/sleep 0\.2/);

      if (detachAt === "awaiting-approval") {
        client.detach();
        await new Promise(resolve => setTimeout(resolve, 30));
        const waiting = await server.runtime.current.getRun(launched.runId);
        assert.ok(waiting.ok && waiting.run);
        assert.equal(waiting.run.status, "running");
        assert.equal(waiting.run.tools.length, 1);
        assert.equal(waiting.run.tools[0]!.startedAt, null);
        assert.equal(waiting.run.tools[0]!.shell, null);
        assert.equal(modelCalls, 1);
        await client.reconnect();
        assert.equal(client.current.snapshot().pendingApproval?.approvalId, approval.approvalId);
        assert.equal(client.current.snapshot().state.kind, "running");
      }

      assert.deepEqual(await client.current.confirm({ approvalId: approval.approvalId, decision: "allow" }), { accepted: true });
      if (detachAt === "executing") {
        await until(async () => {
          const current = await server.runtime.current.getRun(launched.runId);
          return current.ok && current.run?.tools[0]?.status === "started";
        });
        assert.equal(server.runtime.current.snapshot().state.kind, "running");
        client.detach();
      }
      await until(() => server.runtime.current.snapshot().state.kind === "idle");
      await client.reconnect();
      const result = await client.current.getRun(launched.runId);
      assert.ok(result.ok && result.run);
      assert.equal(result.run.runId, launched.runId);
      assert.equal(result.run.status, "completed");
      assert.equal(result.run.tools.length, 1);
      assert.equal(result.run.tools[0]!.toolCallId, "resident-sleep-once");
      assert.equal(result.run.tools[0]!.status, "completed");
      assert.deepEqual(result.run.tools[0]!.shell, { exitCode: 0, timedOut: false, cancelled: false });
      assert.equal(client.current.snapshot().lastPrimaryResult?.text, "已完成这次已批准的等待。");
      assert.equal(client.current.snapshot().pendingApproval, null);
      assert.deepEqual(await client.current.confirm({ approvalId: approval.approvalId, decision: "allow" }), { accepted: false });
      const runs = await client.current.listRuns();
      assert.ok(runs.ok);
      assert.equal(runs.runs.length, 1);
      assert.equal(modelCalls, 2);
      assert.equal(hostCreates, 1);
    } finally { client.detach(); await server.runtime.shutdown(); await server.close(); await rm(root, { recursive: true, force: true }); }
  });
}
