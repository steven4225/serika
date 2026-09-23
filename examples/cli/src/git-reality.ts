import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

export interface GitRealityPin {
  head: string;
  branch: string | null;
  dirty: boolean;
  observedAt: string;
}

export type GitRealityFailureReason =
  | "cancelled"
  | "not_git_repository"
  | "symlink"
  | "timeout"
  | "output_limit"
  | "git_error"
  | "invalid_pin"
  | "unknown_pin";

export type GitInspectionResult =
  | { ok: true; pin: GitRealityPin }
  | { ok: false; reason: GitRealityFailureReason };

export type GitReconciliationStatus =
  | "consistent"
  | "stale"
  | "diverged"
  | "insufficient_evidence";

export interface GitReconciliation {
  status: GitReconciliationStatus;
  current?: GitRealityPin;
  pin?: GitRealityPin;
  reason?: GitRealityFailureReason | "missing_pin" | "dirty_unverifiable";
}

const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OWN_UNTRACKED_FILES = new Set([
  "?? .runloom/checkpoint.json",
  "?? .runloom/checkpoint.json.lock",
]);

interface GitCommandSuccess {
  ok: true;
  output: string;
}

interface GitCommandFailure {
  ok: false;
  reason: GitRealityFailureReason;
  exitCode?: number;
}

type GitCommandResult = GitCommandSuccess | GitCommandFailure;

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
}

function runGit(
  workspace: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, reason: "cancelled" });
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", workspace, ...args],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        signal,
        env: cleanGitEnvironment(),
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ ok: true, output: stdout });
          return;
        }
        if (signal?.aborted || error.name === "AbortError") {
          resolve({ ok: false, reason: "cancelled" });
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ ok: false, reason: "output_limit" });
          return;
        }
        if (error.killed || error.signal === "SIGTERM") {
          resolve({ ok: false, reason: "timeout" });
          return;
        }
        resolve({
          ok: false,
          reason: "git_error",
          ...(typeof error.code === "number" ? { exitCode: error.code } : {}),
        });
      },
    );
  });
}

function isValidPin(pin: GitRealityPin): boolean {
  return (
    FULL_SHA.test(pin.head) &&
    (pin.branch === null || (typeof pin.branch === "string" && pin.branch.length > 0 &&
      Buffer.byteLength(pin.branch, "utf8") <= 256 && !/[\x00-\x1f\x7f]/.test(pin.branch))) &&
    typeof pin.dirty === "boolean" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(pin.observedAt) &&
    Number.isFinite(Date.parse(pin.observedAt)) &&
    new Date(pin.observedAt).toISOString() === pin.observedAt
  );
}

/** Observe only this workspace's Git worktree. No parent repository fallback. */
export async function inspectGitReality(
  workspace: string,
  signal?: AbortSignal,
): Promise<GitInspectionResult> {
  if (signal?.aborted) return { ok: false, reason: "cancelled" };
  try {
    const workspaceInfo = await lstat(workspace);
    if (workspaceInfo.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!workspaceInfo.isDirectory()) return { ok: false, reason: "not_git_repository" };
    const gitInfo = await lstat(join(workspace, ".git"));
    if (gitInfo.isSymbolicLink()) return { ok: false, reason: "symlink" };
    if (!gitInfo.isDirectory() && !gitInfo.isFile()) {
      return { ok: false, reason: "not_git_repository" };
    }
  } catch {
    return { ok: false, reason: "not_git_repository" };
  }

  const root = await runGit(workspace, ["rev-parse", "--show-toplevel"], signal);
  if (!root.ok) return { ok: false, reason: root.reason };
  try {
    if ((await realpath(root.output.trim())) !== (await realpath(workspace))) {
      return { ok: false, reason: "not_git_repository" };
    }
  } catch {
    return { ok: false, reason: "git_error" };
  }

  const head = await runGit(workspace, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
  if (!head.ok) return { ok: false, reason: head.reason };
  const branch = await runGit(workspace, ["branch", "--show-current"], signal);
  if (!branch.ok) return { ok: false, reason: branch.reason };
  const status = await runGit(workspace, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
  if (!status.ok) return { ok: false, reason: status.reason };

  const pin: GitRealityPin = {
    head: head.output.trim(),
    branch: branch.output.trim() || null,
    // The checkpoint and its lock are Runloom bookkeeping. Exclude only their
    // untracked forms; if the user tracks either file, Git changes still count.
    dirty: status.output.split("\n").some((line) => line !== "" && !OWN_UNTRACKED_FILES.has(line)),
    observedAt: new Date().toISOString(),
  };
  return isValidPin(pin) ? { ok: true, pin } : { ok: false, reason: "git_error" };
}

/** Compare a saved pin with a fresh local observation, without changing Git state. */
export async function reconcileGitReality(
  workspace: string,
  pin?: GitRealityPin,
  signal?: AbortSignal,
): Promise<GitReconciliation> {
  const inspection = await inspectGitReality(workspace, signal);
  if (!inspection.ok) {
    return { status: "insufficient_evidence", ...(pin ? { pin } : {}), reason: inspection.reason };
  }
  const current = inspection.pin;
  if (pin === undefined) {
    return { status: "insufficient_evidence", current, reason: "missing_pin" };
  }
  if (!isValidPin(pin)) {
    return { status: "insufficient_evidence", current, pin, reason: "invalid_pin" };
  }
  if (current.head === pin.head) {
    if (current.branch !== pin.branch || current.dirty !== pin.dirty) {
      return { status: "diverged", current, pin };
    }
    if (current.dirty) {
      return { status: "insufficient_evidence", current, pin, reason: "dirty_unverifiable" };
    }
    return { status: "consistent", current, pin };
  }

  const known = await runGit(workspace, ["cat-file", "-e", `${pin.head}^{commit}`], signal);
  if (!known.ok) {
    return {
      status: "insufficient_evidence",
      current,
      pin,
      reason: known.exitCode === 1 || known.exitCode === 128 ? "unknown_pin" : known.reason,
    };
  }
  const ancestor = await runGit(workspace, ["merge-base", "--is-ancestor", pin.head, "HEAD"], signal);
  if (ancestor.ok) return { status: "stale", current, pin };
  if (ancestor.exitCode === 1) return { status: "diverged", current, pin };
  return { status: "insufficient_evidence", current, pin, reason: ancestor.reason };
}
