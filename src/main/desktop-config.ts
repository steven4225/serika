import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Desktop defaults sit above the 30s Shell / 120s Run floors so a >30s task can finish. */
export const DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
export const DESKTOP_DEFAULT_SHELL_TIMEOUT_MS = 300_000;

export interface DesktopConfigResolution {
  configPath: string;
  generated: boolean;
  patched: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fill missing timeout fields on a generated desktop config. Explicit values
 * already present are left alone. Does not enable Shell without a workspace.
 */
export function withDesktopTimeouts(
  config: Record<string, unknown>,
  workspace?: string,
): { config: Record<string, unknown>; patched: boolean } {
  let patched = false;
  const run = isRecord(config.run) ? { ...config.run } : {};
  if (typeof run.totalTimeoutMs !== "number") {
    run.totalTimeoutMs = DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS;
    patched = true;
  }
  const modules = isRecord(config.modules) ? { ...config.modules } : {};
  const previousShell = isRecord(modules.shell) ? modules.shell : {};
  const enabled = typeof previousShell.enabled === "boolean" ? previousShell.enabled : workspace !== undefined;
  const timeoutMs = typeof previousShell.timeoutMs === "number" ? previousShell.timeoutMs : DESKTOP_DEFAULT_SHELL_TIMEOUT_MS;
  if (typeof previousShell.timeoutMs !== "number" || typeof previousShell.enabled !== "boolean") patched = true;
  modules.shell = { ...previousShell, enabled, timeoutMs };
  return {
    config: {
      ...config,
      version: 1,
      ...(workspace !== undefined && typeof config.workspace !== "string" ? { workspace } : {}),
      run,
      modules,
    },
    patched,
  };
}

export function defaultDesktopConfig(workspace?: string): Record<string, unknown> {
  const modules: Record<string, unknown> = {
    pomodoro: { enabled: true },
    shell: {
      enabled: workspace !== undefined,
      timeoutMs: DESKTOP_DEFAULT_SHELL_TIMEOUT_MS,
    },
  };
  if (workspace !== undefined) {
    modules["read-file"] = { enabled: true };
    modules.memory = { enabled: true };
    modules.checkpoint = { enabled: true };
    modules.task = { enabled: true };
  }
  return {
    version: 1,
    ...(workspace === undefined ? {} : { workspace }),
    modules,
    run: { totalTimeoutMs: DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS },
  };
}

/**
 * Resolve the TUI config the desktop process passes to `createRuntimeApp`.
 *
 * `RUNLOOM_CONFIG` wins and is not rewritten. Otherwise a file in Electron
 * userData (outside any workspace) is created or patched so both timeout
 * budgets are present.
 */
export async function resolveDesktopConfig(options: {
  env: NodeJS.ProcessEnv;
  userData: string;
}): Promise<DesktopConfigResolution> {
  const explicit = options.env.RUNLOOM_CONFIG?.trim();
  if (explicit) {
    return { configPath: explicit, generated: false, patched: false };
  }

  const configPath = join(options.userData, "runloom.json");
  const workspace = options.env.RUNLOOM_WORKSPACE?.trim() || undefined;
  let parsed: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(configPath, "utf8");
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) parsed = value;
  } catch {
    parsed = undefined;
  }

  if (parsed === undefined) {
    await mkdir(options.userData, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(defaultDesktopConfig(workspace), null, 2)}\n`);
    return { configPath, generated: true, patched: false };
  }

  const next = withDesktopTimeouts(parsed, workspace);
  if (next.patched) {
    await writeFile(configPath, `${JSON.stringify(next.config, null, 2)}\n`);
  }
  return { configPath, generated: false, patched: next.patched };
}
