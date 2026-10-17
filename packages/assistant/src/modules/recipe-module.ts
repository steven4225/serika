import { tool } from "ai";
import { z } from "zod";
import { AgentError } from "@serika/core";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type { AgentModule, ToolPermissionFacts } from "../module-host.js";
import type { ExecutionRecordStore } from "../execution-record-store.js";
import { RecipeError, RecipeStore, recipeDefinitionSchema, recipeHashSchema } from "../recipe-store.js";
import { createShellExecTool, type ShellModuleOptions } from "./shell-module.js";

const saveSchema = recipeDefinitionSchema.extend({ expectedRevision: z.number().int().nonnegative(), testCallId: z.string().min(1).max(256) }).strict();
const runSchema = z.object({ id: recipeDefinitionSchema.shape.id, expectedHash: recipeHashSchema }).strict();
const manageSchema = z.object({ id: recipeDefinitionSchema.shape.id, expectedRevision: z.number().int().positive(),
  action: z.enum(["enable", "disable", "rollback"]), hash: recipeHashSchema.optional() }).strict();
const neverAborted = new AbortController().signal;
function failure(error: unknown) {
  if (error instanceof RecipeError && error.code === "RECIPE_COMMIT_UNCERTAIN") throw new AgentError({
    code: "TOOL_OUTCOME_UNKNOWN", phase: "tool", retryable: false, message: error.message,
  });
  return { ok: false as const, error: { code: error instanceof RecipeError ? error.code : "RECIPE_UNAVAILABLE",
    message: error instanceof RecipeError ? error.message : "Cannot access recipe catalog; inspect it before retrying" } };
}

const RECIPE_INSTRUCTIONS =
  "For an explicitly requested reusable capability, use the existing file/Shell tools to build and verify a small workspace command or script, then recipe_save only its EXACT successful shell_exec command/cwd and call id from THIS Run. Test after the final change. Ask for registration only when the user wants reuse; do not silently install, alter configuration or restart the host. A command batch may perform the user-approved steps under one confirmation, but is not an OS sandbox. Use /authorize file-path rules or Docker-only /authorize-shell only when explicitly set by the user; no host-wide permission is inferred. In later chats call recipe_list, then recipe_run with the current hash and a fresh approval. recipe_manage can disable/enable or roll back a tested command version. Recipes are command recipes, not text Skills; they confer no permissions, dynamic MCP or tool installation. A version pins command text, not external scripts, dependencies or business correctness. Report those limits. Unknown outcomes require inspection, never automatic replay. ";

/** Host validates concrete shell receipts. A successful exit is NOT proof of semantic quality or isolation. */
export function createRecipeModule(options: {
  store: RecipeStore; records: ExecutionRecordStore; threadId: string;
  currentRun: () => { runId: string; phase: string } | undefined;
  shell: ShellModuleOptions;
}): AgentModule {
  const shell = createShellExecTool(options.store.workspace, options.shell);
  // Recipe approvals are never remembered; each card shows the exact recipe version.
  const permission: ToolPermissionFacts = { defaults: { remember: "never" }, confirmation(input) {
    const value = input.input as { id?: string; expectedHash?: string; command?: string; cwd?: string; action?: string; hash?: string };
    if (input.toolName === "recipe_run" && value.id && value.expectedHash) {
      return options.store.get(value.id, value.expectedHash, input.signal).then(version =>
        `\n运行命令配方：${version.id}\n${version.description}\n命令：${version.command}\n目录：${version.cwd}\n版本：${version.hash}\n${options.shell.sandbox ? "沿用当前 Docker 沙箱配置。" : "这会运行主机命令，工作目录不是系统隔离。"}\n仅批准这次执行；配方不授予持久权限，外部脚本和依赖不随版本冻结。Allow this call? [y/n] `,
        () => "\n配方已变化、停用或无法读取。本次不能执行，请取消并重新查看。Allow this call? [y/n] ");
    }
    if (input.toolName === "recipe_manage" && value.id) {
      return options.store.list(input.signal).then(list => {
        const entry = list.find(item => item.id === value.id);
        const target = entry?.versions.find(version => version.hash === (value.action === "rollback" ? value.hash : entry.activeHash));
        return `\n${value.action === "disable" ? "停用" : value.action === "enable" ? "启用" : "回退"}命令配方：${value.id}\n${target ? `${target.description}\n命令：${target.command}\n目录：${target.cwd}\n版本：${target.hash}` : "目标版本不存在；操作不会成功。"}\n不会执行命令或授予权限，也不撤销过去已发生的操作。Allow this call? [y/n] `;
      });
    }
    return `\n登记命令配方：${value.id}\n命令：${value.command}\n目录：${value.cwd}\n程序会核对本轮真实测试回执。不会执行配方、安装工具或授予后续权限。Allow this call? [y/n] `;
  } };
  return { id: "recipes", setup(ctx) {
    const register = (name: string, risk: "read" | "write" | "external_side_effect", implementation: RegisteredTool["tool"], timeoutMs = 5000) => ctx.registerTool({
      metadata: { name, version: "1", risk, idempotent: risk === "read", timeoutMs }, tool: implementation,
    }, permission);
    ctx.addInstructions(RECIPE_INSTRUCTIONS);
    register("recipe_list", "read", tool({
      description: "List workspace command recipes and tested versions. Recipes never grant permissions or install tools. Read current hash before running; disabled recipes cannot run.",
      inputSchema: z.object({}).strict(),
      execute: async (_, { abortSignal }) => {
        const signal = abortSignal ?? neverAborted;
        try { return { ok: true, recipes: await options.store.list(signal) }; }
        catch (error) { if (signal.aborted) throw signal.reason; return failure(error); }
      },
    }));
    register("recipe_save", "write", tool({
      description: "After user requests capability reuse, register one exact successful shell_exec command from THIS primary Run. Requires approval, exact command/cwd and testCallId; later dispatched writes/commands invalidate that test. Set expectedRevision=0 for a new id; read recipe_list before updating. Up to 32 recipes, 8 versions. No installation or persistent permission. Prefer a self-contained command batch; external scripts/dependencies are NOT snapshotted.",
      inputSchema: saveSchema,
      execute: async (raw, { abortSignal }) => {
        const input = saveSchema.parse(raw), signal = abortSignal ?? neverAborted;
        try {
          const current = options.currentRun();
          if (!current || current.phase !== "primary") throw new RecipeError("RECIPE_TEST_REQUIRED", "Requires a test in this primary Run");
          const run = await options.records.getRun(options.threadId, current.runId);
          const index = run?.tools.findIndex(item => item.toolCallId === input.testCallId) ?? -1;
          const test = run?.tools[index];
          if (!run || run.status !== "running" || !test || test.toolName !== "shell_exec" || test.status !== "completed" ||
            !test.startedAt || test.inputTruncated || !test.shell || test.shell.exitCode !== 0 || test.shell.timedOut || test.shell.cancelled) {
            throw new RecipeError("RECIPE_TEST_REQUIRED", "Provide an actual successful shell_exec receipt in this Run; failures, unknown results and old Runs are not tests");
          }
          let actual: { command?: string; cwd?: string };
          try { actual = JSON.parse(test.inputPreview) as typeof actual; } catch { throw new RecipeError("RECIPE_TEST_REQUIRED", "Test command receipt is incomplete"); }
          if (actual.command !== input.command || (actual.cwd ?? ".") !== input.cwd) throw new RecipeError("RECIPE_TEST_MISMATCH", "Command and cwd must exactly match the tested call");
          if (run.tools.slice(index + 1).some(item => item.startedAt &&
            ["shell_exec", "recipe_run", "write_file", "edit_file", "computer_action"].includes(item.toolName))) {
            throw new RecipeError("RECIPE_TEST_STALE", "A later dispatched operation invalidated the test; verify the final command before registering");
          }
          const definition = recipeDefinitionSchema.parse({ id: input.id, description: input.description, command: input.command, cwd: input.cwd });
          return { ok: true, recipe: await options.store.save(definition,
            { threadId: options.threadId, runId: current.runId, toolCallId: test.toolCallId }, input.expectedRevision, signal),
            note: "已登记实际执行成功的命令；不是业务正确性、安全隔离或未来执行成功的保证。运行仍需新的批准。" };
        } catch (error) { if (signal.aborted) throw signal.reason; return failure(error); }
      },
    }));
    register("recipe_manage", "write", tool({
      description: "Explicitly enable, disable or roll back a workspace command recipe under revision CAS. Rollback selects a previously tested hash, never runs it or restores permissions. Cannot install or restart the host.",
      inputSchema: manageSchema,
      execute: async (input, { abortSignal }) => {
        const signal = abortSignal ?? neverAborted;
        try { return { ok: true, recipe: await options.store.change(input.id, input.expectedRevision, input.action, input.hash, signal) }; }
        catch (error) { if (signal.aborted) throw signal.reason; return failure(error); }
      },
    }));
    register("recipe_run", "external_side_effect", tool({
      description: "Execute an enabled recipe's exact current command via the existing Shell runner, with this-call approval and unchanged sandbox/timeouts. Read recipe_list first, supply its exact hash. No arguments, tool installation, persistent permission or automatic retries. A version pins command text, NOT external files/dependencies. Unknown effects must be reconciled, never replayed.",
      inputSchema: runSchema,
      execute: async (input, context) => {
        // Catch preparation errors only; shell transport/unknown outcomes must escape unchanged.
        let version;
        try { version = await options.store.get(input.id, input.expectedHash, context.abortSignal ?? neverAborted); }
        catch (error) { if (context.abortSignal?.aborted) throw context.abortSignal.reason; return failure(error); }
        return shell.execute!({ command: version.command, cwd: version.cwd }, context);
      },
    }), (options.shell.timeoutMs ?? 30_000) + (options.shell.sandbox ? 10_000 : 1000));
    ctx.registerCommand({ name: "recipes", execute: async () => {
      try { const list = await options.store.list(neverAborted);
        ctx.notify(list.length ? list.map(entry => {
          const active = entry.versions.find(v => v.hash === entry.activeHash)!;
          return `${entry.id} · ${entry.enabled ? "可用" : "已停用"} · v${entry.revision}\n${active.description}\n命令：${active.command}\ncwd：${active.cwd}\nhash：${entry.activeHash}`;
        }).join("\n\n") : "尚无命令配方。交办一个具体任务，验证成功后可以要求登记复用；不会自动安装工具或改变权限。");
      } catch { ctx.notify("无法读取命令配方；没有修改或执行任何内容。"); }
    } });
  } };
}
