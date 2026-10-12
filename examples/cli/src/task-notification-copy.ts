import type { TaskRecord } from "./task-store.js";

const TITLE_MAX_CHARACTERS = 42;

function clipSentence(value: string): string | null {
  const flat = value.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const characters = Array.from(flat);
  if (characters.length <= TITLE_MAX_CHARACTERS) return flat;
  return `${characters.slice(0, TITLE_MAX_CHARACTERS - 1).join("")}…`;
}

function completedTitle(task: TaskRecord): string {
  const kind = task.arrangement?.kind;
  if (kind === "reminder") {
    const source = task.resultText?.trim() ? task.resultText : task.prompt;
    return clipSentence(source) ?? "提醒时间到了";
  }
  switch (kind) {
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

/** Lock-screen title is one short sentence. Long results stay in the inbox. */
export function taskNotificationCopy(task: TaskRecord): { title: string; body: string } {
  switch (task.status) {
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
    case "scheduled":
    case "running":
      return { title: "有一条定时结果", body: "详情在收件箱。" };
    default: {
      const unreachable: never = task.status;
      return unreachable;
    }
  }
}
