import type { ToolExecutionOptions } from "ai";
import { z } from "zod";
import type { DirectoryAccess, DirectoryAccessCode } from "./directory-access.js";

export const DIRECTORY_FILE_INSTRUCTIONS = " Paths may be absolute inside authorized directories, or relative to the explicit project/selected directory. Without an explicit base, ask the user to choose a directory when several are authorized. Read-only grants and protected control files cannot be written. Credential paths cannot be read or written.";

const accessFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.enum(["INVALID_PATH", "PATH_OUTSIDE_WORKSPACE", "DIRECTORY_SELECTION_REQUIRED", "READ_ONLY_DIRECTORY", "PROTECTED_PATH", "SYMLINK_NOT_ALLOWED", "HARDLINK_NOT_ALLOWED"] satisfies DirectoryAccessCode[]), message: z.string() }),
  directories: z.array(z.string()).optional(),
});

export type DirectoryFileFailure = z.infer<typeof accessFailureSchema>;

export function directoryFileOutputSchema<Output>(schema: z.ZodType<Output>) {
  return z.union([schema, accessFailureSchema]);
}

export function directoryFileExecution<Input extends { path?: string | undefined; directory?: string | undefined }, Output>(options: {
  access: DirectoryAccess;
  directory: string | undefined;
  write: boolean;
  execute: (root: string, input: Input & { path: string }, signal?: AbortSignal) => Promise<Output>;
}): (input: Input, execution: ToolExecutionOptions<Record<string, unknown>>) => Promise<Output | z.infer<typeof accessFailureSchema>> {
  return async (input, execution) => {
    execution.abortSignal?.throwIfAborted();
    const directory = input.directory ?? options.directory;
    const selected = await options.access.resolve({ path: input.path ?? ".", ...(directory === undefined ? {} : { directory }), write: options.write });
    if (!selected.ok) return { ok: false, error: { code: selected.code, message: selected.message }, ...(selected.directories ? { directories: [...selected.directories] } : {}) };
    return options.execute(selected.root, { ...input, path: selected.relativePath || "." }, execution.abortSignal);
  };
}
