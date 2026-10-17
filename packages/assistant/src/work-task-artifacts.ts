import { createHash } from "node:crypto";
import { normalize } from "node:path";
import { readFileWriteReceipt, type ExecutionRunRecord, type ExecutionToolRecord } from "./execution-record-store.js";
import { readFileFromWorkspace, type ReadFileFailure } from "./read-file.js";
import { validateWorkspacePath } from "./workspace-path.js";
import type { WorkTask, WorkTaskFailure } from "./work-task-store.js";

export interface WorkTaskReadInput { id: string; expectedRevision: number }
export interface WorkTaskArtifactInput extends WorkTaskReadInput { path: string }
export interface WorkTaskFileReceipt {
  path: string; runId: string; toolCallId: string; bytes: number | null; sha256: string | null;
}
export interface WorkTaskDeliveryDraft {
  taskId: string; revision: number; runId: string | null;
  summary: string; summaryTruncated: boolean;
  artifacts: WorkTaskFileReceipt[];
  /** A failed/interrupted Run may still have successful writes, but is not a clean delivery. */
  warning: string | null;
}
export interface WorkTaskArtifactPreview {
  taskId: string; revision: number; path: string; content: string; bytes: number;
  sha256: string; readAt: string; receipt: WorkTaskFileReceipt | null;
  matchesReceipt: boolean | null;
}
export type WorkTaskReadResult<T> = { ok: true; value: T } | WorkTaskFailure | ReadFileFailure;

export function latestOwnedRun(task: WorkTask, run: ExecutionRunRecord | null): ExecutionRunRecord | null {
  return run !== null && run.runId === task.runIds.at(-1) && run.threadId === task.threadId &&
    run.workTaskId === task.id && run.phase === "primary" ? run : null;
}

/** Reads only the last attempt for each path: a later failure/unknown is never replaced by a prior success. */
export function workTaskFileReceipts(task: WorkTask, record: ExecutionRunRecord | null): WorkTaskFileReceipt[] {
  const run = latestOwnedRun(task, record);
  if (!run) return [];
  const latest = new Map<string, { path: string; tool: ExecutionToolRecord }>();
  for (const tool of run.tools) {
    if (!["write_file", "edit_file"].includes(tool.toolName)) continue;
    let path = tool.fileInput?.path;
    if (path === undefined && !tool.inputTruncated) {
      try {
        const input: unknown = JSON.parse(tool.inputPreview);
        if (typeof input === "object" && input !== null && "path" in input && typeof input.path === "string") path = input.path;
      } catch { /* Incomplete legacy intent cannot prove a path. */ }
    }
    // Aliases such as ./notes/plan.md still supersede an earlier write to that file.
    if (path !== undefined) latest.set(normalize(path), { path, tool });
  }
  return [...latest.values()].flatMap(({ path, tool }) => {
    const receipt = readFileWriteReceipt(tool, path);
    return receipt ? [{ path, runId: run.runId, toolCallId: tool.toolCallId, ...receipt }] : [];
  });
}

export function workTaskDeliveryDraft(task: WorkTask, record: ExecutionRunRecord | null): WorkTaskDeliveryDraft {
  const run = latestOwnedRun(task, record);
  const clean = run?.status === "completed" && !run.tools.some(tool => ["unknown", "started", "requested"].includes(tool.status));
  return {
    taskId: task.id, revision: task.revision, runId: run?.runId ?? null,
    summary: clean ? run.resultTextPreview ?? "" : "", summaryTruncated: clean ? run.resultTextTruncated : false,
    artifacts: workTaskFileReceipts(task, run),
    warning: !run ? "最新执行回执缺失或归属不符；未从旧 Run 预填。" : !clean ? "本轮未正常结束或有未核对效果。成功写入不代表任务完成。" : null,
  };
}

/** User-triggered display only. This creates neither a Run nor acceptance evidence. */
export async function readWorkTaskArtifact(workspace: string, task: WorkTask, run: ExecutionRunRecord | null, path: string): Promise<WorkTaskReadResult<WorkTaskArtifactPreview>> {
  const validated = validateWorkspacePath(workspace, path);
  if (!validated.ok) return { ok: false, error: { code: validated.code, message: validated.message } };
  const normalize = (candidate: string): string | null => {
    const result = validateWorkspacePath(workspace, candidate);
    return result.ok ? result.relativePath : null;
  };
  const receipts = workTaskFileReceipts(task, run);
  const declared = task.acceptance.flatMap(item => item.verification.kind === "artifact_exists" ? [item.verification.path] : []);
  // Arbitrary delivery prose/refs are not a new file-read capability.
  if (![...declared, ...receipts.map(item => item.path)].some(candidate => normalize(candidate) === validated.relativePath)) {
    return { ok: false, error: { code: "WORK_TASK_INVALID_INPUT", message: "File is not a declared or receipted artifact of this task" } };
  }
  const read = await readFileFromWorkspace(workspace, validated.relativePath);
  if (!read.ok) return read;
  const receipt = receipts.find(item => normalize(item.path) === read.path) ?? null;
  const sha256 = createHash("sha256").update(read.content, "utf8").digest("hex");
  return { ok: true, value: {
    taskId: task.id, revision: task.revision, path: read.path, content: read.content, bytes: read.bytes,
    sha256, readAt: new Date().toISOString(), receipt,
    matchesReceipt: receipt?.sha256 == null ? null : receipt.sha256 === sha256 && receipt.bytes === read.bytes,
  } };
}
