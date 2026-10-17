import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { it } from "node:test";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { createRuntimeApp } from "./app.js";
import { createTaskStore, TASK_FILE_NAME } from "./task-store.js";
import { createTaskModule } from "./modules/task-module.js";
import { createModuleHost } from "./module-host.js";
import { createWorkspaceTaskReadApproval } from "./workspace-task-read-policy.js";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

async function fixture(allowWorkspaceTaskReads: boolean) {
  const root = await mkdtemp(join(tmpdir(), "serika-task-read-policy-"));
  const workspace = join(root, "workspace"), foreignWorkspace = join(root, "foreign");
  await mkdir(workspace); await mkdir(foreignWorkspace);
  const taskStore = createTaskStore(workspace);
  const own = await taskStore.create({ prompt: "本工作区喝水", runAt: new Date(Date.now() + 60_000).toISOString() });
  const foreign = await createTaskStore(foreignWorkspace).create({ prompt: "外部工作区私密提醒", runAt: new Date(Date.now() + 60_000).toISOString() });
  assert.ok(own.ok && foreign.ok);
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: {
    task: { enabled: true }, "read-file": { enabled: true }, shell: { enabled: true },
  } }));
  let currentCall = { name: "task_list", input: {} as unknown }, calls = 0, response = "";
  const model = new MockLanguageModelV3({ doStream: async options => {
    const isToolStep = calls++ === 0;
    if (!isToolStep) response = JSON.stringify(options.prompt);
    const chunks = isToolStep ? [
      { type: "stream-start" as const, warnings: [] },
      { type: "tool-call" as const, toolCallId: "query", toolName: currentCall.name, input: JSON.stringify(currentCall.input) },
      { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
    ] : [
      { type: "stream-start" as const, warnings: [] },
      { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
    ];
    return { stream: simulateReadableStream<(typeof chunks)[number]>({ chunks }) };
  } });
  const app = await createRuntimeApp({ args: ["--tui", join(root, "transcripts"), "--thread", "daily-read", "--config", configPath],
    modelAlias: "scripted", model, output: new PassThrough(), env: {}, cwd: root,
    ...(allowWorkspaceTaskReads ? { allowWorkspaceTaskReads: true as const } : {}),
  });
  const prompted: string[] = [];
  const unsubscribe = app.toolConfirmation!.subscribePending(pending => {
    if (pending?.preview.trim()) {
      prompted.push(pending.toolName);
      app.toolConfirmation!.resolveApproval({ approvalId: pending.approvalId, decision: "deny" });
    }
  });
  let sequence = 0;
  return {
    app, workspace, foreignWorkspace, taskStore, own: own.value, foreign: foreign.value, prompted,
    async run(name: string, input: unknown) {
      currentCall = { name, input }; calls = 0; response = ""; app.toolConfirmation!.beginRun();
      try {
        const handle = await app.runtime.run({ agentId: app.agentId, threadId: app.threadId,
          messages: [{ id: `u${++sequence}`, role: "user", parts: [{ type: "text", text: "查询当前工作区提醒" }] }] });
        assert.equal((await handle.result).status, "completed");
        return response;
      } finally { app.toolConfirmation!.endRun(); }
    },
    async dispose() { unsubscribe(); app.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

it("workspace task read Demo: trusted embedded list/get complete without approvals or foreign data", async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(join(f.workspace, TASK_FILE_NAME), "utf8");
    const listed = await f.run("task_list", { limit: 50 });
    assert.equal(f.prompted.length, 0, "read-only workspace queries must not display approval cards");
    assert.match(listed, /本工作区喝水/);
    assert.doesNotMatch(listed, /外部工作区私密提醒/);
    const got = await f.run("task_get", { id: f.own.id });
    assert.match(got, /本工作区喝水/);
    const pathAttempt = await f.run("task_list", { workspace: f.foreignWorkspace, path: join(f.foreignWorkspace, TASK_FILE_NAME) });
    assert.doesNotMatch(pathAttempt, /外部工作区私密提醒/);
    assert.match(pathAttempt, /本工作区喝水/);
    const missing = await f.run("task_get", { id: f.foreign.id });
    assert.doesNotMatch(missing, /外部工作区私密提醒/);
    assert.match(missing, /TASK_NOT_FOUND/);
    assert.deepEqual(f.prompted, []);
    assert.equal(await readFile(join(f.workspace, TASK_FILE_NAME), "utf8"), before, "queries must not acknowledge or modify tasks");
  } finally { await f.dispose(); }
});

it("workspace task read Demo: symlinked task directory cannot expose another workspace", async () => {
  const f = await fixture(true);
  try {
    await rename(join(f.workspace, ".runloom"), join(f.workspace, ".runloom-original"));
    await symlink(join(f.foreignWorkspace, ".runloom"), join(f.workspace, ".runloom"), "dir");
    const listed = await f.run("task_list", {});
    assert.doesNotMatch(listed, /外部工作区私密提醒/);
    assert.match(listed, /TASK_FILE_INVALID/);
    assert.deepEqual(f.prompted, []);
  } finally { await f.dispose(); }
});

it("workspace task read policy trusts built-in object identity, primary agent and exact workspace, never risk/name alone", () => {
  const workspace = "/trusted/workspace", primaryAgentId = "personal";
  const policy = createWorkspaceTaskReadApproval(workspace, primaryAgentId);
  const host = createModuleHost([policy.captureBuiltinModule(createTaskModule(createTaskStore(workspace)))], { notify() {} });
  try {
    for (const name of ["task_list", "task_get"]) {
      const builtin = host.tools.find(registration => registration.metadata.name === name)!;
      const input = { agentId: primaryAgentId, workspaceRoot: workspace, toolName: name, registeredTool: builtin };
      assert.equal(policy.allows(input), true);
      assert.equal(policy.allows({ ...input, agentId: "external-skill" }), false);
      assert.equal(policy.allows({ ...input, workspaceRoot: "/other/workspace" }), false);
      assert.equal(policy.allows({ ...input, registeredTool: { ...builtin } }), false, "same-name copied registration is not trusted");
      assert.equal(policy.allows({ ...input, registeredTool: {
        metadata: { ...builtin.metadata, risk: "read" },
        tool: tool({ inputSchema: z.object({}), execute: async () => "foreign custom data" }),
      } }), false, "custom same-name read tool is not trusted");
    }
    for (const registration of host.tools.filter(registration => !["task_list", "task_get"].includes(registration.metadata.name))) {
      assert.equal(policy.allows({ agentId: primaryAgentId, workspaceRoot: workspace,
        toolName: registration.metadata.name, registeredTool: registration }), false);
    }
  } finally { host.dispose(); }
});

it("workspace task read Demo: TUI keeps per-call approval without the embedding opt-in", async () => {
  const f = await fixture(false);
  try {
    assert.match(await f.run("task_list", {}), /TOOL_DENIED/);
    assert.match(await f.run("task_get", { id: f.own.id }), /TOOL_DENIED/);
    assert.deepEqual(f.prompted, ["task_list", "task_get"]);
  } finally { await f.dispose(); }
});

it("workspace task read Demo: create/reschedule/cancel/ack/files/Shell remain per-call approval", async () => {
  const f = await fixture(true);
  try {
    const before = await readFile(join(f.workspace, TASK_FILE_NAME), "utf8");
    for (const [name, input] of [
      ["task_create", { prompt: "not approved", runAt: new Date(Date.now() + 120_000).toISOString() }],
      ["task_reschedule", { id: f.own.id, runAt: new Date(Date.now() + 120_000).toISOString() }],
      ["task_cancel", { id: f.own.id }], ["task_ack", { id: f.own.id }],
      ["read_file", { path: "notes.txt" }], ["write_file", { path: "notes.txt", content: "not approved" }],
      ["shell_exec", { command: "pwd", cwd: "." }],
    ] as const) {
      assert.match(await f.run(name, input), /TOOL_DENIED/);
    }
    assert.deepEqual(f.prompted, ["task_create", "task_reschedule", "task_cancel", "task_ack", "read_file", "write_file", "shell_exec"]);
    assert.equal(await readFile(join(f.workspace, TASK_FILE_NAME), "utf8"), before);
  } finally { await f.dispose(); }
});
