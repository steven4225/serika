import { isProtectedPath } from "../protected-paths.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";

export interface SeatbeltRuntime {
  node: string;
  git: string;
  libraryDirectories: readonly string[];
}

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
export const seatbeltSystemRoots = ["/bin", "/usr/bin", "/usr/sbin", "/System/Library", "/usr/lib"];

export function seatbeltEnvironment(options: { temp: string; runtime: Pick<SeatbeltRuntime, "node" | "git"> }): NodeJS.ProcessEnv {
  return { HOME: options.temp, TMPDIR: options.temp, PATH: [...new Set([dirname(options.runtime.node), dirname(options.runtime.git), "/usr/bin", "/bin", "/usr/sbin"])].join(":"),
    LANG: "C", LC_ALL: "C", TZ: "UTC", OPENSSL_CONF: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

const execute = promisify(execFile);
async function probe(options: { binary: string; temp: string }): Promise<{ loadedImages: string[]; linkedLibraries: string[] }> {
  const env = seatbeltEnvironment({ temp: options.temp, runtime: { node: options.binary, git: options.binary } });
  const { stderr } = await execute("/bin/sh", ["-c", 'exec /usr/bin/env DYLD_PRINT_LIBRARIES=1 "$1" --version', "--home", options.binary, "--home", options.temp], {
    cwd: options.temp, env, timeout: 30_000,
  });
  const loadedImages = stderr.split("\n").flatMap(line => {
    const match = /^dyld\[\d+\]: <[A-Fa-f0-9-]+> (\/.*)$/.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  const files = loadedImages.filter(path => !seatbeltSystemRoots.some(root => within(root, path)));
  const { stdout } = await execute("/bin/sh", ["-c", 'shift; exec /usr/bin/otool -L "$@"', "--home", options.temp, ...files], { cwd: options.temp, env, timeout: 30_000 });
  const linkedLibraries = stdout.split("\n").flatMap(line => {
    const match = /^\s+(\/.*) \(compatibility version /.exec(line);
    return match?.[1] ? [match[1]] : [];
  });
  return { loadedImages, linkedLibraries };
}

export async function resolveSeatbeltRuntime(options: {
  home: string; protectedPaths: readonly string[]; configPath?: string; searchPath?: string; nodeExecutable?: string;
  probe?: typeof probe;
}): Promise<SeatbeltRuntime> {
  const forbidden = [...options.protectedPaths, options.home, ...[".serika", "Library"].map(name => join(userInfo().homedir, name))];
  const check = (path: string, directory = false) => {
    if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0") ||
      forbidden.some(root => within(root, path) || directory && within(path, root)) ||
      options.configPath && (path.startsWith(options.configPath) || directory && within(path, options.configPath)) ||
      isProtectedPath({ path, write: true, controlPaths: options.protectedPaths, credentialPaths: [] }))
      throw new Error("Protected Seatbelt runtime path");
  };
  const canonical = async (path: string) => { check(path); const result = await realpath(path); check(result); return result; };
  const find = async (name: string) => {
    for (const directory of (options.searchPath ?? process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin").split(":")) {
      if (!isAbsolute(directory)) continue;
      const candidate = join(directory, name);
      try { await access(candidate, constants.X_OK); } catch (error) {
        if (error instanceof Error && "code" in error && ["ENOENT", "EACCES"].includes(String(error.code))) continue;
        throw error;
      }
      return canonical(candidate);
    }
    throw new Error("Seatbelt runtime missing");
  };
  const node = options.nodeExecutable ? await canonical(options.nodeExecutable) : await find("node");
  await access(node, constants.X_OK);
  let git = await find("git");
  const temp = await mkdtemp(join(await realpath(tmpdir()), "serika-runtime-"));
  try {
    if (git === "/usr/bin/git") {
      const result = await execute("/bin/sh", ["-c", "exec /usr/bin/xcrun --find git", "--home", temp], {
        cwd: temp, env: seatbeltEnvironment({ temp, runtime: { node, git } }),
      });
      git = await canonical(result.stdout.trim());
    }
    const libraries = new Set<string>();
    for (const binary of [node, git]) {
      const { loadedImages: images, linkedLibraries } = await (options.probe ?? probe)({ binary, temp });
      if (!images.includes(binary) || images.length < 2) throw new Error("Seatbelt runtime load discovery failed");
      const loaded = new Set<string>();
      for (const image of images) {
        check(image);
        if (image === binary || seatbeltSystemRoots.some(root => within(root, image))) continue;
        const path = await canonical(image); loaded.add(path);
        const directory = dirname(path); check(directory, true);
        libraries.add(directory);
      }
      // dyld opens install-name aliases before their canonical Cellar paths.
      for (const path of new Set(linkedLibraries)) {
        check(path);
        if (seatbeltSystemRoots.some(root => within(root, path))) continue;
        if (!loaded.has(await canonical(path))) continue;
        const directory = dirname(path); check(directory, true); libraries.add(directory);
      }
    }
    return { node, git, libraryDirectories: [...libraries].sort() };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
