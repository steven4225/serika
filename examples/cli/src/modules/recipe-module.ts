import { tool } from "ai";
import { z } from "zod";
import { AgentError } from "@aisdk-agent/core";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
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

/** Host validates concrete shell receipts. A successful exit is NOT proof of semantic quality or isolation. */
export function createRecipeModule(options: {
  store: RecipeStore; records: ExecutionRecordStore; threadId: string;
  currentRun: () => { runId: string; phase: string } | undefined;
  shell: ShellModuleOptions;
}): AgentModule {
  const shell = createShellExecTool(options.store.workspace, options.shell);
  return { id: "recipes", setup(ctx) {
    const register = (name: string, risk: "read" | "write" | "external_side_effect", implementation: RegisteredTool["tool"], timeoutMs = 5000) => ctx.registerTool({
      metadata: { name, version: "1", risk, idempotent: risk === "read", timeoutMs }, tool: implementation,
    });
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
