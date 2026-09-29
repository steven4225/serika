import type { ToolRowStatus } from "./tool-status.js";

export interface ShellExecPresentation {
  status: ToolRowStatus;
  detail?: string;
  exitCode?: number | null;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

function isShellExecShape(output: object): boolean {
  return "exitCode" in output || "timedOut" in output || "cancelled" in output;
}

/**
 * Display-only reading of a `shell_exec` tool result. Truncation is never a
 * failure. Final success/failure follows `ok`, `exitCode`, `timedOut`, and
 * `cancelled` — not live `shell-progress` text.
 */
export function presentShellExec(output: unknown): ShellExecPresentation | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  if (!isShellExecShape(output)) return undefined;
  const record = output as {
    ok?: unknown;
    exitCode?: unknown;
    timedOut?: unknown;
    cancelled?: unknown;
    truncated?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  const timedOut = record.timedOut === true;
  const cancelled = record.cancelled === true;
  const truncated = record.truncated === true;
  const exitCode =
    typeof record.exitCode === "number" || record.exitCode === null ? record.exitCode : undefined;

  if (record.ok === false) {
    const code = typeof record.error?.code === "string" ? record.error.code : "error";
    const message = typeof record.error?.message === "string" ? record.error.message : "";
    const status: ToolRowStatus = code === "TOOL_DENIED" ? "denied" : "failed";
    return {
      status,
      detail: message ? `${code}: ${message}` : code,
      timedOut,
      cancelled,
      truncated,
      ...(exitCode !== undefined ? { exitCode } : {}),
    };
  }

  let status: ToolRowStatus = "ok";
  if (cancelled) status = "cancelled";
  else if (timedOut) status = "timed_out";
  else if (typeof exitCode === "number" && exitCode !== 0) status = "failed";

  const parts: string[] = [];
  if (exitCode !== undefined) parts.push(`exit ${String(exitCode)}`);
  if (timedOut) parts.push("Shell 超时");
  if (cancelled) parts.push("已取消");

  return {
    status,
    timedOut,
    cancelled,
    truncated,
    ...(parts.length > 0 ? { detail: parts.join(" · ") } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}
