import { realpathSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    if (lstatSync(absolute).isSymbolicLink()) return canonicalPath(resolve(dirname(absolute), readlinkSync(absolute)));
    return realpathSync(absolute);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent), absolute.slice(parent.length));
  }
}

/** Experimental writers must fail before creating profiles, locks or journals. */
export function assertExperimentalDataPaths(paths: readonly (string | undefined)[]): void {
  const dailyRoots = [".config", "Library/Application Support"].map(base => canonicalPath(join(homedir(), base, "@aisdk-agent/desktop")));
  for (const path of paths) {
    if (path === undefined) continue;
    const target = canonicalPath(path);
    if (dailyRoots.some(daily => target === daily || target.startsWith(daily + sep))) {
      throw new Error("实验版本拒绝写入日用数据目录；请使用新建的隔离 v6 测试数据目录");
    }
  }
}
