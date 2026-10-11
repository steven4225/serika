export interface SourceRevision {
  revision: string | null;
  dirty: boolean | null;
}

export interface DesktopBuildManifest {
  schemaVersion: 1;
  id: string;
  version: string;
  builtAt: string;
  frontendSource: SourceRevision;
  backendSource: SourceRevision;
  /** Project-owned compiled JS only, not a claim that source has been rebuilt. */
  backendDistFingerprint: string | null;
}

export interface AppBuildInfo {
  /** Runtime owner, not necessarily the Electron main process displaying the page. */
  host?: "desktop" | "resident";
  loaded: DesktopBuildManifest | null;
  /** Frozen when this process starts; never replaced by a later disk build. */
  backendDistAtStartup: string | null;
  backendMatchesBuild: boolean | null;
  diskBuild: "same" | "different" | "unavailable";
  diskBuildId: string | null;
}

export function buildStatus(info: AppBuildInfo, rendererBuild?: DesktopBuildManifest | null): { warning: boolean; text: string } {
  if (info.host === "resident" && (info.diskBuild === "different" ||
    (rendererBuild && info.loaded && rendererBuild.id !== info.loaded.id))) {
    return { warning: true, text: "常驻助手仍加载另一版构建；桌面更新不代表常驻和后台 worker 已更新。请在任务结束、草稿保存后显式停用常驻助手和后台提醒，退出托盘，再手动重开并重新启用。刷新页面或只关窗口不会更新这些进程；不会自动停止它们。" };
  }
  if (!info.loaded) return { warning: true, text: "当前是开发或未标记构建，无法确认已加载版本。" };
  if (rendererBuild && rendererBuild.id !== info.loaded.id) return { warning: true, text: "页面与主进程加载了不同构建。请在任务结束、草稿保存后退出并重开；刷新页面不会更新主进程。" };
  if (info.diskBuild === "different") return { warning: true, text: "磁盘已有另一版构建，当前主进程仍在使用下方版本。请在任务结束、草稿保存后退出并重开；刷新页面不会更新主进程。" };
  if (rendererBuild === null) return { warning: true, text: "当前页面没有构建标识，无法确认页面与主进程是否一致。" };
  if (info.backendMatchesBuild === false) return { warning: true, text: "启动时后端产物与桌面构建时不同。这是混合版本；重新构建桌面并在空闲时退出重开后再核对。" };
  if (info.backendMatchesBuild === null || info.diskBuild === "unavailable") return { warning: true, text: "部分构建标识不可读取，不能确认当前版本一致。已加载信息仍保留，不会用磁盘版本替换它。" };
  return { warning: false, text: "当前主进程与磁盘桌面构建一致，启动时后端产物与该构建匹配。" };
}

/** Startup evidence is a warning, not a fingerprint or proof of current code/liveness. */
export function workerBuildStatus(worker: { running: boolean; processStartedAt?: string | null } | null,
  build: DesktopBuildManifest | null | undefined): { warning: boolean; text: string } | null {
  if (!worker?.running) return null;
  const start = Date.parse(worker.processStartedAt ?? "");
  const built = Date.parse(build?.builtAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(built)) return {
    warning: true, text: "后台 worker 在运行，但缺少可核对的启动时间，不能确认已加载新代码。需要时请显式停用后台提醒后重新启用；不会自动停止。",
  };
  if (start < built) return { warning: true, text: "后台 worker 启动早于当前桌面构建，可能仍在运行旧代码。请等当前任务结束，显式停用后台提醒和常驻助手，退出托盘，再手动重开并重新启用；不会自动停止或重做旧任务。" };
  return { warning: false, text: "后台 worker 启动晚于当前桌面构建；这是启动时间核对，不是构建指纹或通知送达证明。" };
}
