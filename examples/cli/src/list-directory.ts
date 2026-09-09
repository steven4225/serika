import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";

export const LIST_DIRECTORY_MAX_ENTRIES = 200;

export const listDirectoryErrorCodes = [
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "SYMLINK_NOT_ALLOWED",
  "PATH_NOT_FOUND",
  "NOT_DIRECTORY",
  "LIST_FAILED",
] as const;

export type ListDirectoryErrorCode = (typeof listDirectoryErrorCodes)[number];
export type ListDirectoryEntryType = "file" | "directory" | "symlink" | "other";

export interface ListDirectorySuccess {
  ok: true;
  path: string;
  entries: Array<{ name: string; type: ListDirectoryEntryType }>;
  truncated: boolean;
}

export interface ListDirectoryFailure {
  ok: false;
  error: {
    code: ListDirectoryErrorCode;
    message: string;
  };
}

export type ListDirectoryResult = ListDirectorySuccess | ListDirectoryFailure;

const neverAborted = new AbortController().signal;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function failure(
  code: ListDirectoryErrorCode,
  message: string,
): ListDirectoryFailure {
  return { ok: false, error: { code, message } };
}

function mapFilesystemError(
  error: unknown,
  relativePath: string,
): ListDirectoryFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return failure("PATH_NOT_FOUND", `Path not found: ${relativePath}`);
  }
  if (code === "ELOOP") {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }
  return failure("LIST_FAILED", `Unable to list directory: ${relativePath}`);
}

function isPathOutsideWorkspace(workspaceRoot: string, target: string): boolean {
  const relativePath = relative(workspaceRoot, target);
  return (
    isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  );
}

function validateRequestedPath(
  workspaceRoot: string,
  requestedPath: unknown,
):
  | { ok: true; target: string; relativePath: string }
  | { ok: false; result: ListDirectoryFailure } {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    return {
      ok: false,
      result: failure("INVALID_PATH", "Path must be a non-empty relative path"),
    };
  }
  if (requestedPath.includes("\0")) {
    return {
      ok: false,
      result: failure("INVALID_PATH", "Path must not contain NUL bytes"),
    };
  }
  if (isAbsolute(requestedPath) || win32.isAbsolute(requestedPath)) {
    return {
      ok: false,
      result: failure("INVALID_PATH", "Path must be relative to the workspace"),
    };
  }

  const target = resolve(workspaceRoot, requestedPath);
  if (isPathOutsideWorkspace(workspaceRoot, target)) {
    return {
      ok: false,
      result: failure("PATH_OUTSIDE_WORKSPACE", "Path is outside the workspace"),
    };
  }

  return { ok: true, target, relativePath: relative(workspaceRoot, target) };
}

async function rejectSymlinkComponents(
  workspaceRoot: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<ListDirectoryFailure | undefined> {
  let current = workspaceRoot;
  const components = relativePath === "" ? [] : relativePath.split(sep);
  for (const component of components) {
    throwIfAborted(signal);
    current = resolve(current, component);
    try {
      const stats = await lstat(current);
      throwIfAborted(signal);
      if (stats.isSymbolicLink()) {
        return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
      }
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      return mapFilesystemError(error, relativePath || ".");
    }
  }
  return undefined;
}

function entryType(stats: Awaited<ReturnType<typeof lstat>>): ListDirectoryEntryType {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

/** List one directory below a fixed workspace without following requested symlinks. */
export async function listDirectoryFromWorkspace(
  workspace: string,
  requestedPath: string = ".",
  abortSignal: AbortSignal = neverAborted,
): Promise<ListDirectoryResult> {
  const workspaceRoot = resolve(workspace);
  throwIfAborted(abortSignal);

  const validated = validateRequestedPath(workspaceRoot, requestedPath);
  if (!validated.ok) return validated.result;

  const { target, relativePath } = validated;
  const displayPath = relativePath || ".";
  const symlinkResult = await rejectSymlinkComponents(
    workspaceRoot,
    relativePath,
    abortSignal,
  );
  if (symlinkResult) return symlinkResult;

  let targetStats: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStats = await lstat(target);
    throwIfAborted(abortSignal);
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return mapFilesystemError(error, displayPath);
  }

  if (targetStats.isSymbolicLink()) {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }
  if (!targetStats.isDirectory()) {
    return failure("NOT_DIRECTORY", `Not a directory: ${displayPath}`);
  }

  let names: string[];
  try {
    names = await readdir(target);
    throwIfAborted(abortSignal);
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return mapFilesystemError(error, displayPath);
  }

  names.sort();
  const truncated = names.length > LIST_DIRECTORY_MAX_ENTRIES;
  const entries: ListDirectorySuccess["entries"] = [];
  try {
    for (const name of names.slice(0, LIST_DIRECTORY_MAX_ENTRIES)) {
      throwIfAborted(abortSignal);
      const stats = await lstat(resolve(target, name));
      throwIfAborted(abortSignal);
      entries.push({ name, type: entryType(stats) });
    }
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return mapFilesystemError(error, displayPath);
  }

  return { ok: true, path: displayPath, entries, truncated };
}

const listDirectoryOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    entries: z.array(
      z.object({
        name: z.string(),
        type: z.enum(["file", "directory", "symlink", "other"]),
      }),
    ),
    truncated: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(listDirectoryErrorCodes),
      message: z.string(),
    }),
  }),
]);

export function createListDirectoryTool(
  workspace: string,
): Tool<{ path?: string | undefined }, ListDirectoryResult> {
  const workspaceRoot = resolve(workspace);
  return tool({
    description:
      "List one directory below the configured workspace. The path must be relative to the workspace and defaults to the workspace root; results are capped at 200 entries and may be truncated.",
    inputSchema: z.object({ path: z.string().optional() }),
    outputSchema: listDirectoryOutputSchema,
    execute: async ({ path }, { abortSignal }) =>
      listDirectoryFromWorkspace(workspaceRoot, path ?? ".", abortSignal),
  });
}
