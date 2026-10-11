import type { TaskRecordV4 } from "@aisdk-agent/example-cli/dist/task-store.js";
import type { RendererApi } from "./ui-contract.js";

type SavedResultReader = Pick<RendererApi, "getTaskInbox" | "getScheduledTask">;
const terminal = (task: Pick<TaskRecordV4, "status" | "acknowledgedAt">) =>
  task.acknowledgedAt === null && ["completed", "failed", "interrupted"].includes(task.status);

/** Read the current workspace's persisted result; this path never executes or acknowledges a task. */
export async function readSavedTaskNotice(reader: SavedResultReader): Promise<TaskRecordV4 | null> {
  const inbox = await reader.getTaskInbox();
  if (!inbox.ok) throw new Error("暂时无法读取定时结果，请到工作区收件箱核对。");
  const latest = inbox.value.tasks.filter(terminal).sort((a, b) =>
    (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""))[0];
  if (!latest) return null;
  const detail = await reader.getScheduledTask(latest.id);
  if (!detail.ok) throw new Error("定时结果详情暂不可用，请到工作区收件箱核对。");
  return detail.value.id === latest.id && terminal(detail.value) ? detail.value : null;
}

/** A disposed workspace reader cannot publish a late response into its replacement. */
export function createSavedTaskNoticeReader(reader: SavedResultReader,
  publish: (task: TaskRecordV4 | null) => void, report: (message: string) => void) {
  let alive = true;
  let reading = false;
  return {
    dispose() { alive = false; },
    async refresh() {
      if (!alive || reading) return;
      reading = true;
      try {
        const saved = await readSavedTaskNotice(reader);
        if (alive) { publish(saved); report(""); }
      } catch (cause) {
        if (alive) { publish(null); report(cause instanceof Error ? cause.message : "定时结果读取失败，请查看收件箱。"); }
      } finally { reading = false; }
    },
  };
}
