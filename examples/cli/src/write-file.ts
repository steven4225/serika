import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { AgentError } from "@aisdk-agent/core";
import {
  abortReason,
  rejectSymlinkComponents,
  throwIfAborted,
  validateWorkspacePath,
} from "./workspace-path.js";

export const WRITE_FILE_MAX_BYTES = 65_536;

export const writeFileErrorCodes = [
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "SYMLINK_NOT_ALLOWED",
  "FILE_EXISTS",
  "PARENT_NOT_FOUND",
  "NOT_DIRECTORY",
  "NOT_REGULAR_FILE",
  "FILE_TOO_LARGE",
  "NOT_TEXT",
  "WRITE_FAILED",
] as const;

export type WriteFileErrorCode = (typeof writeFileErrorCodes)[number];

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface WriteFileSuccess {
  ok: true;
  path: string;
  bytes: number;
  sha256: string;
}

export interface WriteFileFailure {
  ok: false;
  error: {
    code: WriteFileErrorCode;
    message: string;
  };
}

export type WriteFileResult = WriteFileSuccess | WriteFileFailure;

const neverAborted = new AbortController().signal;

function failure(code: WriteFileErrorCode, message: string): WriteFileFailure {
  return { ok: false, error: { code, message } };
}

function filesystemCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function validUtf8Content(content: string): Buffer | WriteFileFailure {
  if (content.includes("\0")) {
    return failure("NOT_TEXT", "Content must not contain NUL bytes");
  }

  // Buffer.from replaces lone UTF-16 surrogates with U+FFFD. Reject them so
  // the bytes written to disk always represent the input string losslessly.
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return failure("NOT_TEXT", "Content is not valid UTF-16 text");
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return failure("NOT_TEXT", "Content is not valid UTF-16 text");
    }
  }

  const bytes = Buffer.from(content, "utf8");
  if (bytes.length > WRITE_FILE_MAX_BYTES) {
    return failure(
      "FILE_TOO_LARGE",
      `Content exceeds the ${WRITE_FILE_MAX_BYTES}-byte limit`,
    );
  }
  return bytes;
}

async function targetFailure(
  target: string,
  relativePath: string,
): Promise<WriteFileFailure | undefined> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) {
      return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }
    if (stats.isDirectory() || !stats.isFile()) {
      return failure("NOT_REGULAR_FILE", `Not a regular file: ${relativePath || "."}`);
    }
    return failure("FILE_EXISTS", `File already exists: ${relativePath || "."}`);
  } catch (error) {
    const code = filesystemCode(error);
    if (code === "ENOENT") return undefined;
    if (code === "ENOTDIR") {
      return failure("NOT_DIRECTORY", `Not a directory: ${relativePath || "."}`);
    }
    if (code === "ELOOP") {
      return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }
    return failure("WRITE_FAILED", `Unable to inspect path: ${relativePath || "."}`);
  }
}

async function classifyExistingTarget(
  target: string,
  relativePath: string,
): Promise<WriteFileFailure> {
  const existing = await targetFailure(target, relativePath);
  return existing ?? failure("FILE_EXISTS", `File already exists: ${relativePath || "."}`);
}

/** Create one new UTF-8 text file below a fixed workspace. */
export async function writeFileToWorkspace(
  workspace: string,
  requestedPath: string,
  content: string,
  abortSignal: AbortSignal = neverAborted,
): Promise<WriteFileResult> {
  throwIfAborted(abortSignal);

  const workspaceRoot = resolve(workspace);
  const validated = validateWorkspacePath(workspaceRoot, requestedPath);
  if (!validated.ok) return failure(validated.code, validated.message);

  const encoded = validUtf8Content(content);
  if (!Buffer.isBuffer(encoded)) return encoded;

  const { target, relativePath } = validated;
  const parentTarget = dirname(target);
  const parentRelativePath = dirname(relativePath || ".");

  let parentHasSymlink: boolean;
  try {
    parentHasSymlink = await rejectSymlinkComponents(
      workspaceRoot,
      parentRelativePath === "." ? "" : parentRelativePath,
      abortSignal,
    );
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    const code = filesystemCode(error);
    if (code === "ENOENT") {
      return failure("PARENT_NOT_FOUND", `Parent directory not found: ${parentRelativePath}`);
    }
    if (code === "ENOTDIR") {
      return failure("NOT_DIRECTORY", `Not a directory: ${parentRelativePath}`);
    }
    if (code === "ELOOP") {
      return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }
    return failure("WRITE_FAILED", "Unable to inspect parent directory");
  }
  if (parentHasSymlink) {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }

  let parentStats: Awaited<ReturnType<typeof lstat>>;
  try {
    parentStats = await lstat(parentTarget);
  } catch (error) {
    const code = filesystemCode(error);
    if (code === "ENOENT") {
      return failure("PARENT_NOT_FOUND", `Parent directory not found: ${parentRelativePath}`);
    }
    if (code === "ENOTDIR") {
      return failure("NOT_DIRECTORY", `Not a directory: ${parentRelativePath}`);
    }
    if (code === "ELOOP") {
      return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    }
    return failure("WRITE_FAILED", "Unable to inspect parent directory");
  }
  if (parentStats.isSymbolicLink()) {
    return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
  }
  if (!parentStats.isDirectory()) {
    return failure("NOT_DIRECTORY", `Not a directory: ${parentRelativePath}`);
  }

  const existing = await targetFailure(target, relativePath);
  if (existing) return existing;

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    throwIfAborted(abortSignal);
    handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o666,
    );
  } catch (error) {
    if (abortSignal.aborted) throw abortReason(abortSignal);
    const code = filesystemCode(error);
    if (code === "EEXIST") return classifyExistingTarget(target, relativePath);
    if (code === "ENOENT") return failure("PARENT_NOT_FOUND", `Parent directory not found: ${parentRelativePath}`);
    if (code === "ENOTDIR") return failure("NOT_DIRECTORY", `Not a directory: ${parentRelativePath}`);
    if (code === "ELOOP") return failure("SYMLINK_NOT_ALLOWED", "Symbolic links are not allowed");
    return failure("WRITE_FAILED", `Unable to create file: ${relativePath || "."}`);
  }

  try {
    // Once O_EXCL has created the file, finish the operation even if a later
    // cancellation arrives. Cancellation must not be treated as write failure.
    await handle.writeFile(encoded);
    await handle.close();
    return { ok: true, path: relativePath, bytes: encoded.length,
      sha256: createHash("sha256").update(encoded).digest("hex") };
  } catch {
    try {
      await handle.close();
    } catch {
      // The cleanup below still decides whether the partial file can be removed.
    }

    try {
      await unlink(target);
      return failure("WRITE_FAILED", `Unable to complete file write: ${relativePath || "."}`);
    } catch {
      throw new AgentError({ code: "TOOL_OUTCOME_UNKNOWN", phase: "tool", retryable: false,
        message: `Unable to confirm file state after write and cleanup failed: ${relativePath || "."}; inspect the file before another operation` });
    }
  }
}

const writeFileOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(writeFileErrorCodes),
      message: z.string(),
    }),
  }),
]);

export function createWriteFileTool(
  workspace: string,
): Tool<WriteFileInput, WriteFileResult> {
  const workspaceRoot = resolve(workspace);
  return tool({
    description:
      "Create one new UTF-8 text file below the configured workspace. Existing files are never overwritten; the path must be relative to the workspace.",
    inputSchema: z.object({ path: z.string().min(1), content: z.string() }),
    outputSchema: writeFileOutputSchema,
    execute: async ({ path, content }, { abortSignal }) =>
      writeFileToWorkspace(workspaceRoot, path, content, abortSignal),
  });
}
