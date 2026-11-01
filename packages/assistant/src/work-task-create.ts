import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { AgentError } from "@serika/core";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { throwIfAborted, validateWorkspacePath } from "./workspace-path.js";
import { workTaskPhase, type CreateWorkTaskInput, type WorkTask, type WorkTaskResult } from "./work-task-store.js";

/** The model sees this sentence after a save. It is the whole user-visible reply. */
export const WORK_TASK_CREATE_READBACK = "已创建，尚未执行。";

/**
 * Ordinary primary chat only. The key is the current Thread, user message and
 * tool call, so a later message is a different operation. Project and home are
 * hashed into the existing creation receipt: the same key under different
 * ownership collides and is rejected instead of saving a second task.
 */
export const WORK_TASK_CREATE_INSTRUCTIONS = " When the user asks to record a work task, call work_task_create once. It only saves a pending task for a later explicit start. It does not start a Run, run checks, grant Shell or file permission, or bind the task onto the current Run. Propose the goal, constraints, and acceptance items. Use artifact_exists or shell_exit_zero only when that exact path or command is already in the current user message or a file read in this chat; otherwise propose a human item. Do not invent a test. Do not send thread, project, home, an operation id, or any permission. After success, the user-visible reply is exactly the tool readback. ";

const verificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human") }).strict(),
  z.object({ kind: z.literal("artifact_exists"), path: z.string().min(1), requireReadback: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("shell_exit_zero"), command: z.string().min(1), cwd: z.string().min(1) }).strict(),
]);

export const workTaskCreateInputSchema = z.object({
  goal: z.string().min(1),
  constraints: z.array(z.string().min(1)).optional(),
  acceptance: z.array(z.object({
    id: z.string().min(1),
    description: z.string().min(1),
    method: z.enum(["automatic", "human"]),
    required: z.boolean(),
    verification: verificationSchema,
  }).strict()).min(1),
}).strict();

export type WorkTaskCreateInput = z.infer<typeof workTaskCreateInputSchema>;

export interface WorkTaskCreateBinding {
  threadId: string;
  messageId: string;
  projectId: string;
  projectDirectory: string;
  home: string;
  /** Current user text plus file contents already read in this chat. */
  materials: string;
}

export interface WorkTaskCreateHost {
  binding(): { ok: true; value: WorkTaskCreateBinding } | { ok: false; reason: "not-ordinary" | "no-project" };
  directories(): Promise<readonly { path: string }[]>;
  create(input: CreateWorkTaskInput): Promise<WorkTaskResult<WorkTask>>;
}

export type WorkTaskCreateSuccess = {
  ok: true;
  saved: true;
  started: false;
  readback: string;
  value: WorkTask;
};

export function workTaskCreationKey(threadId: string, messageId: string, toolCallId: string): string {
  return `wtc${createHash("sha256").update(JSON.stringify([threadId, messageId, toolCallId])).digest("hex")}`;
}

/** Anchor a relative path at the current project, then require exactly one deepest authorized directory. */
export function projectOwnedPath(projectDirectory: string, requested: string, directories: readonly { path: string }[]):
  { ok: true; relativePath: string } | { ok: false; message: string } {
  if (!projectDirectory) return { ok: false, message: "当前没有唯一项目，不能默认选择目录，未保存。" };
  const located = validateWorkspacePath(projectDirectory, requested);
  if (!located.ok) return { ok: false, message: `${located.message} 未保存。` };
  const matches = directories.filter(dir => {
    const root = dir.path.endsWith(sep) ? dir.path.slice(0, -1) : dir.path;
    return located.target === root || located.target.startsWith(`${root}${sep}`);
  });
  if (matches.length === 0) return { ok: false, message: "路径不在已授权目录内，未保存。" };
  const longest = Math.max(...matches.map(dir => dir.path.length));
  if (matches.filter(dir => dir.path.length === longest).length !== 1) {
    return { ok: false, message: "路径同时落在多个授权目录中，不能默认选一个，未保存。" };
  }
  return { ok: true, relativePath: located.relativePath };
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function proposal(input: unknown): { goal: string; constraints: string[]; checks: string[]; human: string[] } {
  const record = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const constraints = Array.isArray(record.constraints) ? record.constraints.filter((item): item is string => typeof item === "string") : [];
  const checks: string[] = [];
  const human: string[] = [];
  if (Array.isArray(record.acceptance)) {
    for (const item of record.acceptance) {
      if (item === null || typeof item !== "object") continue;
      const criterion = item as Record<string, unknown>;
      const verification = criterion.verification !== null && typeof criterion.verification === "object"
        ? criterion.verification as Record<string, unknown> : {};
      const description = textOf(criterion.description);
      if (verification.kind === "artifact_exists") {
        checks.push(`文件 ${textOf(verification.path)} 存在${verification.requireReadback === true ? "，并在写入后完整回读" : ""}。${description}`);
      } else if (verification.kind === "shell_exit_zero") {
        checks.push(`命令 ${textOf(verification.command)} ，目录 ${textOf(verification.cwd)} ，退出码为 0。${description}`);
      } else if (verification.kind === "human" || criterion.method === "human") {
        human.push(description || "（没有说明）");
      }
    }
  }
  return { goal: textOf(record.goal), constraints, checks, human };
}

/** The y/n card for a proposed save. Approval does not start the task or run its checks. */
export function workTaskCreateConfirmation(input: unknown): string {
  const { goal, constraints, checks, human } = proposal(input);
  const block = (label: string, items: string[]) => [label, ...(items.length ? items.map(item => `- ${item}`) : ["- （无）"])];
  return [
    "保存工作任务",
    "",
    `目标：${goal || "（没有目标）"}`,
    ...block("约束：", constraints),
    ...block("程序检查：", checks),
    ...block("人工项：", human),
    "",
    "确认后只保存，状态是未开始。不会启动任务，不会运行这些检查，也不会授予 Shell 或文件权限。",
    "允许保存这条尚未开始的任务？ [y/n]",
  ].join("\n");
}

function storedAcceptance(input: WorkTaskCreateInput): CreateWorkTaskInput["acceptance"] {
  return input.acceptance.map(item => {
    const verification = item.verification.kind === "artifact_exists"
      ? item.verification.requireReadback === undefined
        ? { kind: "artifact_exists" as const, path: item.verification.path }
        : { kind: "artifact_exists" as const, path: item.verification.path, requireReadback: item.verification.requireReadback }
      : item.verification.kind === "shell_exit_zero"
        ? { kind: "shell_exit_zero" as const, command: item.verification.command, cwd: item.verification.cwd }
        : { kind: "human" as const };
    return { id: item.id, description: item.description, method: item.method, required: item.required, verification };
  });
}

function refuse(message: string): WorkTaskResult<never> {
  return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message } };
}

/** Missing components are not links. An existing link can point outside the project, so it is not a valid proposal. */
async function pathHasSymlink(root: string, relativePath: string, signal: AbortSignal): Promise<boolean> {
  let current = root;
  const components = relativePath === "" || relativePath === "." ? [] : relativePath.split(sep);
  for (const component of components) {
    throwIfAborted(signal);
    current = resolve(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return false;
      throw error;
    }
  }
  return false;
}

async function acceptProposal(binding: WorkTaskCreateBinding, input: WorkTaskCreateInput, directories: readonly { path: string }[], signal: AbortSignal): Promise<WorkTaskResult<null>> {
  for (const item of input.acceptance) {
    if (item.method === "human" && item.verification.kind !== "human") return refuse("人工项不能改成程序检查，未保存。");
    if (item.method !== "automatic") continue;
    switch (item.verification.kind) {
      case "artifact_exists": {
        const owned = projectOwnedPath(binding.projectDirectory, item.verification.path, directories);
        if (!owned.ok) return refuse(owned.message);
        if (!binding.materials.includes(item.verification.path)) return refuse("当前材料里没有这个产物路径，未保存，也没有编造检查。");
        if (await pathHasSymlink(binding.projectDirectory, owned.relativePath, signal)) return refuse("路径经过符号链接，未保存。");
        break;
      }
      case "shell_exit_zero": {
        const owned = projectOwnedPath(binding.projectDirectory, item.verification.cwd, directories);
        if (!owned.ok) return refuse(owned.message);
        if (item.verification.cwd !== "." && !binding.materials.includes(item.verification.cwd)) {
          return refuse("当前材料不能确定命令所在目录，不能默认选一个，未保存。");
        }
        if (!binding.materials.includes(item.verification.command)) {
          return refuse("当前材料不能确定这条测试命令，未保存。请改为人工项，或先读取包含该命令的文件。不会编造可执行测试。");
        }
        if (await pathHasSymlink(binding.projectDirectory, owned.relativePath, signal)) return refuse("命令目录经过符号链接，未保存。");
        break;
      }
      case "human":
        return refuse("程序检查不能使用人工判别，未保存。");
      default: {
        const unreachable: never = item.verification;
        return refuse(`无法识别的检查：${String(unreachable)}`);
      }
    }
  }
  return { ok: true, value: null };
}

export async function executeWorkTaskCreate(host: WorkTaskCreateHost, input: WorkTaskCreateInput, toolCallId: string, signal: AbortSignal): Promise<WorkTaskCreateSuccess | WorkTaskResult<never>> {
  const binding = host.binding();
  if (!binding.ok) {
    return refuse(binding.reason === "not-ordinary"
      ? "只有普通对话可以保存工作任务，未保存，也未开始。"
      : "当前没有唯一的项目或 home，不能默认选择目录，未保存。");
  }
  let directories: readonly { path: string }[];
  try { directories = await host.directories(); }
  catch { return refuse("授权目录无法读取，不能默认选择目录，未保存。"); }
  const accepted = await acceptProposal(binding.value, input, directories, signal);
  if (!accepted.ok) return accepted;
  const created = await host.create({
    operationId: workTaskCreationKey(binding.value.threadId, binding.value.messageId, toolCallId),
    threadId: binding.value.threadId,
    projectId: binding.value.projectId,
    home: binding.value.home,
    goal: input.goal,
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    acceptance: storedAcceptance(input),
  });
  if (!created.ok && created.error.code === "WORK_TASK_COMMIT_UNCERTAIN") {
    throw new AgentError({
      code: "TOOL_OUTCOME_UNKNOWN",
      message: "任务保存结果未确认。请只读核对当前任务，不要自动重发。",
      retryable: false,
      phase: "tool",
    });
  }
  if (!created.ok) return created;
  const pending = created.value.status === "pending" && created.value.runIds.length === 0 && workTaskPhase(created.value) === "ready";
  return {
    ok: true,
    saved: true,
    started: false,
    readback: pending ? WORK_TASK_CREATE_READBACK : "这是已经保存的任务，本次没有另建，也没有启动新的执行。",
    value: created.value,
  };
}

export function savedWorkTaskCreate(output: unknown): { task: WorkTask; readback: string } | undefined {
  if (output === null || typeof output !== "object") return undefined;
  const value = output as { ok?: unknown; saved?: unknown; started?: unknown; readback?: unknown; value?: unknown };
  if (value.ok !== true || value.saved !== true || value.started !== false || typeof value.readback !== "string") return undefined;
  const task = value.value;
  if (task === null || typeof task !== "object" || Array.isArray(task)) return undefined;
  const record = task as WorkTask;
  if (record.kind !== "work" || !Array.isArray(record.runIds)) return undefined;
  return { task: record, readback: value.readback };
}

export function createWorkTaskCreateTool(host: WorkTaskCreateHost): RegisteredTool {
  const registered: Tool<WorkTaskCreateInput, WorkTaskCreateSuccess | WorkTaskResult<never>> = tool({
    description: "Save one manual work task for this chat. The task stays pending until the user starts it from the task page. Do not start a Run, run the checks, or grant Shell or file permission. Goal, constraints, and acceptance are the proposal. Paths and test commands must already appear in the user message or a file read in this chat. Thread, project, home, the creation key, and permissions are host-owned and must be omitted. After success, the user-visible reply is exactly the readback.",
    inputSchema: workTaskCreateInputSchema,
    execute: (input, context) => executeWorkTaskCreate(host, input, context.toolCallId, context.abortSignal ?? new AbortController().signal),
  });
  return {
    metadata: { name: "work_task_create", version: "1", risk: "write", timeoutMs: 1_000, idempotent: false },
    tool: registered,
  };
}
