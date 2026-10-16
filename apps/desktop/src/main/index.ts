import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { defaultUserDataPath, userDataPathFromEnv } from "./user-data-path.js";
import { app, BrowserWindow, ipcMain, Notification, shell, dialog } from "electron";
import { createDemoModel } from "@aisdk-agent/example-cli/dist/demo-model.js";
import { configureCliModel, inspectCliModelConfig } from "@aisdk-agent/example-cli/dist/model-config.js";
import type { CandidateListInput, CandidateResolveInput } from "@aisdk-agent/example-cli/dist/memory-candidates.js";
import { IPC, type ConfirmInput, type MainToRenderer } from "../shared/ui-contract.js";
import type { WorkTaskInputs, WorkTaskReadInput, WorkTaskArtifactInput } from "../shared/work-tasks.js";
import { parseModuleNotification } from "./runtime-bridge.js";
import { moduleNotificationCopy } from "../shared/human-title.js";
import { RuntimeOwnership } from "./runtime-ownership.js";
import { restoreBackup, previewBackup } from "./backup.js";
import type { RestoreResult } from "../shared/backup.js";
import { ConversationDraftStore } from "./conversation-draft-store.js";
import { ConversationDraftSession } from "./conversation-draft-session.js";
import { installHideOnClose, installTray } from "./tray.js";
import { loadDesktopEnvironment, safeStartupError } from "./desktop-env.js";
import { createDesktopRssWorker } from "./rss-worker-service.js";
import { createNotificationReadiness, openSystemNotificationSettings } from "./notification-readiness.js";
import { configureBundledNotifications } from "./bundled-notifications.js";
import { parseTaskResultLink } from "@aisdk-agent/example-cli/dist/task-result-link.js";
import { openTaskNotificationResult } from "./task-notification-route.js";
import { installDesktopFrontmostHint } from "./desktop-frontmost-hint.js";
import type { RssAction } from "@aisdk-agent/example-cli/dist/rss-subscriptions.js";
// Native icons need true transparent corners and optical padding. The avatar
// stays full-size in the renderer; do not use its opaque square in the Dock.
import appIconPath from "../../resources/serika-dock.png?asset";

const here = fileURLToPath(new URL(".", import.meta.url));
let pendingTaskResultLink: string | null = null;
let taskResultAvailable: (() => void) | undefined;
// macOS can deliver an open-url before app.whenReady and before React mounts.
app.on("open-url", (event, url) => {
  if (parseTaskResultLink(url) === null) return;
  event.preventDefault();
  pendingTaskResultLink = url;
  taskResultAvailable?.();
});

/**
 * The desktop shell reads the same inputs the TUI takes on its command line,
 * but from environment variables so `electron-vite dev` needs no argv plumbing:
 *
 *   RUNLOOM_MODEL        mock | deepseek | minimax-m3 | command-code
 *   RUNLOOM_ENV_FILE     explicit absolute path to main-process credentials/config
 *   RUNLOOM_CONFIG       path to the TUI --config JSON (must be outside the workspace)
 *   RUNLOOM_WORKSPACE    used only when generating the userData config
 *   RUNLOOM_TRANSCRIPTS  explicit transcript directory override
 *   RUNLOOM_THREAD       explicit thread id override
 *   RUNLOOM_USER_DATA    absolute Electron userData directory; applied before ready
 * Omitted identity fields use the saved userData startup preference.
 */

// Pin the existing profile before renaming the visible application. Otherwise
// Electron's name-derived default path could strand the user's old history.
const userDataPath = userDataPathFromEnv(process.env) ?? defaultUserDataPath(app.getPath("appData"));
app.setPath("userData", userDataPath);
app.setName("Serika");

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 320,
    minHeight: 480,
    title: process.env.RUNLOOM_DESKTOP_TEST === "1" ? "Serika · 隔离测试" : "Serika",
    icon: appIconPath,
    // Keep macOS traffic lights native; close still uses installHideOnClose.
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 20 } }
      : { frame: false }),
    transparent: false,
    backgroundColor: "#F9EFEB",
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  // Keep the native test identity visible; the HTML title must not erase it.
  window.on("page-title-updated", event => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(here, "../renderer/index.html"));
  }
  return window;
}

function notifyIfHidden(window: BrowserWindow, message: MainToRenderer): void {
  if (message.type !== "output") return;
  const notification = parseModuleNotification(message.text);
  if (notification === undefined) return;
  if (window.isVisible() && window.isFocused()) return;
  if (!Notification.isSupported()) return;
  const copy = moduleNotificationCopy(notification.moduleId, notification.message);
  const shown = new Notification({ title: copy.title, body: copy.body });
  shown.on("click", () => {
    window.show();
    window.focus();
  });
  shown.show();
}

async function main(): Promise<void> {
  let activeWindow: BrowserWindow | undefined;
  app.on("second-instance", (_event, argv) => {
    const link = argv.find(value => parseTaskResultLink(value) !== null);
    if (link) { pendingTaskResultLink = link; taskResultAvailable?.(); }
    if (activeWindow === undefined || activeWindow.isDestroyed()) return;
    if (activeWindow.isMinimized()) activeWindow.restore();
    activeWindow.show();
    activeWindow.focus();
  });
  await app.whenReady();
  if (process.platform === "darwin") app.dock?.setIcon(appIconPath);
  let quitting = false;
  let shuttingDown = false;
  const window = createWindow();
  activeWindow = window;
  const send = (message: MainToRenderer): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC.message, message);
    notifyIfHidden(window, message);
  };
  taskResultAvailable = () => {
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
    send({ type: "task-result-available" });
  };

  const quit = (): void => {
    quitting = true;
    app.quit();
  };
  const tray = installTray(window, quit);
  installHideOnClose(window, () => quitting);
  ipcMain.handle(IPC.hide, () => {
    window.hide();
  });

  let host!: RuntimeOwnership;
  let frontmostHint: ReturnType<typeof installDesktopFrontmostHint> | undefined;
  // Renderer can load before disk/config initialization finishes. Keep info waiting
  // for the actual result rather than returning a misleading "no IPC handler" error.
  let resolveStartup!: () => void;
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  void startup.catch(() => undefined);
  ipcMain.handle(IPC.pomodoro, (_event, action, minutes) => host.pomodoro(action, minutes));
  ipcMain.handle(IPC.info, async () => { await startup; return host.info(); });
  ipcMain.handle(IPC.taskResultOpen, async () => {
    await startup;
    const link = pendingTaskResultLink;
    pendingTaskResultLink = null;
    if (link === null) return null;
    return openTaskNotificationResult(link, host.info().workspaceRoot, id => host.current.getScheduledTask(id));
  });
  try {
    await loadDesktopEnvironment();
    await configureBundledNotifications({ resourcesPath: process.resourcesPath, desktopRoot: join(here, "../.."), packaged: app.isPackaged, env: process.env });
    const { modelAlias, model } = configureCliModel(createDemoModel, process.env);
    const taskWorkerFor = (workspace: string, configPath?: string) => createDesktopRssWorker({ workspace, ...(configPath ? { configPath } : {}), home: app.getPath("home"), env: process.env,
      workerEntry: fileURLToPath(import.meta.resolve("@aisdk-agent/example-cli/dist/task-worker-entry.js")),
      todoist: !!process.env.TODOIST_API_TOKEN?.trim() });
    host = await RuntimeOwnership.create({
      env: process.env, userData: app.getPath("userData"), cwd: process.cwd(),
      home: app.getPath("home"), hostEntry: join(here, "resident-entry.js"),
      modelAlias, model, modelId: inspectCliModelConfig().modelId, send,
      taskAutomation: { status: (workspace, configPath) => taskWorkerFor(workspace, configPath).automationStatus(), enable: (workspace, configPath) => taskWorkerFor(workspace, configPath).enableArrangement() },
    });
    frontmostHint = installDesktopFrontmostHint(window, () => host.info().workspaceRoot ?? null);
    const rssWorker = () => createDesktopRssWorker({ workspace: host.info().workspaceRoot ?? undefined, ...(host.info().configPath ? { configPath: host.info().configPath! } : {}), home: app.getPath("home"), env: process.env,
      workerEntry: fileURLToPath(import.meta.resolve("@aisdk-agent/example-cli/dist/task-worker-entry.js")), todoist: !!process.env.TODOIST_API_TOKEN?.trim() });
    ipcMain.handle(IPC.rssWorkerStatus, () => rssWorker().status());
    ipcMain.handle(IPC.rssWorkerEnabled, (_event, enabled: unknown) => rssWorker().setEnabled(enabled));
    const notificationScopes = new Map<string, ReturnType<typeof createNotificationReadiness>>();
    const notifications = () => { const workspace = host.info().workspaceRoot ?? undefined, key = workspace ?? "";
      if (!notificationScopes.has(key)) notificationScopes.set(key, createNotificationReadiness({ workspace, env: process.env }));
      return notificationScopes.get(key)!; };
    ipcMain.handle(IPC.notificationStatus, () => notifications().status());
    ipcMain.handle(IPC.notificationTest, () => notifications().test());
    ipcMain.handle(IPC.notificationSettings, () => openSystemNotificationSettings(url => shell.openExternal(url)));
    ipcMain.handle(IPC.residentStatus, () => host.residentStatus());
    ipcMain.handle(IPC.residentEnabled, (_event, enabled: unknown) => host.setResidentEnabled(enabled));
  } catch (error) {
    const message = safeStartupError(error, process.env);
    rejectStartup(new Error(message));
    const report = (): void => send({ type: "error", message });
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", report);
    else report();
    app.on("before-quit", () => { quitting = true; tray.dispose(); });
    return;
  }

  const drafts = new ConversationDraftSession(host, new ConversationDraftStore(app.getPath("userData")));
  ipcMain.handle(IPC.telegramStatus, () => host.telegramStatus());
  ipcMain.handle(IPC.telegramAutonomyEnabled, (_event, input) => host.setTelegramAutonomyEnabled(input));
  ipcMain.handle(IPC.telegramEnabled, (_event, enabled: boolean) => host.setTelegramEnabled(enabled));
  ipcMain.handle(IPC.telegramPairing, () => host.beginTelegramPairing());
  ipcMain.handle(IPC.telegramBind, (_event, code: string) => host.confirmTelegramPairing(code));
  ipcMain.handle(IPC.telegramReview, (_event, input) => host.reviewTelegramInput(input));
  ipcMain.handle(IPC.telegramTaskRoute, (_event, input) => host.setTelegramTaskRoute(input));
  ipcMain.handle(IPC.telegramRetryDelivery, (_event, key) => host.retryTelegramDelivery(key));
  ipcMain.handle(IPC.telegramResolveDelivery, (_event, input) => host.resolveTelegramDelivery(input));
  ipcMain.handle(IPC.draftLoad, (_event, scope) => drafts.load(scope));
  ipcMain.handle(IPC.draftSave, (_event, scope, draft) => drafts.save(scope, draft));
  ipcMain.handle(IPC.taskDraftSave, (_event, scope, update) => drafts.saveTask(scope, update));
  ipcMain.handle(IPC.steerAcknowledge, (_event, scope, id) => drafts.acknowledge(scope, id));
  ipcMain.handle(IPC.steerRelease, (_event, scope, id) => drafts.release(scope, id));
  ipcMain.handle(IPC.retryConnection, () => host.retryConnection());
  ipcMain.handle(IPC.threadsList, (_event, query) => host.listThreads(query));
  ipcMain.handle(IPC.threadCreate, (_event, options) => host.createThread(options));
  ipcMain.handle(IPC.threadSelect, (_event, threadId: string) => host.selectThread(threadId));
  ipcMain.handle(IPC.historyDirectory, async () => {
    const selected = await dialog.showOpenDialog(window, { title: "选择旧对话的 transcript 目录", properties: ["openDirectory"] });
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.threadsDiscover, (_event, directory: string) => host.discoverThreads(directory));
  ipcMain.handle(IPC.threadRegister, (_event, input) => host.registerThread(input));
  ipcMain.handle(IPC.memoryEnable, () => host.enableMemory());
  ipcMain.handle(IPC.memoryConsolidate, (_event, input) => host.current.consolidateMemory(input));
  ipcMain.handle(IPC.memoryConsolidationSources, (_event, offset) => host.current.listMemoryConsolidationSources(offset));
  ipcMain.handle(IPC.snapshot, () => host.current.snapshot());
  ipcMain.handle(IPC.rssGet, () => host.current.getRssSubscriptions());
  ipcMain.handle(IPC.rssUpdate, (_event, input: RssAction) => host.current.updateRssSubscriptions(input));
  ipcMain.handle(IPC.rssInbox, () => host.current.getRssInbox());
  ipcMain.handle(IPC.rssAck, (_event, id: string) => host.current.acknowledgeRssResult(id));
  ipcMain.handle(IPC.taskInbox, () => host.current.getTaskInbox());
  ipcMain.handle(IPC.scheduledTask, (_event, id: string) => host.current.getScheduledTask(id));
  ipcMain.handle(IPC.taskResultAck, (_event, id: string) => host.current.acknowledgeTaskResult(id));
  ipcMain.handle(IPC.contextDiagnostics, () => host.current.getContextDiagnostics());
  ipcMain.handle(IPC.contextMode, (_event, input) => host.setContextMode(input));
  ipcMain.handle(IPC.moduleEnabled, (_event, input) => host.setModuleEnabled(input));
  ipcMain.handle(IPC.automationDiagnostics, () => host.current.getAutomationDiagnostics());
  ipcMain.handle(IPC.automationOverview, () => host.current.getAutomationOverview());
  ipcMain.handle(IPC.scheduleSkill, (_event, input) => host.current.scheduleSkill(input));
  ipcMain.handle(IPC.automationScheduleChange, (_event, input) => host.current.changeAutomationSchedule(input));
  ipcMain.handle(IPC.dreamingOverview, () => host.current.getDreamingOverview());
  ipcMain.handle(IPC.dream, () => host.current.dream());
  ipcMain.handle(IPC.learnedSkillChange, (_event, input) => host.current.changeLearnedSkill(input));
  ipcMain.handle(IPC.learnedSkillReferences, () => host.current.getLearnedSkillReferences());
  ipcMain.handle(IPC.autonomyEnabled, (_event, input) => host.setAutonomyEnabled(input));
  ipcMain.handle(IPC.dreamingEnabled, (_event, input) => host.setDreamingEnabled(input));
  ipcMain.handle(IPC.runSkill, (_event, input) => host.current.runSkill(input));
  ipcMain.handle(IPC.memoryLibraryGet, () => host.current.getMemoryLibrary());
  ipcMain.handle(IPC.memoryDocumentRead, (_event, id) => host.current.readMemoryDocument(id));
  ipcMain.handle(IPC.memoryLibraryChange, (_event, input) => host.current.changeMemoryLibrary(input));
  ipcMain.handle(IPC.memoriesList, (_event, input) => host.current.listMemories(input));
  ipcMain.handle(IPC.memoryGet, (_event, id) => host.current.getMemory(id));
  ipcMain.handle(IPC.previewMemoryImport, (_event, input) => host.current.previewMemoryImport(input));
  ipcMain.handle(IPC.confirmMemoryImport, (_event, input) => host.current.confirmMemoryImport(input));
  ipcMain.handle(IPC.getMemoryImportReceipt, (_event, input) => host.current.getMemoryImportReceipt(input));
  ipcMain.handle(IPC.listRecipes, (_event, input) => host.current.listRecipes());
  ipcMain.handle(IPC.changeRecipe, (_event, input) => host.current.changeRecipe(input));
  ipcMain.handle(IPC.memoryUpdate, (_event, input) => host.current.updateMemory(input));
  ipcMain.handle(IPC.memoryHistory, (_event, input) => host.current.getMemoryHistory(input));
  ipcMain.handle(IPC.memoryQuery, (_event, input) => host.current.queryMemory(input));
  ipcMain.handle(IPC.memoryPreview, (_event, input) => host.current.previewMemoryAction(input));
  ipcMain.handle(IPC.memoryApply, (_event, input) => host.current.applyMemoryAction(input));
  ipcMain.handle(IPC.memoryMaintenance, () => host.current.getMemoryMaintenance());
  ipcMain.handle(IPC.memoryReferences, () => host.current.getMemoryReferences());
  ipcMain.handle(IPC.history, () => host.current.history());
  ipcMain.handle(IPC.historyPage, (_event, input) => host.current.historyPage(input));
  ipcMain.handle(IPC.backupData, async () => {
    if (host.current.snapshot().state.kind !== "idle") throw new Error("请等待当前执行或整理结束，再备份");
    const selected = await dialog.showSaveDialog(window, { title: "备份 Serika 数据", defaultPath: `Serika-${new Date().toISOString().replace(/[:.]/g, "-")}.serika-backup`, filters: [{ name: "Serika 数据备份", extensions: ["serika-backup"] }] });
    if (selected.canceled || !selected.filePath) return null;
    return host.exportBackup(selected.filePath);
  });
  let restoreSelection: { id: string; source: string; fingerprint: string; expires: number; scope: string | null; result?: RestoreResult } | undefined;
  let restoreWorking = false;
  ipcMain.handle(IPC.previewRestoreData, async () => {
    if (restoreWorking) throw new Error("正在处理恢复，请稍候");
    if (host.current.snapshot().state.kind !== "idle") throw new Error("请等待当前执行结束，再恢复副本");
    restoreWorking = true;
    const scope = host.info().workspaceRoot;
    try {
    const selected = await dialog.showOpenDialog(window, { title: "选择 Serika 备份", properties: ["openFile"], filters: [{ name: "Serika 数据备份", extensions: ["serika-backup"] }] });
    if (selected.canceled || !selected.filePaths[0]) return null;
    const preview = await previewBackup(selected.filePaths[0]);
    if (scope !== host.info().workspaceRoot || host.current.snapshot().state.kind !== "idle") throw new Error("工作区或执行状态已改变，请重新选择备份");
    const id = randomUUID();
    restoreSelection = { id, source: selected.filePaths[0], fingerprint: preview.fingerprint, expires: Date.now() + 30 * 60_000, scope };
    const { fingerprint: _fingerprint, ...display } = preview;
    return { ...display, id };
    } finally { restoreWorking = false; }
  });
  ipcMain.handle(IPC.restoreData, async (_event, id: unknown) => {
    if (restoreWorking) throw new Error("正在处理恢复，请稍候");
    const selection = restoreSelection;
    if (typeof id !== "string" || selection?.id !== id || selection.expires <= Date.now() || selection.scope !== host.info().workspaceRoot) throw new Error("请先选择备份并核对预览，过期或切换工作区后需重新选择");
    if (selection.result) throw new Error("此备份已恢复；可直接接回，不会重复创建目录");
    if (host.current.snapshot().state.kind !== "idle") throw new Error("请等待当前执行结束，再恢复副本");
    restoreWorking = true;
    try {
    const location = await dialog.showOpenDialog(window, { title: "选择恢复副本的保存位置（不会覆盖日用数据）", properties: ["openDirectory", "createDirectory"] });
    if (location.canceled || !location.filePaths[0]) return null;
    if (restoreSelection !== selection || selection.expires <= Date.now() || selection.scope !== host.info().workspaceRoot) throw new Error("恢复预览已过期或工作区改变，请重新选择");
    if (host.current.snapshot().state.kind !== "idle") throw new Error("助手已开始执行；恢复未开始，请稍后重试");
    const restored = await restoreBackup(selection.source, location.filePaths[0], selection.fingerprint);
    selection.result = restored;
    shell.showItemInFolder(restored.path); return restored;
    } finally { restoreWorking = false; }
  });
  ipcMain.handle(IPC.activateRestoreData, async (_event, id: unknown) => {
    if (restoreWorking) throw new Error("正在处理恢复，请稍候");
    const selection = restoreSelection;
    if (id !== null && (typeof id !== "string" || selection?.id !== id || !selection.result || selection.expires <= Date.now() || selection.scope !== host.info().workspaceRoot)) throw new Error("恢复副本未准备好或工作区已改变，请重新核对");
    if (id === null && !host.info().recoveryWorkspace) throw new Error("当前不在恢复工作区");
    restoreWorking = true;
    const scope = host.info().workspaceRoot;
    try {
    await drafts.flush();
    if (scope !== host.info().workspaceRoot || id !== null && (selection !== restoreSelection || selection!.expires <= Date.now())) throw new Error("工作区或恢复预览已改变，请重新核对");
    await host.activateRecovery(id === null ? null : selection!.result!.path);
    restoreSelection = undefined;
    } finally { restoreWorking = false; }
  });
  ipcMain.handle(IPC.home, () => host.current.home());
  ipcMain.handle(IPC.run, (_event, text: string, options) => host.current.run(text, options));
  ipcMain.handle(IPC.steer, (_event, input) => drafts.steer(input));
  ipcMain.handle(IPC.cancel, () => host.current.cancel());
  ipcMain.handle(IPC.confirm, (_event, input: ConfirmInput) => host.current.confirm(input));
  ipcMain.handle(IPC.command, (_event, line: string) => host.current.command(line));
  ipcMain.handle(IPC.listRuns, () => host.current.listRuns());
  ipcMain.handle(IPC.getRun, (_event, runId: string) => host.current.getRun(runId));
  ipcMain.handle(IPC.memoryCandidatesList, (_event, input?: CandidateListInput) => host.current.listMemoryCandidates(input));
  ipcMain.handle(IPC.memoryCandidateGet, (_event, id: string) => host.current.getMemoryCandidate(id));
  ipcMain.handle(IPC.memoryCandidateResolve, (_event, input: CandidateResolveInput) => host.current.resolveMemoryCandidate(input));
  ipcMain.handle(IPC.createWorkTask, (_event, input: WorkTaskInputs["createWorkTask"]) => host.current.createWorkTask(input));
  ipcMain.handle(IPC.listWorkTasks, () => host.current.listWorkTasks());
  ipcMain.handle(IPC.getWorkTask, (_event, id: string) => host.current.getWorkTask(id));
  ipcMain.handle(IPC.getWorkTaskDeliveryDraft, (_event, input: WorkTaskReadInput) => host.current.getWorkTaskDeliveryDraft(input));
  ipcMain.handle(IPC.getWorkTaskContinuation, (_event, input: WorkTaskReadInput) => host.current.getWorkTaskContinuation(input));
  ipcMain.handle(IPC.getWorkTaskArtifact, (_event, input: WorkTaskArtifactInput) => host.current.getWorkTaskArtifact(input));
  ipcMain.handle(IPC.runWorkTask, (_event, input: WorkTaskInputs["runWorkTask"]) => host.current.runWorkTask(input));
  ipcMain.handle(IPC.submitWorkTaskDelivery, (_event, input: WorkTaskInputs["submitWorkTaskDelivery"]) => host.current.submitWorkTaskDelivery(input));
  ipcMain.handle(IPC.recordHumanAcceptance, (_event, input: WorkTaskInputs["recordHumanAcceptance"]) => host.current.recordHumanAcceptance(input));
  ipcMain.handle(IPC.reconcileWorkTask, (_event, input: WorkTaskInputs["reconcileWorkTask"]) => host.current.reconcileWorkTask(input));
  ipcMain.handle(IPC.cancelWorkTask, (_event, input: WorkTaskInputs["cancelWorkTask"]) => host.current.cancelWorkTask(input));
  ipcMain.handle(IPC.requestWorkTaskChanges, (_event, input: WorkTaskInputs["requestWorkTaskChanges"]) => host.current.requestWorkTaskChanges(input));
  resolveStartup();

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    quitting = true;
    tray.dispose();
    void Promise.resolve(frontmostHint?.stop()).catch(() => undefined).then(() => drafts.flush().catch(() => undefined)).then(() => host.shutdown()).finally(() => {
      app.quit();
    });
  });
}

if (app.requestSingleInstanceLock()) void main();
else app.quit();
