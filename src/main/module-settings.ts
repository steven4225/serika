import { lstat, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { BUILTIN_MODULE_IDS, resolveTuiModuleConfig, type BuiltinModuleId } from "@aisdk-agent/example-cli/dist/tui-module-config.js";

export interface ModuleSettingInput { id: BuiltinModuleId; enabled: boolean; expectedEnabled: boolean }
export interface DreamingSettingInput { enabled: boolean; expectedEnabled: boolean }

/** Only the host-resolved external config is writable; renderer paths/authority are rejected. */
export async function changeDreamingSetting(configPath: string, input: DreamingSettingInput, cwd: string): Promise<() => Promise<void>> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["enabled", "expectedEnabled"].includes(key)) || typeof input.enabled !== "boolean" || typeof input.expectedEnabled !== "boolean") throw new Error("经验学习开关参数无效");
  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("配置必须是常规文件，且不超过 64 KiB");
  const before = await readFile(configPath, "utf8");
  const config = JSON.parse(before);
  await resolveTuiModuleConfig({ configPath }, { cwd });
  const enabled = config.automation?.dreaming?.enabled === true;
  if (enabled !== input.expectedEnabled) throw new Error("经验学习配置已变化，请重新加载后再操作");
  const next = JSON.stringify({ ...config, automation: { ...config.automation, dreaming: { ...config.automation?.dreaming, enabled: input.enabled } } }, null, 2) + "\n";
  if (Buffer.byteLength(next) > 64 * 1024) throw new Error("修改后的配置超过 64 KiB");
  const replace = async (expected: string, content: string, validate: boolean) => {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode: stat.mode & 0o777 });
      if (validate) await resolveTuiModuleConfig({ configPath: temporary }, { cwd });
      if (await readFile(configPath, "utf8") !== expected) throw new Error("配置已被其他程序修改，未覆盖，请重新加载");
      await rename(temporary, configPath);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  };
  await replace(before, next, true);
  return () => replace(next, before, false);
}

/** Enables built-ins using their defaults; never invents credentials or app-control permissions. */
export async function changeModuleSetting(configPath: string, input: ModuleSettingInput, cwd: string): Promise<() => Promise<void>> {
  if (!input || !BUILTIN_MODULE_IDS.includes(input.id) || typeof input.enabled !== "boolean" || typeof input.expectedEnabled !== "boolean") throw new Error("模块开关参数无效");
  const stat = await lstat(configPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error("配置必须是常规文件，且不超过 64 KiB");
  const before = await readFile(configPath, "utf8");
  const current = await resolveTuiModuleConfig({ configPath }, { cwd });
  if (current.enabled[input.id] !== input.expectedEnabled) throw new Error("模块配置已变化，请重新加载后再操作");
  const config = JSON.parse(before);
  const saved = config.modules?.[input.id];
  if (saved === undefined && input.id === "computer") throw new Error("本机应用控制需要先配置驱动路径和允许控制的应用");
  const declaration = saved ?? { enabled: false };
  if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) throw new Error("模块配置无效");
  const next = JSON.stringify({ ...config, modules: { ...config.modules, [input.id]: { ...declaration, enabled: input.enabled } } }, null, 2) + "\n";
  if (Buffer.byteLength(next) > 64 * 1024) throw new Error("修改后的配置超过 64 KiB");
  const replace = async (expected: string, content: string, validate: boolean) => {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode: stat.mode & 0o777 });
      if (validate) await resolveTuiModuleConfig({ configPath: temporary }, { cwd });
      if (await readFile(configPath, "utf8") !== expected) throw new Error("配置已被其他程序修改，未覆盖，请重新加载");
      await rename(temporary, configPath);
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  };
  await replace(before, next, true);
  return () => replace(next, before, false);
}
