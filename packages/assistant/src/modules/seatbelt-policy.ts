import { dirname, join } from "node:path";

// S0 approved installation. An upgrade requires a new native probe before widening reads.
export const SEATBELT_NODE = "/opt/homebrew/Cellar/node/26.4.0/bin/node";
export const SEATBELT_GIT = "/Library/Developer/CommandLineTools/usr/bin/git";
const runtimeRoots = [
  "/System/Library",
  "/usr/lib",
  "/Library/Developer/CommandLineTools/usr/lib",
  "/opt/homebrew/Cellar/node/26.4.0/bin",
  "/opt/homebrew/opt/node/bin",
  "/opt/homebrew/Cellar/node/26.4.0/lib",
  "/opt/homebrew/opt/node/lib",
  "/opt/homebrew/Cellar/llhttp/9.4.2/lib",
  "/opt/homebrew/opt/llhttp/lib",
  "/opt/homebrew/Cellar/libuv/1.52.1/lib",
  "/opt/homebrew/opt/libuv/lib",
  "/opt/homebrew/Cellar/ada-url/3.4.4/lib",
  "/opt/homebrew/opt/ada-url/lib",
  "/opt/homebrew/Cellar/simdjson/4.6.4/lib",
  "/opt/homebrew/opt/simdjson/lib",
  "/opt/homebrew/Cellar/brotli/1.2.0/lib",
  "/opt/homebrew/opt/brotli/lib",
  "/opt/homebrew/Cellar/c-ares/1.34.8/lib",
  "/opt/homebrew/opt/c-ares/lib",
  "/opt/homebrew/Cellar/hdrhistogram_c/0.11.10/lib",
  "/opt/homebrew/opt/hdrhistogram_c/lib",
  "/opt/homebrew/Cellar/merve/1.2.2_1/lib",
  "/opt/homebrew/opt/merve/lib",
  "/opt/homebrew/Cellar/nbytes/0.1.4/lib",
  "/opt/homebrew/opt/nbytes/lib",
  "/opt/homebrew/Cellar/libnghttp2/1.69.0/lib",
  "/opt/homebrew/opt/libnghttp2/lib",
  "/opt/homebrew/Cellar/libnghttp3/1.17.0/lib",
  "/opt/homebrew/opt/libnghttp3/lib",
  "/opt/homebrew/Cellar/libngtcp2/1.24.0/lib",
  "/opt/homebrew/opt/libngtcp2/lib",
  "/opt/homebrew/Cellar/sqlite/3.53.4/lib",
  "/opt/homebrew/opt/sqlite/lib",
  "/opt/homebrew/Cellar/libffi/3.6.0/lib",
  "/opt/homebrew/opt/libffi/lib",
  "/opt/homebrew/Cellar/uvwasi/0.0.23/lib",
  "/opt/homebrew/opt/uvwasi/lib",
  "/opt/homebrew/Cellar/zstd/1.5.7_1/lib",
  "/opt/homebrew/opt/zstd/lib",
  "/opt/homebrew/Cellar/openssl@3/3.6.5/lib",
  "/opt/homebrew/opt/openssl@3/lib",
  "/opt/homebrew/Cellar/icu4c@78/78.3/lib",
  "/opt/homebrew/opt/icu4c@78/lib",
  "/opt/homebrew/Cellar/simdutf/9.0.0/lib",
  "/opt/homebrew/opt/simdutf/lib",
  "/opt/homebrew/lib/node_modules/npm",
  "/opt/homebrew/Cellar/pnpm/11.9.0/libexec/lib/node_modules/pnpm"
];

export const SEATBELT_INSTRUCTIONS = "Desktop autonomous shell_exec uses macOS Seatbelt with network disabled. Only the authorized directory and a private temporary directory are writable. Runtime dependencies are read-only. Credentials, application data and external process control are denied. posix_spawn and process-group changes are refused to keep all descendants cancellable; programs requiring them fail. Commands needing network or unsupported operations require an explicitly selected host Run and per-call confirmation. Seatbelt failure never falls back to host. Shell is never remembered.";

const pathFilter = (kind: string, paths: readonly string[]) => paths.map(path => `(${kind} ${JSON.stringify(path)})`).join(" ");

export function seatbeltPolicy(options: { directory: string; temp: string; userHome: string; protectedPaths: readonly string[]; configPath?: string }): string {
  const { directory, temp, userHome } = options;
  const sensitiveRoots = [...options.protectedPaths, ...[".serika", ".ssh", ".aws", ".gnupg", "Library"].map(name => join(userHome, name))];
  const roots = [...runtimeRoots, directory, temp];
  const literals = ["/", "/bin/sh", SEATBELT_GIT, "/dev/null", "/dev/urandom", SEATBELT_NODE];
  const ancestors = new Set<string>(["/"]);
  for (const path of [...roots, ...literals]) for (let p = dirname(path); p !== "/"; p = dirname(p)) ancestors.add(p);
  const credentialNames = "(^|/)([.]env($|[.])|[.](ssh|aws|gnupg)(/|$)|[.](netrc|npmrc|pypirc|git-credentials)($|/)|[.]docker/config[.]json($|/))";
  const denied = `(require-any ${pathFilter("subpath", sensitiveRoots)} (regex #${JSON.stringify(credentialNames)})` +
    (options.configPath ? ` (regex (string-append "^" (regex-quote ${JSON.stringify(options.configPath)})))` : "") + ")";
  const protectedParents = new Set<string>();
  for (const root of [...runtimeRoots, ...sensitiveRoots, ...(options.configPath ? [options.configPath] : [])])
    for (let p = dirname(root); p !== "/"; p = dirname(p)) protectedParents.add(p);
  // Renaming an ancestor must not replace a protected runtime or trusted file.
  const writable = `(require-all (require-any ${pathFilter("subpath", [directory, temp])}) (require-not ${denied}) (require-not (require-any ${pathFilter("subpath", runtimeRoots)} ${pathFilter("literal", [...protectedParents])})))`;
  return `(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n` +
    `(deny process-info*)\n(allow signal (target self))\n` +
    `(allow sysctl-read (sysctl-name-regex #"^hw[.]") (sysctl-name-regex #"^vm[.]") (sysctl-name-regex #"^kern[.]os") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.hostname") (sysctl-name "kern.version"))\n` +
    `(deny syscall-unix (syscall-number SYS_setsid) (syscall-number SYS_setpgid) (syscall-number SYS_posix_spawn))\n` +
    `(allow file-read-metadata ${pathFilter("literal", [...ancestors])})\n` +
    `(allow file-read* (require-all (require-any ${pathFilter("subpath", roots)} ${pathFilter("literal", literals)}) (require-not ${denied})))\n` +
    `(allow file-write* ${writable} (literal "/dev/null"))\n`;
}
