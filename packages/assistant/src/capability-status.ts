import type { ResolvedTuiModuleConfig } from "./tui-module-config.js";
import { BUILTIN_MODULE_IDS } from "./tui-module-config.js";
import type { ToolConfirmation } from "./tool-confirmation.js";

/** A module-owned capability entry, same shape as the generic one. */
export type ModuleCapabilityEntry = (registeredTools: readonly string[]) => { id: string; enabled: boolean; registeredTools: string[]; state: "disabled" | "registered" | "not_registered"; note?: string };

export interface CapabilityStatusInput {
  config: ResolvedTuiModuleConfig | undefined;
  /** Names of the tools actually registered for the primary agent. */
  tools: readonly string[];
  /** The module that registered each tool (module-host evidence, not a name prefix). */
  toolModules: ReadonlyMap<string, string>;
  /** Host-authorized foreground autonomy is active for this entry. */
  autonomy?: boolean;
  entry?: "desktop" | "telegram";
  seatbelt?: boolean;
  permissions?: ReturnType<ToolConfirmation["snapshot"]> | undefined;
  /** Module-owned entries (Todoist, architecture-v2 §4.4 step 2); order stays BUILTIN_MODULE_IDS. */
  moduleEntries?: ReadonlyMap<string, ModuleCapabilityEntry>;
  pi?: ReturnType<import("./foreground-herdr.js").ForegroundHerdrTargets["snapshot"]>;
}

/** Registration evidence only. Never probes apps, services, credentials or package directories. */
export function capabilityStatus(input: CapabilityStatusInput) {
  const { config, tools, toolModules, autonomy: desktopAutonomy = false, entry = "desktop", moduleEntries = new Map<string, ModuleCapabilityEntry>() } = input;
  return {
    modules: BUILTIN_MODULE_IDS.map(id => {
      // Ownership is what the module host recorded at registration, not a name prefix.
      const registeredTools = tools.filter(name => toolModules.get(name) === id);
      const owned = moduleEntries.get(id);
      if (owned) return owned(registeredTools);
      const enabled = config?.enabled[id] === true;
      return { id, enabled, registeredTools,
        state: !enabled ? "disabled" as const : registeredTools.length ? "registered" as const : "not_registered" as const,
      };
    }),
    tools: [...tools],
    execution: {
      directories: config?.authorizedDirectories ?? [],
      files: input.permissions?.autonomousFiles === true ? "foreground_authorized" : "scoped_grants_or_confirmation",
      fileGrants: input.permissions?.fileAuthorizations ?? [],
      shell: { configured: config?.enabled.shell === true, registered: tools.includes("shell_exec"),
        mode: input.seatbelt ? "seatbelt" : config?.shellSandbox ? "docker" : "host",
        authorization: !tools.includes("shell_exec") ? "not_registered" : input.seatbelt ? "foreground_authorized" :
          config?.shellSandbox && input.permissions?.shell ? "current_run_authorized" : "per_call_confirmation",
        health: "not_checked" },
      terminal: { configured: config?.enabled.terminal === true, registered: tools.includes("terminal_exec"),
        authorization: tools.includes("terminal_exec") ? "per_call_confirmation" : "not_registered", health: "not_checked" },
      pi: { registered: tools.includes("herdr_pi_read") && tools.includes("herdr_pi_control"),
        target: config?.terminalTarget ?? null, authorization: "selected_target_reads_auto; control_per_call_confirmation", health: "not_checked",
        ...(input.pi ? { currentRun: input.pi } : {}) },
    },
    shell: { mode: config?.shellSandbox ? "docker" : "host", authority: desktopAutonomy ? `explicit_workspace_${entry}_primary; no background inheritance` : "current_run_only; no permissions inherited from recipes",
      warning: desktopAutonomy ? `当前工作区${entry === "telegram" ? "绑定 Telegram 私聊" : "桌面"}前台文件操作已授权，本机 Shell 仍逐条确认；其他入口不继承。Shell 使用进程的本机权限，工作区不是沙箱。` : config?.shellSandbox ? "沿用配置的挂载与网络限制。" : "工作目录不是操作系统隔离；主机命令仍需明确批准。" },
    computer: { configured: !!config?.computer, allowedBundleIds: config?.computer?.allowedBundleIds ?? [],
      service: "not_checked" as const, permissions: "not_checked" as const,
      next: "配置与工具注册不证明服务或系统权限就绪。computer_check 检查连接、computer_observe 观察明确授权的应用均免逐条确认；未授权应用直接拒绝，computer_action 每次确认且不可记住。不会启动驱动或授予系统权限。" },
    mcp: { state: "unsupported_dynamic_registration" as const,
      note: "当前宿主只注册内置集成；其他应用安装的 MCP/CUA 不会自动继承。新增集成须由宿主明确配置，不会自行修改安全配置。" },
  };
}
export type CapabilityStatus = ReturnType<typeof capabilityStatus>;
export function formatCapabilitySummary(status: CapabilityStatus): string {
  return "Host capability facts (configuration, registration and authorization; health remains not_checked):\n" + JSON.stringify({
    modules: status.modules.map(({ id, enabled, state }) => ({ id, enabled, state })),
    tools: [...status.tools].sort(), execution: status.execution,
  }) + "\nThese host facts take priority over conversation claims that a tool is missing. Registration does not prove installation or health. Disabled or unregistered tools remain unavailable. A registered Pi path can discover and adopt an existing target in this Run without persistent binding. Checked candidates were verified in this Run; verification is not adoption. candidateId is a temporary handle, not real identity. A refreshed handle does not mean the target disappeared. The host owns selection immediately after discovery and rechecks the adopted identity before every action. If these facts are insufficient, call capability_status for detail. Tool schemas are supplied separately.";
}
export function formatCapabilityStatus(status: CapabilityStatus): string {
  return ["当前助手能力（配置／实际注册，不是健康检查）：",
    ...status.modules.map(item => `${item.id}：${item.state === "disabled" ? "未启用" : item.state === "registered" ? `已注册 ${item.registeredTools.join(", ")}` : "未注册对话工具"}${item.note ? `；${item.note}` : ""}`),
    `CUA：${status.computer.configured ? "已配置" : "未配置"}；服务和系统权限尚未检查。`,
    status.computer.next, status.mcp.note, status.shell.warning,
    status.tools.includes("recipe_list")
      ? "复用能力：/recipes 查看已登记命令配方；登记、执行、停用、回退仍需本次批准，不会自动安装或重启宿主。"
      : "命令配方未启用：需要明确启用当前主助手的 Shell；不会自行修改配置、安装或重启宿主。",
  ].join("\n");
}
