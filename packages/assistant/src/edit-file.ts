import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { tool, type Tool } from "ai";
import { z } from "zod";
import {
  abortReason,
  rejectSymlinkComponents,
  throwIfAborted,
  validateWorkspacePath,
} from "./workspace-path.js";

export const EDIT_FILE_MAX_BYTES = 65_536;

export const editFileErrorCodes = [
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "SYMLINK_NOT_ALLOWED",
  "FILE_NOT_FOUND",
  "NOT_REGULAR_FILE",
  "FILE_TOO_LARGE",
  "NOT_TEXT",
  "INVALID_OLD_TEXT",
  "TEXT_NOT_FOUND",
  "AMBIGUOUS_MATCH",
  "READ_FAILED",
  "WRITE_FAILED",
] as const;

export type EditFileErrorCode = (typeof editFileErrorCodes)[number];

export interface EditFileSuccess {
  ok: true;
  path: string;
  bytes: number;
  sha256: string;
}

export interface EditFileFailure {
  ok: false;
  error: {
    code: EditFileErrorCode;
    message: string;
  };
}

export type EditFileResult = EditFileSuccess | EditFileFailure;

export interface EditFileInput {
  path: string;
  oldText: string;
  newText: string;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const neverAborted = new AbortController().signal;

function failure(
  code: EditFileErrorCode,
  message: string,
): EditFileFailure {
  return { ok: false, error: { code, message } };
}

function hasInvalidText(text: string): boolean {
  if (text.includes("\0")) return true;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function mapReadError(error: unknown): EditFileFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return failure("FILE_NOT_FOUND", "File not found");
  }
  if (code === "ELOOP") {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }
  if (code === "EISDIR") {
    return failure("NOT_REGULAR_FILE", "Target is not a regular file");
  }
  return failure("READ_FAILED", "Unable to read file");
}

async function readFileForEdit(
  workspaceRoot: string,
  target: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<
  | { ok: true; content: string; mode: number }
  | { ok: false; result: EditFileFailure }
  > {
  try {
    if (await rejectSymlinkComponents(workspaceRoot, relativePath, signal)) {
      return { ok: false, result: failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed") };
    }
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    return { ok: false, result: mapReadError(error) };
  }

  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(target);
    throwIfAborted(signal);
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    return { ok: false, result: mapReadError(error) };
  }
  if (stats.isSymbolicLink()) {
    return { ok: false, result: failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed") };
  }
  if (!stats.isFile()) {
    return { ok: false, result: failure("NOT_REGULAR_FILE", "Target is not a regular file") };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    throwIfAborted(signal);
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    throwIfAborted(signal);
    const bytes = Buffer.allocUnsafe(EDIT_FILE_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      throwIfAborted(signal);
      const read = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      bytesRead += read.bytesRead;
      if (read.bytesRead === 0) break;
    }
    throwIfAborted(signal);
    if (bytesRead > EDIT_FILE_MAX_BYTES) {
      return {
        ok: false,
        result: failure("FILE_TOO_LARGE", "File exceeds the 64 KiB limit"),
      };
    }
    let content: string;
    try {
      content = decoder.decode(bytes.subarray(0, bytesRead));
    } catch {
      return { ok: false, result: failure("NOT_TEXT", "File is not valid UTF-8 text") };
    }
    if (content.includes("\0")) {
      return { ok: false, result: failure("NOT_TEXT", "File contains NUL bytes") };
    }
    return { ok: true, content, mode: stats.mode & 0o7777 };
  } catch (error) {
    if (signal.aborted) throw abortReason(signal);
    return { ok: false, result: mapReadError(error) };
  } finally {
    if (handle) await handle.close();
  }
}

function replacementIndex(content: string, oldText: string):
  | { ok: true; index: number }
  | { ok: false; result: EditFileFailure } {
  let first = -1;
  let matches = 0;
  let from = 0;
  while (from <= content.length - oldText.length) {
    const index = content.indexOf(oldText, from);
    if (index === -1) break;
    if (first === -1) first = index;
    matches += 1;
    if (matches > 1) {
      return {
        ok: false,
        result: failure("AMBIGUOUS_MATCH", "Text occurs more than once"),
      };
    }
    from = index + 1;
  }
  if (matches === 0) {
    return { ok: false, result: failure("TEXT_NOT_FOUND", "Text was not found") };
  }
  return { ok: true, index: first };
}

async function removeTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The original write error or cancellation is the meaningful result.
  }
}

/** Replace exactly one literal occurrence in an existing workspace text file. */
export async function editFileInWorkspace(
  workspace: string,
  input: EditFileInput,
  abortSignal: AbortSignal = neverAborted,
): Promise<EditFileResult> {
  throwIfAborted(abortSignal);

  if (input.oldText.length === 0) {
    return failure("INVALID_OLD_TEXT", "oldText must be non-empty");
  }
  if (hasInvalidText(input.oldText) || hasInvalidText(input.newText)) {
    return failure("NOT_TEXT", "Text must be valid UTF-8 without NUL bytes");
  }

  const workspaceRoot = resolve(workspace);
  const validatedPath = validateWorkspacePath(workspaceRoot, input.path);
  if (!validatedPath.ok) return failure(validatedPath.code, validatedPath.message);
  const { target, relativePath } = validatedPath;

  const read = await readFileForEdit(
    workspaceRoot,
    target,
    relativePath,
    abortSignal,
  );
  if (!read.ok) return read.result;

  const match = replacementIndex(read.content, input.oldText);
  if (!match.ok) return match.result;
  const content =
    read.content.slice(0, match.index) +
    input.newText +
    read.content.slice(match.index + input.oldText.length);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > EDIT_FILE_MAX_BYTES) {
    return failure("FILE_TOO_LARGE", "Edited file exceeds the 64 KiB limit");
  }

  throwIfAborted(abortSignal);
  const tempPath = join(
    dirname(target),
    `.${basename(target)}.runloom-edit-${randomUUID()}.tmp`,
  );
  let tempCreated = false;
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    tempHandle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    tempCreated = true;
    throwIfAborted(abortSignal);
    await tempHandle.writeFile(content, "utf8");
    throwIfAborted(abortSignal);
    await tempHandle.close();
    tempHandle = undefined;
    await chmod(tempPath, read.mode);
    throwIfAborted(abortSignal);
    await rename(tempPath, target);
    tempCreated = false;
    return { ok: true, path: relativePath, bytes,
      sha256: createHash("sha256").update(content, "utf8").digest("hex") };
  } catch (error) {
    if (tempHandle) {
      try {
        await tempHandle.close();
      } catch {
        // Preserve the operation's original failure or cancellation.
      }
    }
    if (tempCreated) await removeTempFile(tempPath);
    if (abortSignal.aborted) throw abortReason(abortSignal);
    return failure("WRITE_FAILED", "Unable to write edited file");
  }
}

const editFileOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(editFileErrorCodes),
      message: z.string(),
    }),
  }),
]);

export function createEditFileTool(
  workspace: string,
): Tool<EditFileInput, EditFileResult> {
  const workspaceRoot = resolve(workspace);
  return tool({
    description:
      "Replace exactly one literal occurrence in an existing UTF-8 text file below the configured workspace. Required argument names are path, oldText and newText (camelCase, not old_text/new_text). Read the current file first; oldText must match exactly once. No match or multiple matches is rejected before editing.",
    inputSchema: z.object({
      path: z.string().describe("Relative path below the configured workspace."),
      oldText: z.string().describe("Exact existing text to replace; use the camelCase key oldText."),
      newText: z.string().describe("Replacement text; use the camelCase key newText."),
    }),
    outputSchema: editFileOutputSchema,
    execute: async (input, { abortSignal }) =>
      editFileInWorkspace(workspaceRoot, input, abortSignal),
  });
}
