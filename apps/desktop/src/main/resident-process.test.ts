import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "@serika/example-cli/dist/context-budget.js";
import { ResidentClient } from "./resident-transport.js";
import { residentStartup, saveResidentStartup } from "./resident-startup.js";
import type { PendingApproval } from "../shared/ui-contract.js";

it("the actual headless entry retains Thread, Run receipts and a timer when clients detach, change a capability and switch Thread", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(`${process.platform === "darwin" ? "/private/tmp" : "/tmp"}/serika-process-`);
  const workspace = join(root, "workspace"), userData = join(root, "profile"), configPath = join(root, "config.json");
  const directory = join(root, "state"), identityPath = join(directory, "identity.json"), socket = join(root, "socket", "host.sock");
  const paths = { directory, token: join(directory, "auth-token"), socket };
  const scope = { userData, configPath, workspaceRoot: workspace };
  await mkdir(workspace);
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { pomodoro: { enabled: true }, shell: { enabled: false }, memory: { enabled: false } },
    contextCompaction: { ...DEFAULT_CONTEXT_BUDGET_CONFIG, contextWindowTokens: 512_000 },
    modelContextWindows: [{ provider: "mock-provider", modelId: "mock-model-id", contextWindowTokens: 512_000 }] }));
  await saveResidentStartup(identityPath, residentStartup(userData, root, { RUNLOOM_CONFIG: configPath, RUNLOOM_MODEL: "mock", RUNLOOM_DESKTOP_TEST: "1" }), false);
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./resident-entry.ts", import.meta.url)), "--identity", identityPath, "--socket", socket], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), env: { ...process.env, RUNLOOM_MODEL: "mock" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.stdout.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => done({ code, signal }));
  });
  let client: Awaited<ReturnType<typeof ResidentClient.connect>> | undefined;
  const connect = async () => {
    const deadline = Date.now() + 6000;
    do {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Headless entry exited: ${stderr}`);
      try { return await ResidentClient.connect({ paths, scope, send: () => {} }); }
      catch (error) { if (Date.now() >= deadline) throw new Error(`Host did not connect: ${String(error)} ${stderr}`); }
      await new Promise(done => setTimeout(done, 25));
    } while (true);
  };
  try {
    client = await connect();
    const thread = client.info().threadId, pid = child.pid!;
    assert.equal(client.info().modelAlias, "mock/default", "this is a process/lifecycle test, not real-provider evidence");
    assert.deepEqual(await client.current.command("/pomodoro start 3"), { ok: true });
    assert.equal((await client.getLifecycleStatus()).pomodoroRunning, true);
    const started = await client.current.run("计算 20 + 22", { memoryConsolidation: "exclude" });
    assert.equal(started.ok, true);
    client.detach();
    process.kill(pid, 0);
    client = await connect();
    const deadline = Date.now() + 5000;
    while (client.current.snapshot().state.kind !== "idle") {
      const approval: PendingApproval | null = client.current.snapshot().pendingApproval;
      if (approval) assert.equal((await client.current.confirm({ approvalId: approval.approvalId, decision: "allow" })).accepted, true);
      if (Date.now() > deadline) throw new Error("Mock Run did not finish");
      await new Promise(done => setTimeout(done, 5)); await client.refresh();
    }
    const runs = await client.current.listRuns();
    assert.equal(runs.ok, true);
    if (runs.ok && started.ok) { assert.equal(runs.runs.length, 1); assert.equal(runs.runs[0]?.runId, started.runId); }
    assert.equal(client.info().threadId, thread);
    assert.equal((await client.getLifecycleStatus()).pomodoroRunning, true);
    await client.setModuleEnabled({ id: "shell", enabled: true, expectedEnabled: false });
    assert.equal(client.info().modules?.find(module => module.id === "shell")?.enabled, true);
    assert.equal((await client.getLifecycleStatus()).pomodoroRunning, true);
    const beforeMode = await client.current.getContextDiagnostics(); assert(beforeMode.ok);
    await client.setContextMode({ mode: "long-task", expectedBudget: beforeMode.value.budget });
    const afterMode = await client.current.getContextDiagnostics(); assert(afterMode.ok);
    assert.equal(afterMode.value.budget.mode, "long-task"); assert.equal(afterMode.value.budget.inputBudgetTokens, 400_000);
    assert.equal(afterMode.value.budget.contextWindowTokens, 512_000, "resident mode selection must preserve configured capacity");
    assert.equal((await client.getLifecycleStatus()).pomodoroRunning, true, "mode selection must not end the independent timer");
    client.detach(); client = await connect();
    const reconnectedMode = await client.current.getContextDiagnostics(); assert(reconnectedMode.ok);
    assert.equal(reconnectedMode.value.budget.mode, "long-task");
    await client.createThread({ preserveDraft: true });
    assert.notEqual(client.info().threadId, thread);
    await client.current.command("/pomodoro status");
    assert.match(client.current.snapshot().recentOutput, /番茄钟运行中，剩余/);
    assert.equal((await client.getLifecycleStatus()).pomodoroRunning, true);
    await assert.rejects(client.requestStop(), /番茄钟/);
    await client.current.command("/pomodoro cancel");
    await client.requestStop();
    const exit = await exited;
    assert.equal(exit.code, 0, stderr);
    assert.equal(exit.signal, null);
  } finally {
    client?.detach();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited.catch(() => undefined), new Promise(done => setTimeout(done, 1000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited.catch(() => undefined); }
    await rm(root, { recursive: true, force: true });
  }
});
