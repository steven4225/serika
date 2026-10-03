import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import { createRuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { createDemoModel } from "@aisdk-agent/example-cli/dist/demo-model.js";
import { configureCliModel, inspectCliModelConfig } from "@aisdk-agent/example-cli/dist/model-config.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import type { CandidateListInput, CandidateResolveInput } from "@aisdk-agent/example-cli/dist/memory-candidates.js";
import { IPC, type ConfirmInput, type MainToRenderer } from "../shared/ui-contract.js";
import type { WorkTaskInputs } from "../shared/work-tasks.js";
import { resolveDesktopConfig } from "./desktop-config.js";
import { resolveDesktopIdentity } from "./desktop-identity.js";
import { parseModuleNotification, RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import { installHideOnClose, installTray } from "./tray.js";
import { loadDesktopEnvironment, safeStartupError } from "./desktop-env.js";

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

  const output = new TeeOutput(send);
  let bridge!: RuntimeBridge;
  // Renderer can load before disk/config initialization finishes. Keep info waiting
  // for the actual result rather than returning a misleading "no IPC handler" error.
  let resolveStartup!: () => void;
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  void startup.catch(() => undefined);
  ipcMain.handle(IPC.info, async () => { await startup; return bridge.info(); });
  try {
    await loadDesktopEnvironment();
    const { modelAlias, model } = configureCliModel(createDemoModel, process.env);
    const desktopConfig = await resolveDesktopConfig({ env: process.env, userData: app.getPath("userData") });
    // Resolve through the backend's own config validation/canonical workspace rules.
    const moduleConfig = await resolveTuiModuleConfig({ configPath: desktopConfig.configPath }, { cwd: process.cwd() });
    const identity = await resolveDesktopIdentity({
      env: process.env, userData: app.getPath("userData"), cwd: process.cwd(),
      configPath: moduleConfig.configPath!, workspaceRoot: moduleConfig.workspaceRoot,
    });
    const args = ["--tui", identity.transcriptDirectory, "--thread", identity.threadId, "--config", identity.configPath];
    const runtimeApp = await createRuntimeApp({
      args,
      modelAlias,
      model,
      output,
      env: process.env,
      cwd: process.cwd(),
    });
    const controller = createAssistantController(runtimeApp);
    output.attach(controller);
    bridge = new RuntimeBridge(
      runtimeApp,
      controller,
      { modelAlias, modelId: inspectCliModelConfig().modelId, temporaryThread: false, temporaryDirectory: false, identitySource: identity.identitySource },
      output,
      send,
    );
  } catch (error) {
    const message = safeStartupError(error, process.env);
    rejectStartup(new Error(message));
    const report = (): void => send({ type: "error", message });
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", report);
    else report();
    app.on("before-quit", () => tray.dispose());
    return;
  }

  ipcMain.handle(IPC.snapshot, () => bridge.snapshot());
  ipcMain.handle(IPC.contextDiagnostics, () => bridge.getContextDiagnostics());
  ipcMain.handle(IPC.history, () => bridge.history());
  ipcMain.handle(IPC.home, () => bridge.home());
  ipcMain.handle(IPC.run, (_event, text: string) => bridge.run(text));
  ipcMain.handle(IPC.cancel, () => bridge.cancel());
  ipcMain.handle(IPC.confirm, (_event, input: ConfirmInput) => bridge.confirm(input));
  ipcMain.handle(IPC.command, (_event, line: string) => bridge.command(line));
  ipcMain.handle(IPC.listRuns, () => bridge.listRuns());
  ipcMain.handle(IPC.getRun, (_event, runId: string) => bridge.getRun(runId));
  ipcMain.handle(IPC.memoryCandidatesList, (_event, input?: CandidateListInput) => bridge.listMemoryCandidates(input));
  ipcMain.handle(IPC.memoryCandidateGet, (_event, id: string) => bridge.getMemoryCandidate(id));
  ipcMain.handle(IPC.memoryCandidateResolve, (_event, input: CandidateResolveInput) => bridge.resolveMemoryCandidate(input));
  ipcMain.handle(IPC.createWorkTask, (_event, input: WorkTaskInputs["createWorkTask"]) => bridge.createWorkTask(input));
  ipcMain.handle(IPC.listWorkTasks, () => bridge.listWorkTasks());
  ipcMain.handle(IPC.getWorkTask, (_event, id: string) => bridge.getWorkTask(id));
  ipcMain.handle(IPC.runWorkTask, (_event, input: WorkTaskInputs["runWorkTask"]) => bridge.runWorkTask(input));
  ipcMain.handle(IPC.submitWorkTaskDelivery, (_event, input: WorkTaskInputs["submitWorkTaskDelivery"]) => bridge.submitWorkTaskDelivery(input));
  ipcMain.handle(IPC.recordHumanAcceptance, (_event, input: WorkTaskInputs["recordHumanAcceptance"]) => bridge.recordHumanAcceptance(input));
  ipcMain.handle(IPC.reconcileWorkTask, (_event, input: WorkTaskInputs["reconcileWorkTask"]) => bridge.reconcileWorkTask(input));
  ipcMain.handle(IPC.cancelWorkTask, (_event, input: WorkTaskInputs["cancelWorkTask"]) => bridge.cancelWorkTask(input));
  ipcMain.handle(IPC.requestWorkTaskChanges, (_event, input: WorkTaskInputs["requestWorkTaskChanges"]) => bridge.requestWorkTaskChanges(input));
  resolveStartup();

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    quitting = true;
    tray.dispose();
    void bridge.shutdown().finally(() => {
      app.quit();
    });
  });
}

if (app.requestSingleInstanceLock()) void main();
else app.quit();
