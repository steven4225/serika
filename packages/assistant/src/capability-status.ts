import type { ResolvedTuiModuleConfig } from "./tui-module-config.js";
import { BUILTIN_MODULE_IDS } from "./tui-module-config.js";

/** Registration evidence only. Never probes apps, services, credentials or package directories. */
export function capabilityStatus(config: ResolvedTuiModuleConfig | undefined, tools: readonly string[], toolModules: ReadonlyMap<string, string>, desktopAutonomy = false, entry: "desktop" | "telegram" = "desktop") {
  return {
    modules: BUILTIN_MODULE_IDS.map(id => {
      // Ownership is what the module host recorded at registration, not a name prefix.
      const registeredTools = tools.filter(name => toolModules.get(name) === id);
      const enabled = config?.enabled[id] === true;
      return { id, enabled, registeredTools,
        state: !enabled ? "disabled" as const : registeredTools.length ? "registered" as const : "not_registered" as const,
        ...(id === "memory" && enabled && config?.memoryWritePolicy === "automatic"
          ? { note: "记忆由宿主自动注入和整理，普通对话不注册直接写入工具。" } : {}),
      };
    }),
    tools: [...tools],
    shell: { mode: config?.shellSandbox ? "docker" : "host", authority: desktopAutonomy ? `explicit_workspace_${entry}_primary; no background inheritance` : "current_run_only; no permissions inherited from recipes",
      warning: desktopAutonomy ? `当前工作区${entry === "telegram" ? "绑定 Telegram 私聊" : "桌面"}前台文件与本机 Shell 已授权；其他入口不继承。Shell 使用进程的本机权限，工作区不是沙箱。` : config?.shellSandbox ? "沿用配置的挂载与网络限制。" : "工作目录不是操作系统隔离；主机命令仍需明确批准。" },
    computer: { configured: !!config?.computer, allowedBundleIds: config?.computer?.allowedBundleIds ?? [],
      service: "not_checked" as const, permissions: "not_checked" as const,
      next: "配置与工具注册不证明服务或系统权限就绪。批准 computer_check 可单独检查连接（不读取窗口内容），批准 computer_observe 才观察指定的允许应用；不会启动驱动或授予系统权限。" },
    mcp: { state: "unsupported_dynamic_registration" as const,
      note: "当前宿主只注册内置集成；其他应用安装的 MCP/CUA 不会自动继承。新增集成须由宿主明确配置，不会自行修改安全配置。" },
  };
}
export type CapabilityStatus = ReturnType<typeof capabilityStatus>;
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
