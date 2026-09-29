import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Notification, shell } from "electron";
import { createRuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { createDemoModel } from "@aisdk-agent/example-cli/dist/demo-model.js";
import { configureCliModel } from "@aisdk-agent/example-cli/dist/model-config.js";
import { IPC, type ConfirmInput, type MainToRenderer } from "../shared/ui-contract.js";
import { resolveDesktopConfig } from "./desktop-config.js";
import { parseModuleNotification, RuntimeBridge, TeeOutput } from "./runtime-bridge.js";
import { installHideOnClose, installTray } from "./tray.js";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * The desktop shell reads the same inputs the TUI takes on its command line,
 * but from environment variables so `electron-vite dev` needs no argv plumbing:
 *
 *   RUNLOOM_MODEL        mock | deepseek | minimax-m3   (as in the CLI)
 *   RUNLOOM_CONFIG       path to the TUI --config JSON (must be outside the workspace)
 *   RUNLOOM_WORKSPACE    used only when generating the userData config
 *   RUNLOOM_TRANSCRIPTS  transcript directory (temporary when omitted)
 *   RUNLOOM_THREAD       thread id (random when omitted)
 */
function runtimeArgs(
  env: NodeJS.ProcessEnv,
  configPath: string,
): {
  args: string[];
  temporaryThread: boolean;
  temporaryDirectory: boolean;
} {
  const args = ["--tui"];
  const transcripts = env.RUNLOOM_TRANSCRIPTS?.trim();
  const thread = env.RUNLOOM_THREAD?.trim();
  if (transcripts) args.push(transcripts);
  if (thread) args.push("--thread", thread);
  args.push("--config", configPath);
  return { args, temporaryThread: !thread, temporaryDirectory: !transcripts };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 380,
    height: 680,
    minWidth: 320,
    minHeight: 480,
    title: "Runloom",
    frame: false,
    transparent: true,
    hasShadow: true,
    show: false,
    ...(process.platform === "darwin"
      ? { vibrancy: "hud" as const, visualEffectState: "active" as const }
      : {}),
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
  await app.whenReady();
  let quitting = false;
  let shuttingDown = false;
  const window = createWindow();
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
  const { modelAlias, model } = configureCliModel(createDemoModel, process.env);
  const desktopConfig = await resolveDesktopConfig({
    env: process.env,
    userData: app.getPath("userData"),
  });
  const { args, temporaryThread, temporaryDirectory } = runtimeArgs(process.env, desktopConfig.configPath);
  let bridge!: RuntimeBridge;
  try {
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
      { modelAlias, temporaryThread, temporaryDirectory },
      output,
      send,
    );
  } catch (error) {
    window.webContents.once("did-finish-load", () => {
      send({ type: "error", message: `Runtime could not start: ${String(error)}` });
    });
    app.on("before-quit", () => tray.dispose());
    return;
  }

  ipcMain.handle(IPC.info, () => bridge.info());
  ipcMain.handle(IPC.snapshot, () => bridge.snapshot());
  ipcMain.handle(IPC.history, () => bridge.history());
  ipcMain.handle(IPC.home, () => bridge.home());
  ipcMain.handle(IPC.run, (_event, text: string) => bridge.run(text));
  ipcMain.handle(IPC.cancel, () => bridge.cancel());
  ipcMain.handle(IPC.confirm, (_event, input: ConfirmInput) => bridge.confirm(input));
  ipcMain.handle(IPC.command, (_event, line: string) => bridge.command(line));
  ipcMain.handle(IPC.listRuns, () => bridge.listRuns());
  ipcMain.handle(IPC.getRun, (_event, runId: string) => bridge.getRun(runId));

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

void main();
