import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { matchesFileWritePath, readFileWriteReceipt, type ExecutionRecordStore, type ExecutionRunRecord } from "./execution-record-store.js";
import { rejectSymlinkComponents, validateWorkspacePath } from "./workspace-path.js";
import type { WorkTask, AcceptanceStatus, WorkTaskEvidence } from "./work-task-store.js";
export interface VerificationEnvironment { workspaceRoot: string | undefined; executionRecords: ExecutionRecordStore }

function previewObject(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch { return undefined; }
}

function taskOwnsRun(task: WorkTask, run: ExecutionRunRecord): boolean {
  return run.threadId === task.threadId && run.workTaskId === task.id &&
    run.phase === "primary" && task.runIds.includes(run.runId);
}

export async function verifyAutomaticCriterion(
  app: VerificationEnvironment,
  task: WorkTask,
  criterion: WorkTask["acceptance"][number],
  runningRun?: { runId: string; signal: AbortSignal },
): Promise<{ status: AcceptanceStatus; evidence: WorkTaskEvidence[]; note: string }> {
  const now = new Date().toISOString();
  const latestRunId = task.runIds.at(-1);
  const latestRun = latestRunId === undefined
    ? null
    : await app.executionRecords.getRun(task.threadId, latestRunId);
  if (latestRun === undefined || latestRun === null) {
    return { status: "blocked", evidence: [], note: "No task-owned Run receipt is available for this delivery." };
  }
  if (!taskOwnsRun(task, latestRun) || (runningRun !== undefined && runningRun.runId !== latestRun.runId) || (latestRun.status === "running" && runningRun?.runId !== latestRun.runId) || latestRun.status === "interrupted" ||
      latestRun.tools.some((tool) => tool.status === "unknown")) {
    return { status: "blocked", evidence: [], note: "The latest task Run contains a missing, foreign, interrupted, or unknown receipt that requires review." };
  }
  if (criterion.verification.kind === "shell_exit_zero") {
    const expectedCommand = criterion.verification.command;
    const expectedCwd = criterion.verification.cwd;
    const matchingShell = latestRun.tools.filter((item) => {
      if (item.toolName !== "shell_exec" || item.inputTruncated) return false;
      const input = previewObject(item.inputPreview);
      return input?.command === expectedCommand && (input.cwd ?? ".") === expectedCwd;
    }).at(-1);
    const succeeded = matchingShell?.status === "completed" && matchingShell.shell?.exitCode === 0 &&
      matchingShell.shell.timedOut === false && matchingShell.shell.cancelled === false &&
      !latestRun.tools.some((tool, index) => index > latestRun.tools.indexOf(matchingShell) && ["write_file", "edit_file"].includes(tool.toolName));
    return matchingShell === undefined || !succeeded
      ? { status: "failed", evidence: [], note: "No matching successful Shell receipt after the latest file operation was found." }
      : {
          status: "passed",
          evidence: [{ id: randomUUID(), kind: "tool", runId: latestRun.runId,
            toolCallId: matchingShell.toolCallId, toolName: "shell_exec",
            command: expectedCommand, cwd: expectedCwd,
            verifiedAt: now, outcome: "succeeded" }],
          note: "Matched the latest Run's exact, untruncated Shell command and cwd with exitCode 0 and no timeout or cancellation.",
        };
  }
  if (criterion.verification.kind === "artifact_exists") {
    if (app.workspaceRoot === undefined) return { status: "blocked", evidence: [], note: "No workspace is configured." };
    const requested = criterion.verification.path;
    const path = validateWorkspacePath(app.workspaceRoot, requested);
    if (!path.ok) return { status: "failed", evidence: [], note: path.message };
    const matchingWrite = latestRun.tools.filter((tool) => matchesFileWritePath(tool, requested)).at(-1);
    const written = matchingWrite === undefined ? undefined : readFileWriteReceipt(matchingWrite, requested);
    if (matchingWrite === undefined || written === undefined) {
      return { status: "failed", evidence: [], note: "No matching successful write/edit receipt belongs to this WorkTask." };
    }
    try {
      if (await rejectSymlinkComponents(app.workspaceRoot, path.relativePath, runningRun?.signal ?? new AbortController().signal)) {
        return { status: "failed", evidence: [], note: "Artifact path contains a symbolic link." };
      }
      const stats = await lstat(path.target);
      if (!stats.isFile()) return { status: "failed", evidence: [], note: "Artifact is not a regular file." };
      if (stats.size > 8 * 1024 * 1024) {
        return { status: "blocked", evidence: [], note: "Artifact exceeds the 8 MiB verification limit." };
      }
      const content = await readFile(path.target, runningRun === undefined ? {} : { signal: runningRun.signal });
      const digest = createHash("sha256").update(content).digest("hex");
      if ((written.sha256 !== null && digest !== written.sha256) ||
          (written.bytes !== null && content.length !== written.bytes)) {
        return { status: "failed", evidence: [], note: "Artifact content no longer matches the successful file write receipt." };
      }
      return {
        status: "passed",
        evidence: [{ id: randomUUID(), kind: "artifact", runId: latestRun.runId,
          toolCallId: matchingWrite.toolCallId, path: path.relativePath,
          sha256: digest, verifiedAt: now }],
        note: written.sha256 === null
          ? "Artifact currently exists as a regular non-symlink file and matches a complete legacy task write/edit receipt."
          : "Artifact path, byte count and SHA-256 match the latest task-owned compact file write receipt.",
      };
    } catch {
      return { status: "failed", evidence: [], note: "Artifact could not be read from the current workspace." };
    }
  }
  return { status: "blocked", evidence: [], note: "Human acceptance must be recorded explicitly." };
}
