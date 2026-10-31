import { arrangementDisplayStatus } from "./task-lifecycle.js";
import type { TaskRecord } from "./task-store.js";

/** Returned by the desktop notifier when the in-app window is already frontmost. */
export const FOREGROUND_NOTIFICATION_OMITTED = "foreground-omitted" as const;
export type DesktopNotificationDelivery = "submitted" | typeof FOREGROUND_NOTIFICATION_OMITTED;

function completedTitle(task: TaskRecord): string {
  const kind = task.arrangement?.kind;
  switch (kind) {
    case "reminder":
      return "提醒时间到了";
    case "todoist-brief":
      return "Todoist 日报已保存";
    case "rss-digest":
      return "资讯检查已结束";
    case "skill":
      return "定时结果已保存";
    case undefined:
      return "定时结果已保存";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** Lock-screen copy omits all prompt/result content; it stays in the application inbox. */
export function taskNotificationCopy(task: TaskRecord & { attempts?: readonly { status: string }[] }): { title: string; body: string } {
  switch (arrangementDisplayStatus(task)) {
    case "completed":
      return {
        title: completedTitle(task),
        body: task.arrangement?.kind === "reminder" ? "提醒已到，详情在收件箱。" : "详情在收件箱。",
      };
    case "failed":
      return { title: "这次安排没有完成", body: "详情在收件箱，不会自动重做。" };
    case "interrupted":
      return { title: "安排中断，不会自动重做", body: "请回桌面核对。详情在收件箱。" };
    case "cancelled":
      return { title: "这次安排已取消", body: "详情在收件箱。" };
    case "pending":
    case "running":
      return { title: "有一条定时结果", body: "详情在收件箱。" };
    default:
      return { title: "有一条定时结果", body: "详情在收件箱。" };
  }
}
