import { HerdrClient, herdrTargetSchema, resolveTuiModuleConfig } from "@serika/assistant";
import type { HerdrTarget } from "@serika/assistant";
import type { HerdrPane, HerdrSession, HerdrTargetInput } from "../shared/ui-contract.js";
import { updateDesktopConfig } from "./module-settings.js";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Herdr 返回的元数据无效");
  return value as Record<string, unknown>;
}
/** Lists target metadata only. It never reads output, attaches or starts Herdr. */
export class HerdrTargets {
  readonly #client: HerdrClient;
  constructor(private readonly options: { env: NodeJS.ProcessEnv; cwd: string; authorizedDirectory: string | null }) {
    this.#client = new HerdrClient(options);
  }
  sessions(): Promise<HerdrSession[]> { return this.#client.sessions(); }
  panes(session: string): Promise<HerdrPane[]> { return this.#client.panes(session); }
  async bind(configPath: string, input: HerdrTargetInput): Promise<() => Promise<void>> {
    const parsed = record(input);
    if (Object.keys(parsed).some(key => key !== "target" && key !== "expected") || !("expected" in parsed) || !("target" in parsed)) throw new Error("Herdr 绑定参数无效");
    const expected = parsed.expected === null ? null : herdrTargetSchema.parse(parsed.expected);
    let target: HerdrTarget | undefined;
    if (parsed.target !== null) {
      const selected = record(parsed.target);
      if (Object.keys(selected).some(key => !["session", "paneId", "terminalId"].includes(key))) throw new Error("Herdr 目标参数无效");
      const session = herdrTargetSchema.shape.session.parse(selected.session);
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
