import type { TaskRecordV4 } from "@serika/assistant";
import type { RendererApi } from "./ui-contract.js";

type SavedResultReader = Pick<RendererApi, "getTaskInbox" | "getScheduledTask">;
const terminal = (task: Pick<TaskRecordV4, "status" | "acknowledgedAt">) =>
  task.acknowledgedAt === null && ["completed", "failed", "interrupted"].includes(task.status);

/** Presentation only: never alters acknowledgement, task status, or history. */
export function createTaskNoticeDismissals(storage: Pick<Storage, "getItem" | "setItem">, workspaceRoot: string) {
  const key = `serika:task-notice-dismissed:${workspaceRoot}`;
  const identity = (task: Pick<TaskRecordV4, "id" | "finishedAt">) => JSON.stringify([task.id, task.finishedAt]);
  let dismissed: string[] = [];
  const read = (): string[] => {
    try {
      const saved: unknown = JSON.parse(storage.getItem(key) ?? "[]");
      return Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string").slice(-128) : [];
    } catch { return []; }
  };
  return {
    has: (task: Pick<TaskRecordV4, "id" | "finishedAt">) => dismissed.includes(identity(task)) || read().includes(identity(task)),
    dismiss(task: Pick<TaskRecordV4, "id" | "finishedAt">) {
      dismissed = [...new Set([...read(), ...dismissed].filter(value => value !== identity(task))), identity(task)].slice(-128);
      try { storage.setItem(key, JSON.stringify(dismissed)); }
      catch { /* The current window still hides this result. No task data is changed. */ }
    },
  };
}

/** Read the current workspace's persisted result; this path never executes or acknowledges a task. */
export async function readSavedTaskNotice(reader: SavedResultReader, isDismissed = (_task: Pick<TaskRecordV4, "id" | "finishedAt">) => false): Promise<TaskRecordV4 | null> {
  const inbox = await reader.getTaskInbox();
  if (!inbox.ok) throw new Error("暂时无法读取定时结果，请到工作区收件箱核对。");
  const latest = inbox.value.tasks.filter(task => terminal(task) && !isDismissed(task)).sort((a, b) =>
    (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
  if (!latest) return null;
  const detail = await reader.getScheduledTask(latest.id);
  if (!detail.ok) throw new Error("定时结果详情暂不可用，请到工作区收件箱核对。");
  return detail.value.id === latest.id && terminal(detail.value) && !isDismissed(detail.value) ? detail.value : null;
}

/** A disposed workspace reader cannot publish a late response into its replacement. */
export function createSavedTaskNoticeReader(reader: SavedResultReader,
  publish: (task: TaskRecordV4 | null) => void, report: (message: string) => void,
  isDismissed?: (task: Pick<TaskRecordV4, "id" | "finishedAt">) => boolean) {
  let alive = true;
  let reading = false;
  return {
    dispose() { alive = false; },
    async refresh() {
      if (!alive || reading) return;
      reading = true;
      try {
        const saved = await readSavedTaskNotice(reader, isDismissed);
        if (alive) { publish(saved); report(""); }
      } catch (cause) {
        if (alive) { publish(null); report(cause instanceof Error ? cause.message : "定时结果读取失败，请查看收件箱。"); }
      } finally { reading = false; }
    },
  };
}
