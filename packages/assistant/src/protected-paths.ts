import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AssistantAssembly } from "./assembly.js";
import type { ResolvedTuiModuleConfig } from "./tui-module-config.js";
import { dirname, join, resolve, sep } from "node:path";

export const serikaCodeRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))) + sep;

export interface ProtectedPaths {
  controlPaths: readonly string[];
  credentialPaths: readonly string[];
}

// The same expressions are consumed by JavaScript and the Seatbelt compiler.
export const protectedNames = {
  control: "(^|/)[.]git($|/(config($|[.]lock$|[.]worktree($|[.]lock$)|/)|worktrees/[^/]+/config[.]worktree($|[.]lock$)|hooks($|/)))|(^|/)Serika[.]command$",
  modulesControl: "(^|/)[.]git/modules/(.*/)?(config($|[.]lock$|[.]worktree($|[.]lock$))|hooks($|/))",
  gitMetadataDirectories: "(^|/)[.]git/(modules|worktrees)($|/)",
  credential: "(^|/)([.]env($|[.])|[.](ssh|aws|gnupg)(/|$)|[.](netrc|npmrc|pypirc|git-credentials)($|/)|[.]docker/config[.]json($|/))",
};

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function isProtectedPath(options: ProtectedPaths & { path: string; write: boolean }): boolean {
  const path = resolve(options.path);
  if (new RegExp(protectedNames.credential).test(path) || options.credentialPaths.some(root => within(root, path))) return true;
  return options.write && (new RegExp(protectedNames.control).test(path) ||
    new RegExp(protectedNames.modulesControl).test(path) ||
    [...options.controlPaths, ...options.credentialPaths].some(root => within(root, path) || within(path, root)));
}

export function protectedPathFilter(options: ProtectedPaths & { write: boolean }): string {
  const paths = options.write ? [...options.controlPaths, ...options.credentialPaths] : options.credentialPaths;
  const regex = (pattern: string) => `(regex #${JSON.stringify(pattern)})`;
  const controls = options.write ? `${regex(protectedNames.control)} ${regex(protectedNames.modulesControl)}` : "";
  return `(require-any ${paths.map(path => `(subpath ${JSON.stringify(path)})`).join(" ")} ${regex(protectedNames.credential)} ${controls})`;
}

export function configuredProtectedPaths(options: {
  assembly: AssistantAssembly | undefined; config: ResolvedTuiModuleConfig | undefined; cwd: string;
  home?: string | undefined; env?: NodeJS.ProcessEnv;
}): { protectedPaths: string[]; credentialPaths: string[] } {
  const { assembly, config, cwd } = options;
  return {
    credentialPaths: [
      ...(options.home ? [resolve(cwd, options.home, "env")] : []),
      ...(assembly?.dataDirectory ? [resolve(cwd, assembly.dataDirectory, "../env")] : []),
      ...["RUNLOOM_ENV_FILE", "RUNLOOM_HOST_ENV_FILE", "RUNLOOM_WORKER_ENV_FILE"].flatMap(key => options.env?.[key] ? [resolve(cwd, options.env[key]!)] : []),
    ],
    protectedPaths: [
      ...(config?.configPath ? [config.configPath, `${config.configPath}.lock`] : []),
      ...(options.home ? ["config.json", "config.json.lock"].map(path => resolve(cwd, options.home!, path)) : []),
      ...(options.env?.RUNLOOM_NOTIFICATION_HELPER ? [resolve(cwd, options.env.RUNLOOM_NOTIFICATION_HELPER)] : []),
      ...(assembly?.dataDirectory ? [resolve(cwd, assembly.dataDirectory)] : []),
      resolve(homedir(), ".config/serika"), resolve(homedir(), "Applications/Serika-releases"), resolve(homedir(), "Applications/Serika.command"),
      serikaCodeRoot,
      ...(config?.computer?.executable ? [config.computer.executable] : []),
      ...(config?.automation?.skills?.map(skill => resolve(cwd, skill.directory)) ?? []),
    ],
  };
}

const gitControlPaths = (gitDirectory: string): string[] => ["config", "config.lock", "config.worktree", "config.worktree.lock", "hooks"].map(name => join(gitDirectory, name));

/** Inspect only the target's ancestors and the Git controls they name. */
export async function gitControlsForTarget(target: string): Promise<string[]> {
  const { lstat, readFile, realpath } = await import("node:fs/promises");
  const missing = (error: unknown) => error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR"].includes(String(error.code));
  const canonical = async (path: string) => { try { return await realpath(path); } catch (error) { if (missing(error)) return path; throw error; } };
  for (let directory = resolve(target);; directory = dirname(directory)) {
    const markerPath = join(directory, ".git");
    let stats: Awaited<ReturnType<typeof lstat>> | undefined;
    try { stats = await lstat(markerPath); } catch (error) { if (!missing(error)) throw error; }
    let gitDirectory: string | undefined;
    let common: string | undefined;
    if (stats) {
      gitDirectory = markerPath;
      if (stats.isFile()) {
        const marker = /^gitdir: (.+)\r?\n?$/.exec(await readFile(markerPath, "utf8"));
        if (!marker?.[1]) return [markerPath];
        gitDirectory = resolve(directory, marker[1]);
      }
    } else {
      try {
        common = (await readFile(join(directory, "commondir"), "utf8")).trim();
        gitDirectory = directory;
      } catch (error) { if (!missing(error)) throw error; }
      if (!gitDirectory) {
        try {
          if ((await lstat(join(directory, "HEAD"))).isFile() && (await lstat(join(directory, "objects"))).isDirectory()) gitDirectory = directory;
        } catch (error) { if (!missing(error)) throw error; }
      }
    }
    if (gitDirectory) {
      const paths = gitControlPaths(gitDirectory);
      if (common === undefined) {
        try { common = (await readFile(join(gitDirectory, "commondir"), "utf8")).trim(); }
        catch (error) { if (!missing(error)) throw error; }
      }
      if (common !== undefined) paths.push(...gitControlPaths(resolve(gitDirectory, common)));
      return Promise.all(paths.map(canonical));
    }
    if (dirname(directory) === directory) return [];
  }
}
