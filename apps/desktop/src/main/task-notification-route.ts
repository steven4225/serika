import { parseTaskResultLink, taskResultWorkspaceKey } from "@serika/example-cli/dist/task-result-link.js";
import type { AutomationResult } from "@serika/example-cli/dist/assistant-controller.js";
import type { TaskRecordV4 } from "@serika/example-cli/dist/task-store.js";

/** Notification payload can only select a record in the current workspace. */
export async function openTaskNotificationResult(link: string, workspaceRoot: string | null,
  getTask: (id: string) => Promise<AutomationResult<TaskRecordV4>>) {
  const route = parseTaskResultLink(link);
  if (!route || !workspaceRoot || route.workspaceKey !== taskResultWorkspaceKey(workspaceRoot)) {
    throw new Error("这条通知属于另一个工作区或链接无效；不会自动切换或读取它。");
  }
  const task = await getTask(route.taskId);
  if (!task.ok) throw new Error(`通知结果不可用：${task.error.code}`);
  return { taskId: route.taskId, workspaceRoot };
}
