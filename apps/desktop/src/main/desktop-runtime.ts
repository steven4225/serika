import { ChannelEffectGuard } from "./channel-effect-guard.js";
import { createHash } from "node:crypto";
import { createThreadTranscriptReader } from "@aisdk-agent/core";
import type { UIMessage } from "ai";
import { historyPage, type HistoryPageInput } from "../shared/history.js";
import { readQqConfig, type QqConfig } from "./qq-config.js";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { tryAcquireFlock, type FlockHandle } from "@aisdk-agent/example-cli/dist/flock.js";
import type { ChannelAccountStatus, ChannelAccount, ChannelTarget } from "../shared/channels.js";
import { ComputerConnection } from "./computer-connection.js";
import type { ComputerConnectionInput } from "../shared/ui-contract.js";
import { HerdrTargets } from "./herdr-target.js";
import type { HerdrTargetInput } from "../shared/ui-contract.js";
import type { LanguageModel } from "ai";
import { createRuntimeApp, type TaskAutomationHost } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import { enableDesktopMemory, resolveDesktopConfig } from "./desktop-config.js";
import { createDesktopThread, listDesktopThreads, registerDesktopThread, resolveDesktopIdentity, selectDesktopThread, type DesktopIdentityResolution } from "./desktop-identity.js";
import { discoverThreadDirectory, inspectThread } from "./thread-history.js";
import { RuntimeBridge, TeeOutput, type Send } from "./runtime-bridge.js";
import { changeModuleSetting, changeDreamingSetting, changeAutonomySetting, changeTelegramAutonomySetting, type AutonomySettingInput, ConfigCommitUncertainError, type ModuleSettingInput, type DreamingSettingInput } from "./module-settings.js";
import type { AppInfo, ContextModeInput } from "../shared/ui-contract.js";
import { readLoadedBuild } from "./build-identity.js";
import { createPomodoroService, type PomodoroService } from "@aisdk-agent/example-cli/dist/modules/pomodoro-module.js";
import { ExecutionRecordStore } from "@aisdk-agent/example-cli/dist/execution-record-store.js";
import type { RunRecord } from "@aisdk-agent/core";
import type { TelegramGateway } from "./telegram-gateway.js";
import { telegramUnavailable } from "../shared/telegram.js";
import { createTaskStore, type TaskListInput } from "@aisdk-agent/example-cli/dist/task-store.js";
import { exportBackup } from "./backup.js";
import { ConversationDraftStore } from "./conversation-draft-store.js";
import { MAX_CONVERSATION_DRAFT_BYTES } from "../shared/conversation-drafts.js";
import { changeContextMode } from "./context-settings.js";

interface Options { userData: string; cwd: string; env: NodeJS.ProcessEnv; modelAlias: string; modelId?: string; model: LanguageModel; send: Send; taskAutomation?: TaskAutomationHost; /** Ownership transfers to this host, including final disposal. */ pomodoroService?: PomodoroService }

/** Owns desktop selection only. Each selected Thread still uses the original controller/loop. */
export class DesktopRuntime {
  #options: Options;
  #identity!: DesktopIdentityResolution;
  #bridge!: RuntimeBridge;
  #computer?: ComputerConnection;
  #changing = false;
  #transition: Promise<void> | undefined;
  #available = true;
  #lastInfo!: AppInfo;
  #recoveryError: string | undefined;
  #pomodoroService: PomodoroService;
  #qqAccounts = new Map<string, { name: string; config: QqConfig }>();
  #telegrams = new Map<string, TelegramGateway>();
  #botClaims = new Map<number, { gateway: TelegramGateway; lease: FlockHandle }>();
  #telegram: TelegramGateway | undefined;
  #accountFailures = new Map<string, { account: ChannelAccount; message: string }>();
  #telegramFailure: string | undefined;
  #channelBindings = new Map<string, import("@aisdk-agent/example-cli/dist/tui-module-config.js").TelegramAutonomyGrant | null>();
  #sourceBarriers = new Map<string, (record: RunRecord) => Promise<void>>();
  #runtimes = new Map<string, RuntimeBridge>();
  #poolTail: Promise<unknown> = Promise.resolve();
  #creating = new Map<string, Promise<RuntimeBridge>>();
  #registryTail: Promise<unknown> = Promise.resolve();
  #admitted = new Map<string, string>();
  #effects!: ChannelEffectGuard;
  #idleBacklogs = new Set<string>();
  #backgroundOwner: string | undefined;
  #closed = false;
  viewRevision = 0;
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
    const host = new DesktopRuntime(options);
    try {
      const config = await resolveDesktopConfig(options);
      const modules = await resolveTuiModuleConfig({ configPath: config.configPath }, { cwd: options.cwd });
      host.#identity = await resolveDesktopIdentity({ ...options, configPath: modules.configPath!, workspaceRoot: modules.workspaceRoot });
      host.#effects = new ChannelEffectGuard(join(options.userData, "channel-resources", `${createHash("sha256").update(host.#identity.workspaceRoot ?? host.#identity.transcriptDirectory).digest("hex")}.json`), host.#identity.workspaceRoot ?? host.#identity.transcriptDirectory);
      await host.#effects.load();
      const resource = host.#effects.snapshot();
      if (resource) {
        const thread = (await listDesktopThreads(host.#scope())).find(item => item.threadId === resource.threadId);
        const run = thread ? await new ExecutionRecordStore(thread.transcriptDirectory).getRun(thread.threadId, resource.runId) : null;
        if (run && !["running", "interrupted"].includes(run.status) && !run.tools.some(tool => tool.status === "unknown")) await host.#effects.release(resource.threadId, resource.runId);
      }
      host.#bridge = await host.#make(host.#identity);
      host.#runtimes.set(host.#identity.threadId, host.#bridge);
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
  attachTelegram(gateway: TelegramGateway) {
    const id = gateway.identity.accountId ?? "default";
    if (this.#telegrams.has(id)) throw new Error("Telegram already attached");
    this.#telegrams.set(id, gateway);
    if (id === "default" || !this.#telegram) this.#telegram = gateway;
  }
  async releaseTelegramBot(gateway: TelegramGateway) {
    for (const [id, claim] of this.#botClaims) if (claim.gateway === gateway) { this.#botClaims.delete(id); await claim.lease.release(); }
  }
  async claimTelegramBot(botId: number, gateway: TelegramGateway) {
    const existing = this.#botClaims.get(botId);
    if (existing) { if (existing.gateway !== gateway) throw new Error("同一 Bot 已有 poller"); return; }
    const directory = join(this.#options.userData, "telegram-bots");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lease = await tryAcquireFlock(join(directory, `${botId}.lock`));
    if (!lease) throw new Error("同一 Bot 已有 poller");
    this.#botClaims.set(botId, { gateway, lease });
  }
  #telegramFor(target?: ChannelTarget) {
    if (target && (typeof target !== "object" || Array.isArray(target) || Object.keys(target).some(key => !["accountId", "topicId"].includes(key)) || target.topicId !== undefined && (!Number.isSafeInteger(target.topicId) || target.topicId <= 0))) throw new Error("通道目标无效");
    if (target?.accountId && this.#accountFailures.has(target.accountId)) throw new Error("该账号的配置或记录需核对，请恢复后重启");
    const gateway = target?.accountId ? this.#telegrams.get(target.accountId) : this.#telegram;
    if (!gateway) throw new Error("请先配置并连接通道账号");
    return gateway.conversation(target?.topicId);
  }
  async registerQqAccount(account: Extract<ChannelAccount, { platform: "qq" }>) {
    const config = await readQqConfig(account.configPath);
    if (config.binding.workspace === this.#identity.workspaceRoot) throw new Error("QQ 必须使用独立群工作区");
    if ([...this.#qqAccounts.values()].some(item => item.config.binding.botId === config.binding.botId && item.config.binding.groupId === config.binding.groupId)) throw new Error("同一 QQ 群不可重复注册");
    this.#qqAccounts.set(account.id, { name: account.name, config });
  }
  channelAccounts(): ChannelAccountStatus[] {
    const telegram: ChannelAccountStatus[] = [...this.#telegrams.values()].map(gateway => {
      const status = gateway.status(), data = gateway.store.snapshot(), accountId = gateway.identity.accountId ?? "default";
      return { platform: "telegram", id: accountId, name: gateway.identity.name ?? "Telegram", botId: data.botId, connection: status.connection,
        conversations: [status, ...(status.conversations ?? [])].flatMap(item => item.owner ? [{ platform: "telegram" as const, accountId, kind: item.topicId ? "topic" as const : "private" as const,
          externalId: String(item.owner.chatId), ...(item.topicId ? { topicId: item.topicId } : {}), workspace: data.workspace, threadId: item.owner.threadId, revision: item.bindingRevision ?? 1 }] : []) };
    });
    return [...telegram.filter(account => !this.#accountFailures.has(account.id)), ...[...this.#accountFailures.values()].map(({ account, message }): ChannelAccountStatus => ({ platform: account.platform, id: account.id, name: account.name, botId: null, connection: "failed", message, conversations: [] })), ...[...this.#qqAccounts].map(([id, { name, config }]): ChannelAccountStatus => ({ platform: "qq", id, name, botId: config.binding.botId, connection: "unverified",
      message: "已显式注册外部 QQ 配置；未验证独立群助手的在线状态。只读查看不启动 Controller，也不能代替 owner 审批。",
      conversations: [{ platform: "qq", accountId: id, kind: "group", externalId: String(config.binding.groupId), workspace: config.binding.workspace, threadId: config.binding.threadId, revision: 1, readOnly: true }] }))];
  }
  async channelHistory(accountId: string, input?: HistoryPageInput) {
    const account = this.#qqAccounts.get(accountId);
    if (!account) throw new Error("只能查看可信配置显式注册的 QQ 群");
    const { threadId } = account.config.binding;
    const path = join(account.config.stateDirectory, "transcripts", `${createHash("sha256").update(threadId).digest("hex")}.jsonl`);
    const transcript = await createThreadTranscriptReader()(path, threadId);
    return historyPage(transcript.messages as UIMessage[], threadId, input);
  }
  telegramAccounts() { return [...[...this.#telegrams.values()].filter(gateway => !this.#accountFailures.has(gateway.identity.accountId ?? "default")).map(gateway => gateway.status()),
    ...[...this.#accountFailures.values()].filter(item => item.account.platform === "telegram").map(({ account, message }) => ({ ...telegramUnavailable(), available: true, accountId: account.id, accountName: account.name, connection: "failed" as const, lastError: message }))]; }
  telegramStatus(target?: ChannelTarget) { return this.#telegramFailure ? { ...telegramUnavailable(), available: true, connection: "failed" as const, lastError: this.#telegramFailure } : this.#telegrams.size ? this.#telegramFor(target).status() : telegramUnavailable(); }
  telegramFailed(account?: ChannelAccount) { if (account) { this.#accountFailures.set(account.id, { account, message: "该账号配置或记录未确认，未接收消息；请核对可信配置和状态文件后重启，不会重建绑定或重做执行。" }); return; } this.#telegramFailure = "Telegram 配置或记录无法读取，未接收消息。桌面助手仍可使用；请检查可信环境文件和通道状态文件后重启。不会重建绑定或重做执行。"; }
  channelTelegramAutonomyEnabled(grant?: import("@aisdk-agent/example-cli/dist/tui-module-config.js").TelegramAutonomyGrant | null) { return this.#available && this.#bridge.telegramAutonomyEnabled(grant); }
  channelTelegramToolApprovalSkipped(grant?: import("@aisdk-agent/example-cli/dist/tui-module-config.js").TelegramAutonomyGrant | null) { return this.#available && this.#bridge.telegramToolApprovalSkipped(grant); }
  async setTelegramAutonomyEnabled(input: import("../shared/telegram.js").TelegramAutonomySettingInput, target?: ChannelTarget) {
    let undo: (() => Promise<void>) | undefined;
    await this.#replace(async () => {
      const binding = this.#telegramFor(target).autonomyBinding();
      if (!binding || binding.workspaceRoot !== this.#identity.workspaceRoot) throw new Error("请先连接并核对当前工作区的 Telegram 私聊绑定");
      undo = await changeTelegramAutonomySetting(this.#identity.configPath, input, this.#options.cwd, binding, this.#bridge.telegramAutonomyEnabled(binding));
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
    return this.telegramStatus(target);
  }
  async changeTelegramBinding(input: { threadId: string | null; expectedRevision: number }, target?: ChannelTarget) {
    const gateway = this.#telegramFor(target);
    if (!input || input.threadId !== null && (typeof input.threadId !== "string" || !(await listDesktopThreads(this.#scope())).some(thread => thread.threadId === input.threadId))) throw new Error("请选择当前工作区已登记的对话");
    return gateway.changeBinding(input);
  }
  setTelegramEnabled(enabled: boolean, target?: ChannelTarget) { return this.#telegramFor(target).setEnabled(enabled); }
  beginTelegramPairing(target?: ChannelTarget) { return this.#telegramFor(target).beginPairing(); }
  confirmTelegramPairing(code: string, target?: ChannelTarget) { return this.#telegramFor(target).confirmPairing(code); }
  reviewTelegramInput(input: { key: string; note: string }, target?: ChannelTarget) { return this.#telegramFor(target).reviewInput(input); }
  setTelegramTaskRoute(input: { id: string; kind: "once" | "recurring"; enabled: boolean }, target?: ChannelTarget) { return this.#telegramFor(target).setTaskRoute(input); }
  retryTelegramDelivery(key: string, target?: ChannelTarget) { return this.#telegramFor(target).retryDelivery(key); }
  resolveTelegramDelivery(input: { key: string; action: "cancel" | "review"; note?: string }, target?: ChannelTarget) { return this.#telegramFor(target).resolveDelivery(input); }
  /** Host-only channel surface, deliberately not in resident IPC's method whitelist. */
  channelSubscribe(listener: Send) { this.#channelListeners.add(listener); return () => { this.#channelListeners.delete(listener); }; }
  channelResourceStatus() { return this.#effects.snapshot(); }
  async reviewChannelResource(input: { threadId: string; runId: string; note: string }) {
    const owner = this.#effects.snapshot();
    if (!input || typeof input.note !== "string" || !input.note.trim() || input.note.length > 2000 || !owner || owner.threadId !== input.threadId || owner.runId !== input.runId || this.#admitted.has(input.threadId) || this.channelSnapshot(input.threadId).snapshot.state.kind !== "idle") throw new Error("请先停止原执行并填写实际核对观察；资源归属已变化时请刷新");
    // The report is explicit release authority, never a claim that unknown effects succeeded.
    await this.#effects.release(input.threadId, input.runId, input.note.trim());
  }
  channelAdmissionAvailable(threadId: string) { return this.#admitted.has(threadId) || this.#admitted.size < 2; }
  channelBridge(threadId: string) {
    const bridge = this.#runtimes.get(threadId);
    if (!bridge) throw new Error("该对话尚未连接");
    return bridge;
  }
  channelSnapshot(threadId?: string) {
    const bridge = threadId ? this.#runtimes.get(threadId) : this.#bridge;
    return { info: bridge?.info() ?? { ...this.info(), ...(threadId ? { threadId } : {}) }, snapshot: bridge?.snapshot() ?? { ...this.#bridge.snapshot(), state: { kind: "idle" as const }, pendingApproval: null } };
  }
  #registry<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#registryTail.then(operation);
    this.#registryTail = result.catch(() => undefined);
    return result;
  }
  async #threadBridge(threadId: string) {
    if (this.#closed || this.#changing || !this.#available) throw new Error("助手正在关闭或更新配置");
    const existing = this.#runtimes.get(threadId);
    if (existing) return existing;
    let pending = this.#creating.get(threadId);
    if (!pending) {
      pending = this.#poolTail.then(async () => {
        if (this.#runtimes.size >= 8) {
          const idle = [...this.#runtimes].find(([id, bridge]) => id !== this.#identity.threadId && !this.#sourceBarriers.has(id) && !this.#admitted.has(id) && id !== this.#backgroundOwner && bridge.snapshot().state.kind === "idle");
          if (!idle) throw new Error("运行实例已满，请等待现有操作结算");
          this.#runtimes.delete(idle[0]); await idle[1].shutdown();
        }
        const thread = (await listDesktopThreads(this.#scope())).find(item => item.threadId === threadId);
        if (!thread) throw new Error("对话未登记到当前工作区");
        const bridge = await this.#make({ ...this.#identity, ...thread, identitySource: "saved" });
        this.#runtimes.set(threadId, bridge);
        return bridge;
      }).finally(() => this.#creating.delete(threadId));
      this.#poolTail = pending.catch(() => undefined);
      this.#creating.set(threadId, pending);
    }
    return pending;
  }
  /** Original workspace TaskStore, independent of foreground capability switches. */
  #channelTaskStore() {
    if (!this.#identity.workspaceRoot) throw new Error("当前没有确定的工作区，未读取安排");
    return createTaskStore(this.#identity.workspaceRoot);
  }
  channelScheduledTask(id: string) { return this.#channelTaskStore().get(id); }
  async channelRecurringTask(id: string) {
    const result = await this.#channelTaskStore().getRecurring(id);
    return result.ok ? { ok: true as const, value: result.value?.recurringTask ?? null } : result;
  }
  channelScheduledTasks(input: TaskListInput) { return this.#channelTaskStore().list(input); }
  async channelEnsureThread(threadId: string) {
    return this.#registry(async () => {
      const existing = (await listDesktopThreads(this.#scope())).find(thread => thread.threadId === threadId);
      if (existing) return existing;
      if (!/^[a-f0-9-]{36}$/.test(threadId)) throw new Error("无效的宿主 Thread ID");
      const thread = { threadId, transcriptDirectory: join(this.#options.userData, "transcripts", threadId) };
      await registerDesktopThread(this.#scope(), thread);
      return thread;
    });
  }
  async channelCreateThread() { return this.#registry(() => createDesktopThread(this.#scope())); }
  async channelReceipt(threadId: string, runId: string) {
    const thread = (await listDesktopThreads(this.#scope())).find(item => item.threadId === threadId);
    if (!thread) throw new Error("Telegram 对话未登记到当前工作区");
    return new ExecutionRecordStore(thread.transcriptDirectory).getRun(threadId, runId);
  }
  async channelRun(threadId: string, text: string, task: boolean, bind: (record: RunRecord, taskId: string | null) => Promise<void>, receivedAt?: string, binding?: import("@aisdk-agent/example-cli/dist/tui-module-config.js").TelegramAutonomyGrant | null) {
    const bridge = await this.#threadBridge(threadId);
    if (this.#sourceBarriers.has(threadId) || !bridge.snapshot().canSubmit) return { ok: false as const, reason: "busy" as const };
    const release = bridge.reserveChannel();
    let taskId: string | null = null;
    this.#channelBindings.set(threadId, binding ?? null);
    this.#sourceBarriers.set(threadId, record => bind(record, taskId));
    try {
      await bridge.yieldBackground();
      if (task) {
        const created = await bridge.createWorkTask({ goal: text, acceptance: [{ id: "user-quality", description: "用户确认任务结果符合需求", required: true, method: "human", verification: { kind: "human" } }] });
        if (!created.ok) throw new Error("工作任务未能保存，未启动执行");
        taskId = created.value.id;
        return await bridge.runWorkTaskFromChannel({ id: taskId, expectedRevision: created.value.revision });
      }
      return await bridge.runFromChannel(text, receivedAt);
    } finally { this.#sourceBarriers.delete(threadId); this.#channelBindings.delete(threadId); release(); }
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
  getLifecycleStatus() { return { activeRuns: [...this.#runtimes.values()].filter(bridge => bridge.snapshot().state.kind !== "idle").length + this.#creating.size, pomodoroRunning: this.#pomodoroService.status().status.state === "running" }; }
  info(): AppInfo {
    const info = this.#available ? this.#bridge.info() : this.#lastInfo;
    return { ...info, viewRevision: this.viewRevision, attachments: true, pomodoroControls: true, memoryLibrary: true, build: readLoadedBuild(), ...(this.#recoveryError ? { runtimeRecovery: { state: "failed" as const, message: this.#recoveryError } } : {}) };
  }
  #scope() { return { ...this.#options, configPath: this.#identity.configPath, workspaceRoot: this.#identity.workspaceRoot }; }
  #assertIdle() {
    if (!this.#available) throw new Error(this.#recoveryError ?? "助手连接未恢复，请重新连接");
    if (this.#changing || this.#creating.size || this.#sourceBarriers.size || [...this.#runtimes.values()].some(bridge => bridge.snapshot().state.kind !== "idle")) throw new Error("请先等待当前执行或整理结束，再切换会话");
  }

  #resumeBackground() {
    if (this.#closed || this.#changing || this.#admitted.size || this.#backgroundOwner) return;
    for (const id of this.#idleBacklogs) {
      this.#idleBacklogs.delete(id);
      this.#runtimes.get(id)?.resumeBackground();
      if (this.#backgroundOwner) break;
    }
  }
  async #make(identity: DesktopIdentityResolution): Promise<RuntimeBridge> {
    const config = await resolveTuiModuleConfig({ configPath: identity.configPath }, { cwd: this.#options.cwd });
    if (config.workspaceRoot !== identity.workspaceRoot) throw new Error("配置工作区已变化，请恢复原工作区配置后重新连接；不会混入其他工作区");
    const send: Send = message => {
      for (const listener of this.#channelListeners) listener(message);
      if (message.type === "state" && message.state.kind === "idle") {
        const foregroundEnded = this.#admitted.delete(identity.threadId);
        if (foregroundEnded) { this.#idleBacklogs.add(identity.threadId); queueMicrotask(() => this.#resumeBackground()); }
        const owner = this.#effects.snapshot();
        if (owner?.threadId === identity.threadId && !owner.unknown) {
          void new ExecutionRecordStore(identity.transcriptDirectory).getRun(identity.threadId, owner.runId).then(async run => {
            if (!run || run.status === "running" || run.status === "interrupted" || run.tools.some(tool => tool.status === "unknown")) this.#effects.markUnknown(identity.threadId, owner.runId);
            else await this.#effects.release(identity.threadId, owner.runId);
          }).catch(() => this.#effects.markUnknown(identity.threadId, owner.runId));
        }
      }
      if (identity.threadId === this.#identity.threadId && this.#available) this.#options.send(message);
    };
    const output = new TeeOutput(send);
    const app = await createRuntimeApp({
      args: ["--tui", identity.transcriptDirectory, "--thread", identity.threadId, "--config", identity.configPath],
      modelAlias: this.#options.modelAlias, model: this.#options.model, output, env: this.#options.env, cwd: this.#options.cwd,
      pomodoroService: this.#pomodoroService,
      allowWorkspaceTaskReads: true,
      allowDesktopAutonomy: true,
      allowLocalTerminalControl: true,
      authorizeTelegramAutonomy: grant => {
        const binding = this.#channelBindings.get(identity.threadId);
        return !!binding && ["workspaceRoot", "botId", "userId", "chatId", "threadId", "topicId", "bindingRevision"].every(key => grant[key as keyof typeof grant] === binding[key as keyof typeof binding]) && [...this.#telegrams.values()].some(gateway => gateway.authorizesRun(grant));
      },
      beforePrimaryRunCreate: async record => {
        if (this.#closed || this.#changing) throw new Error("助手正在关闭或更新配置");
        if (!this.#admitted.has(identity.threadId) && this.#admitted.size >= 2) throw new Error("当前工作区已有两个活动执行（含等待审批），本条未排队");
        this.#admitted.set(identity.threadId, record.id);
        try {
          for (const [threadId, bridge] of this.#runtimes) if (threadId !== identity.threadId) await bridge.yieldBackground();
          await this.#sourceBarriers.get(identity.threadId)?.(record);
        } catch (error) { this.#admitted.delete(identity.threadId); throw error; }
      },
      backgroundAdmission: () => {
        if (this.#closed || this.#changing) return null;
        if (this.#admitted.size || this.#backgroundOwner) { this.#idleBacklogs.add(identity.threadId); return null; }
        this.#backgroundOwner = identity.threadId;
        return () => { if (this.#backgroundOwner === identity.threadId) this.#backgroundOwner = undefined; queueMicrotask(() => this.#resumeBackground()); };
      },
      beforeToolDispatch: async input => {
        // Unknown tools default to effects. Only explicitly read-only registrations bypass the domain.
        if (["add", "capability_status", "list_directory", "web_fetch", "web_search", "feed_read",
          // These built-in stores serialize their own mutations with workspace locks/CAS.
          "memory_list", "memory_get", "memory_query", "memory_add", "memory_update", "memory_delete", "memory_revise", "memory_candidates_list", "memory_apply_candidate", "memory_prepare_consolidation", "memory_stage_candidates",
          "task_list", "task_get", "task_create", "task_cancel", "task_reschedule", "task_ack", "task_repeat_create", "task_repeat_list", "task_repeat_get", "task_repeat_pause", "task_repeat_resume", "task_repeat_cancel"].includes(input.toolName)) return { allow: true };
        const runId = this.#admitted.get(identity.threadId);
        if (!runId) return { allow: false, reason: "副作用未取得前台执行归属" };
        if (!await this.#effects.claim(identity.threadId, runId)) return { allow: false, reason: "工作区修改资源被其他执行占用或效果待核对；本次未派发，请等结算后明确重试" };
        return { allow: true };
      },
      afterTaskArrangementSaved: async saved => { for (const gateway of this.#telegrams.values()) await gateway.arrangementSaved(saved, identity.threadId); },
      taskArrangementDestination: () => [...this.#telegrams.values()].map(gateway => gateway.arrangementDestination(identity.threadId)).find(Boolean) ?? null,
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
        identitySource: identity.identitySource, entryMode: this.#options.env.RUNLOOM_DESKTOP_TEST === "1" ? "test" : "daily" }, output, send);
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
      if (!this.#identity.workspaceRoot) throw new Error("没有固定工作区，不能备份");
      const threads = await listDesktopThreads(this.#scope());
      if (!threads.some(thread => thread.threadId === this.#identity.threadId && thread.transcriptDirectory === this.#identity.transcriptDirectory)) threads.unshift(this.#identity);
      return await exportBackup({ workspace: this.#identity.workspaceRoot, threads, destination,
        knownSecrets: Object.entries(this.#options.env).filter(([key]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)/i.test(key)).flatMap(([, value]) => value ? [value] : []) });
    } finally { this.#changing = false; }
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

  async #replace(select: () => Promise<DesktopIdentityResolution>, reuseUnchanged = false, settings?: { rollback: () => Promise<void>; reason?: "modules" | "context" | "terminal" | "computer" }, activate?: () => Promise<void>): Promise<void> {
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
        await Promise.all([...this.#runtimes.values()].map(bridge => bridge.shutdown()));
        this.#runtimes.clear();
        this.#bridge = await this.#make(next);
        this.#runtimes.set(next.threadId, this.#bridge);
        this.#available = true;
        this.#recoveryError = undefined;
        this.viewRevision++;
        this.#identity = next;
        await activate?.();
      } catch (error) {
        if (error instanceof ConfigCommitUncertainError) {
          // rename may already have published a different toolset. Never keep
          // serving the previous controller, and never guess a rollback result.
          this.#available = false;
          this.#recoveryError = error.message;
          configurationError = error.message;
          if (!disposed) await Promise.all([...this.#runtimes.values()].map(bridge => bridge.shutdown()));
          this.#runtimes.clear();
          throw error;
        }
        if (settings) configurationError = error instanceof Error ? error.message : String(error);
        let rollbackFailed = false;
        try { await settings?.rollback(); } catch { rollbackFailed = true; }
        if (disposed) {
          try {
            this.#bridge = await this.#make(previous);
            this.#runtimes.set(previous.threadId, this.#bridge);
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

  async selectThread(threadId: string) {
    const bridge = await this.#threadBridge(threadId);
    await this.#registry(async () => {
      if (this.#closed || this.#changing) throw new Error("助手正在关闭或更新配置");
      this.viewRevision++;
      this.#identity = await selectDesktopThread(this.#scope(), threadId);
      this.#bridge = bridge;
      this.#options.send({ type: "identity-changed", info: this.info() });
    });
  }
  createThread(options?: { preserveDraft: boolean; taskDraft?: string; chatDraft?: string }) {
    return this.#registry(async () => {
      if (options !== undefined && (typeof options !== "object" || options === null || typeof options.preserveDraft !== "boolean")) throw new Error("新对话参数无效");
      for (const draft of [options?.taskDraft, options?.chatDraft]) {
        if (draft !== undefined && (typeof draft !== "string" || Buffer.byteLength(draft) > MAX_CONVERSATION_DRAFT_BYTES)) throw new Error("Invalid conversation draft");
      }
      if (options?.taskDraft !== undefined && options.chatDraft !== undefined) throw new Error("Ambiguous draft target");
      if (options?.taskDraft === undefined && options?.chatDraft === undefined && !options?.preserveDraft && (await this.#inspect(this.#identity)).emptyVerified) return;
      const thread = await createDesktopThread(this.#scope());
      if (options?.taskDraft !== undefined || options?.chatDraft !== undefined) await new ConversationDraftStore(this.#options.userData).saveDraft({ workspaceRoot: this.#identity.workspaceRoot, directory: thread.transcriptDirectory, threadId: thread.threadId }, { text: options.taskDraft ?? options.chatDraft ?? "", excludeFromMemory: false, ...(options.taskDraft !== undefined ? { createTask: true } : {}) });
      const bridge = await this.#threadBridge(thread.threadId);
      this.viewRevision++;
      this.#identity = await selectDesktopThread(this.#scope(), thread.threadId);
      this.#bridge = bridge;
      this.#options.send({ type: "identity-changed", info: this.info() });
    });
  }
  enableMemory() {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await enableDesktopMemory(this.#identity.configPath, this.#options.cwd);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
  }
  async setModuleEnabled(input: ModuleSettingInput) {
    let undo: (() => Promise<void>) | undefined;
    await this.#replace(async () => {
      undo = await changeModuleSetting(this.#identity.configPath, input, this.#options.cwd);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); } });
    // Unrelated adapter disposal and failed/rolled-back changes never cancel.
    if (input.id === "pomodoro" && !input.enabled) this.#pomodoroService.cancel();
  }
  #computerConnection() {
    return this.#computer ??= new ComputerConnection({ ...this.#options, configPath: this.#identity.configPath, workspaceRoot: this.#identity.workspaceRoot });
  }
  async #computerOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertIdle(); this.#changing = true;
    this.#send({ type: "state", state: { kind: "command", name: "computer-connection" } });
    const transition = operation();
    this.#transition = transition.then(() => {}, () => {});
    try { return await transition; }
    finally { this.#changing = false; this.#transition = undefined; this.#send({ type: "state", state: { kind: "idle" } }); }
  }
  getComputerConnection() { this.current; return this.#computerConnection().view(); }
  selectComputerDriver(path: string) { return this.#computerOperation(() => this.#computerConnection().select(path)); }
  discoverComputerApps(token: string) { return this.#computerOperation(() => this.#computerConnection().discover(token)); }
  checkComputerConnection() { return this.#computerOperation(() => this.#computerConnection().check()); }
  async saveComputerConnection(input: ComputerConnectionInput) {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await this.#computerConnection().save(input);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); }, reason: "computer" });
  }
  listHerdrSessions() { this.current; return new HerdrTargets(this.#options.env, this.#options.cwd, this.#identity.workspaceRoot).sessions(); }
  listHerdrPanes(session: string) { this.current; return new HerdrTargets(this.#options.env, this.#options.cwd, this.#identity.workspaceRoot).panes(session); }
  setHerdrTarget(input: HerdrTargetInput) {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await new HerdrTargets(this.#options.env, this.#options.cwd, this.#identity.workspaceRoot).bind(this.#identity.configPath, this.#options.cwd, this.#identity.workspaceRoot, input);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); }, reason: "terminal" });
  }
  setAutonomyEnabled(input: AutonomySettingInput) {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await changeAutonomySetting(this.#identity.configPath, input, this.#options.cwd, this.#identity.workspaceRoot);
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
  setContextMode(input: ContextModeInput) {
    let undo: (() => Promise<void>) | undefined;
    return this.#replace(async () => {
      undo = await changeContextMode(this.#identity.configPath, input, this.#options.cwd);
      return this.#identity;
    }, false, { rollback: async () => { await undo?.(); }, reason: "context" });
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
        this.#runtimes.set(this.#identity.threadId, this.#bridge);
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
    this.#closed = true;
    await Promise.all([...this.#telegrams.values()].map(gateway => gateway.close()));
    await this.#transition?.catch(() => undefined);
    await Promise.allSettled([...this.#creating.values()]);
    try { await Promise.all([...this.#runtimes.values()].map(bridge => bridge.shutdown())); this.#runtimes.clear(); }
    finally { for (const claim of this.#botClaims.values()) await claim.lease.release(); this.#pomodoroService.dispose(); }
  }
}
