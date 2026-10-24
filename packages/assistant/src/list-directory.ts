import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { DirectoryAccess } from "./directory-access.js";
import { tool, type Tool } from "ai";
import { DIRECTORY_FILE_INSTRUCTIONS, directoryFileExecution, directoryFileOutputSchema, type DirectoryFileFailure } from "./directory-file-tool.js";
import { z } from "zod";
import {
  rejectSymlinkComponents,
  validateWorkspacePath,
} from "./workspace-path.js";

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

  const validated = validateWorkspacePath(workspaceRoot, requestedPath);
  if (!validated.ok) return failure(validated.code, validated.message);

  const { target, relativePath } = validated;
  const displayPath = relativePath || ".";
  let hasSymlinkComponent: boolean;
  try {
    hasSymlinkComponent = await rejectSymlinkComponents(
      workspaceRoot,
      relativePath,
      abortSignal,
    );
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return mapFilesystemError(error, displayPath);
  }
  if (hasSymlinkComponent) {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }

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

export function createListDirectoryTool(access: DirectoryAccess, directory?: string): Tool<{ path?: string | undefined } & { directory?: string | undefined }, ListDirectoryResult | DirectoryFileFailure> {
  const inputSchema = z.object({ path: z.string().optional(), directory: z.string().optional() });
  return tool({
    description: "List one directory below the configured workspace. The path defaults to the selected root; results are capped at 200 entries and may be truncated." + DIRECTORY_FILE_INSTRUCTIONS,
    inputSchema,
    outputSchema: directoryFileOutputSchema(listDirectoryOutputSchema),
    execute: directoryFileExecution<z.infer<typeof inputSchema>, ListDirectoryResult>({
      access, directory, write: false,
      execute: (root, input, signal) => listDirectoryFromWorkspace(root, input.path, signal),
    }),
  });
}
