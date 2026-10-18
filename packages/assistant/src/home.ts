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

const GIT_HINT_SUMMARY =
  "本页未重新核对 Git；输入 /resume 查看当前变化。checkpoint 的 pin 不是当前 HEAD。";

/**
 * One Home line under a section head. `bullet` items print as "  - text";
 * other items and notes print as "  text". Texts are already one line.
 */
export interface HomeItem {
  kind: "item" | "note";
  text: string;
  bullet: boolean;
}

export interface HomeSection {
  kind: "checkpoint" | "git" | "tasks";
  /** Section head without the full-width colon, e.g. 项目进度. */
  title: string;
  /** Text after the head on the same line; may be empty. */
  summary: string;
  items: HomeItem[];
}

/**
 * Structured Home (architecture-v2 §4.4 step 3): the single source for the
 * CLI text (`formatHome`) and the desktop panel. Read-only; no caching.
 */
export interface HomeSnapshot {
  version: 1;
  /** As printed after 时间：, e.g. "2026/01/02 03:04（UTC）". */
  time: string;
  identity: {
    modelAlias: string;
    modelId: string;
    workspaceRoot: string | null;
    threadId: string;
    directory: string;
    temporaryDirectory: boolean;
    temporaryThread: boolean;
  };
  sections: HomeSection[];
  /** Commands listed under 可用入口：. */
  entries: string[];
}

const item = (text: string): HomeItem => ({ kind: "item", text, bullet: false });
const bullet = (text: string): HomeItem => ({ kind: "item", text, bullet: true });
const note = (text: string): HomeItem => ({ kind: "note", text, bullet: false });
const section = (kind: HomeSection["kind"], title: string, summary: string, items: HomeItem[] = []): HomeSection =>
  ({ kind, title, summary, items });
const gitSection = (): HomeSection => section("git", "Git", GIT_HINT_SUMMARY);

function taskText(task: TaskSummaryV3): string {
  const detail = task.status === "completed"
    ? task.resultPreview
    : task.error === null ? null : `${task.error.code}: ${task.error.messagePreview}`;
  return `${task.status} · ${oneLine(task.id)} · ${oneLine(task.promptPreview)} · runAt ${oneLine(task.runAt)}${detail ? ` · ${oneLine(detail)}` : ""}`;
}

async function checkpointSections(options: HomeOptions): Promise<HomeSection[]> {
  const progress = (summary: string, items: HomeItem[] = []) => section("checkpoint", "项目进度", summary, items);
  if (!options.checkpointEnabled) return [progress("checkpoint 未启用。")];
  if (!options.checkpointStore) return [progress("checkpoint store 不可用。")];
  try {
    const result = await options.checkpointStore.getCurrent();
    if (!result.ok) return [progress(`读取失败（${result.error.code}: ${oneLine(result.error.message)}）。`)];
    const current = result.current;
    if (!current) return [progress("尚无保存的 checkpoint。"), gitSection()];
    const sameThread = current.source.threadId === options.threadId;
    const items = [
      item(`目标：${oneLine(current.goal)}`),
      ...(current.currentPhase ? [item(`阶段：${oneLine(current.currentPhase)}`)] : []),
      item(`保存时间：${oneLine(current.updatedAt)}`),
      item(`来源 Thread：${oneLine(current.source.threadId)}${sameThread ? "（当前 Thread）" : "（与当前 Thread 不同；不是这段对话的续接）"}`),
      ...current.nextActions.slice(0, 3).map((action) => item(`下一步：${oneLine(action)}`)),
    ];
    if (current.nextActions.length > 3) items.push(note(`另有 ${current.nextActions.length - 3} 条下一步未展示。`));
    return [
      progress(`${current.status === "completed" ? "上次完成的 checkpoint" : `checkpoint ${current.status}`} · v${current.version}`, items),
      gitSection(),
    ];
  } catch (error) {
    return [progress(`读取失败（${errorText(error)}）。`)];
  }
}

async function taskSection(options: HomeOptions): Promise<HomeSection> {
  if (!options.taskEnabled) return section("tasks", "本地任务", "task 未启用。");
  if (!options.taskStore) return section("tasks", "本地任务", "task store 不可用。");
  const items: HomeItem[] = [];
  try {
    const inbox = await options.taskStore.list({ inbox: true, limit: 5 });
    if (!inbox.ok) {
      items.push(note(`未确认终态记录：读取失败（${inbox.error.code}: ${oneLine(inbox.error.message)}）。`));
    } else {
      items.push(note(`未确认终态记录${inbox.value.truncated ? "（仅展示前 5 条，另有未展示）" : ""}：`));
      items.push(...(inbox.value.tasks.length ? inbox.value.tasks.map((task) => bullet(taskText(task))) : [bullet("无")]));
    }
  } catch (error) {
    items.push(note(`未确认终态记录：读取失败（${errorText(error)}）。`));
  }
  try {
    const recent = await options.taskStore.list({ status: "pending", limit: 5 });
    if (!recent.ok) {
      items.push(note(`最近创建的 scheduled/running：读取失败（${recent.error.code}: ${oneLine(recent.error.message)}）。`));
    } else {
      items.push(note(`最近创建的 scheduled/running${recent.value.truncated ? "（仅展示前 5 条，另有未展示）" : ""}：`));
      items.push(...(recent.value.tasks.length ? recent.value.tasks.map((task) => bullet(taskText(task))) : [bullet("无")]));
    }
  } catch (error) {
    items.push(note(`最近创建的 scheduled/running：读取失败（${errorText(error)}）。`));
  }
  items.push(note("completed 只表示 worker Run 正常结束，不代表业务成功或桌面通知已送达。"));
  return section("tasks", "本地任务", "", items);
}

/** Read-only Home snapshot. Call again to refresh; no observations are cached. */
export async function readHomeSnapshot(options: HomeOptions): Promise<HomeSnapshot> {
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
  const entries = ["/modules"];
  if (options.checkpointEnabled) entries.push("/resume");
  if (options.taskEnabled) entries.push("/task inbox");
  return {
    version: 1,
    time: `${date}（${timeZone}）`,
    identity: {
      modelAlias: oneLine(options.modelAlias),
      modelId: oneLine(options.modelId),
      workspaceRoot: options.workspaceRoot ? oneLine(options.workspaceRoot) : null,
      threadId: oneLine(options.threadId),
      directory: oneLine(options.directory),
      temporaryDirectory: options.temporaryDirectory,
      temporaryThread: options.temporaryThread,
    },
    sections: [...(await checkpointSections(options)), await taskSection(options)],
    entries,
  };
}

/** The CLI Home text; byte-identical to the step-1 snapshot. */
export function formatHome(snapshot: HomeSnapshot): string {
  const { identity } = snapshot;
  const lines = [
    "Serika Home",
    `时间：${snapshot.time}`,
    `模型：${identity.modelAlias}（${identity.modelId}；配置值，不代表本次已联网验证）`,
    `Workspace：${identity.workspaceRoot ?? "未设置"}`,
    `Thread：${identity.threadId}`,
    `Transcript 目录：${identity.directory}`,
    ...(identity.temporaryDirectory ? ["注意：transcript 目录为本次临时生成；重启不会自动回到这里。"] : []),
    ...(identity.temporaryThread ? ["注意：Thread ID 为本次临时生成；重启不会自动回到这段对话。"] : []),
  ];
  for (const current of snapshot.sections) {
    // The progress block and the task block are each preceded by a blank line; Git follows progress directly.
    if (current.kind !== "git") lines.push("");
    lines.push(`${current.title}：${current.summary}`);
    lines.push(...current.items.map((entry) => `  ${entry.bullet ? "- " : ""}${entry.text}`));
  }
  lines.push("", "可用入口：", ...snapshot.entries.map((entry) => `  ${entry}`));
  return lines.join("\n");
}

/** Read and format in one step (the CLI /home path). */
export async function renderHome(options: HomeOptions): Promise<string> {
  return formatHome(await readHomeSnapshot(options));
}
