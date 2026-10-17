import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { BeforeToolExecuteInput, ToolExecutionDecision } from "@serika/core";
import { AUTO_CONSOLIDATION_AGENT_ID } from "./consolidation.js";
import { createPermissionExtension, type PermissionExtension } from "./permission-extension.js";
import { createReadFileModule, RUN_AUTHORIZED_FILE_TOOLS } from "./modules/read-file-module.js";
import type { FileAuthorizationRule } from "./tui-module-config.js";
import { PERMISSION_DECISIONS } from "./permission-decisions.snapshot.js";
import { createModuleHost } from "./module-host.js";
import { createWebModule } from "./modules/web-module.js";
import { builtinToolPermissions } from "./testing.js";

/**
 * Locks the current tool permission decisions before permission rules move
 * from tool-name lists into module declarations. Every refactor step must keep
 * this table identical. Regenerate only for an explicitly confirmed rule change:
 * SERIKA_UPDATE_PERMISSION_SNAPSHOT=1 node --test dist/permission-decisions.test.js
 */

const WORKSPACE = "/workspace";
const PRIMARY = "calculator";

/** Every tool the host registers today, with its declared risk and a typical input. */
const TOOLS: ReadonlyArray<readonly [name: string, risk: string, input: unknown, variant?: unknown]> = [
  ["capability_status", "read", {}],
  ["read_file", "read", { path: "src/a.ts" }, { path: "docs/b.md" }],
  ["list_directory", "read", { path: "src" }],
  ["search_files", "read", { path: "src", query: "x" }],
  ["write_file", "write", { path: "src/a.ts", content: "x" }, { path: "src/sub/b.ts", content: "x" }],
  ["edit_file", "write", { path: "src/a.ts", oldText: "a", newText: "b" }, { path: "docs/b.md", oldText: "a", newText: "b" }],
  ["shell_exec", "external_side_effect", { command: "ls", cwd: "." }],
  ["web_fetch", "read", { url: "https://example.com/a" }, { url: "https://other.example/a" }],
  ["feed_read", "read", { url: "https://example.com/feed" }],
  ["web_search", "read", { query: "x" }],
  ["pomodoro_start", "write", { minutes: 25 }],
  ["pomodoro_status", "read", {}],
  ["pomodoro_cancel", "write", {}],
  ["memory_list", "read", {}],
  ["memory_get", "read", { id: "m1" }],
  ["memory_add", "write", { text: "x" }],
  ["memory_update", "write", { id: "m1", text: "x" }],
  ["memory_delete", "write", { id: "m1" }],
  ["memory_query", "read", {}],
  ["memory_revise", "write", {}],
  ["memory_candidates_list", "read", {}],
  ["memory_apply_candidate", "write", {}],
  ["memory_stage_candidates", "read", {}],
  ["memory_prepare_consolidation", "read", {}],
  ["checkpoint_prepare", "read", {}],
  ["checkpoint_get", "read", {}],
  ["checkpoint_save", "write", {}],
  ["task_create", "write", {}],
  ["task_list", "read", {}],
  ["task_get", "read", { id: "t1" }],
  ["task_cancel", "write", { id: "t1" }],
  ["task_reschedule", "write", { id: "t1" }],
  ["task_ack", "write", { id: "t1" }],
  ["task_repeat_create", "write", {}],
  ["task_repeat_list", "read", {}],
  ["task_repeat_get", "read", { id: "r1" }],
  ["task_repeat_pause", "write", { id: "r1" }],
  ["task_repeat_resume", "write", { id: "r1" }],
  ["task_repeat_cancel", "write", { id: "r1" }],
  ["todoist_list_tasks", "read", { view: "planning" }],
  ["computer_check", "read", {}],
  ["computer_observe", "read", {}],
  ["computer_action", "external_side_effect", {}],
  ["recipe_list", "read", {}],
  ["recipe_save", "write", {}],
  ["recipe_manage", "write", {}],
  ["recipe_run", "external_side_effect", {}],
];
const RISK = new Map(TOOLS.map(([name, risk]) => [name, risk]));

type Shell = "host" | "docker";
/**
 * Permission facts come from the real modules, so a module's declarations are
 * part of what is locked. These tools' cards came from the app's own prompt
 * before they moved into their modules and were never locked here (the
 * snapshot saw the generic card); the module tests cover them. shell_exec is
 * not listed: its app card replaced the internal fallback card, and the
 * snapshot now records the card the app actually shows.
 */
const APP_CARD_TOOLS = new Set(["recipe_list", "recipe_save", "recipe_manage", "recipe_run", "computer_check",
  "web_fetch", "feed_read", "web_search", "memory_list", "memory_get", "memory_add", "memory_update", "memory_delete",
  "memory_query", "memory_revise", "memory_candidates_list", "memory_apply_candidate", "memory_stage_candidates",
  "memory_prepare_consolidation"]);
function moduleToolPermissions(shell: Shell) {
  return new Map([...builtinToolPermissions({ shell })].map(([name, facts]) => {
    if (!APP_CARD_TOOLS.has(name)) return [name, facts] as const;
    const { confirmation, ...withoutCard } = facts;
    return [name, withoutCard] as const;
  }));
}
function extension(shell: Shell, fileAuthorizations: readonly FileAuthorizationRule[] = []) {
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  return createPermissionExtension(sink, {
    prompt: () => undefined,
    workspaceRoot: WORKSPACE,
    fileAuthorizations,
    shell: { enabled: true, sandbox: shell === "docker" ? { backend: "docker", image: "img", readablePaths: [], writablePaths: [] } : undefined },
    web: { enabled: true, searchEnabled: true },
    toolPermissions: moduleToolPermissions(shell),
    report: undefined,
    autoApprove: [],
    toolRisk: name => RISK.get(name),
  });
}

function call(toolName: string, input: unknown, agentId = PRIMARY): BeforeToolExecuteInput {
  return { toolName, toolCallId: `call-${toolName}`, input, definition: { id: agentId } as BeforeToolExecuteInput["definition"],
    signal: new AbortController().signal };
}

/** Runs one call; an asked call is left pending for the caller to resolve. */
async function decide(ext: PermissionExtension, input: BeforeToolExecuteInput, withPreview = false): Promise<{ text: string; settle?: Promise<ToolExecutionDecision> }> {
  let settled: ToolExecutionDecision | undefined;
  let failed: unknown;
  let result: Promise<ToolExecutionDecision>;
  try {
    result = Promise.resolve(ext.beforeToolExecute(input));
  } catch (error) {
    return { text: `throws: ${(error as Error).message}` };
  }
  result.then(value => { settled = value; }, error => { failed = error; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const pending = ext.confirmation.getPending();
  if (pending !== undefined) {
    const remember = pending.remember ? `; remember: ${pending.remember.label}` : "";
    return { text: `ask${remember}${withPreview ? `; preview: ${pending.preview}` : ""}`, settle: result };
  }
  if (failed !== undefined) return { text: `throws: ${(failed as Error).message}` };
  assert.ok(settled, `${input.toolName} neither settled nor asked`);
  return { text: settled.allow ? "allow" : `deny: ${settled.reason}` };
}

async function answer(ext: PermissionExtension, decision: "allow" | "deny", remember = false): Promise<void> {
  const pending = ext.confirmation.getPending();
  if (pending === undefined) return;
  assert.ok(ext.confirmation.resolveApproval({ approvalId: pending.approvalId, decision, ...(remember ? { remember: true } : {}) }));
}

async function once(ext: PermissionExtension, input: BeforeToolExecuteInput, withPreview = false): Promise<string> {
  const outcome = await decide(ext, input, withPreview);
  if (outcome.settle) { await answer(ext, "deny"); await outcome.settle; }
  return outcome.text;
}

async function buildTable(): Promise<Record<string, string>> {
  const table: Record<string, string> = {};
  const record = (scenario: string, tool: string, text: string) => { table[`${scenario} | ${tool}`] = text; };
  for (const [name, , input, variant] of TOOLS) {
    for (const shell of ["host", "docker"] as const) {
      const ext = extension(shell); ext.confirmation.beginRun();
      record(`plain-${shell}`, name, await once(ext, call(name, input), true));
    }
    {
      const ext = extension("host"); ext.confirmation.beginRun(true);
      record("autonomous", name, await once(ext, call(name, input)));
    }
    {
      const ext = extension("host"); ext.confirmation.beginRun(false, "telegram");
      record("telegram", name, await once(ext, call(name, input)));
    }
    {
      const ext = extension("host");
      ext.confirmation.setPendingAuthorization({ allowedPaths: ["src"], tools: [...RUN_AUTHORIZED_FILE_TOOLS], lifetime: "run" });
      ext.confirmation.beginRun();
      record("run-file-authorization(src)", name, await once(ext, call(name, input)));
      ext.confirmation.endRun(); ext.confirmation.beginRun();
      record("run-file-authorization(src) next-run", name, await once(ext, call(name, input)));
    }
    {
      const ext = extension("host", [{ allowedPaths: ["src"], tools: ["read_file", "write_file"] }]);
      ext.confirmation.beginRun();
      record("config-file-authorization(src: read_file, write_file)", name, await once(ext, call(name, input)));
    }
    {
      const ext = extension("docker"); ext.confirmation.setPendingShellAuthorization(); ext.confirmation.beginRun();
      record("shell-authorization-docker", name, await once(ext, call(name, input)));
    }
    {
      const ext = extension("host"); ext.confirmation.setPendingWebAuthorization(["https://example.com"]); ext.confirmation.beginRun();
      record("web-authorization(https://example.com)", name, await once(ext, call(name, input)));
    }
    {
      const ext = extension("host"); ext.confirmation.beginRun();
      const search = await decide(ext, call("web_search", { query: "x" }));
      await answer(ext, "deny"); await search.settle;
      record("after-web_search-denied", name, await once(ext, call(name, input)));
      ext.confirmation.endRun(); ext.confirmation.beginRun();
      record("after-web_search-denied next-run", name, await once(ext, call(name, input)));
    }
    {
      const ext = extension("host"); ext.confirmation.beginRun();
      const first = await decide(ext, call(name, input));
      const offered = ext.confirmation.getPending()?.remember !== undefined;
      if (first.settle) { await answer(ext, "allow", offered); await first.settle; }
      record("remembered same", name, offered ? await once(ext, call(name, input)) : "not offered");
      if (offered && variant !== undefined) record("remembered variant", name, await once(ext, call(name, variant)));
      if (offered) {
        record("remembered other-agent", name, await once(ext, call(name, input, "other-agent")));
        ext.confirmation.endRun(); ext.confirmation.beginRun(false, "telegram");
        record("remembered then telegram", name, await once(ext, call(name, input)));
      }
    }
    {
      const ext = extension("host"); ext.confirmation.beginRun();
      record("consolidation-agent", name, await once(ext, call(name, input, AUTO_CONSOLIDATION_AGENT_ID)));
    }
  }
  {
    const ext = extension("host");
    let text: string;
    try { ext.confirmation.setPendingShellAuthorization(); text = "accepted"; } catch (error) { text = `throws: ${(error as Error).message}`; }
    record("shell-authorization-host", "setPendingShellAuthorization", text);
  }
  const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
  for (const files of [false, true]) for (const shell of [false, true]) for (const web of [false, true]) for (const report of [false, true]) {
    const ext = createPermissionExtension(sink, {
      prompt: () => undefined, workspaceRoot: WORKSPACE, fileAuthorizations: [],
      shell: { enabled: shell, sandbox: undefined }, web: { enabled: web, searchEnabled: web },
      toolPermissions: createModuleHost([
        ...(files ? [createReadFileModule(WORKSPACE)] : []),
        ...(web ? [createWebModule({ searchEnabled: true, feedEnabled: true })] : []),
      ], { notify() {} }).toolPermissions,
      report: report ? { configPath: null, workspaceRoot: WORKSPACE } : undefined, autoApprove: [],
    });
    record("commands", `files=${files} shell=${shell} web=${web} report=${report}`, (ext.commands ?? []).map(command => `/${command.name}`).join(" ") || "(none)");
  }
  return table;
}

describe("permission decision snapshot", () => {
  it("matches the locked decisions of the current rules", async () => {
    const table = await buildTable();
    if (process.env.SERIKA_UPDATE_PERMISSION_SNAPSHOT === "1") {
      const file = fileURLToPath(new URL("../src/permission-decisions.snapshot.ts", import.meta.url));
      writeFileSync(file, "// Generated by permission-decisions.test.ts. Do not edit by hand.\n" +
        "// Regenerate only for an explicitly confirmed permission rule change.\n" +
        `export const PERMISSION_DECISIONS: Readonly<Record<string, string>> = ${JSON.stringify(table, null, 2)};\n`);
      return;
    }
    assert.deepEqual(table, PERMISSION_DECISIONS);
  });
});
