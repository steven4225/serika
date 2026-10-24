import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { ChannelAccount } from "../shared/channels.js";

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const envName = (value: unknown) => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value);
export async function readChannelsConfig(env: NodeJS.ProcessEnv, workspace: string): Promise<ChannelAccount[]> {
  const path = env.CHANNELS_CONFIG?.trim();
  if (!path) return [{ platform: "telegram", id: "default", name: "Telegram", tokenEnv: "TELEGRAM_BOT_TOKEN", proxyEnv: "TELEGRAM_PROXY_URL" },
    ...(env.QQ_CONFIG?.trim() ? [{ platform: "qq" as const, id: "qq-default", name: "QQ", configPath: env.QQ_CONFIG.trim() }] : [])];
  if (!isAbsolute(path)) throw new Error("CHANNELS_CONFIG 必须是工作区外的绝对路径");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid() || stat.size > 64 * 1024) throw new Error("通道配置必须是当前用户私有的普通文件（最多 64 KiB）");
  const part = relative(await realpath(workspace), await realpath(path));
  if (!part || part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part)) throw new Error("通道配置必须位于工作区外");
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!record(raw) || raw.version !== 1 || Object.keys(raw).some(key => !["version", "accounts"].includes(key)) || !Array.isArray(raw.accounts) || raw.accounts.length > 16) throw new Error("通道配置版本或账号数量无效");
  const ids = new Set<string>(), credentials = new Set<string>();
  return raw.accounts.map((value: unknown): ChannelAccount => {
    if (!record(value) || typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(value.id) || ids.has(value.id) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 100) throw new Error("通道账号 ID/名称无效或重复");
    ids.add(value.id);
    if (value.platform === "telegram" && Object.keys(value).every(key => ["platform", "id", "name", "tokenEnv", "proxyEnv"].includes(key)) && envName(value.tokenEnv) && (value.proxyEnv === undefined || envName(value.proxyEnv))) {
      const credential = env[value.tokenEnv as string]?.trim();
      if (credential && credentials.has(credential)) throw new Error("同一 Telegram Bot 不能配置两个 poller");
      if (credential) credentials.add(credential);
      return value as unknown as ChannelAccount;
    }
    if (value.platform === "qq" && Object.keys(value).every(key => ["platform", "id", "name", "configPath"].includes(key)) && typeof value.configPath === "string" && isAbsolute(value.configPath)) return value as unknown as ChannelAccount;
    throw new Error("通道配置字段无效；只接受凭据环境变量引用和 QQ 外部配置引用");
  });
}
