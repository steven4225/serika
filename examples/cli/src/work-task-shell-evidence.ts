import type { ExecutionToolRecord } from "./execution-record-store.js";
import type { AcceptanceCriterion, WorkTask } from "./work-task-store.js";

export interface TaskShellCommand { command: string; cwd: string }
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** One approved invocation for all required tests. No inferred read-only Shell commands. */
export function workTaskTestBatch(task: Pick<WorkTask, "acceptance">): TaskShellCommand | null {
  const checks = task.acceptance.filter(item => item.required && item.method === "automatic")
    .flatMap(item => item.verification.kind === "shell_exit_zero" ? [item.verification] : []);
  const unique = checks.filter((item, index) => checks.findIndex(other => other.command === item.command && other.cwd === item.cwd) === index);
  if (unique.length < 2 || unique.some(item => item.cwd !== unique[0]!.cwd || item.command.includes("\0"))) return null;
  // Separate shells preserve each command's syntax/exit semantics; && stops on any failure.
  // Keep the original cwd at the tool boundary so path/symlink/sandbox checks still apply.
  const command = unique.map(item => `/bin/sh -c ${quote(item.command)}`).join(" &&\n");
  if (Buffer.byteLength(command) > 1024) return null; // Existing evidence contract, never truncate.
  return { command, cwd: unique[0]!.cwd };
}

export function matchesTaskTestCommand(task: Pick<WorkTask, "acceptance">, criterion: AcceptanceCriterion, input: TaskShellCommand): boolean {
  if (criterion.verification.kind !== "shell_exit_zero") return false;
  if (input.command === criterion.verification.command && input.cwd === criterion.verification.cwd) return true;
  const batch = criterion.required ? workTaskTestBatch(task) : null;
  return batch !== null && input.command === batch.command && input.cwd === batch.cwd;
}

/** A dispatched Shell may write even when it fails. Denied/not-started calls have no effect. */
export function invalidatesTaskTest(tool: ExecutionToolRecord): boolean {
  if (tool.status === "not_started") return false;
  if (tool.status === "failed" && tool.startedAt === null) return false;
  return ["write_file", "edit_file", "shell_exec", "computer_action"].includes(tool.toolName);
}

export function shellCommand(tool: ExecutionToolRecord): TaskShellCommand | null {
  if (tool.toolName !== "shell_exec" || tool.inputTruncated || tool.inputPreview === null) return null;
  try {
    const input = JSON.parse(tool.inputPreview) as Record<string, unknown> | null;
    if (!input || typeof input.command !== "string" || (input.cwd !== undefined && typeof input.cwd !== "string")) return null;
    return { command: input.command, cwd: (input.cwd as string | undefined) ?? "." };
  } catch { return null; }
}
