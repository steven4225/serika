export const SETTINGS_ROUTES = [
  "home",
  "connectors",
  "devices",
  "skills",
  "channels",
  "memory",
  "advanced",
  "files",
  "general",
  "notifications",
  "shortcuts",
  "about",
  "context",
] as const;

export type SettingsRoute = (typeof SETTINGS_ROUTES)[number];

/** Records stay on the existing panel. They are a settings handoff, not a pushed settings page. */
export type SettingsListTarget = SettingsRoute | "records";

export type ThinkingChoice = "balanced" | "performance";

/** Poll interval while app info / host IPC is not ready yet. */
export const SETTINGS_HOST_RETRY_MS = 300;
export const SETTINGS_HOST_READ_ATTEMPTS = 4;

const CONNECTOR_MODULE_IDS = ["todoist"] as const;

export function isConnectorModule(id: string): boolean {
  return (CONNECTOR_MODULE_IDS as readonly string[]).includes(id);
}

export function settingsRouteForInitial(initial: false | "modules" | "context" | "terminal" | "computer"): SettingsRoute {
  if (initial === "computer") return "devices";
  if (initial === "terminal") return "files";
  if (initial === "context") return "context";
  if (initial === "modules") return "advanced";
  return "home";
}

/** Home returns to 手札. Every pushed pane returns to the settings list. */
export function settingsBackTarget(route: SettingsRoute): "hand" | "home" {
  return route === "home" ? "hand" : "home";
}

export function settingsCopy(route: SettingsRoute): { title: string; description: string } {
  switch (route) {
    case "home": return { title: "设置", description: "外观、偏好和应用信息" };
    case "connectors": return { title: "连接应用", description: "连接 Todoist 等外部服务。" };
    case "devices": return { title: "电脑控制", description: "查看允许控制的应用、驱动与实际注册的工具。" };
    case "skills": return { title: "技能", description: "使用已加载的文本技能、命令配方和已审核的经验。" };
    case "channels": return { title: "Telegram", description: "连接手机私聊，接收回复、确认操作和提醒结果。" };
    case "memory": return { title: "记忆设置", description: "设置日常聊天中的自动记忆。" };
    case "advanced": return { title: "高级", description: "数据位置、上下文、内置功能与执行诊断。" };
    case "files": return { title: "文件与网页", description: "访问工作区文件、公开网页、搜索和 RSS 来源。" };
    case "general": return { title: "通用", description: "切换 Serika 的浅色或深色外观。" };
    case "notifications": return { title: "通知与后台", description: "检查系统通知、后台提醒和常驻助手的运行状态。" };
    case "shortcuts": return { title: "快捷键", description: "搜索、发送和显示窗口。" };
    case "about": return { title: "关于", description: "查看实际加载版本，导出或恢复本机数据。" };
    case "context": return { title: "上下文与压缩", description: "长对话由系统自动管理，通常不需要你操作。" };
    default: {
      const unreachable: never = route;
      return unreachable;
    }
  }
}

export const SETTINGS_CONNECTION_ROWS = [
  { route: "connectors", title: "连接应用", description: "连接 Todoist 等外部服务。" },
  { route: "files", title: "文件与网页", description: "访问工作区文件、公开网页、搜索和 RSS 来源。" },
  { route: "devices", title: "电脑控制", description: "查看允许控制的应用、驱动与实际注册的工具。" },
  { route: "skills", title: "技能", description: "使用已加载的文本技能、命令配方和已审核的经验。" },
  { route: "channels", title: "Telegram", description: "连接手机私聊，接收回复、确认操作和提醒结果。" },
] as const satisfies readonly { route: SettingsRoute; title: string; description: string }[];

export const SETTINGS_OTHER_ROWS = [
  { route: "general", title: "通用", description: "切换 Serika 的浅色或深色外观。" },
  { route: "memory", title: "记忆设置", description: "设置日常聊天中的自动记忆。" },
  { route: "notifications", title: "通知与后台", description: "检查系统通知、后台提醒和常驻助手的运行状态。" },
  { route: "shortcuts", title: "快捷键", description: "搜索、发送和显示窗口。" },
  { route: "advanced", title: "高级", description: "数据位置、上下文、内置功能与执行诊断。" },
  { route: "about", title: "关于", description: "查看实际加载版本，导出或恢复本机数据。" },
] as const satisfies readonly { route: SettingsRoute; title: string; description: string }[];

export function thinkingChoiceForBudget(mode: "daily" | "long-task" | undefined): ThinkingChoice | "unconfigured" {
  if (mode === "daily") return "balanced";
  if (mode === "long-task") return "performance";
  return "unconfigured";
}

/** Same choice is a no-op. A new choice maps onto the existing context-budget preset. */
export function applyThinkingChoice(current: ThinkingChoice | "unconfigured", choice: ThinkingChoice): "daily" | "long-task" | null {
  if (current === choice) return null;
  return choice === "balanced" ? "daily" : "long-task";
}

export interface RecordedCallPage {
  calls: readonly { status?: string }[];
  droppedCount?: number;
}

export interface RecordedCallView {
  /** Provider attempts. Cancelled before dispatch is excluded. Null when the page was not reported. */
  recordedCalls: number | null;
  /** The journal dropped older calls, so recordedCalls is only the retained window. */
  incomplete: boolean;
}

/** Count calls that reached dispatch. A dropped journal is a retained window, not a full total. */
export function recordedCallView(page: RecordedCallPage | null | undefined): RecordedCallView {
  if (!page) return { recordedCalls: null, incomplete: false };
  return {
    recordedCalls: page.calls.filter(call => call.status !== "not_dispatched").length,
    incomplete: typeof page.droppedCount === "number" && page.droppedCount > 0,
  };
}

export function recordedCallLabel(view: RecordedCallView): string | null {
  if (view.recordedCalls === null) return null;
  if (view.incomplete) return `近期保留记录 · ${view.recordedCalls} 次调用`;
  return `已记录 ${view.recordedCalls} 次模型调用`;
}

export type HostReadResult<T> = { ok: true; value: T } | { ok: false; retry: boolean };

export type HostReadOutcome<T> =
  | { status: "ready"; value: T }
  | { status: "unavailable" }
  | { status: "stale" };

/**
 * Wait until the host is ready, then read. Failures retry. A superseded read
 * returns stale so a late response cannot overwrite a newer result.
 */
export async function readWhenHostReady<T>(input: {
  hostReady: () => boolean;
  read: () => Promise<HostReadResult<T>>;
  isCurrent: () => boolean;
  wait?: (ms: number) => Promise<void>;
  retryMs?: number;
  maxAttempts?: number;
}): Promise<HostReadOutcome<T>> {
  const wait = input.wait ?? ((ms: number) => new Promise(resolve => { setTimeout(resolve, ms); }));
  const retryMs = input.retryMs ?? SETTINGS_HOST_RETRY_MS;
  const maxAttempts = input.maxAttempts ?? SETTINGS_HOST_READ_ATTEMPTS;
  let attempts = 0;
  while (input.isCurrent()) {
    if (!input.hostReady()) {
      await wait(retryMs);
      continue;
    }
    attempts += 1;
    try {
      const result = await input.read();
      if (!input.isCurrent()) return { status: "stale" };
      if (result.ok) return { status: "ready", value: result.value };
      if (!result.retry) return { status: "unavailable" };
    } catch {
      if (!input.isCurrent()) return { status: "stale" };
    }
    if (!input.isCurrent()) return { status: "stale" };
    if (attempts >= maxAttempts) return { status: "unavailable" };
    await wait(retryMs);
  }
  return { status: "stale" };
}

/** Ignore a response whose request id is no longer the latest. */
export function takeHostRead<T>(request: number, current: number, outcome: HostReadOutcome<T>): { status: "ready"; value: T } | { status: "unavailable" } | null {
  if (request !== current || outcome.status === "stale") return null;
  if (outcome.status === "ready") return outcome;
  return { status: "unavailable" };
}

export type RecordedCallRead =
  | { status: "ready"; view: RecordedCallView }
  | { status: "inactive" }
  | { status: "stale" };

/** Read the existing usage page only while settings is showing it. A late page is stale. */
export async function readRecordedCallsWhenActive(input: {
  active: () => boolean;
  read: () => Promise<RecordedCallPage | null | undefined>;
  isCurrent: () => boolean;
}): Promise<RecordedCallRead> {
  if (!input.isCurrent() || !input.active()) return { status: "inactive" };
  try {
    const page = await input.read();
    if (!input.isCurrent()) return { status: "stale" };
    if (!input.active()) return { status: "inactive" };
    return { status: "ready", view: recordedCallView(page) };
  } catch {
    if (!input.isCurrent()) return { status: "stale" };
    if (!input.active()) return { status: "inactive" };
    return { status: "ready", view: recordedCallView(undefined) };
  }
}
