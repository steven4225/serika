import { isProtectedPath, type ProtectedPaths } from "./protected-paths.js";
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { DirectoryAccess } from "./directory-access.js";
import { tool, type Tool } from "ai";
import { DIRECTORY_FILE_INSTRUCTIONS, directoryFileExecution, directoryFileOutputSchema, type DirectoryFileFailure } from "./directory-file-tool.js";
import { z } from "zod";
import { READ_FILE_MAX_BYTES } from "./read-file.js";
import {
  rejectSymlinkComponents,
  validateWorkspacePath,
} from "./workspace-path.js";

const SEARCH_FILES_MAX_ENTRIES = 1_000;
const SEARCH_FILES_MAX_MATCHES = 100;

export const searchFilesErrorCodes = [
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "SYMLINK_NOT_ALLOWED",
  "PATH_NOT_FOUND",
  "NOT_DIRECTORY",
  "INVALID_QUERY",
  "LIST_FAILED",
  "SEARCH_FAILED",
] as const;

export type SearchFilesErrorCode = (typeof searchFilesErrorCodes)[number];

export interface WorkspaceToolFailure {
  ok: false;
  error: {
    code: SearchFilesErrorCode;
    message: string;
  };
}

export interface SearchFilesMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchFilesInput {
  query: string;
  path?: string | undefined;
}

export interface SearchFilesSuccess {
  ok: true;
  matches: SearchFilesMatch[];
  truncated: boolean;
  skippedOversize: number;
}

export type SearchFilesResult = SearchFilesSuccess | WorkspaceToolFailure;

const decoder = new TextDecoder("utf-8", { fatal: true });
const neverAborted = new AbortController().signal;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function failure(code: SearchFilesErrorCode, message: string): WorkspaceToolFailure {
  return { ok: false, error: { code, message } };
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function validateQuery(query: string): WorkspaceToolFailure | undefined {
  if (query.length === 0) {
    return failure("INVALID_QUERY", "Query must be non-empty");
  }
  if (query.includes("\r") || query.includes("\n") || query.includes("\0")) {
    return failure("INVALID_QUERY", "Query must not contain CR, LF, or NUL");
  }
  return undefined;
}

function isExcludedName(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

async function inspectSearchRoot(
  workspaceRoot: string,
  target: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<WorkspaceToolFailure | undefined> {
  const components = relativePath === "" ? [] : relativePath.split(sep);
  for (const component of components) {
    if (isExcludedName(component)) {
      return failure("INVALID_PATH", "Path is excluded from workspace search");
    }
  }

  let hasSymlinkComponent: boolean;
  try {
    hasSymlinkComponent = await rejectSymlinkComponents(
      workspaceRoot,
      relativePath,
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    const code = filesystemCode(error);
    if (code === "ENOENT") {
      return failure("PATH_NOT_FOUND", `Path not found: ${relativePath || "."}`);
    }
    if (code === "ENOTDIR") {
      return failure("NOT_DIRECTORY", `Not a directory: ${relativePath || "."}`);
    }
    if (code === "ELOOP") {
      return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }
    return failure("LIST_FAILED", `Unable to inspect path: ${relativePath || "."}`);
  }
  if (hasSymlinkComponent) {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }

  let current = workspaceRoot;
  for (const component of components) {
    throwIfAborted(signal);
    if (isExcludedName(component)) {
      return failure("INVALID_PATH", "Path is excluded from workspace search");
    }
    current = resolve(current, component);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
      throwIfAborted(signal);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      const code = filesystemCode(error);
      if (code === "ENOENT") {
        return failure("PATH_NOT_FOUND", `Path not found: ${relativePath}`);
      }
      if (code === "ENOTDIR") {
        return failure("NOT_DIRECTORY", `Not a directory: ${relativePath}`);
      }
      return failure("LIST_FAILED", `Unable to inspect path: ${relativePath}`);
    }
    if (stats.isSymbolicLink()) {
      return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }
    if (!stats.isDirectory()) {
      return failure("NOT_DIRECTORY", `Not a directory: ${relativePath}`);
    }
  }

  if (components.length === 0) {
    try {
      const stats = await lstat(target);
      throwIfAborted(signal);
      if (stats.isSymbolicLink()) {
        return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
      }
      if (!stats.isDirectory()) {
        return failure("NOT_DIRECTORY", "Not a directory: .");
      }
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      const code = filesystemCode(error);
      if (code === "ENOENT") return failure("PATH_NOT_FOUND", "Path not found: .");
      return failure("LIST_FAILED", "Unable to inspect path: .");
    }
  }

  return undefined;
}

function resultBytes(matches: readonly SearchFilesMatch[]): number {
  // The non-truncated envelope is one byte larger than the truncated one.
  // Check the larger shape before adding a match so either final state fits.
  return Buffer.byteLength(
    JSON.stringify({ ok: true, matches, truncated: false, skippedOversize: 0 }),
    "utf8",
  );
}

/** Search literal text in eligible UTF-8 files below one workspace directory. */
export async function searchFilesInWorkspace(
  workspace: string,
  query: string,
  requestedPath?: string,
  abortSignal: AbortSignal = neverAborted,
  protectedPaths?: ProtectedPaths,
): Promise<SearchFilesResult> {
  throwIfAborted(abortSignal);
  const invalidQuery = validateQuery(query);
  if (invalidQuery) return invalidQuery;

  const workspaceRoot = resolve(workspace);
  const validatedPath = validateWorkspacePath(
    workspaceRoot,
    requestedPath ?? ".",
  );
  if (!validatedPath.ok) {
    return failure(validatedPath.code, validatedPath.message);
  }

  const rootFailure = await inspectSearchRoot(
    workspaceRoot,
    validatedPath.target,
    validatedPath.relativePath,
    abortSignal,
  );
  if (rootFailure) return rootFailure;

  const matches: SearchFilesMatch[] = [];
  let entriesChecked = 0;
  let truncated = false;
  let skippedOversize = 0;

  const visit = async (directory: string): Promise<void> => {
    throwIfAborted(abortSignal);
    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, {
        withFileTypes: true,
        encoding: "utf8",
      });
      throwIfAborted(abortSignal);
    } catch (error) {
      if (abortSignal.aborted) throw abortReason(abortSignal);
      throw failure("LIST_FAILED", `Unable to list directory: ${relative(workspaceRoot, directory) || "."}`);
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const entry of entries) {
      throwIfAborted(abortSignal);
      if (entriesChecked === SEARCH_FILES_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      entriesChecked += 1;

      if (isExcludedName(entry.name) || entry.isSymbolicLink()) continue;

      const entryPath = resolve(directory, entry.name);
      if (protectedPaths && isProtectedPath({ ...protectedPaths, path: entryPath, write: false })) continue;
      if (entry.isDirectory()) {
        await visit(entryPath);
        if (truncated) return;
        continue;
      }
      if (!entry.isFile()) continue;

      let stats: Awaited<ReturnType<typeof lstat>>;
      let bytes: Buffer;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        stats = await lstat(entryPath);
        throwIfAborted(abortSignal);
        if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
          continue;
        }
        if (stats.size > READ_FILE_MAX_BYTES) {
          skippedOversize += 1;
          continue;
        }

        // Match read_file's bounded read and final-component symlink guard.
        handle = await open(entryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        throwIfAborted(abortSignal);
        const bounded = Buffer.allocUnsafe(READ_FILE_MAX_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < bounded.length) {
          throwIfAborted(abortSignal);
          const read = await handle.read(
            bounded,
            bytesRead,
            bounded.length - bytesRead,
            bytesRead,
          );
          bytesRead += read.bytesRead;
          if (read.bytesRead === 0) break;
        }
        throwIfAborted(abortSignal);
        if (bytesRead > READ_FILE_MAX_BYTES) {
          skippedOversize += 1;
          continue;
        }
        bytes = bounded.subarray(0, bytesRead);
      } catch (error) {
        if (abortSignal.aborted) throw abortReason(abortSignal);
        throw failure("SEARCH_FAILED", `Unable to search file: ${relative(workspaceRoot, entryPath)}`);
      } finally {
        if (handle) await handle.close();
      }
      if (bytes.includes(0)) continue;

      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        continue;
      }

      const path = relative(workspaceRoot, entryPath);
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        throwIfAborted(abortSignal);
        if (!lines[index]!.includes(query)) continue;
        if (matches.length === SEARCH_FILES_MAX_MATCHES) {
          truncated = true;
          return;
        }
        const match = { path, line: index + 1, text: lines[index]! };
        matches.push(match);
        if (resultBytes(matches) > READ_FILE_MAX_BYTES) {
          matches.pop();
          truncated = true;
          return;
        }
        if (matches.length === SEARCH_FILES_MAX_MATCHES) {
          truncated = true;
          return;
        }
      }
    }
  };

  try {
    await visit(validatedPath.target);
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    if (error && typeof error === "object" && "ok" in error && error.ok === false) {
      return error as WorkspaceToolFailure;
    }
    return failure("SEARCH_FAILED", "Unable to search workspace");
  }

  return { ok: true, matches, truncated, skippedOversize };
}

const searchFilesOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() })),
    truncated: z.boolean(),
    skippedOversize: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.enum(searchFilesErrorCodes), message: z.string() }),
  }),
]);

export function createSearchFilesTool(access: DirectoryAccess, directory?: string): Tool<SearchFilesInput & { directory?: string | undefined }, SearchFilesResult | DirectoryFileFailure> {
  const inputSchema = z.object({ query: z.string(), path: z.string().optional(), directory: z.string().optional() });
  return tool({
    description: "Search literal, case-sensitive text in UTF-8 files below the configured workspace. Hidden paths, node_modules, and symbolic links are excluded; results may be truncated by search limits." + DIRECTORY_FILE_INSTRUCTIONS,
    inputSchema,
    outputSchema: directoryFileOutputSchema(searchFilesOutputSchema),
    execute: directoryFileExecution<z.infer<typeof inputSchema>, SearchFilesResult>({
      access, directory, write: false,
      execute: (root, input, signal) => searchFilesInWorkspace(root, input.query, input.path, signal, {
        controlPaths: access.options.protectedPaths, credentialPaths: access.options.credentialPaths ?? [],
      }),
    }),
  });
}
