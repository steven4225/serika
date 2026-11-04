import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Writable } from "node:stream";
import type { BeforeToolExecuteInput } from "@serika/core";
import type { ToolPermissionFacts } from "./module-host.js";
import { createTaskTrust, fileAllowlistRoot, hostShellCwd, TASK_TRUST_IDLE_MS, userWaitLabel } from "./task-trust.js";
import { createToolConfirmation } from "./tool-confirmation.js";

const roots = ["/work"];
const facts = new Map<string, ToolPermissionFacts>([
  ["write_file", { scope: { kind: "directoryPath", argument: "path" }, defaults: { remember: "never" } }],
  ["terminal_exec", { defaults: { remember: "never" } }],
  ["shell_exec", { defaults: { remember: "never" } }],
  ["computer_action", { defaults: { remember: "never" } }],
]);

function call(toolName: string, input: unknown): BeforeToolExecuteInput {
  return { toolName, toolCallId: toolName + JSON.stringify(input), input, definition: { id: "calculator" },
    signal: new AbortController().signal } as unknown as BeforeToolExecuteInput;
}

function confirmation(trust: ReturnType<typeof createTaskTrust>, output = new Writable({ write(_c, _e, done) { done(); } })) {
  return createToolConfirmation(output, {
    directory: "/work",
    prompt: () => "preview\nAllow this call? [y/n] ",
    toolPermissions: facts,
    taskTrust: { trust, directoryRoots: roots, isHostShell: name => name === "terminal_exec" || name === "shell_exec" },
  });
}

async function allow(trust: ReturnType<typeof createTaskTrust>, input: BeforeToolExecuteInput) {
  const pending = confirmation(trust);
  const decision = pending.beforeToolExecute(input);
  const card = pending.getPending();
  assert.ok(card, input.toolName);
  assert.equal(pending.resolveApproval({ approvalId: card.approvalId, decision: "allow" }), true);
  assert.deepEqual(await decision, { allow: true });
}

describe("task trust", () => {
  it("names a user wait separately from a model timeout label", () => {
    assert.equal(userWaitLabel({ herdr: true, toolName: "terminal_exec" }), "在等你：选 Pi 目标");
    assert.equal(userWaitLabel({ toolName: "terminal_exec" }), "在等你：批 主机命令");
    assert.equal(userWaitLabel({ toolName: "write_file" }), "在等你：批 写入文件");
    assert.equal(userWaitLabel({}), null);
  });

  it("reuses an allowlisted file, a host cwd, and one app after a single allow", async () => {
    const trust = createTaskTrust();
    const key = trust.noteRunStart({ threadId: "thread" });
    const gate = confirmation(trust);
    await allow(trust, call("write_file", { path: "notes/a.txt" }));
    const again = gate.beforeToolExecute(call("write_file", { path: "src/b.txt" }));
    assert.equal(gate.getPending(), undefined);
    assert.deepEqual(await again, { allow: true });
    const outside = gate.beforeToolExecute(call("write_file", { path: "/etc/passwd" }));
    assert.equal(gate.getPending()?.toolName, "write_file");
    gate.resolveApproval({ approvalId: gate.getPending()!.approvalId, decision: "deny" });
    assert.equal((await outside).allow, false);

    await allow(trust, call("terminal_exec", { command: "ls", cwd: "pkg" }));
    const nested = gate.beforeToolExecute(call("terminal_exec", { command: "pwd", cwd: "pkg/deeper" }));
    assert.equal(gate.getPending(), undefined);
    assert.deepEqual(await nested, { allow: true });
    const otherDir = gate.beforeToolExecute(call("terminal_exec", { command: "pwd", cwd: "other" }));
    assert.ok(gate.getPending());
    gate.resolveApproval({ approvalId: gate.getPending()!.approvalId, decision: "deny" });
    await otherDir;
    const otherTool = gate.beforeToolExecute(call("shell_exec", { command: "pwd", cwd: "pkg" }));
    assert.equal(gate.getPending()?.toolName, "shell_exec");
    gate.resolveApproval({ approvalId: gate.getPending()!.approvalId, decision: "deny" });
    await otherTool;

    await allow(trust, call("computer_action", { bundleId: "com.example.Editor" }));
    const sameApp = gate.beforeToolExecute(call("computer_action", { bundleId: "com.example.Editor" }));
    assert.equal(gate.getPending(), undefined);
    assert.deepEqual(await sameApp, { allow: true });
    assert.equal(fileAllowlistRoot(roots, { path: "notes/a.txt" }, "/work", { kind: "directoryPath", argument: "path" }), "/work");
    assert.equal(hostShellCwd({ cwd: "pkg" }, "/work"), "/work/pkg");
    assert.equal(trust.list("thread").some(grant => grant.kind === "files"), true);
    trust.forget(trust.list("thread").find(grant => grant.kind === "host-shell")!.id);
    const forgotten = gate.beforeToolExecute(call("terminal_exec", { command: "ls", cwd: "pkg" }));
    assert.equal(gate.getPending()?.toolName, "terminal_exec");
    gate.resolveApproval({ approvalId: gate.getPending()!.approvalId, decision: "deny" });
    await forgotten;
    trust.end(key);
    const ended = gate.beforeToolExecute(call("write_file", { path: "notes/c.txt" }));
    assert.equal(gate.getPending()?.toolName, "write_file");
    gate.resolveApproval({ approvalId: gate.getPending()!.approvalId, decision: "deny" });
    await ended;
  });

  it("drops an idle empty scope and keeps a task scope separate from the thread", async () => {
    let now = 0;
    const trust = createTaskTrust(() => now);
    trust.noteRunStart({ threadId: "thread" });
    await allow(trust, call("terminal_exec", { command: "ls", cwd: "." }));
    trust.noteRunEnd(trust.scopeKey());
    now = TASK_TRUST_IDLE_MS + 1;
    trust.noteRunStart({ threadId: "thread" });
    const gate = confirmation(trust);
    const expired = gate.beforeToolExecute(call("terminal_exec", { command: "ls", cwd: "." }));
    assert.ok(gate.getPending());
    gate.resolveApproval({ approvalId: gate.getPending()!.approvalId, decision: "deny" });
    await expired;
    trust.noteRunEnd(trust.scopeKey());
    const threadKey = trust.noteRunStart({ threadId: "thread" });
    await allow(trust, call("terminal_exec", { command: "ls", cwd: "." }));
    trust.noteRunEnd(threadKey);
    const taskKey = trust.noteRunStart({ threadId: "thread", workTaskId: "task" });
    const taskGate = confirmation(trust);
    const taskCall = taskGate.beforeToolExecute(call("terminal_exec", { command: "ls", cwd: "." }));
    assert.equal(taskGate.getPending()?.toolName, "terminal_exec");
    taskGate.resolveApproval({ approvalId: taskGate.getPending()!.approvalId, decision: "deny" });
    await taskCall;
    trust.end(taskKey);
    trust.noteRunStart({ threadId: "thread" });
    const reused = confirmation(trust).beforeToolExecute(call("terminal_exec", { command: "ls", cwd: "." }));
    assert.equal((await reused).allow, true);
  });

  it("keeps grants while a run is still open past the idle bound", () => {
    let now = 0;
    const trust = createTaskTrust(() => now);
    const key = trust.noteRunStart({ workTaskId: "task", threadId: "thread" });
    trust.grantHostShell(key, "terminal_exec", "/work");
    now = TASK_TRUST_IDLE_MS + 5;
    assert.equal(trust.allowsHostShell(key, "terminal_exec", "/work"), true);
    trust.noteRunEnd(key);
    now += TASK_TRUST_IDLE_MS + 1;
    assert.equal(trust.allowsHostShell(key, "terminal_exec", "/work"), false);
  });

  it("keeps a pinned Pi for the same idle window as a host directory", () => {
    let now = 0;
    const trust = createTaskTrust(() => now);
    const key = trust.noteRunStart({ threadId: "thread", workTaskId: "task" });
    const target = { authorizedDirectory: "/work", session: "offline", paneId: "p1", terminalId: "t1" };
    trust.pinTarget(key, target);
    trust.noteRunEnd(key);
    now = TASK_TRUST_IDLE_MS;
    assert.deepEqual(trust.pinnedTarget(key), target);
    assert.equal(trust.pinnedTarget(trust.key({ threadId: "thread" })), undefined);
    now += 1;
    assert.equal(trust.pinnedTarget(key), undefined);
    const open = trust.noteRunStart({ threadId: "thread", workTaskId: "task" });
    trust.pinTarget(open, target);
    now += TASK_TRUST_IDLE_MS + 5;
    assert.deepEqual(trust.pinnedTarget(open), target);
  });

  it("pins one Pi target and clears control when the identity is dropped", () => {
    const trust = createTaskTrust();
    const key = trust.noteRunStart({ threadId: "thread" });
    const target = { authorizedDirectory: "/work", session: "offline", paneId: "p1", terminalId: "t1" };
    trust.pinTarget(key, target);
    trust.grantPiControl(key, "fingerprint");
    assert.deepEqual(trust.pinnedTarget(key), target);
    trust.clearPi(key);
    assert.equal(trust.pinnedTarget(key), undefined);
    assert.equal(trust.allowsPiControl(key, "fingerprint"), false);
    trust.pinTarget(key, target);
    trust.grantPiControl(key, "fingerprint");
    trust.end(key);
    assert.equal(trust.pinnedTarget(key), undefined);
    assert.equal(trust.allowsPiControl(key, "fingerprint"), false);
  });
});
