import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";
import { tool, type Tool } from "ai";
import { z } from "zod";

export const READ_FILE_MAX_BYTES = 65_536;

export const readFileErrorCodes = [
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "SYMLINK_NOT_ALLOWED",
  "FILE_NOT_FOUND",
  "NOT_REGULAR_FILE",
  "FILE_TOO_LARGE",
  "NOT_TEXT",
  "READ_FAILED",
] as const;

export type ReadFileErrorCode = (typeof readFileErrorCodes)[number];

export interface ReadFileSuccess {
  ok: true;
  path: string;
  content: string;
  bytes: number;
}

export interface ReadFileFailure {
  ok: false;
  error: {
    code: ReadFileErrorCode;
    message: string;
  };
}

export type ReadFileResult = ReadFileSuccess | ReadFileFailure;

const neverAborted = new AbortController().signal;
const decoder = new TextDecoder("utf-8", { fatal: true });

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function failure(code: ReadFileErrorCode, message: string): ReadFileFailure {
  return { ok: false, error: { code, message } };
}

function mapFilesystemError(
  error: unknown,
  relativePath: string,
): ReadFileFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return failure("FILE_NOT_FOUND", `File not found: ${relativePath || "."}`);
  }
  if (code === "ELOOP") {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }
  if (code === "EISDIR") {
    return failure("NOT_REGULAR_FILE", `Not a regular file: ${relativePath || "."}`);
  }
  return failure("READ_FAILED", `Unable to read file: ${relativePath || "."}`);
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
  | { ok: false; result: ReadFileFailure } {
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
  target: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<ReadFileFailure | undefined> {
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
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        return failure("FILE_NOT_FOUND", `File not found: ${relativePath || "."}`);
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ELOOP"
      ) {
        return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
      }
      throw error;
    }
  }
  return undefined;
}

/**
 * Read one UTF-8 text file below a fixed workspace.
 *
 * File-system checks are intentionally process-local. They reject symlink
 * components observed before the read, but do not claim to prevent another
 * process from replacing a path concurrently.
 */
export async function readFileFromWorkspace(
  workspace: string,
  requestedPath: string,
  abortSignal: AbortSignal = neverAborted,
): Promise<ReadFileResult> {
  const workspaceRoot = resolve(workspace);
  throwIfAborted(abortSignal);

  const validated = validateRequestedPath(workspaceRoot, requestedPath);
  if (!validated.ok) return validated.result;

  const { target, relativePath } = validated;
  let symlinkResult: ReadFileFailure | undefined;
  try {
    symlinkResult = await rejectSymlinkComponents(
      workspaceRoot,
      target,
      relativePath,
      abortSignal,
    );
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return mapFilesystemError(error, relativePath);
  }
  if (symlinkResult) return symlinkResult;

  let targetStats: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStats = await lstat(target);
    throwIfAborted(abortSignal);
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return mapFilesystemError(error, relativePath);
  }

  if (targetStats.isSymbolicLink()) {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }
  if (!targetStats.isFile()) {
    return failure("NOT_REGULAR_FILE", `Not a regular file: ${relativePath || "."}`);
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfAborted(abortSignal);
    // O_NOFOLLOW prevents a final-component symlink from being opened if the
    // path changes between lstat and open. Intermediate replacement races are
    // outside this local tool's isolation contract.
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    throwIfAborted(abortSignal);

    const bytes = Buffer.allocUnsafe(READ_FILE_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      throwIfAborted(abortSignal);
      const read = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      bytesRead += read.bytesRead;
      if (read.bytesRead === 0) break;
    }
    throwIfAborted(abortSignal);
    if (bytesRead > READ_FILE_MAX_BYTES) {
      return failure(
        "FILE_TOO_LARGE",
        `File exceeds the ${READ_FILE_MAX_BYTES}-byte limit`,
      );
    }

    const contentBytes = bytes.subarray(0, bytesRead);
    let content: string;
    try {
      content = decoder.decode(contentBytes);
    } catch {
      return failure("NOT_TEXT", "File is not valid UTF-8 text");
    }
    if (content.includes("\0")) {
      return failure("NOT_TEXT", "File contains NUL bytes");
    }
    return { ok: true, path: relativePath, content, bytes: bytesRead };
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return mapFilesystemError(error, relativePath);
  } finally {
    if (handle) await handle.close();
  }
}

const readFileOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    content: z.string(),
    bytes: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(readFileErrorCodes),
      message: z.string(),
    }),
  }),
]);

export function createReadFileTool(
  workspace: string,
): Tool<{ path: string }, ReadFileResult> {
  const workspaceRoot = resolve(workspace);
  return tool({
    description:
      "Read one UTF-8 text file below the configured workspace. The path must be relative to the workspace.",
    inputSchema: z.object({ path: z.string().min(1) }),
    outputSchema: readFileOutputSchema,
    execute: async ({ path }, { abortSignal }) =>
      readFileFromWorkspace(workspaceRoot, path, abortSignal),
  });
}
