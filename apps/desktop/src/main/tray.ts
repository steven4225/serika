import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Tray } from "electron";

export const TOGGLE_SHORTCUT = "Alt+Space";

/**
 * Keep the menu-bar icon monochrome rather than squeezing a portrait into 16px.
 * macOS recolors template images for light/dark menu bars.
 */
function trayIcon(): Electron.NativeImage {
  const draw = (size: number): Buffer => {
    const buffer = Buffer.alloc(size * size * 4, 0);
    const center = (size - 1) / 2;
    const outer = size * 0.42;
    const inner = size * 0.2;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const distance = Math.hypot(x - center, y - center);
        const ring = distance <= outer && distance >= inner;
        const alpha = ring ? 255 : 0;
        const offset = (y * size + x) * 4;
        buffer[offset] = 0;
        buffer[offset + 1] = 0;
        buffer[offset + 2] = 0;
        buffer[offset + 3] = alpha;
      }
    }
    return buffer;
  };
  const image = nativeImage.createFromBitmap(draw(16), { width: 16, height: 16, scaleFactor: 1 });
  image.addRepresentation({ buffer: draw(32), width: 32, height: 32, scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

export function toggleWindow(window: BrowserWindow): void {
  if (window.isVisible() && window.isFocused()) {
    window.hide();
    return;
  }
  window.show();
  window.focus();
}

export interface TrayHandle {
  tray: Tray;
  dispose(): void;
}

/**
 * Menu bar presence for a window that hides instead of closing. The dock icon
 * stays visible so Cmd+Tab still reaches the app; hiding it is a later choice.
 */
export function installTray(window: BrowserWindow, onQuit: () => void): TrayHandle {
  const tray = new Tray(trayIcon());
  tray.setToolTip("Serika");
  const menu = Menu.buildFromTemplate([
    { label: "显示 / 隐藏", click: () => toggleWindow(window) },
    { type: "separator" },
    { label: `切换窗口  ${TOGGLE_SHORTCUT.replace("Alt", "⌥")}`, enabled: false },
    { type: "separator" },
    { label: "退出 Serika", click: onQuit },
  ]);
  tray.on("click", () => toggleWindow(window));
  tray.on("right-click", () => tray.popUpContextMenu(menu));

  const registered = globalShortcut.register(TOGGLE_SHORTCUT, () => toggleWindow(window));
  if (!registered) {
    // Another app owns the shortcut; the tray click still works.
    tray.setToolTip(`Serika（${TOGGLE_SHORTCUT} 被占用）`);
  }

  return {
    tray,
    dispose: () => {
      globalShortcut.unregister(TOGGLE_SHORTCUT);
      tray.destroy();
    },
  };
}

export function installHideOnClose(window: BrowserWindow, isQuitting: () => boolean): void {
  window.on("close", (event) => {
    if (isQuitting()) return;
    event.preventDefault();
    window.hide();
  });
  app.on("activate", () => {
    window.show();
  });
}
