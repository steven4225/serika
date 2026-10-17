import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export type WorkspacePathErrorCode = "INVALID_PATH" | "PATH_OUTSIDE_WORKSPACE";

export interface WorkspacePath {
  target: string;
  relativePath: string;
}

export type WorkspacePathValidation =
  | ({ ok: true } & WorkspacePath)
  | {
      ok: false;
      code: WorkspacePathErrorCode;
      message: string;
    };

export function validateWorkspacePath(
  workspaceRoot: string,
  requestedPath: unknown,
): WorkspacePathValidation {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return {
      ok: false,
      code: "INVALID_PATH",
      message: "Path must be a non-empty relative path",
    };
  }
  if (requestedPath.includes("\0")) {
    return {
      ok: false,
      code: "INVALID_PATH",
      message: "Path must not contain NUL bytes",
    };
  }
  if (isAbsolute(requestedPath) || win32.isAbsolute(requestedPath)) {
    return {
      ok: false,
      code: "INVALID_PATH",
      message: "Path must be relative to the workspace",
    };
  }

  const target = resolve(workspaceRoot, requestedPath);
  const relativePath = relative(workspaceRoot, target);
  if (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    return {
      ok: false,
      code: "PATH_OUTSIDE_WORKSPACE",
      message: "Path is outside the workspace",
    };
  }

  return { ok: true, target, relativePath };
}

/**
 * Check every existing path component without following symbolic links.
 * Missing components are left to the caller to map to its tool-specific error.
 */
export async function rejectSymlinkComponents(
  workspaceRoot: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<boolean> {
  let current = workspaceRoot;
  const components = relativePath === "" ? [] : relativePath.split(sep);
  for (const component of components) {
    throwIfAborted(signal);
    current = resolve(current, component);
    const stats = await lstat(current);
    throwIfAborted(signal);
    if (stats.isSymbolicLink()) return true;
  }
  return false;
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}
