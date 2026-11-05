import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AppInfo, DirectoryAuthorization, DirectorySettingsInput } from "../shared/ui-contract.js";
import type { TelegramData, TelegramInbound } from "./telegram-store.js";
import type { TelegramKeyboard } from "./telegram-api.js";

export const TELEGRAM_DIRECTORY_AUTHORIZATION_USAGE = "新增或调整目录授权，请在空闲时发送完整指令：\n授权目录 只读 /绝对路径\n授权目录 读写 /绝对路径\n请填写已存在目录的实际绝对路径。宿主会先显示范围，点击确认卡后才保存；收到已保存并核对回执后，再按新权限继续。保存结果未知时请用 /directories 核对，不自动重试。/directories 查看当前目录。";
type Context = { data: Pick<TelegramData, "enabled" | "botId" | "owner" | "deliveries">;
  info: Pick<AppInfo, "threadId" | "projectDirectory" | "authorizedDirectories" | "runtimeRecovery" | "configPath">; idle: boolean };
type Permit = { code: string; binding: string; expires: number; chatId: number;
  directories: DirectoryAuthorization[]; expectedDirectories: DirectoryAuthorization[]; path: string; access: "read" | "readwrite" };
const accessLabel = (access: "read" | "readwrite") => access === "read" ? "只读" : "读写";
const directoryList = (directories: readonly DirectoryAuthorization[]) => directories.length
  ? directories.map(item => `${accessLabel(item.access)}：${item.path}`).join("\n") : "无";
function binding(context: Context): string | undefined {
  const { data, info } = context;
  if (!data.enabled || !data.owner || !data.botId || !context.idle || info.runtimeRecovery || !info.configPath) return;
  return JSON.stringify([data.botId, data.owner.userId, data.owner.chatId, data.owner.threadId,
    info.threadId, info.configPath, info.projectDirectory, info.authorizedDirectories]);
}

export class TelegramDirectoryAuthorization {
  #permit: Permit | undefined;
  constructor(readonly options: {
    current: () => Context; now: () => number;
    save: (input: DirectorySettingsInput) => Promise<void>;
    send: (key: string, chatId: number, text: string, keyboard?: TelegramKeyboard) => Promise<unknown>;
  }) {}

  clear() { this.#permit = undefined; }
  deliveryIsLive(key: string, chatId: number): boolean {
    const permit = this.#permit;
    return !!permit && permit.expires > this.options.now() && permit.binding === binding(this.options.current()) &&
      permit.chatId === chatId && key === `directory:${permit.code}`;
  }

  async handle(input: TelegramInbound): Promise<boolean> {
    const text = input.text;
    const decision = /^directory_(allow|deny) ([A-F0-9]{10})$/.exec(text);
    const command = /^授权目录\s+(只读|读写)\s+(.+)$/.exec(text);
    if (!decision && !command && text !== "/directories" && !/^(?:新增|增加)?授权目录/.test(text)) return false;
    const current = this.options.current(), owner = current.data.owner;
    if (!owner) return true;
    const reply = (body: string) => this.options.send(`input:${input.key}`, owner.chatId, body);
    if (decision) {
      const permit = this.#permit;
      if (!permit || permit.code !== decision[2] || !this.deliveryIsLive(`directory:${permit.code}`, owner.chatId)) {
        this.clear(); await reply("目录确认已过期、已处理或当前绑定与授权已变化；未再次保存，请重新发送完整授权指令。"); return true;
      }
      const card = current.data.deliveries.find(item => item.key === `directory:${permit.code}`);
      if (!input.callback || card?.state !== "submitted" || card.messageId !== input.callback.messageId) {
        await reply("请点击实际收到的目录确认卡；这条消息没有授权目录。"); return true;
      }
      this.clear();
      if (decision[1] === "deny") { await reply("已取消目录授权，未改动配置。"); return true; }
      try {
        const stat = await lstat(permit.path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(permit.path) !== permit.path ||
            binding(this.options.current()) !== permit.binding) throw new Error("changed");
      } catch { await reply("目录路径、当前绑定或授权已变化；未保存，请重新发送完整指令。"); return true; }
      try {
        await this.options.save({ directories: permit.directories, expectedDirectories: permit.expectedDirectories });
        const saved = this.options.current();
        if (binding({ ...saved, info: { ...saved.info, authorizedDirectories: permit.expectedDirectories } }) !== permit.binding ||
            JSON.stringify(saved.info.authorizedDirectories) !== JSON.stringify(permit.directories)) {
          await reply("目录保存后的状态尚未确认；不会自动重试。请发送 /directories 核对当前状态。"); return true;
        }
        await reply(`已保存并核对目录授权：${accessLabel(permit.access)} ${permit.path}\n当前授权目录：\n${directoryList(saved.info.authorizedDirectories)}`);
      } catch {
        await reply("目录保存未获确认；不会自动重试。请发送 /directories 核对当前状态，状态不可用时需先恢复连接。");
      }
      return true;
    }
    if (text === "/directories") {
      await reply(current.info.runtimeRecovery ? "运行时当前不可用，缓存配置不能证明当前权限；请先恢复连接。" :
        `当前授权目录：\n${directoryList(current.info.authorizedDirectories)}\n\n${TELEGRAM_DIRECTORY_AUTHORIZATION_USAGE}`); return true;
    }
    if (!command) { await reply(TELEGRAM_DIRECTORY_AUTHORIZATION_USAGE); return true; }
    const identity = binding(current);
    if (!identity) { await reply("请等待当前执行结束，并确保绑定与连接可用，再新增目录授权。"); return true; }
    const path = command[2]!;
    if (!isAbsolute(path) || path.includes("\0")) { await reply(`需要填写绝对路径，未保存。\n${TELEGRAM_DIRECTORY_AUTHORIZATION_USAGE}`); return true; }
    let canonical: string;
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) { await reply("请指定已存在的目录，不能使用文件或目录符号链接；未保存。"); return true; }
      canonical = await realpath(path);
    } catch { await reply("目录不存在或当前无法访问，未保存。"); return true; }
    if (identity !== binding(this.options.current())) { await reply("当前绑定或授权已变化，请重新发送指令；未保存。"); return true; }
    const access: DirectoryAuthorization["access"] = command[1] === "只读" ? "read" : "readwrite";
    const expectedDirectories = current.info.authorizedDirectories.map(item => ({ ...item }));
    const existing = expectedDirectories.find(item => item.path === canonical);
    if (existing?.access === access) { await reply(`当前已经授权：${accessLabel(access)} ${canonical}，未重复保存。`); return true; }
    const directories = expectedDirectories.map(item => item.path === canonical ? { path: canonical, access } : item);
    if (!existing) directories.push({ path: canonical, access });
    const permit: Permit = { code: randomBytes(5).toString("hex").toUpperCase(), binding: identity,
      expires: this.options.now() + 5 * 60_000, chatId: owner.chatId, directories, expectedDirectories, path: canonical, access };
    this.#permit = permit;
    await this.options.send(`directory:${permit.code}`, owner.chatId,
      `${existing ? "替换这一项目录权限" : "新增目录授权"}：${accessLabel(access)} ${canonical}\n${existing ? `原权限：${accessLabel(existing.access)}\n` : ""}此授权会持久保存，适用于共享这份目录配置的桌面和当前绑定 Telegram；不会修改其他项目。\n当前授权目录：\n${directoryList(expectedDirectories)}\n\n请在五分钟内点击确认；尚未保存。`,
      { inline_keyboard: [[{ text: "确认目录授权", callback_data: `directory_allow:${permit.code}` },
        { text: "取消", callback_data: `directory_deny:${permit.code}` }]] });
    return true;
  }
}
