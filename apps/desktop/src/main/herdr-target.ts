import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { herdrTargetSchema, resolveTuiModuleConfig } from "@serika/assistant";
import type { HerdrTarget } from "@serika/assistant";
import type { HerdrPane, HerdrSession, HerdrTargetInput } from "../shared/ui-contract.js";
import { updateDesktopConfig } from "./module-settings.js";

const execute = promisify(execFile);
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Herdr 返回的元数据无效");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value || value.length > limit || /[\x00-\x1f]/.test(value)) throw new Error("Herdr 目标标识无效");
  return value;
}
function sessionName(value: unknown): string {
  const name = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error("Herdr 会话名称无效");
  return name;
}

/** Lists target metadata only. It never reads output, attaches or starts Herdr. */
export class HerdrTargets {
  constructor(private readonly options: { env: NodeJS.ProcessEnv; cwd: string; authorizedDirectory: string | null }) {}
  async #binary(): Promise<string> {
    const paths = [...(this.options.env.PATH ?? "/usr/bin:/bin").split(delimiter),
      ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [])];
    for (const directory of new Set(paths)) {
      if (!isAbsolute(directory)) continue;
      try {
        const candidate = resolve(directory, "herdr");
        await access(candidate, constants.X_OK);
        const binary = await realpath(candidate);
        if (!(await stat(binary)).isFile()) continue;
        if (this.options.authorizedDirectory) {
          const inside = relative(await realpath(this.options.authorizedDirectory), binary);
          if (!inside || inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) throw new Error("Herdr 程序必须位于授权目录之外");
        }
        return binary;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))) throw error;
      }
    }
    throw new Error("未找到可执行的 Herdr；请核对安装路径，不会自动安装或启动");
  }
  async #json(args: string[]): Promise<unknown> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "XDG_CONFIG_HOME"]) {
      if (this.options.env[key] !== undefined) env[key] = this.options.env[key];
    }
    const { stdout } = await execute(await this.#binary(), args, { cwd: this.options.cwd, env, timeout: 5000, maxBuffer: 512 * 1024 });
    return JSON.parse(stdout);
  }
  async sessions(): Promise<HerdrSession[]> {
    const { sessions } = record(await this.#json(["session", "list", "--json"]));
    if (!Array.isArray(sessions) || sessions.length > 128) throw new Error("Herdr 会话列表无效");
    return sessions.map(value => { const item = record(value); return { name: sessionName(item.name), running: item.running === true }; });
  }
  async panes(session: string): Promise<HerdrPane[]> {
    const { panes } = record(record(await this.#json(["--session", sessionName(session), "pane", "list"])).result);
    if (!Array.isArray(panes) || panes.length > 256) throw new Error("Herdr 终端列表无效");
    return panes.map(value => { const item = record(value); return {
      paneId: herdrTargetSchema.shape.paneId.parse(item.pane_id), terminalId: herdrTargetSchema.shape.terminalId.parse(item.terminal_id),
      title: typeof item.terminal_title_stripped === "string" ? item.terminal_title_stripped.replace(/[\x00-\x1f]/g, " ").slice(0, 120) : "",
    }; });
  }
  async bind(configPath: string, input: HerdrTargetInput): Promise<() => Promise<void>> {
    const parsed = record(input);
    if (Object.keys(parsed).some(key => key !== "target" && key !== "expected") || !("expected" in parsed) || !("target" in parsed)) throw new Error("Herdr 绑定参数无效");
    const expected = parsed.expected === null ? null : herdrTargetSchema.parse(parsed.expected);
    let target: HerdrTarget | undefined;
    if (parsed.target !== null) {
      const selected = record(parsed.target);
      if (Object.keys(selected).some(key => !["session", "paneId", "terminalId"].includes(key))) throw new Error("Herdr 目标参数无效");
      const session = sessionName(selected.session);
      const pane = (await this.panes(session)).find(value => value.paneId === selected.paneId);
      if (!pane || pane.terminalId !== selected.terminalId) throw new Error("Herdr 终端已关闭或替换，请刷新后重新选择");
      target = herdrTargetSchema.parse({ authorizedDirectory: this.options.authorizedDirectory, session, paneId: pane.paneId, terminalId: pane.terminalId });
    }
    const saved = await updateDesktopConfig(configPath, this.options.cwd, async (before, path) => {
      const current = await resolveTuiModuleConfig({ configPath: path }, { cwd: this.options.cwd });
      if (!this.options.authorizedDirectory || current.authorizedDirectory !== this.options.authorizedDirectory) throw new Error("授权目录已变化，请重新连接");
      if (!current.enabled.terminal || current.shellSandbox) throw new Error("请先开启本地终端控制；Docker 模式不能接管宿主终端");
      if (JSON.stringify(current.terminalTarget ?? null) !== JSON.stringify(expected)) throw new Error("Herdr 目标已变化，请刷新后重新选择");
      const config = JSON.parse(before!);
      delete config.modules.terminal.target;
      if (target) config.modules.terminal.target = target;
      return JSON.stringify(config, null, 2) + "\n";
    });
    return saved.rollback ?? (async () => {});
  }
}
