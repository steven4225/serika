import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Notification, shell, dialog } from "electron";
import { createDemoModel } from "@aisdk-agent/example-cli/dist/demo-model.js";
import { configureCliModel, inspectCliModelConfig } from "@aisdk-agent/example-cli/dist/model-config.js";
import type { CandidateListInput, CandidateResolveInput } from "@aisdk-agent/example-cli/dist/memory-candidates.js";
import { IPC, type ConfirmInput, type MainToRenderer } from "../shared/ui-contract.js";
import type { WorkTaskInputs, WorkTaskReadInput, WorkTaskArtifactInput } from "../shared/work-tasks.js";
import { parseModuleNotification } from "./runtime-bridge.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { installHideOnClose, installTray } from "./tray.js";
import { loadDesktopEnvironment, safeStartupError } from "./desktop-env.js";
import { createDesktopRssWorker } from "./rss-worker-service.js";
import type { RssAction } from "@aisdk-agent/example-cli/dist/rss-subscriptions.js";

const here = fileURLToPath(new URL(".", import.meta.url));

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
 * Omitted identity fields use the saved userData startup preference.
 */

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 320,
    minHeight: 480,
    title: "Runloom",
    frame: false,
    transparent: false,
    backgroundColor: "#fcfbf8",
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
  const shown = new Notification({ title: `Runloom · ${notification.moduleId}`, body: notification.message });
  shown.on("click", () => {
    window.show();
    window.focus();
  });
  shown.show();
}

async function main(): Promise<void> {
  let activeWindow: BrowserWindow | undefined;
  app.on("second-instance", () => {
    if (activeWindow === undefined || activeWindow.isDestroyed()) return;
    if (activeWindow.isMinimized()) activeWindow.restore();
    activeWindow.show();
    activeWindow.focus();
  });
  await app.whenReady();
  let quitting = false;
  let shuttingDown = false;
  const window = createWindow();
  activeWindow = window;
  const send = (message: MainToRenderer): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC.message, message);
    notifyIfHidden(window, message);
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

  let host!: DesktopRuntime;
  // Renderer can load before disk/config initialization finishes. Keep info waiting
  // for the actual result rather than returning a misleading "no IPC handler" error.
  let resolveStartup!: () => void;
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  void startup.catch(() => undefined);
  ipcMain.handle(IPC.info, async () => { await startup; return host.info(); });
  try {
    await loadDesktopEnvironment();
    const { modelAlias, model } = configureCliModel(createDemoModel, process.env);
    host = await DesktopRuntime.create({
      env: process.env, userData: app.getPath("userData"), cwd: process.cwd(),
      modelAlias, model, modelId: inspectCliModelConfig().modelId, send,
    });
    const rssWorker = createDesktopRssWorker({ workspace: host.info().workspaceRoot ?? undefined, home: app.getPath("home"), env: process.env,
      workerEntry: fileURLToPath(import.meta.resolve("@aisdk-agent/example-cli/dist/task-worker-entry.js")) });
    ipcMain.handle(IPC.rssWorkerStatus, () => rssWorker.status());
    ipcMain.handle(IPC.rssWorkerEnabled, (_event, enabled: unknown) => rssWorker.setEnabled(enabled));
  } catch (error) {
    const message = safeStartupError(error, process.env);
    rejectStartup(new Error(message));
    const report = (): void => send({ type: "error", message });
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", report);
    else report();
    app.on("before-quit", () => tray.dispose());
    return;
  }

  ipcMain.handle(IPC.threadsList, () => host.listThreads());
  ipcMain.handle(IPC.threadCreate, () => host.createThread());
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
  ipcMain.handle(IPC.contextDiagnostics, () => host.current.getContextDiagnostics());
  ipcMain.handle(IPC.memoriesList, (_event, input) => host.current.listMemories(input));
  ipcMain.handle(IPC.memoryGet, (_event, id) => host.current.getMemory(id));
  ipcMain.handle(IPC.memoryUpdate, (_event, input) => host.current.updateMemory(input));
  ipcMain.handle(IPC.memoryHistory, (_event, input) => host.current.getMemoryHistory(input));
  ipcMain.handle(IPC.memoryQuery, (_event, input) => host.current.queryMemory(input));
  ipcMain.handle(IPC.memoryPreview, (_event, input) => host.current.previewMemoryAction(input));
  ipcMain.handle(IPC.memoryApply, (_event, input) => host.current.applyMemoryAction(input));
  ipcMain.handle(IPC.memoryMaintenance, () => host.current.getMemoryMaintenance());
  ipcMain.handle(IPC.memoryReferences, () => host.current.getMemoryReferences());
  ipcMain.handle(IPC.history, () => host.current.history());
  ipcMain.handle(IPC.home, () => host.current.home());
  ipcMain.handle(IPC.run, (_event, text: string, options) => host.current.run(text, options));
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
    void host.shutdown().finally(() => {
      app.quit();
    });
  });
}

if (app.requestSingleInstanceLock()) void main();
else app.quit();
