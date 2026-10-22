import { mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertExperimentalDataPaths } from "@serika/assistant";
import type { TuiArgs } from "./cli-options.js";

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalPath(dirname(path)), path.slice(dirname(path).length + 1));
  }
}

export async function resolveCliHome(args: TuiArgs, options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  initialize: boolean;
  userHome?: string;
}): Promise<TuiArgs> {
  const selected = args.home ?? options.env.SERIKA_HOME ?? join(options.userHome ?? homedir(), ".serika");
  if (!selected.trim()) throw new Error("Serika home must be a non-empty directory");
  const home = await canonicalPath(resolve(options.cwd, selected));
  const { home: _home, ...assembly } = args;
  const directory = args.directory === undefined ? join(home, "transcripts") : resolve(options.cwd, args.directory);
  const configPath = args.configPath === undefined ? join(home, "config.json") : resolve(options.cwd, args.configPath);
  assertExperimentalDataPaths([home, directory, configPath]);
  if (options.initialize) await mkdir(home, { recursive: true, mode: 0o700 });
  const configured = args.configPath !== undefined;
  const shorthand = args.workspace !== undefined || args.autoConsolidate || args.todoistEnabled;
  const resolved = { ...assembly, directory, dataDirectory: join(home, "data") };
  if (shorthand) return resolved;
  if (!configured && options.initialize) {
    let file;
    try { file = await open(configPath, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (file) {
      try {
        await file.writeFile(JSON.stringify({ version: 1, modules: {
          pomodoro: { enabled: true }, memory: { enabled: true, autoConsolidate: false }, task: { enabled: true },
        } }, null, 2) + "\n");
        await file.sync();
      } finally { await file.close(); }
      const folder = await open(home, "r");
      try { await folder.sync(); } finally { await folder.close(); }
    }
  }
  if (!configured && !options.initialize) {
    try { await stat(configPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved; throw error; }
  }
  return { ...resolved, configPath };
}
