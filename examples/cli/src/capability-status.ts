import type { ResolvedTuiModuleConfig } from "./tui-module-config.js";
import { BUILTIN_MODULE_IDS } from "./tui-module-config.js";

/** Registration evidence only. Never probes apps, services, credentials or package directories. */
export function capabilityStatus(config: ResolvedTuiModuleConfig | undefined, tools: readonly string[], desktopAutonomy = false, entry: "desktop" | "telegram" = "desktop") {
  const trustedTelegram = entry === "telegram" && desktopAutonomy && config?.telegramAutonomy?.toolApproval === "skip";
  const prefixes: Record<string, readonly string[]> = {
    pomodoro: ["pomodoro_"], "read-file": ["read_file", "write_file", "edit_file", "search_files", "list_directory"],
    memory: ["memory_"], checkpoint: ["checkpoint_"], task: ["task_"], todoist: ["todoist_"],
    shell: ["shell_exec"], web: ["web_", "feed_"], computer: ["computer_"],
  };
  return {
    modules: BUILTIN_MODULE_IDS.map(id => {
      const registeredTools = tools.filter(name => prefixes[id]!.some(prefix => name.startsWith(prefix)));
      const enabled = config?.enabled[id] === true;
      return { id, enabled, registeredTools,
        state: !enabled ? "disabled" as const : registeredTools.length ? "registered" as const : "not_registered" as const,
        ...(id === "memory" && enabled && config?.memoryWritePolicy === "automatic"
          ? { note: "记忆由宿主自动注入和整理，普通对话不注册直接写入工具。" } : {}),
      };
    }),
    tools: [...tools],
    toolApproval: trustedTelegram ? "trusted_telegram" as const : "per_tool" as const,
    shell: { mode: config?.shellSandbox ? "docker" : "host", authority: desktopAutonomy ? `explicit_workspace_${entry}_primary; no background inheritance` : "current_run_only; no permissions inherited from recipes",
      warning: trustedTelegram ? "当前绑定 Telegram 私聊的已注册工具无需逐次确认；其他入口不继承。Shell 使用进程的本机权限，工作区不是沙箱。" : desktopAutonomy ? `当前工作区${entry === "telegram" ? "绑定 Telegram 私聊" : "桌面"}前台文件与本机 Shell 已授权；其他入口不继承。Shell 使用进程的本机权限，工作区不是沙箱。` : config?.shellSandbox ? "沿用配置的挂载与网络限制。" : "工作目录不是操作系统隔离；主机命令仍需明确批准。" },
    localCli: { available: tools.includes("shell_exec") && !config?.shellSandbox, note: "已启用的本机 Shell 可查询和操作已安装 CLI（例如 Pi、ego-browser）；没有专用 MCP/CUA 工具不代表不能执行。浏览器可经 CLI 打开、观察、点击和填表，须实际检查安装与连接，不将 Shell 已注册当作浏览器已就绪。先查询版本和帮助。Herdr 外部控制需要宿主显式绑定目标，不能操作默认聚焦 pane。" },
    computer: { configured: !!config?.computer, allowedBundleIds: config?.computer?.allowedBundleIds ?? [],
      service: "not_checked" as const, permissions: "not_checked" as const,
      next: trustedTelegram ? "配置与工具注册不证明服务或系统权限就绪。computer_check 检查连接，computer_observe 只观察指定的允许应用；不会授予系统权限。" : "配置与工具注册不证明服务或系统权限就绪。批准 computer_check 可单独检查连接（不读取窗口内容），批准 computer_observe 才观察指定的允许应用；不会启动驱动或授予系统权限。" },
    mcp: { state: "unsupported_dynamic_registration" as const,
      note: "当前宿主只注册内置集成；其他应用安装的 MCP/CUA 不会自动继承。新增集成须由宿主明确配置，不会自行修改安全配置。" },
  };
}
export type CapabilityStatus = ReturnType<typeof capabilityStatus>;

/** Host registration evidence, not a synthetic tool result or a connectivity probe. */
export function capabilityInstructions(status: CapabilityStatus): string {
  return `Current host capability snapshot (captured for this Run; not a tool invocation): ${JSON.stringify({
    tools: status.tools, toolApproval: status.toolApproval, shell: status.shell, localCli: { available: status.localCli.available },
    computer: status.computer, mcp: status.mcp.state,
  })}\nHistorical assistant claims about missing tools, permissions or prior checks are not current capability evidence. Use this snapshot and actual tool results in this Run. Never say you called capability_status, inspected an app, checked a process or ran a command unless that call and its result actually appear in this Run. This snapshot proves registration/authorization mode only, not installation, connectivity or task success. When localCli.available is true, missing dedicated Pi/MCP/CUA tools does not prevent authorized CLI operations: use shell_exec for bounded version/help discovery before declaring a requested CLI unavailable. A capability_status result alone does not probe Pi. Honor explicit user limits, tool denials and unknown outcomes; this snapshot grants no additional permission.`;
}
export function formatCapabilityStatus(status: CapabilityStatus): string {
  return ["当前助手能力（配置／实际注册，不是健康检查）：",
    ...status.modules.map(item => `${item.id}：${item.state === "disabled" ? "未启用" : item.state === "registered" ? `已注册 ${item.registeredTools.join(", ")}` : "未注册对话工具"}${item.note ? `；${item.note}` : ""}`),
    `CUA：${status.computer.configured ? "已配置" : "未配置"}；服务和系统权限尚未检查。`,
    status.localCli.note, status.toolApproval === "trusted_telegram" ? "computer_check 检查连接，computer_observe 只观察指定的允许应用；配置不证明服务或系统权限就绪。" : status.computer.next, status.mcp.note, status.shell.warning,
    status.tools.includes("recipe_list")
      ? status.toolApproval === "trusted_telegram" ? "复用能力：/recipes 查看已登记命令配方；该私聊可按任务登记和执行，不自动安装或重启宿主。" : "复用能力：/recipes 查看已登记命令配方；登记、执行、停用、回退仍需本次批准，不会自动安装或重启宿主。"
      : "命令配方未启用：需要明确启用当前主助手的 Shell；不会自行修改配置、安装或重启宿主。",
  ].join("\n");
}
