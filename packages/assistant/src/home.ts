import type { WorkspaceCheckpointStore } from "./checkpoint-store.js";
import type { TaskStore, TaskSummaryV3 } from "./task-store.js";

export interface HomeOptions {
  modelAlias: string;
  modelId: string;
  workspaceRoot: string | null;
  directory: string;
  threadId: string;
  temporaryDirectory: boolean;
  temporaryThread: boolean;
  checkpointEnabled: boolean;
  taskEnabled: boolean;
  checkpointStore?: Pick<WorkspaceCheckpointStore, "getCurrent">;
  taskStore?: Pick<TaskStore, "list">;
  now?: Date;
  timeZone?: string;
}

function oneLine(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? oneLine(error.message) : "读取失败";
}

const GIT_HINT =
  "Git：本页未重新核对 Git；输入 /resume 查看当前变化。checkpoint 的 pin 不是当前 HEAD。";

function taskLine(task: TaskSummaryV3): string {
  const detail = task.status === "completed"
    ? task.resultPreview
    : task.error === null ? null : `${task.error.code}: ${task.error.messagePreview}`;
  return `  - ${task.status} · ${oneLine(task.id)} · ${oneLine(task.promptPreview)} · runAt ${oneLine(task.runAt)}${detail ? ` · ${oneLine(detail)}` : ""}`;
}

async function checkpointLines(options: HomeOptions): Promise<string[]> {
  if (!options.checkpointEnabled) return ["项目进度：checkpoint 未启用。"];
  if (!options.checkpointStore) return ["项目进度：checkpoint store 不可用。"];
  try {
    const result = await options.checkpointStore.getCurrent();
    if (!result.ok) return [`项目进度：读取失败（${result.error.code}: ${oneLine(result.error.message)}）。`];
    const current = result.current;
    if (!current) return ["项目进度：尚无保存的 checkpoint。", GIT_HINT];
    const sameThread = current.source.threadId === options.threadId;
    const lines = [
      `项目进度：${current.status === "completed" ? "上次完成的 checkpoint" : `checkpoint ${current.status}`} · v${current.version}`,
      `  目标：${oneLine(current.goal)}`,
      ...(current.currentPhase ? [`  阶段：${oneLine(current.currentPhase)}`] : []),
      `  保存时间：${oneLine(current.updatedAt)}`,
      `  来源 Thread：${oneLine(current.source.threadId)}${sameThread ? "（当前 Thread）" : "（与当前 Thread 不同；不是这段对话的续接）"}`,
      ...current.nextActions.slice(0, 3).map((action) => `  下一步：${oneLine(action)}`),
    ];
    if (current.nextActions.length > 3) lines.push(`  另有 ${current.nextActions.length - 3} 条下一步未展示。`);
    lines.push(GIT_HINT);
    return lines;
  } catch (error) {
    return [`项目进度：读取失败（${errorText(error)}）。`];
  }
}

async function taskLines(options: HomeOptions): Promise<string[]> {
  if (!options.taskEnabled) return ["本地任务：task 未启用。"];
  if (!options.taskStore) return ["本地任务：task store 不可用。"];
  const lines = ["本地任务："];
  try {
    const inbox = await options.taskStore.list({ inbox: true, limit: 5 });
    if (!inbox.ok) {
      lines.push(`  未确认终态记录：读取失败（${inbox.error.code}: ${oneLine(inbox.error.message)}）。`);
    } else {
      lines.push(`  未确认终态记录${inbox.value.truncated ? "（仅展示前 5 条，另有未展示）" : ""}：`);
      lines.push(...(inbox.value.tasks.length ? inbox.value.tasks.map(taskLine) : ["  - 无"]));
    }
  } catch (error) {
    lines.push(`  未确认终态记录：读取失败（${errorText(error)}）。`);
  }
  try {
    const recent = await options.taskStore.list({ status: "pending", limit: 5 });
    if (!recent.ok) {
      lines.push(`  最近创建的 scheduled/running：读取失败（${recent.error.code}: ${oneLine(recent.error.message)}）。`);
    } else {
      lines.push(`  最近创建的 scheduled/running${recent.value.truncated ? "（仅展示前 5 条，另有未展示）" : ""}：`);
      lines.push(...(recent.value.tasks.length ? recent.value.tasks.map(taskLine) : ["  - 无"]));
    }
  } catch (error) {
    lines.push(`  最近创建的 scheduled/running：读取失败（${errorText(error)}）。`);
  }
  lines.push("  completed 只表示 worker Run 正常结束，不代表业务成功或桌面通知已送达。");
  return lines;
}

/** Read-only Home snapshot. Call again to refresh; no observations are cached. */
export async function renderHome(options: HomeOptions): Promise<string> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const lines = [
    "Serika Home",
    `时间：${date}（${timeZone}）`,
    `模型：${oneLine(options.modelAlias)}（${oneLine(options.modelId)}；配置值，不代表本次已联网验证）`,
    `Workspace：${options.workspaceRoot ? oneLine(options.workspaceRoot) : "未设置"}`,
    `Thread：${oneLine(options.threadId)}`,
    `Transcript 目录：${oneLine(options.directory)}`,
    ...(options.temporaryDirectory ? ["注意：transcript 目录为本次临时生成；重启不会自动回到这里。"] : []),
    ...(options.temporaryThread ? ["注意：Thread ID 为本次临时生成；重启不会自动回到这段对话。"] : []),
    "",
    ...(await checkpointLines(options)),
  ];
  lines.push("", ...(await taskLines(options)), "", "可用入口：");
  lines.push("  /modules");
  if (options.checkpointEnabled) lines.push("  /resume");
  if (options.taskEnabled) lines.push("  /task inbox");
  return lines.join("\n");
}
