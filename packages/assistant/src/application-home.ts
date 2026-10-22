import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertExperimentalDataPaths } from "./experimental-data.js";

function canonicalPath(path: string): string {
  try { return realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(canonicalPath(dirname(path)), path.slice(dirname(path).length + 1));
  }
}

export function resolveApplicationHome(options: {
  home?: string | undefined; env: NodeJS.ProcessEnv; cwd: string; userHome?: string | undefined;
}): string {
  const selected = options.home ?? options.env.SERIKA_HOME ?? join(options.userHome ?? homedir(), ".serika");
  if (!selected.trim()) throw new Error("Serika home must be a non-empty directory");
  const home = canonicalPath(resolve(options.cwd, selected));
  assertExperimentalDataPaths([home]);
  return home;
}
