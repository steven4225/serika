import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFlock } from "@aisdk-agent/example-cli/dist/flock.js";
import { BUILTIN_MODULE_IDS, resolveTuiModuleConfig, type BuiltinModuleId } from "@aisdk-agent/example-cli/dist/tui-module-config.js";

export interface ModuleSettingInput { id: BuiltinModuleId; enabled: boolean; expectedEnabled: boolean }
export interface DreamingSettingInput { enabled: boolean; expectedEnabled: boolean }

async function readConfig(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("配置必须是常规文件，且不超过 64 KiB");
    return { text: await file.readFile("utf8"), mode: stat.mode & 0o777 };
  } finally { await file.close(); }
}

async function locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const file = await open(lockPath, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await file.stat()).isFile()) throw new Error("配置锁必须是常规文件");
  } finally { await file.close(); }
  const lock = await acquireFlock(lockPath);
  let result: T;
  try { result = await operation(); }
  catch (error) { await lock.release().catch(() => {}); throw error; }
  try { await lock.release(); }
  catch (error) { throw new ConfigCommitUncertainError(error); }
  return result;
}

export class ConfigCommitUncertainError extends Error {
  constructor(cause: unknown) { super("配置保存结果未确认，已暂停新执行。请重新连接并核对实际模块开关；不会自动重做任务。", { cause }); }
}

async function replace(path: string, expected: string | undefined, content: string, mode: number, cwd: string, validate: boolean) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
    try { await file.writeFile(content, "utf8"); await file.chmod(mode); await file.sync(); } finally { await file.close(); }
    if (validate) await resolveTuiModuleConfig({ configPath: temporary }, { cwd });
    let current: string | undefined;
    try { current = (await readConfig(path)).text; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current !== expected) throw new Error("配置已被其他程序修改，未覆盖，请重新加载");
    // Advisory flock serializes cooperating writers. An editor ignoring it can
    // still race between this comparison and rename; this is not a filesystem CAS.
    await rename(temporary, path); renamed = true;
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (renamed) throw new ConfigCommitUncertainError(error);
    throw error;
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Shared by every desktop config writer; caller supplies only a trusted host path. */
export async function updateDesktopConfig(configPath: string, cwd: string, mutate: (text: string | undefined, path: string) => Promise<string | undefined>, allowCreate = false): Promise<{ changed: boolean; rollback?: () => Promise<void> }> {
  try {
    const stat = await lstat(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("配置必须是常规文件，且不超过 64 KiB");
  } catch (error) { if (!allowCreate || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Aliased parent directories must use the same advisory lock.
  const path = join(await realpath(dirname(configPath)), basename(configPath));
  return locked(path, async () => {
    let before: Awaited<ReturnType<typeof readConfig>> | undefined;
    try { before = await readConfig(path); }
    catch (error) { if (!allowCreate || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const next = await mutate(before?.text, path);
    if (next === undefined || next === before?.text) return { changed: false };
    if (Buffer.byteLength(next) > 64 * 1024) throw new Error("修改后的配置超过 64 KiB");
    await replace(path, before?.text, next, before?.mode ?? 0o600, cwd, true);
    const previous = before;
    return { changed: true, ...(previous ? { rollback: () => locked(path, () => replace(path, next, previous.text, previous.mode, cwd, false)) } : {}) };
  });
}

async function changeConfig(configPath: string, cwd: string, mutate: (text: string, path: string) => Promise<string>): Promise<() => Promise<void>> {
  const result = await updateDesktopConfig(configPath, cwd, (before, path) => mutate(before!, path));
  return result.rollback ?? (async () => {});
}

/** Only the host-resolved external config is writable; renderer paths/authority are rejected. */
export async function changeDreamingSetting(configPath: string, input: DreamingSettingInput, cwd: string): Promise<() => Promise<void>> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["enabled", "expectedEnabled"].includes(key)) || typeof input.enabled !== "boolean" || typeof input.expectedEnabled !== "boolean") throw new Error("经验学习开关参数无效");
  return changeConfig(configPath, cwd, async (before, path) => {
    const config = JSON.parse(before);
    await resolveTuiModuleConfig({ configPath: path }, { cwd });
    const enabled = config.automation?.dreaming?.enabled === true;
    if (enabled !== input.expectedEnabled) throw new Error("经验学习配置已变化，请重新加载后再操作");
    return JSON.stringify({ ...config, automation: { ...config.automation, dreaming: { ...config.automation?.dreaming, enabled: input.enabled } } }, null, 2) + "\n";
  });
}

/** Enables built-ins using their defaults; never invents credentials or app-control permissions. */
export async function changeModuleSetting(configPath: string, input: ModuleSettingInput, cwd: string): Promise<() => Promise<void>> {
  if (!input || !BUILTIN_MODULE_IDS.includes(input.id) || typeof input.enabled !== "boolean" || typeof input.expectedEnabled !== "boolean") throw new Error("模块开关参数无效");
  return changeConfig(configPath, cwd, async (before, path) => {
    const current = await resolveTuiModuleConfig({ configPath: path }, { cwd });
    if (current.enabled[input.id] !== input.expectedEnabled) throw new Error("模块配置已变化，请重新加载后再操作");
    const config = JSON.parse(before);
    const saved = config.modules?.[input.id];
    if (saved === undefined && input.id === "computer") throw new Error("本机应用控制需要先配置驱动路径和允许控制的应用");
    const declaration = saved ?? { enabled: false };
    if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) throw new Error("模块配置无效");
    return JSON.stringify({ ...config, modules: { ...config.modules, [input.id]: { ...declaration, enabled: input.enabled } } }, null, 2) + "\n";
  });
}
