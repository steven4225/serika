import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import type { BeforeToolExecuteInput } from "@serika/core";
import { createToolConfirmation, type ToolRiskLookup } from "./tool-confirmation.js";
import { createPermissionExtension } from "./permission-extension.js";
import { builtinToolPermissions } from "./testing.js";

/** The built-in modules' declared permission facts, as the host collects them. */
const modulePermissions = builtinToolPermissions();

function sink(): Writable & { text: string } {
  const stream = new Writable({ write(chunk, _encoding, done) { stream.text += String(chunk); done(); } }) as Writable & { text: string };
  stream.text = "";
  return stream;
}

let callCount = 0;
function call(toolName: string, input: unknown = {}, agentId = "calculator"): BeforeToolExecuteInput {
  callCount += 1;
  return { toolName, toolCallId: `call-${callCount}`, input, definition: { id: agentId },
    signal: new AbortController().signal } as unknown as BeforeToolExecuteInput;
}

const risk: ToolRiskLookup = (name) => ({
  read_file: "read", web_search: "read", memory_list: "read", computer_observe: "read",
  recipe_list: "read", write_file: "write", task_create: "write",
} as Record<string, "read" | "write">)[name];

function setup(output = sink()) {
  return createToolConfirmation(output, { prompt: () => "preview\nAllow this call? [y/n] ", workspaceRoot: "/tmp/ws", toolRisk: risk, toolPermissions: modulePermissions });
}

/** Starts a call, checks whether it waits, and answers it when it does. */
async function decide(confirmation: ReturnType<typeof setup>, input: BeforeToolExecuteInput,
  answer?: { decision: "allow" | "deny"; remember?: boolean }) {
  const decision = confirmation.beforeToolExecute(input);
  const pending = confirmation.getPending();
  if (pending !== undefined && answer !== undefined) {
    assert.equal(confirmation.resolveApproval({ approvalId: pending.approvalId, ...answer }), true);
  }
  return { pending, decision: pending === undefined || answer !== undefined ? await decision : undefined };
}

describe("remembered conversation grants", () => {
  it("remembers a read-risk tool by name across Runs, for the granting agent only", async () => {
    const confirmation = setup();
    confirmation.beginRun();
    const first = await decide(confirmation, call("read_file", { path: "a.txt" }), { decision: "allow", remember: true });
    assert.equal(first.pending?.remember?.label, "本次对话内不再询问 read_file");
    confirmation.endRun();
    confirmation.beginRun();
    assert.deepEqual((await decide(confirmation, call("read_file", { path: "deep/b.txt" }))).decision, { allow: true });
    const other = await decide(confirmation, call("read_file", { path: "a.txt" }, "skill-agent"), { decision: "deny" });
    assert.notEqual(other.pending, undefined, "another agent still asks");
    confirmation.endRun();
    assert.deepEqual(confirmation.listRemembered().map(grant => [grant.id, grant.toolName, grant.kind]), [["1", "read_file", "tool"]]);
  });

  it("remembers file writes per directory without subdirectories or other file tools", async () => {
    const confirmation = setup();
    const first = await decide(confirmation, call("write_file", { path: "notes/a.md", content: "x" }), { decision: "allow", remember: true });
    assert.match(first.pending?.remember?.label ?? "", /notes\/ 下的文件（不含子目录）/);
    assert.deepEqual((await decide(confirmation, call("write_file", { path: "notes/b.md", content: "y" }))).decision, { allow: true });
    assert.notEqual((await decide(confirmation, call("write_file", { path: "notes/sub/c.md" }), { decision: "deny" })).pending, undefined);
    assert.notEqual((await decide(confirmation, call("write_file", { path: "other.md" }), { decision: "deny" })).pending, undefined);
    assert.notEqual((await decide(confirmation, call("edit_file", { path: "notes/a.md" }), { decision: "deny" })).pending, undefined);
    assert.notEqual((await decide(confirmation, call("write_file", { path: "../escape.md" }), { decision: "deny" })).pending?.approvalId, undefined);
    assert.equal(confirmation.listRemembered().length, 1);
  });

  it("remembers web_fetch per exact origin", async () => {
    const confirmation = setup();
    await decide(confirmation, call("web_fetch", { url: "https://example.com/a" }), { decision: "allow", remember: true });
    assert.deepEqual((await decide(confirmation, call("web_fetch", { url: "https://example.com/b?q=1" }))).decision, { allow: true });
    assert.notEqual((await decide(confirmation, call("web_fetch", { url: "http://example.com/a" }), { decision: "deny" })).pending, undefined);
    assert.notEqual((await decide(confirmation, call("web_fetch", { url: "https://sub.example.com/" }), { decision: "deny" })).pending, undefined);
  });

  it("never offers to remember shell, computer, recipe, memory or non-read tools", async () => {
    const confirmation = setup();
    for (const toolName of ["shell_exec", "computer_observe", "recipe_list", "memory_list", "task_create", "unknown_tool"]) {
      const { pending } = await decide(confirmation, call(toolName, { command: "ls" }), { decision: "allow" });
      assert.equal(pending?.remember, undefined, toolName);
    }
    const decision = confirmation.beforeToolExecute(call("shell_exec", { command: "ls" }));
    const pending = confirmation.getPending()!;
    assert.equal(confirmation.resolveApproval({ approvalId: pending.approvalId, decision: "allow", remember: true }), false,
      "remember is rejected, not downgraded to a plain allow");
    assert.notEqual(confirmation.getPending(), undefined);
    assert.equal(confirmation.resolveApproval({ approvalId: pending.approvalId, decision: "deny" }), true);
    await decision;
    assert.deepEqual(confirmation.listRemembered(), []);
  });

  it("does not remember plain allows or denials", async () => {
    const confirmation = setup();
    await decide(confirmation, call("read_file", { path: "a" }), { decision: "allow" });
    const denied = confirmation.beforeToolExecute(call("read_file", { path: "a" }));
    const pending = confirmation.getPending()!;
    assert.equal(confirmation.resolveApproval({ approvalId: pending.approvalId, decision: "deny", remember: true }), false);
    assert.equal(confirmation.resolveApproval({ approvalId: pending.approvalId, decision: "deny" }), true);
    await denied;
    assert.notEqual((await decide(confirmation, call("read_file", { path: "a" }), { decision: "deny" })).pending, undefined);
    assert.deepEqual(confirmation.listRemembered(), []);
  });

  it("is neither used nor offered in a Telegram Run", async () => {
    const confirmation = setup();
    await decide(confirmation, call("read_file", { path: "a" }), { decision: "allow", remember: true });
    confirmation.beginRun(false, "telegram");
    const { pending } = await decide(confirmation, call("read_file", { path: "a" }), { decision: "deny" });
    assert.notEqual(pending, undefined);
    assert.equal(pending?.remember, undefined);
    confirmation.endRun();
    confirmation.beginRun();
    assert.deepEqual((await decide(confirmation, call("read_file", { path: "a" }))).decision, { allow: true });
  });

  it("keeps the web_search denial latch ahead of a remembered origin", async () => {
    const confirmation = setup();
    await decide(confirmation, call("web_fetch", { url: "https://example.com/" }), { decision: "allow", remember: true });
    confirmation.beginRun();
    await decide(confirmation, call("web_search", { query: "q" }), { decision: "deny" });
    assert.equal((await decide(confirmation, call("web_fetch", { url: "https://example.com/" }))).decision?.allow, false);
  });

  it("accepts r in the terminal only when a grant is offered", async () => {
    const output = sink();
    const confirmation = setup(output);
    const decision = confirmation.beforeToolExecute(call("read_file", { path: "a" }));
    assert.match(output.text, /Waiting for y\/n\/r/);
    assert.equal(confirmation.handleLine("r"), true);
    assert.deepEqual(await decision, { allow: true });
    assert.equal(confirmation.listRemembered().length, 1);
    const shell = confirmation.beforeToolExecute(call("shell_exec", { command: "ls" }));
    assert.equal(confirmation.handleLine("r"), true);
    assert.notEqual(confirmation.getPending(), undefined, "r is not an answer for shell");
    assert.match(output.text, /Please enter y or n\./);
    confirmation.handleLine("n");
    await shell;
  });

  it("lists and forgets single grants through /permissions", async () => {
    const output = sink();
    const permission = createPermissionExtension(output, {
      workspaceRoot: "/tmp/ws", fileAuthorizations: [],
      shell: { enabled: false, sandbox: undefined }, web: { enabled: true, searchEnabled: false }, toolPermissions: modulePermissions,
      report: { configPath: null, workspaceRoot: "/tmp/ws" }, autoApprove: [], toolRisk: risk,
    });
    const confirmation = permission.confirmation;
    for (const input of [call("read_file", { path: "a" }), call("web_fetch", { url: "https://example.com/" })]) {
      const decision = permission.beforeToolExecute(input) as Promise<unknown>;
      confirmation.resolveApproval({ approvalId: confirmation.getPending()!.approvalId, decision: "allow", remember: true });
      await decision;
    }
    const command = permission.commands!.find(item => item.name === "permissions")!;
    await command.execute("");
    assert.match(output.text, /本次对话记住的授权: 2 条/);
    assert.match(output.text, /- 1: 本次对话内不再询问 read_file/);
    await command.execute("forget 1");
    assert.match(output.text, /已清除第 1 条/);
    assert.deepEqual(confirmation.listRemembered().map(grant => grant.id), ["2"]);
    await command.execute("forget 9");
    assert.match(output.text, /没有编号为 9/);
    permission.beforeToolExecute(call("read_file", { path: "a" }));
    assert.notEqual(confirmation.getPending(), undefined, "a forgotten grant asks again");
  });
});
