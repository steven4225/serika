import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { tryAcquireFlock } from "./flock.js";
import { TASK_FILE_MAX_BYTES, readLegacyTaskDocument, validateTaskDocument, type LegacyTaskRecord, type TaskRecordV4 } from "./task-store.js";
import { WORK_TASK_FILE_MAX_BYTES, mapLegacyWorkTasks, type WorkTask } from "./work-task-store.js";

export interface TaskUpgradeRow {
  id: string;
  kind: "arrangement" | "work";
  from: string;
  to: string;
  effectReviewRequired: boolean;
  acceptanceOpen: boolean;
}

export interface TaskUpgradePlan {
  blocked: boolean;
  reasons: string[];
  counts: {
    arrangements: number;
    workTasks: number;
    recurring: number;
    from: Record<string, number>;
  };
  rows: TaskUpgradeRow[];
}

export interface TaskUpgradeReceipt {
  version: 1;
  dataDirectory: string;
  tasksBeforeSha256: string | null;
  workTasksBeforeSha256: string | null;
  tasksAfterSha256: string;
  legacyWorkTaskRenamed: boolean;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function assertAuthorizedCopy(dataDirectory: string): string {
  const directory = resolve(dataDirectory);
  const blocked = [resolve(homedir(), ".serika"), resolve(homedir(), ".config", "serika")];
  for (const block of blocked) {
    if (directory === block || directory.startsWith(`${block}${sep}`)) {
      throw new Error("拒绝操作日用 home；只允许已授权副本");
    }
  }
  return directory;
}

function mapArrangement(task: LegacyTaskRecord): TaskRecordV4 {
  const status = task.status === "scheduled" || task.status === "failed" || task.status === "interrupted" ? "pending" : task.status;
  return { ...task, kind: "arrangement", status };
}

function bump(counts: Record<string, number>, status: string): void {
  counts[status] = (counts[status] ?? 0) + 1;
}

export function planTaskUpgrade(tasksValue: unknown | null, workTasksValue: unknown | null): { plan: TaskUpgradePlan; document?: ReturnType<typeof validateTaskDocument> } {
  const reasons: string[] = [];
  const from: Record<string, number> = {};
  const rows: TaskUpgradeRow[] = [];
  const arrangements = tasksValue === null ? [] : readLegacyTaskDocument(tasksValue).tasks.map(mapArrangement);
  const recurring = tasksValue === null ? [] : readLegacyTaskDocument(tasksValue).recurringTasks;
  const legacyTasks = tasksValue === null ? [] : readLegacyTaskDocument(tasksValue).tasks;
  const workTasks = workTasksValue === null ? [] : mapLegacyWorkTasks(workTasksValue);
  for (const task of legacyTasks) bump(from, `arrangement:${task.status}`);
  if (workTasksValue !== null && isRecord(workTasksValue) && Array.isArray(workTasksValue.tasks)) {
    for (const task of workTasksValue.tasks) {
      if (isRecord(task) && typeof task.status === "string") bump(from, `work:${task.status}`);
    }
  }
  for (const task of legacyTasks) {
    rows.push({ id: task.id, kind: "arrangement", from: task.status, to: mapArrangement(task).status, effectReviewRequired: false, acceptanceOpen: false });
    if (task.status === "running") reasons.push(`未结算定时实例 ${task.id}`);
  }
  for (const task of workTasks) {
    const fromStatus = legacyWorkStatus(task);
    rows.push({ id: task.id, kind: "work", from: fromStatus, to: task.status, effectReviewRequired: task.effectReviewRequired, acceptanceOpen: task.acceptanceOpen });
    if (task.status === "running") reasons.push(`未结算工作任务 ${task.id}`);
  }
  const ids = [...arrangements, ...workTasks].map((task) => task.id);
  if (new Set(ids).size !== ids.length) reasons.push("任务 ID 冲突");
  const operations = [...arrangements, ...workTasks, ...recurring].flatMap((task) => task.creation ? [task.creation.operationId] : []);
  if (new Set(operations).size !== operations.length) reasons.push("创建键冲突");
  let document: ReturnType<typeof validateTaskDocument> | undefined;
  if (reasons.length === 0) {
    try {
      document = validateTaskDocument({ version: 5, tasks: [...workTasks, ...arrangements], recurringTasks: recurring });
      const bytes = Buffer.byteLength(`${JSON.stringify(document)}\n`, "utf8");
      if (bytes > TASK_FILE_MAX_BYTES) reasons.push("合并后的 tasks.json 超过 16 MiB，未截断");
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : "合并结果无法通过 v5 校验");
    }
  }
  return {
    plan: {
      blocked: reasons.length > 0,
      reasons,
      counts: { arrangements: arrangements.length, workTasks: workTasks.length, recurring: recurring.length, from },
      rows,
    },
    ...(document === undefined || reasons.length > 0 ? {} : { document }),
  };
}

function legacyWorkStatus(task: WorkTask): string {
  if (task.status === "running" || task.status === "completed" || task.status === "cancelled") return task.status;
  if (task.effectReviewRequired) return "needs_review";
  if (task.acceptanceOpen) return "awaiting_acceptance";
  if (task.runIds.length === 0 && task.delivery === null) return "ready";
  return "paused";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptional(path: string, max: number): Promise<{ bytes: Buffer; value: unknown } | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${path} 不是普通文件`);
    if (stats.size > max) throw new Error(`${path} 超过读取限额`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const bytes = await readFile(path);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) as unknown };
}

async function writeNew(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function upgradeTaskCopy(input: { dataDirectory: string; dryRun?: boolean }): Promise<TaskUpgradePlan & { dryRun: boolean; receipt?: TaskUpgradeReceipt }> {
  const directory = assertAuthorizedCopy(input.dataDirectory);
  const tasksPath = join(directory, "tasks.json");
  const workPath = join(directory, "work-tasks.json");
  const tasks = await readOptional(tasksPath, TASK_FILE_MAX_BYTES);
  const work = await readOptional(workPath, WORK_TASK_FILE_MAX_BYTES);
  if (tasks !== null && isRecord(tasks.value) && tasks.value.version === 5) {
    if (work !== null) throw new Error("tasks.json 已是 v5，同时仍有 work-tasks.json；未合并");
    const document = validateTaskDocument(tasks.value);
    return { dryRun: input.dryRun === true, blocked: false, reasons: [], counts: {
      arrangements: document.tasks.filter((task) => task.kind === "arrangement").length,
      workTasks: document.tasks.filter((task) => task.kind === "work").length,
      recurring: document.recurringTasks.length, from: {},
    }, rows: [] };
  }
  const planned = planTaskUpgrade(tasks?.value ?? null, work?.value ?? null);
  if (input.dryRun === true || planned.plan.blocked || planned.document === undefined) {
    return { ...planned.plan, dryRun: input.dryRun === true };
  }
  const locks = [];
  for (const path of [tasksPath, workPath]) {
    const lock = await tryAcquireFlock(`${path}.lock`);
    if (lock === null) throw new Error("任务文件正被写入；未升级");
    locks.push(lock);
  }
  try {
    const againTasks = await readOptional(tasksPath, TASK_FILE_MAX_BYTES);
    const againWork = await readOptional(workPath, WORK_TASK_FILE_MAX_BYTES);
    if (sha(againTasks?.bytes ?? Buffer.alloc(0)) !== sha(tasks?.bytes ?? Buffer.alloc(0)) || sha(againWork?.bytes ?? Buffer.alloc(0)) !== sha(work?.bytes ?? Buffer.alloc(0))) {
      throw new Error("升级期间源文件已变化；未写入");
    }
    const text = `${JSON.stringify(planned.document)}\n`;
    if (tasks !== null) await writeFile(join(directory, "tasks.json.pre-v5"), tasks.bytes, { flag: "wx", mode: 0o600 });
    await writeNew(tasksPath, text);
    const receipt: TaskUpgradeReceipt = {
      version: 1,
      dataDirectory: directory,
      tasksBeforeSha256: tasks === null ? null : sha(tasks.bytes),
      workTasksBeforeSha256: work === null ? null : sha(work.bytes),
      tasksAfterSha256: sha(Buffer.from(text)),
      legacyWorkTaskRenamed: work === null,
    };
    if (work !== null) {
      await rename(workPath, join(directory, "work-tasks.json.pre-v5"));
      receipt.legacyWorkTaskRenamed = true;
    }
    await writeFile(join(directory, "tasks-v5-upgrade.json"), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    return { ...planned.plan, dryRun: false, receipt };
  } finally {
    for (const lock of locks.reverse()) await lock.release();
  }
}

export async function rollbackTaskCopy(input: { dataDirectory: string }): Promise<{ restored: true }> {
  const directory = assertAuthorizedCopy(input.dataDirectory);
  const receiptPath = join(directory, "tasks-v5-upgrade.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as TaskUpgradeReceipt;
  const tasksPath = join(directory, "tasks.json");
  const current = await readFile(tasksPath);
  if (sha(current) !== receipt.tasksAfterSha256) throw new Error("升级后已有新写入；停止回滚，不用备份覆盖副作用");
  const tasksBackup = join(directory, "tasks.json.pre-v5");
  const workBackup = join(directory, "work-tasks.json.pre-v5");
  if (receipt.tasksBeforeSha256 === null) await rm(tasksPath);
  else {
    const original = await readFile(tasksBackup);
    if (sha(original) !== receipt.tasksBeforeSha256) throw new Error("定时任务备份 SHA 不符；未回滚");
    await writeNew(tasksPath, original.toString("utf8"));
    await rm(tasksBackup);
  }
  if (receipt.workTasksBeforeSha256 !== null) {
    const original = await readFile(workBackup);
    if (sha(original) !== receipt.workTasksBeforeSha256) throw new Error("工作任务备份 SHA 不符；未回滚");
    await rename(workBackup, join(directory, "work-tasks.json"));
  }
  await rm(receiptPath);
  return { restored: true };
}
