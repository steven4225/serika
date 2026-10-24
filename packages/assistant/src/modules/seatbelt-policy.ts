import { protectedPathFilter } from "../protected-paths.js";
import type { DirectoryAuthorization } from "../directory-access.js";
import { dirname } from "node:path";

import { seatbeltSystemRoots, type SeatbeltRuntime } from "./seatbelt-runtime.js";

export const SEATBELT_INSTRUCTIONS = "Desktop autonomous shell_exec uses macOS Seatbelt with network disabled. Only authorized read/write directories and a private temporary directory are writable; the deepest directory declaration controls nested permissions. Runtime dependencies are read-only. Credential access, application data writes and external process control are denied. posix_spawn and process-group changes are refused to keep all descendants cancellable; programs requiring them fail. Commands needing network or unsupported operations require an explicitly selected host Run and per-call confirmation. Seatbelt failure never falls back to host. Shell is never remembered.";

const pathFilter = (kind: string, paths: readonly string[]) => paths.map(path => `(${kind} ${JSON.stringify(path)})`).join(" ");

export function seatbeltPolicy(options: { directories: readonly DirectoryAuthorization[]; temp: string; userHome: string; protectedPaths: readonly string[]; credentialPaths?: readonly string[]; runtime: SeatbeltRuntime; configPath?: string }): string {
  const { directories, temp } = options;
  const protection = { controlPaths: options.protectedPaths, credentialPaths: options.credentialPaths ?? [] };
  const runtimeRoots = [...seatbeltSystemRoots, ...options.runtime.libraryDirectories];
  const roots = [...runtimeRoots, ...directories.map(item => item.path), temp];
  const literals = ["/", options.runtime.git, "/dev/null", "/dev/urandom", options.runtime.node];
  const ancestors = new Set<string>(["/"]);
  for (const path of [...roots, ...literals]) for (let p = dirname(path); p !== "/"; p = dirname(p)) ancestors.add(p);
  const deniedRead = protectedPathFilter({ ...protection, write: false });
  const deniedWrite = protectedPathFilter({ ...protection, write: true });
  const protectedParents = new Set<string>();
  for (const root of [...runtimeRoots, options.runtime.node, options.runtime.git, ...protection.controlPaths, ...protection.credentialPaths, ...directories.map(item => item.path), ...(options.configPath ? [options.configPath] : [])])
    for (let p = dirname(root); p !== "/"; p = dirname(p)) protectedParents.add(p);
  // Renaming an ancestor must not replace a protected runtime or trusted file.
  const writableRoots = directories.filter(item => item.access === "readwrite").map(item => {
    const children = directories.filter(child => child.path !== item.path && child.path.startsWith(item.path + "/"));
    return `(require-all (subpath ${JSON.stringify(item.path)})${children.length ? ` (require-not (require-any ${pathFilter("subpath", children.map(child => child.path))}))` : ""})`;
  });
  const writable = `(require-all (require-any ${writableRoots.join(" ")} (subpath ${JSON.stringify(temp)})) (require-not ${deniedWrite}) (require-not (require-any ${pathFilter("subpath", runtimeRoots)} ${pathFilter("literal", [options.runtime.node, options.runtime.git, ...protectedParents])})))`;
  return `(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n` +
    `(deny file-link)\n` +
    `(deny process-info*)\n(allow signal (target self))\n` +
    `(allow sysctl-read (sysctl-name-regex #"^hw[.]") (sysctl-name-regex #"^vm[.]") (sysctl-name-regex #"^kern[.]os") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.hostname") (sysctl-name "kern.version"))\n` +
    `(deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid) (syscall-number SYS_posix_spawn) (syscall-number SYS_link) (syscall-number SYS_linkat))\n` +
    `(allow file-read-metadata ${pathFilter("literal", [...ancestors])})\n` +
    `(allow file-read* (require-all (require-any ${pathFilter("subpath", roots)} ${pathFilter("literal", literals)}) (require-not ${deniedRead})))\n` +
    `(allow file-write* ${writable} (literal "/dev/null"))\n`;
}
