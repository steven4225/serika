import { constants } from "node:fs";
import { access, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { computerConfigSchema, discoverComputerApps } from "@aisdk-agent/example-cli/dist/modules/computer-module.js";
import { updateDesktopConfig } from "./module-settings.js";
import type { ComputerConnectionInput, ComputerConnectionView, ComputerConnectionCheck } from "../shared/ui-contract.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Host-bound drafts and historical checks; no driver calls on view, selection or startup. */
export class ComputerConnection {
  #draft: { token: string; executable: string; before: string; expires: number; apps?: string[] } | undefined;
  #statusPath: string;
  constructor(private options: { configPath: string; workspaceRoot: string | null; userData: string; cwd: string; env: NodeJS.ProcessEnv }) {
    this.#statusPath = join(options.userData, `computer-check-${digest(options.configPath + "\n" + options.workspaceRoot)}.json`);
  }
  async #snapshot() {
    const file = await open(this.options.configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 64 * 1024) throw new Error("电脑控制配置无法读取");
      text = await file.readFile("utf8");
    } finally { await file.close(); }
    const config = JSON.parse(text);
    const computer = computerConfigSchema.parse(config.modules?.computer ?? { enabled: false });
    return { text, computer, fingerprint: digest(JSON.stringify(computer)) };
  }
  async view(): Promise<ComputerConnectionView> {
    const current = await this.#snapshot();
    let lastCheck: ComputerConnectionCheck | null = null;
    try {
      const file = await open(this.#statusPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 4096) throw new Error("连接检查记录无效，请重新检查");
        const record = JSON.parse(await file.readFile("utf8"));
        if (record.fingerprint === current.fingerprint) {
          if (typeof record.checkedAt !== "string" || !Number.isFinite(Date.parse(record.checkedAt)) || typeof record.ok !== "boolean" ||
              (record.errorCode !== undefined && (typeof record.errorCode !== "string" || !/^[A-Z_]{1,80}$/.test(record.errorCode)))) throw new Error("连接检查记录无效，请重新检查");
          lastCheck = { checkedAt: record.checkedAt, ok: record.ok, ...(record.errorCode ? { errorCode: record.errorCode } : {}) };
        }
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { executable: current.computer.executable ?? null, allowedBundleIds: current.computer.allowedBundleIds ?? [], enabled: current.computer.enabled, lastCheck };
  }
  async select(path: string) {
    this.#draft = undefined;
    if (!isAbsolute(path)) throw new Error("请选择已安装驱动的绝对路径");
    const executable = await realpath(path);
    if (this.options.workspaceRoot !== null) {
      const workspace = await realpath(this.options.workspaceRoot);
      const child = relative(workspace, executable);
      if (!child || (!child.startsWith("../") && !isAbsolute(child))) throw new Error("驱动必须安装在工作区外");
    }
    if (!(await stat(executable)).isFile()) throw new Error("驱动必须是可执行文件");
    await access(executable, constants.X_OK);
    const { text } = await this.#snapshot();
    this.#draft = { token: randomUUID(), executable, before: text, expires: Date.now() + 15 * 60_000 };
    return { token: this.#draft.token, executable };
  }
  #selection(token: string) {
    if (!this.#draft || token !== this.#draft.token || Date.now() > this.#draft.expires) throw new Error("驱动选择已失效，请重新选择");
    return this.#draft;
  }
  async discover(token: string) {
    const draft = this.#selection(token);
    delete draft.apps;
    if ((await this.#snapshot()).text !== draft.before) throw new Error("配置已变化，请重新选择驱动");
    const result = await discoverComputerApps(draft.executable, this.options.env);
    if (!result.ok) throw new Error(`无法读取运行中的应用（${result.error.code}）；请检查驱动连接。`);
    if (result.apps.length > 256) throw new Error("运行应用列表过大，请关闭部分应用后重新查找");
    draft.apps = result.apps;
    return result.apps;
  }
  async save(input: ComputerConnectionInput) {
    if (!input || Object.keys(input).some(key => !["token", "allowedBundleIds"].includes(key)) || !Array.isArray(input.allowedBundleIds)) throw new Error("应用选择无效");
    const draft = this.#selection(input.token);
    const computer = computerConfigSchema.parse({ enabled: true, executable: draft.executable, allowedBundleIds: input.allowedBundleIds });
    if (!draft.apps || new Set(input.allowedBundleIds).size !== input.allowedBundleIds.length || input.allowedBundleIds.some(id => !draft.apps!.includes(id))) throw new Error("请选择本次查找到的应用，最多 16 个");
    const result = await updateDesktopConfig(this.options.configPath, this.options.cwd, async before => {
      if (before !== draft.before) throw new Error("配置已变化，未覆盖；请重新选择驱动");
      const config = JSON.parse(before);
      return JSON.stringify({ ...config, modules: { ...config.modules, computer } }, null, 2) + "\n";
    });
    this.#draft = undefined;
    return result.rollback;
  }
  async check(): Promise<ComputerConnectionView> {
    const before = await this.#snapshot();
    if (!before.computer.enabled || !before.computer.executable) throw new Error("请先保存并开启电脑控制");
    const result = await discoverComputerApps(before.computer.executable, this.options.env);
    if ((await this.#snapshot()).text !== before.text) throw new Error("配置在检查期间变化，结果未保存；请重新检查");
    const record = { fingerprint: before.fingerprint, checkedAt: new Date().toISOString(), ok: result.ok, ...(!result.ok ? { errorCode: result.error.code } : {}) };
    await mkdir(this.options.userData, { recursive: true });
    const temporary = `${this.#statusPath}.${randomUUID()}.tmp`;
    let published = false;
    try {
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.#statusPath); published = true;
      const directory = await open(this.options.userData, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { throw new Error(published ? "检查记录保存结果未确认，请刷新核对" : "检查已结束，但结果未能保存，请检查数据目录"); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    return this.view();
  }
}
