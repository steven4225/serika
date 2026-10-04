import type { AppInfo, ExecutionRunRecord } from "../../shared/ui-contract.js";
import type { WorkTask, WorkTaskStatus, WorkTaskInputs } from "../../shared/work-tasks.js";

export const taskStatusLabels: Record<WorkTaskStatus, string> = {
  ready: "待开始", running: "正在执行", paused: "本轮结束 · 未验收", needs_review: "效果待核对",
  awaiting_acceptance: "交付待验收", completed: "验收通过", cancelled: "任务已取消",
};

export const criterionStatusLabels = { passed: "通过", failed: "未通过", blocked: "被阻断", not_run: "尚未验收" };

export function selectCurrentTask(tasks: readonly WorkTask[]): WorkTask | null {
  return tasks.find(task => task.status === "needs_review") ?? tasks.find(task => task.status === "running") ??
    tasks.find(task => task.status === "awaiting_acceptance") ?? tasks.find(task => !["completed", "cancelled"].includes(task.status)) ?? tasks[0] ?? null;
}

export function taskActions(task: WorkTask) {
  return {
    run: task.status === "ready" || task.status === "paused",
    delivery: task.status === "paused" || task.status === "awaiting_acceptance",
    accept: task.status === "awaiting_acceptance" && task.delivery !== null,
    rework: task.status === "awaiting_acceptance",
    reconcile: task.status === "needs_review",
    cancel: ["ready", "paused", "awaiting_acceptance"].includes(task.status),
  };
}

/** Reconciled means a human report exists, not that old receipts became successful. */
export function unreconciledRuns(runs: readonly ExecutionRunRecord[], tasks: readonly WorkTask[]): ExecutionRunRecord[] {
  return runs.filter(run => run.tools.some(tool => tool.status === "unknown") && !tasks.some(task =>
    task.id === run.workTaskId && task.threadId === run.threadId && task.runIds.includes(run.runId) &&
    task.reconciliations.some(report => report.runId === run.runId),
  ));
}

export function isTaskRun(task: WorkTask, run: ExecutionRunRecord): boolean {
  return run.workTaskId === task.id && run.threadId === task.threadId && run.phase === "primary" && task.runIds.includes(run.runId);
}

export function lines(text: string): string[] { return text.split("\n").map(line => line.trim()).filter(Boolean); }

/** Explicit form contract; selecting a template or building it does not run tools. */
export function taskFormAcceptance(artifacts: string, human: string, commands: string, cwd: string): WorkTaskInputs["createWorkTask"]["acceptance"] {
  return [
    ...lines(artifacts).map((path, index) => ({ id: `artifact-${index + 1}`, description: `写入并读回核对：${path}`, required: true, method: "automatic" as const, verification: { kind: "artifact_exists" as const, path, requireReadback: true } })),
    ...lines(commands).map((command, index) => ({ id: `test-${index + 1}`, description: `修改后测试成功：${command}`, required: true, method: "automatic" as const, verification: { kind: "shell_exit_zero" as const, command, cwd: cwd.trim() || "." } })),
    ...lines(human).map((description, index) => ({ id: `human-${index + 1}`, description, required: true, method: "human" as const, verification: { kind: "human" as const } })),
  ];
}

export type TaskTemplateId = "document" | "edit" | "maintain";
export interface TaskFormDraft { goal: string; constraints: string; artifacts: string; human: string }
export const TASK_TEMPLATES: Record<TaskTemplateId, { label: string; draft: TaskFormDraft }> = {
  maintain: { label: "持续推进项目计划", draft: {
    goal: "持续维护 work-plan.md：依据我指定的项目材料形成带来源的结论、优先事项和可执行下一步，后续在同一任务里继续修改与交付。首次执行先向我确认材料与当前要求。",
    constraints: "每轮先读当前材料与 work-plan.md；缺文件时只可按确认要求新建，不凭历史摘要推断磁盘\n只写入或编辑 work-plan.md，保留未要求修改的章节；标明材料来源与未核验事实\n修改后读回核对；每个下一步写明动作、预期产物和完成条件",
    artifacts: "work-plan.md", human: "关键结论可追溯到当前材料，未核验事实单独说明\n旧章节与未要求修改的内容保留\n下一步有动作、产物和完成条件，能直接执行",
  } },
  document: { label: "整理材料成文档", draft: {
    goal: "读取我指定的材料，整理成一份带来源、优先事项和具体下一步的文档，保存到 work-plan.md。请先确认材料路径，不要编造来源。",
    constraints: "先读取当前磁盘中的指定材料，不以旧对话或摘要代替；缺失或矛盾之处直说\n只新建指定产物，不修改其他文件\n保存后读回核对；已有文件不要覆盖",
    artifacts: "work-plan.md", human: "关键结论能追溯到材料，步骤可以直接执行",
  } },
  edit: { label: "修改已有文档", draft: {
    goal: "读取 work-plan.md，按我的要求修改，并保留无关章节。请先向我确认具体修改要求。",
    constraints: "先读当前文件，不凭旧对话或摘要改写\n只编辑 work-plan.md，保留未要求修改的内容\n修改后读回核对；缺文件或匹配不唯一时停止",
    artifacts: "work-plan.md", human: "修改符合本次要求，原有无关内容保留",
  } },
};

export function taskNextAction(task: WorkTask): string {
  switch (task.status) {
    case "ready": return "开始执行";
    case "running": return "查看本轮进度";
    case "paused": return "检查产物并交付，或继续一轮";
    case "needs_review": return "先核对未知效果";
    case "awaiting_acceptance": return "查看验收结果";
    case "completed": return "查看已验收产物";
    case "cancelled": return "查看任务记录";
  }
}

/** Display preference only; never execution state or an authorization. */
export function taskSelectionKey(info: Pick<AppInfo, "configPath" | "workspaceRoot" | "threadId" | "directory"> | null): string | null {
  return info ? `runloom-current-task:${JSON.stringify([info.configPath ?? null, info.workspaceRoot, info.threadId, info.directory])}` : null;
}
export function readTaskSelection(storage: Pick<Storage, "getItem">, key: string): string | null {
  try { const id = storage.getItem(key); return id && id.length <= 1024 ? id : null; } catch { return null; }
}
export function saveTaskSelection(storage: Pick<Storage, "setItem" | "removeItem">, key: string, id: string | null): void {
  try { if (id === null) storage.removeItem(key); else storage.setItem(key, id); } catch { /* A preference cannot prevent working. */ }
}
