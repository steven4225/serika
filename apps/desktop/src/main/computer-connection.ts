import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { computerConfigSchema, discoverComputerApps } from "@serika/assistant";
import type { ComputerConnectionInput, ComputerConnectionView } from "../shared/ui-contract.js";
import { updateDesktopConfig } from "./module-settings.js";

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");

export class ComputerConnection {
  constructor(private readonly options: { configPath: string; cwd: string; env: NodeJS.ProcessEnv; directory: string | null; dataDirectory: string }) {}
  async view(): Promise<ComputerConnectionView> {
    let view!: ComputerConnectionView;
    await updateDesktopConfig(this.options.configPath, this.options.cwd, async text => {
      const config = JSON.parse(text!);
      const computer = computerConfigSchema.parse(config.modules?.computer ?? { enabled: false });
      view = { enabled: computer.enabled, executable: computer.executable ?? "", allowedBundleIds: computer.allowedBundleIds ?? [], revision: fingerprint(text!) };
      return undefined;
    });
    return view;
  }
  async #executable(path: string) {
    if (typeof path !== "string" || !isAbsolute(path)) throw new Error("请选择驱动程序的绝对路径");
    let executable: string;
    try {
      executable = await realpath(path);
      await access(executable, constants.X_OK);
      if (!(await stat(executable)).isFile()) throw new Error();
    } catch { throw new Error("驱动程序不存在或不可执行"); }
    if (this.options.directory !== null) {
      const child = relative(await realpath(this.options.directory), executable);
      if (!child || child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) throw new Error("驱动必须位于授权目录之外");
    }
    return executable;
  }
  async find() {
    const paths = [...(this.options.env.PATH ?? "/usr/bin:/bin").split(delimiter), ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [])];
    const found = new Set<string>();
    for (const path of paths.filter(isAbsolute)) {
      try { found.add(await this.#executable(resolve(path, "cua-driver"))); } catch {}
    }
    return [...found];
  }
  async check(path: string) {
    const executable = await this.#executable(path);
    const result = await discoverComputerApps(executable, this.options.env);
    return { ...result, executable, permissions: "not_checked" as const };
  }
  async save(input: ComputerConnectionInput) {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["enabled", "executable", "allowedBundleIds", "expectedRevision"].includes(key)) || typeof input.expectedRevision !== "string" || typeof input.enabled !== "boolean" || typeof input.executable !== "string" || !Array.isArray(input.allowedBundleIds)) throw new Error("电脑控制设置无效");
    const declaration = computerConfigSchema.parse(input.enabled ? { enabled: true, executable: await this.#executable(input.executable), allowedBundleIds: input.allowedBundleIds } : { enabled: false, executable: input.executable || undefined, allowedBundleIds: input.allowedBundleIds.length ? input.allowedBundleIds : undefined });
    const result = await updateDesktopConfig(this.options.configPath, this.options.cwd, async text => {
      if (fingerprint(text!) !== input.expectedRevision) throw new Error("配置已变化，请刷新后重新确认");
      const config = JSON.parse(text!);
      return JSON.stringify({ ...config, modules: { ...config.modules, computer: declaration } }, null, 2) + "\n";
    }, { dataDirectory: this.options.dataDirectory });
    return result.rollback;
  }
}

export async function disableUnavailableComputer(options: { configPath: string; cwd: string; confirm: () => Promise<boolean> }) {
  let expected = "";
  await updateDesktopConfig(options.configPath, options.cwd, async text => { expected = text!; return undefined; });
  if (!await options.confirm()) return false;
  await updateDesktopConfig(options.configPath, options.cwd, async text => {
    if (text !== expected) throw new Error("配置已变化，未停用电脑控制；请重新启动并核对");
    const config = JSON.parse(text!);
    const computer = computerConfigSchema.parse(config.modules?.computer);
    if (!computer.enabled) throw new Error("电脑控制状态已变化");
    return JSON.stringify({ ...config, modules: { ...config.modules, computer: { ...computer, enabled: false } } }, null, 2) + "\n";
  });
  return true;
}
