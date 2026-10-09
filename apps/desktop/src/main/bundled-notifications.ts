import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

/** Desktop owns this path. An old env-file helper cannot override the installed component. */
export async function configureBundledNotifications(options: {
  resourcesPath: string; desktopRoot: string; packaged: boolean;
  env: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
}): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") return;
  const root = options.packaged ? options.resourcesPath : join(options.desktopRoot, "dist/native");
  const executable = join(root, "Serika Notifications.app/Contents/MacOS/SerikaNotifications");
  // Missing build is visible, not a silent fallback to terminal-notifier.
  try {
    await access(executable, constants.X_OK);
    options.env.RUNLOOM_NOTIFICATION_HELPER = await realpath(executable);
  } catch { throw new Error("Serika 原生通知组件缺失，请重新运行 pnpm install:local；无需安装 terminal-notifier。"); }
}
