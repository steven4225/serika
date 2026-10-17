import { realpath, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

/**
 * Resolve the explicitly configured workspace to the real absolute directory
 * used as the root for read_file. Invalid configuration fails startup rather
 * than silently widening the readable scope to cwd.
 */
export async function resolveWorkspace(
  workspace: string,
  cwd = process.cwd(),
): Promise<string> {
  const configuredPath = resolvePath(cwd, workspace);
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(configuredPath);
  } catch {
    throw new Error(`Workspace does not exist: ${workspace}`);
  }

  let details;
  try {
    details = await stat(resolvedPath);
  } catch {
    throw new Error(`Workspace cannot be inspected: ${workspace}`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${workspace}`);
  }
  return resolvedPath;
}
