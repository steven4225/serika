import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assistantDataPaths, assertExperimentalDataPaths } from "@serika/assistant";
import type { LanguageModel } from "ai";
import { createRuntimeApp, type TaskAutomationHost } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { resolveTuiModuleConfig } from "@serika/assistant";
import { enableDesktopMemory, resolveDesktopConfig } from "./desktop-config.js";
import { createDesktopThread, listDesktopThreads, resolveDesktopIdentity, selectDesktopThread, type DesktopIdentityResolution } from "./desktop-identity.js";
import { inspectThread } from "./thread-history.js";
import { RuntimeBridge, TeeOutput, type Send } from "./runtime-bridge.js";
import { changeModuleSetting, changeAutonomySetting, changeTelegramAutonomySetting, type AutonomySettingInput, ConfigCommitUncertainError, type ModuleSettingInput } from "./module-settings.js";
import { AppInfo } from "../shared/ui-contract.js";
import { readLoadedBuild } from "./build-identity.js";
import { createPomodoroService, type PomodoroService } from "@serika/assistant";
import { ExecutionRecordStore } from "@serika/assistant";
import type { RunRecord } from "@serika/core";
import type { TelegramGateway } from "./telegram-gateway.js";
import { telegramUnavailable } from "../shared/telegram.js";
import { createTaskStore, type TaskListInput } from "@serika/assistant";
import { exportBackup } from "./backup.js";
import { ConversationDraftStore } from "./conversation-draft-store.js";
import { MAX_CONVERSATION_DRAFT_BYTES } from "../shared/conversation-drafts.js";

interface Options { applicationHome: string; cwd: string; env: NodeJS.ProcessEnv; modelAlias: string; modelId?: string; model: LanguageModel; send: Send; taskAutomation?: TaskAutomationHost; /** Ownership transfers to this host, including final disposal. */ pomodoroService?: PomodoroService }

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
  #pomodoroService: PomodoroService;
  #telegram: TelegramGateway | undefined;
  #telegramFailure: string | undefined;
  #sourceBarrier: ((record: RunRecord) => Promise<void>) | undefined;
  #channelListeners = new Set<Send>();
  #send: Send = message => {
    for (const listener of this.#channelListeners) listener(message);
    this.#options.send(message);
  };

  private constructor(options: Options) {
    this.#options = options;
    this.#pomodoroService = options.pomodoroService ?? createPomodoroService();
  }

  static async create(options: Options): Promise<DesktopRuntime> {
    assertExperimentalDataPaths([options.applicationHome, options.env.RUNLOOM_CONFIG, options.env.RUNLOOM_WORKSPACE, options.env.RUNLOOM_TRANSCRIPTS]);
    await mkdir(join(options.applicationHome, "data"), { recursive: true });
    const host = new DesktopRuntime(options);
    try {
      const config = await resolveDesktopConfig(options);
      const modules = await resolveTuiModuleConfig({ dataDirectory: join(options.applicationHome, "data"), configPath: config.configPath }, { cwd: options.cwd });
      host.#identity = await resolveDesktopIdentity({ ...options, configPath: modules.configPath!, workspaceRoot: modules.workspaceRoot });
      host.#bridge = await host.#make(host.#identity);
      host.#lastInfo = host.#bridge.info();
      return host;
    } catch (error) { host.#pomodoroService.dispose(); throw error; }
  }

  get current(): RuntimeBridge {
    if (this.#changing) throw new Error("正在切换会话，请稍候");
    if (!this.#available) throw new Error(this.#recoveryError ?? "助手连接未恢复，请重新连接");
    return this.#bridge;
  }

  get recoveryError() { return this.#recoveryError; }
  attachTelegram(gateway: TelegramGateway) { if (this.#telegram) throw new Error("Telegram already attached"); this.#telegram = gateway; }
  telegramStatus() { return this.#telegramFailure ? { ...telegramUnavailable(), available: true, connection: "failed" as const, lastError: this.#telegramFailure } : this.#telegram?.status() ?? telegramUnavailable(); }
  telegramFailed() { this.#telegramFailure = "Telegram 配置或记录无法读取，未接收消息。桌面助手仍可使用；请检查可信环境文件和通道状态文件后重启。不会重建绑定或重做执行。"; }
  channelTelegramAutonomyEnabled() { return this.#available && this.#bridge.telegramAutonomyEnabled(); }
  async setTelegramAutonomyEnabled(input: import("../shared/telegram.js").TelegramAutonomySettingInput) {
    let undo: (() => Promise<void>) | undefined;
    await this.#replace(async () => {
      const binding = this.#telegram?.autonomyBinding();
      if (!binding || binding.directory !== this.#bridge.info().authorizedDirectory) throw new Error("请先连接并核对当前工作区的 Telegram 私聊绑定");
      undo = await changeTelegramAutonomySetting({ configPath: this.#identity.configPath, input, cwd: this.#options.cwd, binding, state: { enabled: this.#bridge.telegramAutonomyEnabled(), paused: this.#telegram?.autonomyPaused === true } });
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
    if (input.enabled) await this.#telegram?.setAutonomyPaused(false);
    return this.telegramStatus();
  }
  setTelegramEnabled(enabled: boolean) { if (!this.#telegram) throw new Error("请先启用常驻助手"); return this.#telegram.setEnabled(enabled); }
  beginTelegramPairing() { if (!this.#telegram) throw new Error("请先启用常驻助手"); return this.#telegram.beginPairing(); }
  confirmTelegramPairing(code: string) { if (!this.#telegram) throw new Error("请先启用常驻助手"); return this.#telegram.confirmPairing(code); }
  reviewTelegramInput(input: { key: string; note: string }) { if (!this.#telegram) throw new Error("请先启用常驻助手"); return this.#telegram.reviewInput(input); }
  setTelegramTaskRoute(input: { id: string; kind: "once" | "recurring"; enabled: boolean }) { if (!this.#telegram) throw new Error("请先启用常驻助手"); return this.#telegram.setTaskRoute(input); }
  retryTelegramDelivery(key: string) { if (!this.#telegram) throw new Error("请先启用常驻助手"); return this.#telegram.retryDelivery(key); }
  resolveTelegramDelivery(input: { key: string; action: "cancel" | "review"; note?: string }) { if (!this.#telegram) throw new Error("请先启用常驻助手"); return this.#telegram.resolveDelivery(input); }
  /** Host-only channel surface, deliberately not in resident IPC's method whitelist. */
  channelSubscribe(listener: Send) { this.#channelListeners.add(listener); return () => { this.#channelListeners.delete(listener); }; }
  channelSnapshot() { return { info: this.info(), snapshot: this.#bridge.snapshot() }; }
  /** Home TaskStore, independent of foreground capability switches. */
  #channelTaskStore() {
    return createTaskStore(assistantDataPaths(join(this.#options.applicationHome, "data")).tasks);
  }
  channelScheduledTask(id: string) { return this.#channelTaskStore().get(id); }
  async channelRecurringTask(id: string) {
    const result = await this.#channelTaskStore().getRecurring(id);
    return result.ok ? { ok: true as const, value: result.value?.recurringTask ?? null } : result;
  }
  channelScheduledTasks(input: TaskListInput) { return this.#channelTaskStore().list(input); }
  async channelCreateThread() { this.#assertIdle(); return createDesktopThread(this.#scope()); }
  async channelReceipt(threadId: string, runId: string) {
    const thread = (await listDesktopThreads(this.#scope())).find(item => item.threadId === threadId);
    if (!thread) throw new Error("Telegram 对话未登记到当前工作区");
    return new ExecutionRecordStore(thread.transcriptDirectory).getRun(threadId, runId);
  }
  async channelRun(threadId: string, text: string, task: boolean, bind: (record: RunRecord, taskId: string | null) => Promise<void>, receivedAt?: string) {
    let response: Awaited<ReturnType<RuntimeBridge["run"]>> = { ok: false, reason: "starting" };
    await this.#replace(() => selectDesktopThread(this.#scope(), threadId), true, undefined, async () => {
      let taskId: string | null = null;
      this.#sourceBarrier = record => bind(record, taskId);
      try {
        if (task) {
          const created = await this.#bridge.createWorkTask({ goal: text, acceptance: [{ id: "user-quality", description: "用户确认任务结果符合需求", required: true, method: "human", verification: { kind: "human" } }] });
          if (!created.ok) throw new Error("工作任务未能保存，未启动执行");
          taskId = created.value.id;
          response = await this.#bridge.runWorkTaskFromChannel({ id: taskId, expectedRevision: created.value.revision });
        } else response = await this.#bridge.runFromChannel(text, receivedAt);
      } finally { this.#sourceBarrier = undefined; }
    });
    return response;
  }
  pomodoro(action: unknown, minutes?: unknown) {
    if (!this.#available || this.#changing || !this.info().commands.includes("pomodoro")) throw new Error("番茄钟尚未就绪，请稍后重试");
    if (action !== "status" && action !== "start" && action !== "cancel") throw new Error("番茄钟操作无效");
    if (action === "status") return this.#pomodoroService.status();
    if (this.#bridge.snapshot().state.kind !== "idle") throw new Error("助手正在处理消息，请结束后操作番茄钟");
    if (action === "cancel") return this.#pomodoroService.cancel();
    if (action === "start" && typeof minutes === "number" && Number.isInteger(minutes) && minutes >= 1 && minutes <= 180) return this.#pomodoroService.start(minutes);
    throw new Error("请选择 1–180 分钟的专注时长");
  }
  getLifecycleStatus() { return { pomodoroRunning: this.#pomodoroService.status().status.state === "running" }; }
  info(): AppInfo {
    const info = this.#available ? this.#bridge.info() : this.#lastInfo;
    return { ...info, attachments: true, pomodoroControls: true, memoryLibrary: true, build: readLoadedBuild(), ...(this.#recoveryError ? { runtimeRecovery: { state: "failed" as const, message: this.#recoveryError } } : {}) };
  }
  #scope() { return { ...this.#options, configPath: this.#identity.configPath, workspaceRoot: this.#identity.workspaceRoot }; }
  #assertIdle() {
    if (!this.#available) throw new Error(this.#recoveryError ?? "助手连接未恢复，请重新连接");
    if (this.#changing || this.#bridge.snapshot().state.kind !== "idle") throw new Error("请先等待当前执行或整理结束，再切换会话");
  }

  async #make(identity: DesktopIdentityResolution): Promise<RuntimeBridge> {
    const config = await resolveTuiModuleConfig({ dataDirectory: join(this.#options.applicationHome, "data"), configPath: identity.configPath }, { cwd: this.#options.cwd });
    if (config.workspaceRoot !== identity.workspaceRoot) throw new Error("配置工作区已变化，请恢复原工作区配置后重新连接；不会混入其他工作区");
    const output = new TeeOutput(this.#send);
    const app = await createRuntimeApp({
      directory: identity.transcriptDirectory, assistant: { threadId: identity.threadId, configPath: identity.configPath, dataDirectory: join(this.#options.applicationHome, "data") },
      modelAlias: this.#options.modelAlias, model: this.#options.model, output, env: this.#options.env, cwd: this.#options.cwd,
      pomodoroService: this.#pomodoroService,
      allowDirectoryTaskReads: true,
      desktopAutonomyHost: { home: this.#options.applicationHome },
      onHomeSnapshot: snapshot => output.homeSnapshot(snapshot),
      onModuleNotification: notification => output.moduleNotification(notification),
      authorizeTelegramAutonomy: grant => this.#telegram?.matchesAutonomyGrant(grant) === true,
      beforePrimaryRunCreate: record => this.#sourceBarrier?.(record) ?? Promise.resolve(),
      afterTaskArrangementSaved: saved => this.#telegram?.arrangementSaved(saved) ?? Promise.resolve(),
      taskArrangementDestination: () => this.#telegram?.arrangementDestination() ?? null,
      ...(this.#options.taskAutomation ? { taskAutomation: this.#options.taskAutomation } : {}),
    });
    // Assembly rereads the config; do not publish a different workspace under
    // the trusted old Thread/transcript identity if the file changed in between.
    if ((app.workspaceRoot ?? null) !== identity.workspaceRoot || app.moduleConfig?.configPath !== identity.configPath) {
      app.dispose();
      throw new Error("配置工作区或入口在连接期间变化，请核对原配置后重新连接；不会混入其他工作区");
    }
    const controller = createAssistantController(app);
    output.attach(controller);
    try {
      // Await lease acquisition/recovery before publishing the new identity.
      await controller.runs.list();
      return new RuntimeBridge(app, controller, { modelAlias: this.#options.modelAlias,
        ...(this.#options.modelId === undefined ? {} : { modelId: this.#options.modelId }), temporaryThread: false, temporaryDirectory: false,
        identitySource: identity.identitySource, entryMode: this.#options.env.RUNLOOM_DESKTOP_TEST === "1" ? "test" : "daily" }, output, this.#send);
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

  async exportBackup(destination: string) {
    this.#assertIdle(); this.#changing = true;
    try {
      const threads = await listDesktopThreads(this.#scope());
      if (!threads.some(thread => thread.threadId === this.#identity.threadId && thread.transcriptDirectory === this.#identity.transcriptDirectory)) threads.unshift(this.#identity);
      return await exportBackup({ home: this.#options.applicationHome, threads, destination,
        knownSecrets: Object.entries(this.#options.env).filter(([key]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)).flatMap(([, value]) => value ? [value] : []) });
    } finally { this.#changing = false; }
  }

  async #replace(select: () => Promise<DesktopIdentityResolution>, reuseUnchanged = false, settings?: { rollback: () => Promise<void>; reason?: "modules" | "context" }, activate?: () => Promise<void>): Promise<void> {
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
        if (reuseUnchanged && next.threadId === previous.threadId && next.transcriptDirectory === previous.transcriptDirectory) { await activate?.(); return; }
        disposed = true;
        this.#available = false;
        await this.#bridge.shutdown();
        this.#bridge = await this.#make(next);
        this.#available = true;
        this.#recoveryError = undefined;
        this.#identity = next;
        await activate?.();
      } catch (error) {
        if (error instanceof ConfigCommitUncertainError) {
          // rename may already have published a different toolset. Never keep
          // serving the previous controller, and never guess a rollback result.
          this.#available = false;
          this.#recoveryError = error.message;
          configurationError = error.message;
          if (!disposed) await this.#bridge.shutdown();
          throw error;
        }
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
        this.#options.send({ type: "identity-changed", info: this.info(), ...(settings ? { reason: settings.reason ?? "modules", ...(configurationError ? { configurationError } : {}) } : {}) });
      }
    })();
    this.#transition = transition;
    try { await transition; } finally { this.#transition = undefined; }
  }

  selectThread(threadId: string) {
    return this.#replace(() => selectDesktopThread(this.#scope(), threadId));
  }
  createThread(options?: { preserveDraft: boolean; taskDraft?: string; chatDraft?: string }) {
    return this.#replace(async () => {
      if (options !== undefined && (typeof options !== "object" || options === null || typeof options.preserveDraft !== "boolean")) throw new Error("新对话参数无效");
      for (const draft of [options?.taskDraft, options?.chatDraft]) {
        if (draft !== undefined && (typeof draft !== "string" || Buffer.byteLength(draft) > MAX_CONVERSATION_DRAFT_BYTES)) throw new Error("Invalid conversation draft");
      }
      if (options?.taskDraft !== undefined && options.chatDraft !== undefined) throw new Error("Ambiguous draft target");
      if (options?.taskDraft === undefined && options?.chatDraft === undefined && !options?.preserveDraft && (await this.#inspect(this.#identity)).emptyVerified) return this.#identity;
      const thread = await createDesktopThread(this.#scope());
      if (options?.taskDraft !== undefined || options?.chatDraft !== undefined) await new ConversationDraftStore(join(this.#options.applicationHome, "desktop")).saveDraft({ workspaceRoot: this.#identity.workspaceRoot, directory: thread.transcriptDirectory, threadId: thread.threadId }, { text: options.taskDraft ?? options.chatDraft ?? "", excludeFromMemory: false, ...(options.taskDraft !== undefined ? { createTask: true } : {}) });
      return selectDesktopThread(this.#scope(), thread.threadId);
    }, true);
  }
  enableMemory() {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await enableDesktopMemory(this.#identity.configPath, this.#options.cwd, join(this.#options.applicationHome, "data"));
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
  }
  async setModuleEnabled(input: ModuleSettingInput) {
    let undo: (() => Promise<void>) | undefined;
    await this.#replace(async () => {
      undo = await changeModuleSetting(this.#identity.configPath, input, { cwd: this.#options.cwd, dataDirectory: join(this.#options.applicationHome, "data") });
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
    // Unrelated adapter disposal and failed/rolled-back changes never cancel.
    if (input.id === "pomodoro" && !input.enabled) this.#pomodoroService.cancel();
  }
  setAutonomyEnabled(input: AutonomySettingInput) {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await changeAutonomySetting(this.#identity.configPath, input, this.#options.cwd, this.#bridge.info().authorizedDirectory);
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
    await this.#telegram?.close();
    await this.#transition?.catch(() => undefined);
    try { if (this.#available) await this.#bridge.shutdown(); }
    finally { this.#pomodoroService.dispose(); }
  }
}
