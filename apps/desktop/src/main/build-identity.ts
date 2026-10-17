import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppBuildInfo, DesktopBuildManifest, SourceRevision } from "../shared/build-identity.js";

declare const __SERIKA_BUILD__: DesktopBuildManifest | undefined;

function sourceRevision(directory: string): SourceRevision {
  try {
    const options = { cwd: directory, encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
    const revision = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], options).trim().length > 0;
    return { revision, dirty };
  } catch { return { revision: null, dirty: null }; }
}

/** Hash project-owned runtime JS. Excludes sourcemaps, declarations and tests. */
export function fingerprintBackendDist(roots: readonly string[]): string | null {
  try {
    const hash = createHash("sha256");
    let files = 0;
    for (let index = 0; index < roots.length; index++) {
      const root = realpathSync(roots[index]!);
      const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) {
            const bytes = readFileSync(path);
            hash.update(`${index}:${relative(root, path)}:${bytes.length}:`);
            hash.update(bytes); files++;
          }
        }
      };
      walk(root);
    }
    return files === 0 ? null : hash.digest("hex");
  } catch { return null; }
}

function backendPaths(): { roots: string[]; directory: string } {
  const cliDist = dirname(fileURLToPath(import.meta.resolve("@serika/assistant")));
  return {
    directory: dirname(cliDist),
    roots: [cliDist, dirname(fileURLToPath(import.meta.resolve("@serika/core"))),
      join(dirname(cliDist), "node_modules", "@serika", "ai-sdk-adapter", "dist")],
  };
}

export function createBuildManifest(desktopDirectory: string, builtAt = new Date().toISOString()): DesktopBuildManifest {
  const backend = backendPaths();
  const frontendSource = sourceRevision(desktopDirectory);
  const backendSource = sourceRevision(backend.directory);
  const backendDistFingerprint = fingerprintBackendDist(backend.roots);
  const version = (JSON.parse(readFileSync(join(desktopDirectory, "package.json"), "utf8")) as { version: string }).version;
  const content = { schemaVersion: 1 as const, version, builtAt, frontendSource, backendSource, backendDistFingerprint };
  return { ...content, id: createHash("sha256").update(JSON.stringify(content)).digest("hex").slice(0, 16) };
}

function isBuildManifest(value: unknown): value is DesktopBuildManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const source = (s: unknown): boolean => !!s && typeof s === "object" &&
    (typeof (s as SourceRevision).revision === "string" || (s as SourceRevision).revision === null) &&
    (typeof (s as SourceRevision).dirty === "boolean" || (s as SourceRevision).dirty === null);
  return v.schemaVersion === 1 && typeof v.id === "string" && /^[a-f0-9]{16}$/.test(v.id) &&
    typeof v.version === "string" && typeof v.builtAt === "string" && source(v.frontendSource) && source(v.backendSource) &&
    (v.backendDistFingerprint === null || typeof v.backendDistFingerprint === "string" && /^[a-f0-9]{64}$/.test(v.backendDistFingerprint));
}

/** Capture once at startup, not when a Controller is replaced for module settings. */
export function createLoadedBuildReader(loaded: DesktopBuildManifest | null, backendDistAtStartup: string | null, manifestPath: string): () => AppBuildInfo {
  return () => {
    let disk: DesktopBuildManifest | null = null;
    try { const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8")); if (isBuildManifest(value)) disk = value; } catch { /* Diagnostic failure is not runtime failure. */ }
    return {
      loaded,
      backendDistAtStartup,
      backendMatchesBuild: loaded?.backendDistFingerprint && backendDistAtStartup ? loaded.backendDistFingerprint === backendDistAtStartup : null,
      diskBuild: loaded && disk ? disk.id === loaded.id ? "same" : "different" : "unavailable",
      diskBuildId: disk?.id ?? null,
    };
  };
}

const loaded = typeof __SERIKA_BUILD__ === "undefined" ? null : __SERIKA_BUILD__ ?? null;
let startupFingerprint: string | null = null;
if (loaded) { try { startupFingerprint = fingerprintBackendDist(backendPaths().roots); } catch { /* Report unavailable. */ } }
export const readLoadedBuild = createLoadedBuildReader(loaded, startupFingerprint, fileURLToPath(new URL("./build-identity.json", import.meta.url)));
