import type { Writable } from "node:stream";
import type { BeforeToolExecute, BeforeToolExecuteInput } from "@serika/core";
import type { ModuleCommand, ToolPermissionFacts } from "./module-host.js";
import type { DockerShellSandboxConfig } from "./modules/docker-shell-runner.js";
import type { RuntimeExtension } from "./runtime-extension.js";
import {
  createToolConfirmation,
  type ToolConfirmation,
  type ToolConfirmationPrompt,
  type ToolRiskLookup,
} from "./tool-confirmation.js";
import type { FileAuthorizationRule } from "./tui-module-config.js";

/**
 * Tool permission as one extension: the per-call confirmation hook, the
 * host's fixed pre-approvals, the next-Run `/authorize*` grants and the
 * `/permissions` report. The decision rules are those of `createToolConfirmation`.
 */
export interface PermissionExtension extends RuntimeExtension {
  readonly beforeToolExecute: BeforeToolExecute;
  /** The approval state the controller reads, resolves and scopes to Runs. */
  readonly confirmation: ToolConfirmation;
}

export function createPermissionExtension(output: Writable, options: {
  prompt: ToolConfirmationPrompt;
  workspaceRoot: string | undefined;
  /** Explicit `fileAuthorizations` from the trusted config; they load once. */
  fileAuthorizations: readonly FileAuthorizationRule[];
  shell: { enabled: boolean; sandbox: DockerShellSandboxConfig | undefined };
  /** Only for the `/permissions` report. */
  web: { enabled: boolean; searchEnabled: boolean };
  /** Permission facts declared by the assembled modules, by tool name. */
  toolPermissions?: ReadonlyMap<string, ToolPermissionFacts>;
  /** Present when a module configuration was resolved; enables `/permissions`. */
  report: { configPath: string | null; workspaceRoot: string | null } | undefined;
  /**
   * Host-owned calls that never ask, checked in order before confirmation
   * (for example a skill's own declared read tools).
   */
  autoApprove: readonly ((input: BeforeToolExecuteInput) => boolean)[];
  /** Declared risk of registered tools; read-risk tools may be remembered by name. */
  toolRisk?: ToolRiskLookup;
}): PermissionExtension {
  const { workspaceRoot, fileAuthorizations, report } = options;
  const shellSandbox = options.shell.sandbox;
  const confirmation = createToolConfirmation(output, {
    prompt: options.prompt,
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    shellSandboxMode: shellSandbox === undefined ? "host" : "docker",
    ...(options.toolRisk ? { toolRisk: options.toolRisk } : {}),
    ...(options.toolPermissions ? { toolPermissions: options.toolPermissions } : {}),
    ...(fileAuthorizations.length > 0
      ? {
          persistentAuthorizations: fileAuthorizations.map(
            (rule) => ({ ...rule, lifetime: "run" as const }),
          ),
        }
      : {}),
  });
  const beforeToolExecute: BeforeToolExecute = (input) => {
    for (const approve of options.autoApprove) {
      if (approve(input)) {
        input.signal.throwIfAborted();
        return { allow: true };
      }
    }
    return confirmation.beforeToolExecute(input);
  };

  const commands: ModuleCommand[] = [];
  const declared = [...(options.toolPermissions ?? new Map<string, ToolPermissionFacts>())];
  const scopeAuthorizable = (kind: "origin" | "workspacePath") => declared.flatMap(([name, facts]) =>
    facts.defaults?.runAuthorization === "scope" && facts.scope?.kind === kind ? [name] : []);
  // `/authorize` exists only when an assembled tool declares workspace path authorization.
  const pathTools = scopeAuthorizable("workspacePath");
  if (pathTools.length > 0 && workspaceRoot !== undefined) {
    commands.push({
      name: "authorize",
      execute(args) {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const toolToken = tokens.shift();
        const allowedPaths = tokens;
        if (toolToken === undefined || allowedPaths.length === 0) {
          output.write(
            "\n[authorize] Usage: /authorize <tool[,tool...]> <path> [path ...]\n",
          );
          return;
        }
        const toolsToAuthorize = toolToken.split(",").filter(Boolean);
        if (
          toolsToAuthorize.length === 0 ||
          toolsToAuthorize.some(
            (toolName) =>
              !pathTools.includes(toolName),
          )
        ) {
          output.write(
            `\n[authorize] Only these tools can be authorized for one Run: ${pathTools.join(", ")}\n`,
          );
          return;
        }
        try {
          confirmation.setPendingAuthorization({
            tools: toolsToAuthorize,
            allowedPaths,
            lifetime: "run",
          });
          output.write(
            `\n[authorize] 已为下一次 Run 授权 ${toolsToAuthorize.join(", ")}，路径范围：${allowedPaths.join(", ")}。Run 结束后失效；其它工具和路径仍需确认。\n`,
          );
        } catch (error) {
          output.write(`\n[authorize] Invalid rule: ${String(error)}\n`);
        }
      },
    });
  }
  if (options.shell.enabled) {
    commands.push({
      name: "authorize-shell",
      execute(args) {
        if (args.trim() !== "") {
          output.write("\n[authorize-shell] Usage: /authorize-shell\n");
          return;
        }
        if (shellSandbox === undefined) {
          output.write(
            "\n[authorize-shell] Docker sandbox is not configured; shell calls still require per-call y/n confirmation.\n",
          );
          return;
        }
        confirmation.setPendingShellAuthorization();
        output.write(
          "\n[authorize-shell] 已为下一次 Run 授权 Docker sandbox 内的 shell 调用；Run 结束、失败或取消后失效。\n",
        );
      },
    });
  }
  // `/authorize-web` exists only when an assembled tool declares origin authorization.
  const originTools = scopeAuthorizable("origin");
  if (originTools.length > 0) {
    commands.push({
      name: "authorize-web",
      execute(args) {
        const origins = args.trim().split(/\s+/).filter(Boolean);
        if (origins.length === 0) {
          output.write("\n[authorize-web] Usage: /authorize-web <origin> [origin ...]\n");
          return;
        }
        try {
          confirmation.setPendingWebAuthorization(origins);
          output.write(
            `\n[authorize-web] 已为下一次 Run 授权 ${originTools.join("/")} 访问：${origins.join(", ")}。Run 结束、失败或取消后失效；其它 origin 仍需确认。\n`,
          );
        } catch (error) {
          output.write(`\n[authorize-web] Invalid origin: ${String(error)}\n`);
        }
      },
    });
  }
  if (report !== undefined) {
    commands.push({
      name: "permissions",
      execute(args) {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        if (tokens[0] === "forget" && tokens.length === 2) {
          output.write(confirmation.forgetRemembered(tokens[1]!)
            ? `\n[permissions] 已清除第 ${tokens[1]} 条记住的授权；之后同类调用会重新询问。\n`
            : `\n[permissions] 没有编号为 ${tokens[1]} 的记住授权。\n`);
          return;
        }
        if (tokens.length !== 0) {
          output.write("\n[permissions] Usage: /permissions | /permissions forget <编号>\n");
          return;
        }
        const source =
          report.configPath === null
            ? "CLI 参数/默认值"
            : JSON.stringify(report.configPath);
        const workspace =
          report.workspaceRoot === null
            ? "未配置"
            : JSON.stringify(report.workspaceRoot);
        output.write(
          `\n[permissions]\n配置来源: ${source}\nWorkspace: ${workspace}\n`,
        );
        if (shellSandbox === undefined) {
          output.write("Shell sandbox: host (逐次 y/n)\n");
        } else {
          output.write(
            `Shell sandbox: docker (network none)\nShell image: ${shellSandbox.image}\n` +
              `Shell readable: ${shellSandbox.readablePaths.join(",") || "none"}\n` +
              `Shell writable: ${shellSandbox.writablePaths.join(",") || "none"}\n`,
          );
        }
        output.write(
          `Web module: ${options.web.enabled ? "enabled (web_fetch)" : "disabled"}; web authorization is one-Run and origin-specific.\n` +
            `Web search: ${options.web.enabled && options.web.searchEnabled ? "enabled (Exa MCP, no key)" : "disabled"}\n`,
        );
        if (fileAuthorizations.length === 0) {
          output.write("持久文件授权: 未配置\n");
        } else {
          output.write(
            `持久文件授权: ${fileAuthorizations.length} 条\n`,
          );
          for (const [index, rule] of fileAuthorizations.entries()) {
            output.write(
              `- ${index + 1}: tools=${rule.tools.join(",")} paths=${rule.allowedPaths.join(",")}\n`,
            );
          }
          output.write("修改或删除配置后需重启 TUI 生效。\n");
        }
        const remembered = confirmation.listRemembered();
        if (remembered.length === 0) {
          output.write("本次对话记住的授权: 无\n");
        } else {
          output.write(`本次对话记住的授权: ${remembered.length} 条（只在本进程内存，重启或切换对话后失效；Telegram 不继承）\n`);
          for (const grant of remembered) output.write(`- ${grant.id}: ${grant.label}\n`);
          output.write("用 /permissions forget <编号> 清除单条。\n");
        }
        output.write(
          "Shell 的下一 Run 授权只在 Docker sandbox 模式可用；host 模式默认逐次确认，桌面可显式开启工作区自主执行。Shell、memory、checkpoint、Todoist、task 不受持久文件授权影响。\n",
        );
      },
    });
  }

  return { name: "permissions", beforeToolExecute, confirmation, commands };
}
