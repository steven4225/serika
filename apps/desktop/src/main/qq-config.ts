import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { QqBinding } from "./qq-store.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const within = (root: string, path: string) => { const part = relative(root, path); return !part || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
export interface QqConfig { endpoint: string; binding: QqBinding; stateDirectory: string; runtimeConfig: Record<string, unknown> }

/** A separate, external config. Only explicitly selected group file/Shell/web tools exist. */
export async function readQqConfig(path: string): Promise<QqConfig> {
  if (!isAbsolute(path)) throw new Error("QQ_CONFIG 必须是群工作区外的绝对路径。");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || info.mode & 0o022) throw new Error("QQ 配置必须是不可被其他用户修改的普通文件，最多 64 KiB。");
  const canonical = await realpath(path);
  const raw: unknown = JSON.parse(await readFile(canonical, "utf8"));
  if (!record(raw) || raw.version !== 1 || Object.keys(raw).some(key => !["version", "endpoint", "botId", "groupId", "ownerId", "workspace", "modules", "run", "contextCompaction"].includes(key)) ||
      typeof raw.endpoint !== "string" || typeof raw.workspace !== "string" || !isAbsolute(raw.workspace) ||
      ![raw.botId, raw.groupId, raw.ownerId].every(id => Number.isSafeInteger(id) && (id as number) > 0) || raw.botId === raw.ownerId ||
      raw.modules !== undefined && !record(raw.modules)) throw new Error("QQ 配置无效：请核对账号、群号、主人和独立群工作区。");
  const workspace = await realpath(raw.workspace);
  if (!(await lstat(workspace)).isDirectory() || within(workspace, canonical)) throw new Error("QQ 配置必须位于独立群工作区之外。");
  const modules = (raw.modules ?? {}) as Record<string, unknown>;
  if (Object.keys(modules).some(key => !["read-file", "shell", "web"].includes(key))) throw new Error("QQ 模式只支持显式启用文件、Shell、网页工具；不接入 Memory、checkpoint、任务、个人 Todoist、Computer 或 Skills。");
  const botId = raw.botId as number, groupId = raw.groupId as number, ownerId = raw.ownerId as number;
  const threadId = `qq-${createHash("sha256").update(JSON.stringify([botId, groupId, workspace])).digest("hex").slice(0, 24)}`;
  const stateDirectory = join(dirname(canonical), `.serika-qq-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`);
  if (within(workspace, stateDirectory)) throw new Error("QQ 状态目录必须位于群工作区之外。");
  return { endpoint: raw.endpoint, binding: { workspace, botId, groupId, ownerId, threadId }, stateDirectory,
    runtimeConfig: { version: 1, workspace, modules: { pomodoro: { enabled: false }, memory: { enabled: false }, checkpoint: { enabled: false }, task: { enabled: false }, todoist: { enabled: false }, computer: { enabled: false }, ...modules },
      ...(raw.run === undefined ? {} : { run: raw.run }), ...(raw.contextCompaction === undefined ? {} : { contextCompaction: raw.contextCompaction }) } };
}
