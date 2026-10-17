import { checkAssistantStartup, type ReadinessSnapshot, type StartupAssembly } from "@serika/assistant";
import { parseTuiArgs } from "./cli-options.js";

/** `--check`: parse the `--tui` flags, then run the assistant's static preflight. */
export async function checkTuiStartup(
  rawArgs: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; now?: Date } = {},
): Promise<ReadinessSnapshot> {
  let assembly: StartupAssembly | Error;
  try {
    assembly = parseTuiArgs(rawArgs);
  } catch (error) {
    assembly = error instanceof Error ? error : new Error(String(error));
  }
  return checkAssistantStartup(assembly, options);
}
