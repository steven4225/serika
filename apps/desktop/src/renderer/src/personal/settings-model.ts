import type { AppInfo } from "../../../shared/ui-contract.js";

export const SETTINGS_ROUTES = [
  "home",
  "manage",
  "connectors",
  "devices",
  "skills",
  "channels",
  "workspace",
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

const CONNECTOR_MODULE_IDS = ["read-file", "web", "computer", "todoist"] as const;

export function isConnectorModule(id: string): boolean {
  return (CONNECTOR_MODULE_IDS as readonly string[]).includes(id);
}

export function settingsRouteForInitial(initial: false | "modules" | "context"): SettingsRoute {
  if (initial === "context") return "context";
  if (initial === "modules") return "skills";
  return "home";
}

/** Home returns to 手札. Every pushed pane returns to the settings list. */
export function settingsBackTarget(route: SettingsRoute): "hand" | "home" {
  return route === "home" ? "hand" : "home";
}

export function settingsCopy(route: SettingsRoute): { title: string; description: string } {
  switch (route) {
    case "home": return { title: "设置", description: "外观、偏好和应用信息" };
    case "manage": return { title: "管理", description: "这台电脑上的身份。本地使用，无需订阅。" };
    case "connectors": return { title: "连接应用", description: "让 Serika 使用本机文件、网页和已允许的应用。" };
    case "devices": return { title: "设备", description: "这台电脑。云电脑未配置。" };
    case "skills": return { title: "技能", description: "管理 Serika 可以使用的能力。" };
    case "channels": return { title: "聊天渠道", description: "在 Telegram 里使用 Serika。" };
    case "workspace": return { title: "工作区", description: "当前工作区、记忆和已保存的进度。" };
    case "general": return { title: "通用", description: "外观、语言，以及退出桌面后是否继续。" };
    case "notifications": return { title: "通知", description: "消息提醒。入会提醒未配置。" };
    case "shortcuts": return { title: "快捷键", description: "搜索、发送和显示窗口。" };
    case "about": return { title: "关于", description: "当前版本。退出登录未配置。" };
    case "context": return { title: "上下文与压缩", description: "长对话由系统自动管理，通常不需要你操作。" };
    default: {
      const unreachable: never = route;
      return unreachable;
    }
  }
}

export const SETTINGS_CONNECTION_ROWS = [
  { route: "connectors", title: "连接应用", description: "让 Serika 使用本机文件、网页和已允许的应用。" },
  { route: "devices", title: "设备", description: "这台电脑，以及本机应用控制是否开启。" },
  { route: "skills", title: "技能", description: "管理 Serika 可以使用的能力。" },
  { route: "channels", title: "聊天渠道", description: "在 Telegram 里使用 Serika。" },
  { route: "workspace", title: "工作区", description: "当前工作区、记忆和已保存的进度。" },
] as const satisfies readonly { route: SettingsRoute; title: string; description: string }[];

export const SETTINGS_RECORD_ROWS = [
  { route: "records", title: "执行记录与用量", description: "核对每次执行的工具结果，以及近期模型调用。" },
] as const satisfies readonly { route: SettingsListTarget; title: string; description: string }[];

export const SETTINGS_OTHER_ROWS = [
  { route: "general", title: "通用", description: "外观、语言，以及退出桌面后是否继续。" },
  { route: "notifications", title: "通知", description: "消息提醒。入会提醒未配置。" },
  { route: "shortcuts", title: "快捷键", description: "搜索、发送和显示窗口。" },
  { route: "about", title: "关于", description: "当前版本。退出登录未配置。" },
] as const satisfies readonly { route: SettingsRoute; title: string; description: string }[];

type SettingsInfo = Pick<AppInfo, "workspaceRoot" | "computer" | "modules"> | null;

export function settingsRowDescription(route: SettingsRoute, info: SettingsInfo, fallback: string): string {
  if (!info) return fallback;
  if (route === "workspace") return info.workspaceRoot ? fallback : "工作区未配置。";
  if (route === "devices") return info.computer.enabled ? "本机应用控制已开启。" : "本机应用控制未开启。";
  if (route === "connectors" || route === "skills") {
    const modules = (info.modules ?? []).filter(module => route === "connectors" ? isConnectorModule(module.id) : !isConnectorModule(module.id));
    const enabled = modules.filter(module => module.enabled).length;
    return enabled > 0 ? `已开启 ${enabled} 项。` : fallback;
  }
  return fallback;
}

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
