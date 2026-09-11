import { realpath, stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

export interface TuiArgs {
  directory?: string;
  threadId?: string;
  workspace?: string;
  autoConsolidate?: boolean;
  todoistEnabled?: boolean;
}

/**
 * Parse the arguments that follow --tui. A single positional argument is the
 * transcript directory; all other configuration is named so that adding a
 * workspace cannot accidentally change the transcript location.
 */
export function parseTuiArgs(args: readonly string[]): TuiArgs {
  const parsedArgs = args[0] === "--" ? args.slice(1) : args;
  let directory: string | undefined;
  let threadId: string | undefined;
  let workspace: string | undefined;
  let autoConsolidate = false;
  let todoistEnabled = false;

  for (let index = 0; index < parsedArgs.length; index += 1) {
    const arg = parsedArgs[index];
    if (arg === "--thread") {
      const value = parsedArgs[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--thread requires an id");
      }
      threadId = value;
      continue;
    }
    if (arg === "--workspace") {
      const value = parsedArgs[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--workspace requires a directory");
      }
      if (workspace !== undefined) {
        throw new Error("TUI accepts at most one --workspace option");
      }
      workspace = value;
      continue;
    }
    if (arg === "--auto-consolidate") {
      autoConsolidate = true;
      continue;
    }
    if (arg === "--todoist") {
      todoistEnabled = true;
      continue;
    }
    if (arg?.startsWith("--")) {
      throw new Error(`Unknown TUI option: ${arg}`);
    }
    if (directory !== undefined) {
      throw new Error("TUI accepts at most one transcript directory");
    }
    directory = arg;
  }

  if (autoConsolidate && workspace === undefined) {
    throw new Error("--auto-consolidate requires --workspace");
  }

  return {
    ...(directory !== undefined ? { directory } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(autoConsolidate ? { autoConsolidate: true } : {}),
    ...(todoistEnabled ? { todoistEnabled: true } : {}),
  };
}

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
