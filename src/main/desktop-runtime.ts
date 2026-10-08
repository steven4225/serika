import type { LanguageModel } from "ai";
import { createRuntimeApp, type TaskAutomationHost } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import { enableDesktopMemory, resolveDesktopConfig } from "./desktop-config.js";
import { createDesktopThread, listDesktopThreads, registerDesktopThread, resolveDesktopIdentity, selectDesktopThread, type DesktopIdentityResolution } from "./desktop-identity.js";
import { discoverThreadDirectory, inspectThread } from "./thread-history.js";
import { RuntimeBridge, TeeOutput, type Send } from "./runtime-bridge.js";
import { changeModuleSetting, changeDreamingSetting, type ModuleSettingInput, type DreamingSettingInput } from "./module-settings.js";
import type { AppInfo } from "../shared/ui-contract.js";
import { readLoadedBuild } from "./build-identity.js";

interface Options { userData: string; cwd: string; env: NodeJS.ProcessEnv; modelAlias: string; modelId?: string; model: LanguageModel; send: Send; taskAutomation?: TaskAutomationHost }

/** Owns desktop selection only. Each selected Thread still uses the original controller/loop. */
export class DesktopRuntime {
  #options: Options;
  #identity!: DesktopIdentityResolution;
  #bridge!: RuntimeBridge;
  #changing = false;
  #transition: Promise<void> | undefined;
  #available = true;
  #lastInfo!: AppInfo;
  #recoveryError: string | undefined;

  private constructor(options: Options) { this.#options = options; }

  static async create(options: Options): Promise<DesktopRuntime> {
    const host = new DesktopRuntime(options);
    const config = await resolveDesktopConfig(options);
    const modules = await resolveTuiModuleConfig({ configPath: config.configPath }, { cwd: options.cwd });
    host.#identity = await resolveDesktopIdentity({ ...options, configPath: modules.configPath!, workspaceRoot: modules.workspaceRoot });
    host.#bridge = await host.#make(host.#identity);
    host.#lastInfo = host.#bridge.info();
    return host;
  }

  get current(): RuntimeBridge {
    if (this.#changing) throw new Error("正在切换会话，请稍候");
    if (!this.#available) throw new Error(this.#recoveryError ?? "助手连接未恢复，请重新连接");
    return this.#bridge;
  }

  get recoveryError() { return this.#recoveryError; }
  info(): AppInfo {
    const info = this.#available ? this.#bridge.info() : this.#lastInfo;
    return { ...info, build: readLoadedBuild(), ...(this.#recoveryError ? { runtimeRecovery: { state: "failed" as const, message: this.#recoveryError } } : {}) };
  }
  #scope() { return { ...this.#options, configPath: this.#identity.configPath, workspaceRoot: this.#identity.workspaceRoot }; }
  #assertIdle() {
    if (!this.#available) throw new Error(this.#recoveryError ?? "助手连接未恢复，请重新连接");
    if (this.#changing || this.#bridge.snapshot().state.kind !== "idle") throw new Error("请先等待当前执行或整理结束，再切换会话");
  }

  async #make(identity: DesktopIdentityResolution): Promise<RuntimeBridge> {
    const config = await resolveTuiModuleConfig({ configPath: identity.configPath }, { cwd: this.#options.cwd });
    if (config.workspaceRoot !== identity.workspaceRoot) throw new Error("配置工作区已变化，请恢复原工作区配置后重新连接；不会混入其他工作区");
    const output = new TeeOutput(this.#options.send);
    const app = await createRuntimeApp({
      args: ["--tui", identity.transcriptDirectory, "--thread", identity.threadId, "--config", identity.configPath],
      modelAlias: this.#options.modelAlias, model: this.#options.model, output, env: this.#options.env, cwd: this.#options.cwd,
      ...(this.#options.taskAutomation ? { taskAutomation: this.#options.taskAutomation } : {}),
    });
    // Assembly rereads the config; do not publish a different workspace under
    // the trusted old Thread/transcript identity if the file changed in between.
    if (app.workspaceRoot !== identity.workspaceRoot || app.moduleConfig?.configPath !== identity.configPath) {
      app.dispose();
      throw new Error("配置工作区或入口在连接期间变化，请核对原配置后重新连接；不会混入其他工作区");
    }
    const controller = createAssistantController(app);
    output.attach(controller);
    try {
      // Await lease acquisition/recovery before publishing the new identity.
      await controller.listRuns();
      return new RuntimeBridge(app, controller, { modelAlias: this.#options.modelAlias,
        ...(this.#options.modelId === undefined ? {} : { modelId: this.#options.modelId }), temporaryThread: false, temporaryDirectory: false,
        identitySource: identity.identitySource, entryMode: this.#options.env.RUNLOOM_DESKTOP_TEST === "1" ? "test" : "daily" }, output, this.#options.send);
    } catch (error) { await controller.shutdown(); throw error; }
  }

  async #inspect(thread: { threadId: string; transcriptDirectory: string }, query = "") {
    const summary = await inspectThread(thread, query);
    try {
      const { tasks, runs } = await this.#bridge.threadActivity(thread);
      const latestTask = tasks.find(task => !["completed", "cancelled"].includes(task.status)) ?? tasks[0];
      if (summary.title === "新对话" && latestTask) summary.title = latestTask.goal.replace(/\s+/g, " ").slice(0, 48);
      summary.taskCount = tasks.length;
      summary.runCount = runs.length;
      const activityAt = [summary.savedAt, ...tasks.map(task => task.updatedAt), ...runs.map(run => run.finishedAt ?? run.startedAt)].filter((time): time is string => !!time).sort().at(-1);
      if (activityAt) summary.activityAt = activityAt;
      summary.emptyVerified = !summary.error && summary.messageCount === 0 && tasks.length === 0 && runs.length === 0;
      summary.matchesQuery = summary.matchesQuery === true || !query || tasks.some(task => task.goal.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    } catch {
      summary.emptyVerified = false;
      summary.error = [summary.error, "任务或执行记录无法读取；该对话未隐藏，请核对保存位置。"].filter(Boolean).join(" ");
    }
    return summary;
  }

  async listThreads(query?: string) {
    if (query !== undefined && (typeof query !== "string" || query.length > 200)) throw new Error("搜索词请保持在 200 字以内");
    const search = query?.trim() ?? "";
    const registered = await listDesktopThreads(this.#scope());
    if (!registered.some(thread => thread.threadId === this.#identity.threadId && thread.transcriptDirectory === this.#identity.transcriptDirectory)) registered.unshift(this.#identity);
    // Bound file reads in-flight, not only the number of registered entries.
    const summaries = [];
    for (const thread of registered) summaries.push(await this.#inspect(thread, search));
    return summaries;
  }

  discoverThreads(directory: string) { return discoverThreadDirectory(directory); }

  async registerThread(input: { threadId: string; transcriptDirectory: string; confirmedWorkspace: true }) {
    this.#assertIdle();
    if (!input || input.confirmedWorkspace !== true || typeof input.threadId !== "string") throw new Error("请明确确认旧对话属于当前工作区");
    this.#changing = true;
    try {
      const found = (await discoverThreadDirectory(input.transcriptDirectory)).find(thread => thread.threadId === input.threadId);
      if (!found || found.error) throw new Error(found?.error ?? "这个目录没有所选对话");
      await registerDesktopThread(this.#scope(), found);
    } finally { this.#changing = false; }
  }

  async #replace(select: () => Promise<DesktopIdentityResolution>, reuseUnchanged = false, settings?: { rollback: () => Promise<void> }): Promise<void> {
    this.#assertIdle();
    this.#changing = true;
    this.#options.send({ type: "state", state: { kind: "command", name: "thread-switch" } });
    const previous = this.#identity;
    this.#lastInfo = this.#bridge.info();
    let disposed = false;
    let configurationError: string | undefined;
    const transition = (async () => {
      try {
        const next = await select();
        if (reuseUnchanged && next.threadId === previous.threadId && next.transcriptDirectory === previous.transcriptDirectory) return;
        disposed = true;
        this.#available = false;
        await this.#bridge.shutdown();
        this.#bridge = await this.#make(next);
        this.#available = true;
        this.#recoveryError = undefined;
        this.#identity = next;
      } catch (error) {
        if (settings) configurationError = error instanceof Error ? error.message : String(error);
        let rollbackFailed = false;
        try { await settings?.rollback(); } catch { rollbackFailed = true; }
        if (disposed) {
          try {
            this.#bridge = await this.#make(previous);
            this.#available = true;
            this.#recoveryError = undefined;
          } catch {
            this.#available = false;
            this.#recoveryError = "助手连接未恢复。请核对配置或关闭占用该会话的其他实例，再点击重新连接；不会自动重做任务。";
          }
        }
        // Restore persisted selection if activating the new controller failed.
        try { if (previous.identitySource === "saved") await selectDesktopThread(this.#scope(), previous.threadId); }
        catch { configurationError = "原会话选择未能保存，请核对保存目录；不会自动改选其他会话。"; }
        if (rollbackFailed) {
          configurationError = "配置回滚未完成（可能已被其他程序修改），未覆盖其他修改。" + (this.#available ? " 已重新连接当前磁盘配置，请重新核对模块开关。" : " 请核对配置后重新连接。");
        }
        if (!this.#available) throw new Error(this.#recoveryError);
        if (rollbackFailed) throw new Error(configurationError);
        throw error;
      } finally {
        this.#changing = false;
        this.#options.send({ type: "identity-changed", info: this.info(), ...(settings ? { reason: "modules" as const, ...(configurationError ? { configurationError } : {}) } : {}) });
      }
    })();
    this.#transition = transition;
    try { await transition; } finally { this.#transition = undefined; }
  }

  selectThread(threadId: string) {
    return this.#replace(() => selectDesktopThread(this.#scope(), threadId));
  }
  createThread(options?: { preserveDraft: boolean }) {
    return this.#replace(async () => {
      if (options !== undefined && (typeof options !== "object" || options === null || typeof options.preserveDraft !== "boolean")) throw new Error("新对话参数无效");
      // Repeated clicks on an unused conversation reuse it; drafts remain separate.
      if (!options?.preserveDraft && (await this.#inspect(this.#identity)).emptyVerified) return this.#identity;
      const thread = await createDesktopThread(this.#scope());
      return selectDesktopThread(this.#scope(), thread.threadId);
    }, true);
  }
  enableMemory() {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await enableDesktopMemory(this.#identity.configPath, this.#options.cwd);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
  }
  setModuleEnabled(input: ModuleSettingInput) {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await changeModuleSetting(this.#identity.configPath, input, this.#options.cwd);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
  }
  setDreamingEnabled(input: DreamingSettingInput) {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await changeDreamingSetting(this.#identity.configPath, input, this.#options.cwd);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
  }
  /** Reconnect only the trusted selected identity; never resend a Run or tool. */
  async retryConnection(): Promise<void> {
    if (this.#changing) throw new Error("正在重新连接，请稍候");
    if (this.#available) return;
    this.#changing = true;
    this.#options.send({ type: "state", state: { kind: "command", name: "runtime-reconnect" } });
    const transition = (async () => {
      try {
        if (this.#identity.identitySource === "saved") await selectDesktopThread(this.#scope(), this.#identity.threadId);
        this.#bridge = await this.#make(this.#identity);
        this.#available = true;
        this.#recoveryError = undefined;
      } catch {
        this.#recoveryError = "助手仍未连接。请核对配置或关闭占用该会话的其他实例后重试；不会自动重做任务。";
        throw new Error(this.#recoveryError);
      } finally {
        this.#changing = false;
        this.#options.send({ type: "identity-changed", info: this.info(), reason: "modules" });
      }
    })();
    this.#transition = transition;
    try { await transition; } finally { this.#transition = undefined; }
  }
  async shutdown() {
    await this.#transition?.catch(() => undefined);
    if (this.#available) await this.#bridge.shutdown();
  }
}
