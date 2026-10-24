import { join, resolve } from "node:path";
import { DesktopRuntime } from "./desktop-runtime.js";
import { resolveDesktopConfig } from "./desktop-config.js";
import { resolveTuiModuleConfig } from "@serika/assistant";
import { ResidentClient, type ResidentPaths } from "./resident-transport.js";
import type { RemoteRuntimeMethods, ResidentScope } from "./resident-protocol.js";
import { createResidentService, resolveResidentPaths } from "./resident-service.js";
import { residentStartup, saveResidentStartup } from "./resident-startup.js";
import type { AppInfo } from "../shared/ui-contract.js";
import type { ResidentServiceState } from "../shared/resident-service.js";
import { prepareRecoveryProfile, readRecoverySelection, saveRecoverySelection, type RecoverySelection } from "./recovery-profile.js";

type Runtime = DesktopRuntime | (ResidentClient & RemoteRuntimeMethods);
type Options = Parameters<typeof DesktopRuntime.create>[0] & { home: string; hostEntry: string;
  serviceFactory?: typeof createResidentService;
};

/** One runtime owner. A failed transfer never silently takes over a live host. */
export class RuntimeOwnership {
  #host: Runtime | undefined;
  #lastInfo?: AppInfo;
  #error: string | undefined;
  #switching = false;
  #transition: Promise<void> | undefined;
  #service: ReturnType<typeof createResidentService>;
  #paths: ResidentPaths;
  #scope: ResidentScope;
  #startup: ReturnType<typeof residentStartup>;
  #sourceOptions!: Options;
  #recovery: RecoverySelection | null = null;
  #restartRequired = false;
  private constructor(private options: Options, scope: ResidentScope, workspace: string | null) {
    this.#scope = scope;
    const paths = resolveResidentPaths(scope.applicationHome);
    this.#paths = { directory: paths.stateDirectory, token: join(paths.stateDirectory, "auth-token"), socket: paths.socketPath };
    this.#startup = residentStartup(options.applicationHome, options.cwd, { ...options.env, RUNLOOM_CONFIG: scope.configPath });
    this.#service = (options.serviceFactory ?? createResidentService)({ home: options.home, applicationHome: scope.applicationHome, ...(workspace ? { workspace } : {}), hostEntry: options.hostEntry, identityPath: paths.identityPath, env: options.env });
  }
  static async create(sourceOptions: Options, ignoreRecoverySelection = false): Promise<RuntimeOwnership> {
    const sourceConfigPath = resolve(sourceOptions.cwd, sourceOptions.env.RUNLOOM_CONFIG?.trim() || join(sourceOptions.applicationHome, "config.json"));
    const explicitIdentity = [sourceOptions.env.RUNLOOM_WORKSPACE, sourceOptions.env.RUNLOOM_THREAD, sourceOptions.env.RUNLOOM_TRANSCRIPTS].some(value => value?.trim());
    const recovery = ignoreRecoverySelection || explicitIdentity ? null : await readRecoverySelection(sourceOptions.applicationHome, sourceConfigPath);
    const options = recovery ? { ...sourceOptions, applicationHome: recovery.recoveryRoot, env: { ...sourceOptions.env, RUNLOOM_CONFIG: recovery.configPath, RUNLOOM_WORKSPACE: undefined, RUNLOOM_THREAD: undefined, RUNLOOM_TRANSCRIPTS: undefined } } : sourceOptions;
    const selected = await resolveDesktopConfig(options);
    const config = await resolveTuiModuleConfig({ dataDirectory: join(options.applicationHome, "data"), configPath: selected.configPath }, { cwd: options.cwd });
    if (!config.configPath) throw new Error("桌面助手需要固定的工作区与配置");
    const owner = new RuntimeOwnership(options, { applicationHome: options.applicationHome, configPath: config.configPath }, config.workspaceRoot);
    owner.#sourceOptions = sourceOptions; owner.#recovery = recovery;
    const state = await owner.#service.status();
    if (!state.ok && process.platform === "darwin") throw new Error(state.message ?? "无法确认助手宿主状态，不会启动第二个执行宿主");
    if (state.registered) {
      if (!state.compatible) throw new Error(state.message ?? "常驻助手配置不匹配");
      await saveResidentStartup(owner.#service.paths.identityPath, owner.#startup, true);
      owner.#host = await owner.#connect();
    } else {
      await saveResidentStartup(owner.#service.paths.identityPath, owner.#startup, false);
      owner.#host = await DesktopRuntime.create(options);
    }
    owner.#lastInfo = owner.#host.info();
    return owner;
  }
  get applicationHome() { return this.options.applicationHome; }
  get current() {
    if (this.#switching || !this.#host || this.#error) throw new Error(this.#error ?? "正在切换助手宿主，请稍候");
    return this.#host.current;
  }
  async snapshot() {
    const active = this.#active();
    if (active instanceof ResidentClient) await active.refresh();
    if (active !== this.#active()) throw new Error("助手宿主已切换，请重新读取状态");
    return active.current.snapshot();
  }
  info(): AppInfo {
    const info = this.#host?.info() ?? this.#lastInfo;
    if (!info) throw new Error("助手尚未启动");
    const visible = { ...info, ...(info.build ? { build: { ...info.build,
      host: this.#host instanceof ResidentClient ? "resident" as const : "desktop" as const } } : {}),
      ...(this.#recovery ? { recoveryWorkspace: { originalWorkspace: this.#recovery.sourceWorkspace } } : {}) };
    return this.#error ? { ...visible, runtimeRecovery: { state: "failed", message: this.#error } } : visible;
  }
  #active() { if (this.#switching || !this.#host || this.#error) throw new Error(this.#error ?? "助手宿主暂不可用"); return this.#host; }
  pomodoro(...args: Parameters<DesktopRuntime["pomodoro"]>) { return this.#active().pomodoro(...args); }
  listThreads(...args: Parameters<DesktopRuntime["listThreads"]>) { return this.#active().listThreads(...args); }
  exportBackup(destination: string) { return this.#active().exportBackup(destination); }
  createThread(...args: Parameters<DesktopRuntime["createThread"]>) { return this.#active().createThread(...args); }
  selectThread(...args: Parameters<DesktopRuntime["selectThread"]>) { return this.#active().selectThread(...args); }
  telegramStatus() { return this.#active().telegramStatus(); }
  setTelegramAutonomyEnabled(...args: Parameters<DesktopRuntime["setTelegramAutonomyEnabled"]>) { return this.#active().setTelegramAutonomyEnabled(...args); }
  setTelegramEnabled(enabled: boolean) { return this.#active().setTelegramEnabled(enabled); }
  beginTelegramPairing() { return this.#active().beginTelegramPairing(); }
  confirmTelegramPairing(code: string) { return this.#active().confirmTelegramPairing(code); }
  reviewTelegramInput(input: { key: string; note: string }) { return this.#active().reviewTelegramInput(input); }
  setTelegramTaskRoute(input: { id: string; kind: "once" | "recurring"; enabled: boolean }) { return this.#active().setTelegramTaskRoute(input); }
  retryTelegramDelivery(key: string) { return this.#active().retryTelegramDelivery(key); }
  resolveTelegramDelivery(input: { key: string; action: "cancel" | "review"; note?: string }) { return this.#active().resolveTelegramDelivery(input); }
  enableMemory() { return this.#active().enableMemory(); }
  setAuthorizedDirectories(...args: Parameters<DesktopRuntime["setAuthorizedDirectories"]>) { return this.#active().setAuthorizedDirectories(...args); }
  setModuleEnabled(...args: Parameters<DesktopRuntime["setModuleEnabled"]>) { return this.#active().setModuleEnabled(...args); }

  getComputerConnection() { return this.#active().getComputerConnection(); }
  findComputerDrivers() { return this.#active().findComputerDrivers(); }
  checkComputerConnection(path: string) { return this.#active().checkComputerConnection(path); }
  saveComputerConnection(...args: Parameters<DesktopRuntime["saveComputerConnection"]>) { return this.#active().saveComputerConnection(...args); }
  listHerdrSessions() { return this.#active().listHerdrSessions(); }
  listHerdrPanes(session: string) { return this.#active().listHerdrPanes(session); }
  setHerdrTarget(...args: Parameters<DesktopRuntime["setHerdrTarget"]>) { return this.#active().setHerdrTarget(...args); }
  setAutonomyEnabled(...args: Parameters<DesktopRuntime["setAutonomyEnabled"]>) { return this.#active().setAutonomyEnabled(...args); }

  async activateRecovery(root: string | null) {
    const host = this.#active();
    if ([this.#sourceOptions.env.RUNLOOM_WORKSPACE, this.#sourceOptions.env.RUNLOOM_THREAD, this.#sourceOptions.env.RUNLOOM_TRANSCRIPTS].some(value => value?.trim())) throw new Error("当前入口显式指定了工作区或对话；请从正常日用入口打开后再接回恢复副本，不会覆盖显式身份");
    if (host.current.snapshot().state.kind !== "idle") throw new Error("请等待当前执行、整理和确认结束，再切换恢复工作区");
    this.#switching = true;
    let finish!: () => void;
    this.#transition = new Promise(resolve => { finish = resolve; });
    let next: RuntimeOwnership | undefined, stopped = false;
    try {
      if (host instanceof ResidentClient || (await this.#service.status()).registered) throw new Error("请先显式关闭常驻助手，再切换恢复工作区；不会留下两份主执行宿主");
      if ((await host.getLifecycleStatus()).pomodoroRunning) throw new Error("请先结束番茄钟，再切换恢复工作区；不会丢失计时");
      const sourceConfigPath = resolve(this.#sourceOptions.cwd, this.#sourceOptions.env.RUNLOOM_CONFIG?.trim() || join(this.#sourceOptions.applicationHome, "config.json"));
      const selection = root === null ? null : await prepareRecoveryProfile({ root, applicationHome: this.options.applicationHome, cwd: this.options.cwd,
        sourceConfigPath, sourceWorkspace: this.#recovery?.sourceWorkspace ?? this.info().workspaceRoot ?? this.#scope.applicationHome });
      const nextOptions = selection ? { ...this.#sourceOptions, applicationHome: selection.recoveryRoot, env: { ...this.#sourceOptions.env, RUNLOOM_CONFIG: selection.configPath,
        RUNLOOM_THREAD: undefined, RUNLOOM_TRANSCRIPTS: undefined, RUNLOOM_WORKSPACE: undefined } } : this.#sourceOptions;
      // Assemble and validate first. The restored workspace has independent
      // identity/leases and no automatic consolidation or external connections.
      next = await RuntimeOwnership.create(nextOptions, true);
      if (selection && !(await next.current.listMemories()).ok) throw new Error("恢复副本的记忆无法读取；原工作区未切换，请核对备份");
      this.#lastInfo = this.info();
      stopped = true;
      this.#host = undefined;
      await host.shutdown();
      await saveRecoverySelection(this.#sourceOptions.applicationHome, selection);
      this.#host = next.#host; next.#host = undefined;
      this.options = next.options; this.#scope = next.#scope; this.#paths = next.#paths; this.#service = next.#service; this.#startup = next.#startup;
      this.#recovery = selection; this.#error = undefined;
    } catch (error) {
      if (stopped) { this.#host = undefined; this.#restartRequired = true; this.#error = "恢复入口切换未确认，请退出重开核对已保存的工作区；不会重做旧任务。"; }
      await next?.shutdown();
      throw error;
    } finally {
      this.#switching = false; finish(); this.#transition = undefined;
      this.options.send({ type: "identity-changed", info: this.info(), reason: "modules" });
    }
  }
  async #connect() {
    const deadline = Date.now() + 10_000;
    do {
      try { return await ResidentClient.connect({ paths: this.#paths, scope: this.#scope, send: message => this.options.send(
        message.type === "identity-changed" && message.info.build
          ? { ...message, info: { ...message.info, build: { ...message.info.build, host: "resident" } } }
          : message) }); }
      catch { if (Date.now() >= deadline) throw new Error("常驻助手已启用，但连接尚未恢复；请重新连接，不会另开执行宿主"); }
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
  }
  async residentStatus(): Promise<ResidentServiceState> { return this.#service.status(); }
  async setResidentEnabled(enabled: unknown): Promise<ResidentServiceState> {
    if (typeof enabled !== "boolean") throw new Error("常驻模式参数无效");
    const host = this.#active();
    this.#switching = true;
    let finish!: () => void;
    this.#transition = new Promise(resolve => { finish = resolve; });
    this.#lastInfo = host.info();
    try {
      if (host.current.snapshot().state.kind !== "idle") throw new Error("请等待当前执行、整理或确认结束，再切换常驻模式");
      if ((await host.getLifecycleStatus()).pomodoroRunning) throw new Error("请先结束番茄钟，再切换常驻模式；不会悄悄重置计时");
      this.options.send({ type: "state", state: { kind: "command", name: "resident-switch" } });
      const before = await this.#service.status();
      if (!before.ok) throw new Error(before.message ?? "无法确认常驻助手状态");
      if (enabled) {
        await saveResidentStartup(this.#service.paths.identityPath, this.#startup, before.registered);
        if (host instanceof ResidentClient) return before;
        if (before.registered) throw new Error("已有助手宿主，请先核对连接，不会接管当前执行");
        this.#host = undefined; await host.shutdown();
        const state = await this.#service.enable();
        if (!state.ok || !state.registered || !state.compatible) throw new Error(state.message ?? "常驻助手未能启用");
        this.#host = await this.#connect();
      } else {
        if (host instanceof ResidentClient) {
          this.#host = undefined;
          try { await host.requestStop(); } finally { host.detach(); }
        }
        else if (!before.registered) return before;
        else throw new Error("已有另一份助手宿主，不会在当前入口强制停止它");
        const state = await this.#service.disable();
        if (!state.ok || state.registered) throw new Error(state.message ?? "尚未确认助手服务已停止");
        this.#host = await DesktopRuntime.create(this.options);
      }
      this.#error = undefined;
      return await this.#service.status();
    } catch (error) {
      if (!this.#host) {
        const status = await this.#service.status();
        if (status.ok && !status.registered) {
          try { this.#host = await DesktopRuntime.create(this.options); } catch { /* Retain explicit unavailable state. */ }
        }
        if (!this.#host) this.#error = "助手连接未恢复。请重新连接；不会自动重做任务，也不会启动第二个宿主。";
      }
      throw error;
    } finally {
      this.#switching = false;
      finish(); this.#transition = undefined;
      this.options.send({ type: "identity-changed", info: this.info(), reason: "modules" });
    }
  }
  async retryConnection() {
    if (this.#switching) throw new Error("正在切换宿主，请稍候");
    if (this.#restartRequired) throw new Error(this.#error);
    this.#switching = true;
    let finish!: () => void;
    this.#transition = new Promise(resolve => { finish = resolve; });
    try {
    if (this.#host instanceof ResidentClient) { await this.#host.reconnect(); await this.#host.retryConnection(); }
    else if (this.#error || !this.#host) {
      const state = await this.#service.status();
      if (!state.ok) throw new Error(state.message ?? "无法确认助手宿主状态");
      if (state.registered) {
        if (!state.compatible) throw new Error(state.message ?? "常驻助手身份不匹配");
        await saveResidentStartup(this.#service.paths.identityPath, this.#startup, true);
        this.#host = await this.#connect();
      } else this.#host = await DesktopRuntime.create(this.options);
    } else await this.#host.retryConnection();
    this.#error = undefined;
    this.options.send({ type: "identity-changed", info: this.info(), reason: "modules" });
    } finally { this.#switching = false; finish(); this.#transition = undefined; }
  }
  async shutdown() {
    await this.#transition;
    if (this.#host instanceof ResidentClient) this.#host.detach();
    else await this.#host?.shutdown();
  }
}
