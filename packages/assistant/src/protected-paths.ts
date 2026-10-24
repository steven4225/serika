import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AssistantAssembly } from "./assembly.js";
import type { ResolvedTuiModuleConfig } from "./tui-module-config.js";
import { join, resolve, sep } from "node:path";

export const serikaCodeRoot = fileURLToPath(new URL("../../..", import.meta.url));

export interface ProtectedPaths {
  controlPaths: readonly string[];
  credentialPaths: readonly string[];
}

// The same expressions are consumed by JavaScript and the Seatbelt compiler.
export const protectedNames = {
  control: "(^|/)[.]git($|/(config($|[.]lock$|/)|hooks($|/)))|(^|/)Serika[.]command$",
  credential: "(^|/)([.]env($|[.])|[.](ssh|aws|gnupg)(/|$)|[.](netrc|npmrc|pypirc|git-credentials)($|/)|[.]docker/config[.]json($|/))",
};

const within = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function isProtectedPath(options: ProtectedPaths & { path: string; write: boolean }): boolean {
  const path = resolve(options.path);
  if (new RegExp(protectedNames.credential).test(path) || options.credentialPaths.some(root => within(root, path))) return true;
  return options.write && (new RegExp(protectedNames.control).test(path) ||
    [...options.controlPaths, ...options.credentialPaths].some(root => within(root, path) || within(path, root)));
}

export function protectedPathFilter(options: ProtectedPaths & { write: boolean }): string {
  const paths = options.write ? [...options.controlPaths, ...options.credentialPaths] : options.credentialPaths;
  const patterns = options.write ? Object.values(protectedNames) : [protectedNames.credential];
  return `(require-any ${paths.map(path => `(subpath ${JSON.stringify(path)})`).join(" ")} ${patterns.map(pattern => `(regex #${JSON.stringify(pattern)})`).join(" ")})`;
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

export const gitControlPaths = (gitDirectory: string): string[] => ["config", "config.lock", "hooks"].map(name => join(gitDirectory, name));

export async function scanProtectedPaths(roots: readonly string[]): Promise<ProtectedPaths> {
  const { lstat, readdir, realpath } = await import("node:fs/promises");
  const controlPaths: string[] = [], credentialPaths: string[] = [];
  const canonical = async (path: string) => { try { return await realpath(path); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return path; throw error; } };
  async function visit(path: string): Promise<void> {
    const stats = await lstat(path);
    if (isProtectedPath({ path, write: false, controlPaths: [], credentialPaths: [] })) credentialPaths.push(await canonical(path));
    else if (path.endsWith("/.git")) {
      for (const control of gitControlPaths(path)) controlPaths.push(await canonical(control));
    } else if (new RegExp(protectedNames.control).test(path)) controlPaths.push(await canonical(path));
    if (stats.isSymbolicLink()) return;
    if (stats.isFile() && stats.nlink > 1) credentialPaths.push(path);
    if (stats.isDirectory()) for (const name of await readdir(path)) await visit(join(path, name));
  }
  for (const root of roots) await visit(root);
  return { controlPaths, credentialPaths };
}
