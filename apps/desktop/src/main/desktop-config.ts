import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { contextBudgetForMode } from "@serika/assistant";
import { updateDesktopConfig } from "./module-settings.js";

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
  // Desktop has no memory review queue: legacy review configs that already
  // consolidate automatically are moved to the automatic write policy.
  const memory = isRecord(modules.memory) ? modules.memory : undefined;
  if (memory?.enabled === true && memory.autoConsolidate === true && memory.writePolicy !== "automatic") {
    modules.memory = { ...memory, writePolicy: "automatic" };
    patched = true;
  }
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
    modules.memory = { enabled: true, autoConsolidate: true, writePolicy: "automatic", queryRewrite: { enabled: true }, contextView: { enabled: true } };
    modules.checkpoint = { enabled: true };
    modules.task = { enabled: true };
  }
  return {
    version: 1,
    ...(workspace === undefined ? {} : { workspace }),
    modules,
    run: { totalTimeoutMs: DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS },
    contextCompaction: contextBudgetForMode("daily"),
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
  cwd?: string;
}): Promise<DesktopConfigResolution> {
  const explicit = options.env.RUNLOOM_CONFIG?.trim();
  if (explicit) {
    return { configPath: explicit, generated: false, patched: false };
  }

  const configPath = join(options.userData, "runloom.json");
  const workspace = options.env.RUNLOOM_WORKSPACE?.trim() || undefined;
  await mkdir(options.userData, { recursive: true });
  let generated = false, patched = false;
  try {
    await updateDesktopConfig(configPath, options.cwd ?? process.cwd(), async raw => {
      if (raw === undefined) {
        const dailyWorkspace = workspace ?? join(options.userData, "workspaces", "personal");
        await mkdir(dailyWorkspace, { recursive: true });
        generated = true;
        return `${JSON.stringify(defaultDesktopConfig(dailyWorkspace), null, 2)}\n`;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("Desktop config must be an object");
      const next = withDesktopTimeouts(parsed, workspace);
      patched = next.patched;
      return patched ? `${JSON.stringify(next.config, null, 2)}\n` : undefined;
    }, true);
  } catch (error) {
    throw new Error(`Cannot read or update desktop config ${configPath}; refusing to replace it`, { cause: error });
  }
  return { configPath, generated, patched };
}

/** Explicit setup opts into source-checked automatic writes. Legacy review configs are upgraded by withDesktopTimeouts. */
export async function enableDesktopMemory(configPath: string, cwd = process.cwd()): Promise<() => Promise<void>> {
  const result = await updateDesktopConfig(configPath, cwd, async before => {
    const config = JSON.parse(before!);
    if (!isRecord(config) || config.modules !== undefined && !isRecord(config.modules)) throw new Error("无法读取模块配置");
    const modules = isRecord(config.modules) ? config.modules : {};
    const memory = isRecord(modules.memory) ? modules.memory : {};
    const policyOnly = memory.enabled === true && memory.autoConsolidate === true && memory.writePolicy !== "automatic";
    const next = { ...config, modules: { ...modules, memory: { ...memory, enabled: true, autoConsolidate: true, writePolicy: "automatic", ...(!policyOnly ? { queryRewrite: { enabled: true } } : {}) } } };
    return `${JSON.stringify(next, null, 2)}\n`;
  });
  return result.rollback ?? (async () => {});
}
