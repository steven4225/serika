import { assertAssemblyCombination, type AssistantAssembly } from "@serika/assistant";

/** CLI form of an assembly: `--tui [directory] --thread … --config …`. */
export type TuiArgs = AssistantAssembly & { directory?: string };

/**
 * Parse the arguments that follow --tui. A single positional argument is the
 * transcript directory; all other configuration is named so that adding a
 * workspace cannot accidentally change the transcript location.
 */
export function parseTuiArgs(args: readonly string[]): TuiArgs {
  const parsedArgs = args[0] === "--" ? args.slice(1) : args;
  let directory: string | undefined;
  let threadId: string | undefined;
  let configPath: string | undefined;
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
    if (arg === "--config") {
      const value = parsedArgs[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--config requires a file path");
      }
      if (configPath !== undefined) {
        throw new Error("TUI accepts at most one --config option");
      }
      configPath = value;
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

  const parsed: TuiArgs = {
    ...(directory !== undefined ? { directory } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    ...(workspace !== undefined ? { workspace } : {}),
    ...(autoConsolidate ? { autoConsolidate: true } : {}),
    ...(todoistEnabled ? { todoistEnabled: true } : {}),
  };
  assertAssemblyCombination(parsed);
  return parsed;
}
