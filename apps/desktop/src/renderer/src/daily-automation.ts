import type { NotificationReadinessStatus, RssWorkerResponse } from "../../shared/ui-contract.js";

export function backgroundServiceLabel(worker: RssWorkerResponse | null): string {
  if (!worker) return "正在查询…";
  if (!worker.ok) return "状态不可用；请刷新或查看配置诊断，暂不能依赖提醒";
  if (worker.setupReady === false) return "后台服务配置未就绪；请查看配置诊断，暂不能依赖提醒";
  if (!worker.registered) return "未启用；关窗口后不会执行提醒";
  if (!worker.running) return "已注册，但当前未报告运行进程；暂不能依赖提醒";
  if (worker.notifyEnabled !== true) return "进程运行中，但未确认通知配置";
  if (worker.notificationRoutingEnabled !== true) return "进程运行中，但未配置点击通知打开结果";
  return "后台服务运行中；已配置系统通知和结果跳转";
}

/** The task capability governs scheduling, not ownership of an existing service. */
export function backgroundActionAllowed(action: "test" | "enable" | "disable", enabled: boolean, busy: boolean, working: boolean): boolean {
  return !busy && !working && (action !== "enable" || enabled);
}

export function notificationPermissionLabel(status: NotificationReadinessStatus | null): string {
  if (!status) return "正在查询…";
  if (!status.helperConfigured) return "Serika 通知未就绪";
  switch (status.authorization) {
    case "authorized": return "系统已允许通知";
    case "not_requested": return "尚未申请；请发送一次测试通知";
    case "denied": return "系统已拒绝；请在系统设置中允许通知";
    case "unknown": return "权限状态未确认";
  }
}
