import { configuredProtectedPaths, isProtectedPath, scanProtectedPaths } from "./protected-paths.js";
import { realpathSync } from "node:fs";
import type { AssistantAssembly } from "./assembly.js";
import { resolveTuiModuleConfig, type ResolvedTuiModuleConfig } from "./tui-module-config.js";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export interface DirectoryAuthorization {
  path: string;
  access: "read" | "readwrite";
}

export type DirectoryAccessCode = "INVALID_PATH" | "PATH_OUTSIDE_WORKSPACE" |
  "DIRECTORY_SELECTION_REQUIRED" | "READ_ONLY_DIRECTORY" | "PROTECTED_PATH" |
  "SYMLINK_NOT_ALLOWED" | "HARDLINK_NOT_ALLOWED";

export type DirectoryAccessResult =
  | { ok: true; root: string; target: string; relativePath: string; access: DirectoryAuthorization["access"] }
  | { ok: false; code: DirectoryAccessCode; message: string; directories?: readonly string[] };

export interface DirectoryAccessRequest { path: string; directory?: string | undefined; write: boolean }

const within = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const deny = (code: DirectoryAccessCode, message: string): DirectoryAccessResult => ({ ok: false, code, message });
const fsCode = (error: unknown): unknown => typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

async function inspectPath(path: string): Promise<{ path: string; blocked?: "SYMLINK_NOT_ALLOWED" | "HARDLINK_NOT_ALLOWED" }> {
  const parts = resolve(path).split(sep).filter(Boolean);
  let current: string = sep;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try { stats = await lstat(current); }
    catch (error) {
      if (fsCode(error) === "ENOENT" || fsCode(error) === "ENOTDIR") return { path: resolve(current, ...parts.slice(index + 1)) };
      throw error;
    }
    if (stats.isSymbolicLink()) return { path, blocked: "SYMLINK_NOT_ALLOWED" };
    if (stats.isFile() && stats.nlink > 1) return { path, blocked: "HARDLINK_NOT_ALLOWED" };
    current = await realpath(current);
  }
  return { path: current };
}

/** Directory capability is checked after every tool approval and before filesystem access. */
export class DirectoryAccess {
  readonly options: {
    load: () => Promise<readonly DirectoryAuthorization[]>;
    protectedPaths: readonly string[];
    credentialPaths?: readonly string[];
  };
  constructor(options: DirectoryAccess["options"]) {
    const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
    this.options = { ...options, protectedPaths: options.protectedPaths.map(canonical), credentialPaths: (options.credentialPaths ?? []).map(canonical) };
  }

  async declarations(): Promise<readonly DirectoryAuthorization[]> {
    const declarations = await this.options.load();
    return Promise.all(declarations.map(async declaration => {
      if ((await lstat(declaration.path)).isSymbolicLink()) throw new Error("Authorized directory must not be a symlink");
      const inspected = await inspectPath(await realpath(declaration.path));
      if (inspected.blocked) throw new Error(`Authorized directory rejected: ${inspected.blocked}`);
      if (!(await lstat(inspected.path)).isDirectory()) throw new Error("Authorized path must be a directory");
      return { ...declaration, path: inspected.path };
    }));
  }

  async resolve(request: DirectoryAccessRequest): Promise<DirectoryAccessResult> {
    if (!request.path || request.path.includes("\0") || (!isAbsolute(request.path) && win32.isAbsolute(request.path))) {
      return deny("INVALID_PATH", "Path must be nonempty and contain no NUL");
    }
    const declarations = await this.declarations();
    let base: string | undefined;
    if (request.directory !== undefined) {
      if (!isAbsolute(request.directory)) return deny("INVALID_PATH", "Select an absolute authorized directory");
      const selectedDirectory = resolve(request.directory);
      base = declarations.some(item => within(item.path, selectedDirectory)) ? selectedDirectory : undefined;
      if (base === undefined) return deny("PATH_OUTSIDE_WORKSPACE", "Selected directory is not authorized");
    }
    if (!isAbsolute(request.path) && base === undefined) {
      if (declarations.length > 1) return { ok: false, code: "DIRECTORY_SELECTION_REQUIRED",
        message: "Choose an authorized directory for this relative path", directories: declarations.map(item => item.path) };
      base = declarations[0]?.path;
      if (base === undefined) return deny("PATH_OUTSIDE_WORKSPACE", "No directory is authorized");
    }
    const requested = isAbsolute(request.path) ? request.path : base === undefined ? undefined : resolve(base, request.path);
    if (requested === undefined) return deny("PATH_OUTSIDE_WORKSPACE", "No directory is authorized");
    if (!declarations.some(item => within(item.path, resolve(requested)))) return deny("PATH_OUTSIDE_WORKSPACE", "Path is outside authorized directories");
    const inspected = await inspectPath(requested);
    if (inspected.blocked) return deny(inspected.blocked, "Symbolic links and multiply linked files are not allowed");
    const target = inspected.path;
    const selected = declarations.filter(item => within(item.path, target)).sort((a, b) => b.path.length - a.path.length)[0];
    if (selected === undefined) return deny("PATH_OUTSIDE_WORKSPACE", "Path is outside authorized directories");
    const scanned = await scanProtectedPaths(declarations.map(item => item.path));
    if (isProtectedPath({ path: target, write: request.write, controlPaths: [...this.options.protectedPaths, ...scanned.controlPaths], credentialPaths: [...(this.options.credentialPaths ?? []), ...scanned.credentialPaths] })) {
      return deny("PROTECTED_PATH", "Protected credentials cannot be accessed and trusted controls cannot be modified");
    }
    if (request.write && selected.access === "read") return deny("READ_ONLY_DIRECTORY", "The deepest matching directory is read-only");
    return { ok: true, root: selected.path, target, relativePath: relative(selected.path, target), access: selected.access };
  }

  async allowsPath(request: DirectoryAccessRequest): Promise<boolean> {
    return (await this.resolve(request)).ok;
  }
}

export function configuredDirectoryAccess(options: {
  assembly: AssistantAssembly | undefined; config: ResolvedTuiModuleConfig | undefined; cwd: string;
  home?: string | undefined; env?: NodeJS.ProcessEnv; todoistTimeZone?: string | undefined;
}): DirectoryAccess {
  const { assembly, config, cwd } = options;
  return new DirectoryAccess({
    load: async () => config?.configPath
      ? (await resolveTuiModuleConfig(assembly!, { cwd, todoistTimeZone: options.todoistTimeZone })).authorizedDirectories
      : config?.authorizedDirectories ?? [],
    ...configuredProtectedPaths(options),
  });
}
