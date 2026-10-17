import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { describe, it } from "node:test";
import type { BeforeToolExecuteInput } from "@serika/core";
import { createPermissionExtension } from "./permission-extension.js";

type PermissionOptions = Parameters<typeof createPermissionExtension>[1];

function sink(): Writable & { text: string } {
  const stream = new Writable({ write(chunk, _encoding, done) { stream.text += String(chunk); done(); } }) as Writable & { text: string };
  stream.text = "";
  return stream;
}

function call(toolName: string, signal = new AbortController().signal): BeforeToolExecuteInput {
  return { toolName, toolCallId: `call-${toolName}`, input: {}, definition: { id: "calculator" }, signal } as unknown as BeforeToolExecuteInput;
}

const base: PermissionOptions = {
  prompt: () => undefined,
  workspaceRoot: undefined,
  fileAuthorizations: [],
  fileToolsEnabled: false,
  shell: { enabled: false, sandbox: undefined },
  web: { enabled: false, searchEnabled: false },
  report: undefined,
  autoApprove: [],
};

describe("permission extension", () => {
  it("allows host pre-approved calls without a pending approval", async () => {
    const permission = createPermissionExtension(sink(), { ...base, autoApprove: [input => input.toolName === "capability_status"] });
    assert.deepEqual(await permission.beforeToolExecute(call("capability_status")), { allow: true });
    assert.equal(permission.confirmation.getPending(), undefined);
  });

  it("still rejects an aborted pre-approved call", () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const permission = createPermissionExtension(sink(), { ...base, autoApprove: [() => true] });
    assert.throws(() => permission.beforeToolExecute(call("capability_status", controller.signal)), /cancelled/);
  });

  it("asks for every other call through the shared confirmation", async () => {
    const output = sink();
    const permission = createPermissionExtension(output, { ...base, autoApprove: [() => false] });
    const decision = permission.beforeToolExecute(call("shell_exec"));
    const pending = permission.confirmation.getPending();
    assert.equal(pending?.toolName, "shell_exec");
    assert.equal(permission.confirmation.resolveApproval({ approvalId: pending!.approvalId, decision: "deny" }), true);
    assert.deepEqual(await decision, { allow: false, reason: "User denied this tool call" });
  });

  it("registers only the grants the assembly can honor", () => {
    const names = (options: Partial<PermissionOptions>) =>
      (createPermissionExtension(sink(), { ...base, ...options }).commands ?? []).map(command => command.name);
    assert.deepEqual(names({}), []);
    assert.deepEqual(names({ fileToolsEnabled: true }), [], "file grants need a workspace");
    assert.deepEqual(names({ fileToolsEnabled: true, workspaceRoot: "/tmp/ws", shell: { enabled: true, sandbox: undefined },
      web: { enabled: true, searchEnabled: false }, report: { configPath: null, workspaceRoot: "/tmp/ws" } }),
    ["authorize", "authorize-shell", "authorize-web", "permissions"]);
  });
});
