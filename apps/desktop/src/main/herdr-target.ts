import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { herdrBindingSchema, type HerdrBinding } from "@aisdk-agent/example-cli/dist/local-terminal.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import { updateDesktopConfig } from "./module-settings.js";
import type { HerdrTargetInput } from "../shared/ui-contract.js";

const execute = promisify(execFile);
function sessionName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error("Herdr 会话名称无效");
}
function bounded(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error(`Herdr ${name}无效`);
  return value;
}
/** Metadata only: never attaches, starts a server, or reads terminal buffers. */
export class HerdrTargets {
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly cwd: string, private readonly workspaceRoot?: string | null) {}
  async #binary() {
    for (const directory of (this.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const candidate = resolve(directory, "herdr");
      try {
        await access(candidate, constants.X_OK);
        const binary = await realpath(candidate);
        if (!(await stat(binary)).isFile()) continue;
        if (this.workspaceRoot) {
          const path = relative(this.workspaceRoot, binary);
          if (!path || !path.startsWith("../") && !isAbsolute(path)) throw new Error("Herdr 程序必须安装在信任工作区之外");
        }
        return binary;
      } catch (error) { if (!["ENOENT", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    throw new Error("未找到已安装的 Herdr，请核对宿主 PATH；不会自动安装或启动");
  }
  async #json(args: string[]) {
    // Fixed argv, no shell interpolation or inherited session selection.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "XDG_CONFIG_HOME"]) if (this.env[key] !== undefined) env[key] = this.env[key];
    const { stdout } = await execute(await this.#binary(), args, { cwd: this.cwd, env, timeout: 5000, maxBuffer: 512 * 1024 });
    return JSON.parse(stdout);
  }
  async sessions(): Promise<{ name: string; running: boolean }[]> {
    const result = await this.#json(["session", "list", "--json"]);
    if (!Array.isArray(result.sessions) || result.sessions.length > 128) throw new Error("Herdr 会话列表无效");
    return result.sessions.map((item: { name: unknown; running: unknown }) => {
      sessionName(item.name); return { name: item.name, running: item.running === true };
    });
  }
  async panes(session: string): Promise<{ paneId: string; terminalId: string; title: string }[]> {
    sessionName(session);
    const result = await this.#json(["--session", session, "pane", "list"]);
    if (!Array.isArray(result.result?.panes) || result.result.panes.length > 256) throw new Error("Herdr pane 列表无效");
    return result.result.panes.map((pane: Record<string, unknown>) => ({ paneId: bounded(pane.pane_id, "pane"), terminalId: bounded(pane.terminal_id, "terminal"), title: typeof pane.terminal_title_stripped === "string" ? pane.terminal_title_stripped.slice(0, 120) : "" }));
  }
  async bind(configPath: string, cwd: string, workspaceRoot: string | null, input: HerdrTargetInput): Promise<() => Promise<void>> {
    if (!input || typeof input !== "object" || Object.keys(input).some(key => !["target", "expected"].includes(key)) || !("expected" in input)) throw new Error("终端绑定参数无效");
    const expected = input.expected === null ? null : herdrBindingSchema.parse(input.expected);
    let binding: HerdrBinding | undefined;
    if (input.target !== null) {
      if (!input.target || Object.keys(input.target).some(key => !["session", "paneId", "terminalId"].includes(key))) throw new Error("终端目标无效");
      sessionName(input.target.session);
      const pane = (await this.panes(input.target.session)).find(item => item.paneId === input.target!.paneId);
      if (!pane || pane.terminalId !== input.target.terminalId) throw new Error("终端已关闭或替换，请刷新并重新选择");
      binding = herdrBindingSchema.parse({ workspaceRoot, session: input.target.session, paneId: pane.paneId, terminalId: pane.terminalId });
    }
    const result = await updateDesktopConfig(configPath, cwd, async (before, path) => {
      const current = await resolveTuiModuleConfig({ configPath: path }, { cwd });
      if (!workspaceRoot || current.workspaceRoot !== workspaceRoot) throw new Error("工作区已变化，请重新连接");
      if (JSON.stringify(current.herdrBinding ?? null) !== JSON.stringify(expected)) throw new Error("终端绑定已变化，请刷新");
      if (binding && (!current.enabled.shell || current.shellSandbox)) throw new Error("Herdr 需要开启本机 Shell；不会替换 Docker 配置");
      const config = JSON.parse(before!); delete config.herdrBinding;
      if (binding) config.herdrBinding = binding;
      return JSON.stringify(config, null, 2) + "\n";
    });
    return result.rollback ?? (async () => {});
  }
}
