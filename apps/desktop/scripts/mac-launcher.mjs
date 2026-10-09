import { cp, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { embedNotificationHelper } from "./build-notification-helper.mjs";

/** Register only read-only task-result navigation in this generated local app. */
export function registerTaskResultScheme(plist, run = execFileSync) {
  try {
    const scheme = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0", plist], { encoding: "utf8", stdio: "pipe" }).trim();
    if (scheme !== "serika") throw new Error("Local launcher has an unexpected URL scheme.");
    return false;
  } catch (error) {
    if (error.message === "Local launcher has an unexpected URL scheme.") throw error;
    // A partially populated or unrelated URLTypes is not silently replaced.
    try {
      run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleURLTypes", plist], { encoding: "utf8", stdio: "pipe" });
    } catch {
      for (const command of ["Add :CFBundleURLTypes array", "Add :CFBundleURLTypes:0 dict",
        "Add :CFBundleURLTypes:0:CFBundleURLName string serika.task-result", "Add :CFBundleURLTypes:0:CFBundleURLSchemes array",
        "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string serika"]) {
        run("/usr/libexec/PlistBuddy", ["-c", command, plist], { stdio: "pipe" });
      }
      return true;
    }
    throw new Error("Local launcher URL registration is incomplete; regenerate the isolated launcher.");
  }
}

// Local launcher, not a distributable package: code and dependencies stay in
// this checkout. Never patch the shared Electron installation in node_modules.
export async function prepareMacLauncher(desktop, electronBinary, run = execFileSync, embedNotifications = embedNotificationHelper) {
  desktop = resolve(desktop);
  const source = dirname(dirname(dirname(electronBinary)));
  const version = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(source, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  const directory = join(desktop, "dist", `local-${version}`);
  const bundle = join(directory, "Serika.app");
  const executable = join(bundle, "Contents/MacOS/Serika");
  const marker = join(bundle, "Contents/Resources/serika-local.json");
  try {
    const saved = JSON.parse(await readFile(marker, "utf8"));
    if (typeof saved.desktop !== "string" || resolve(saved.desktop) !== desktop || saved.version !== version) throw new Error("Local Serika launcher belongs to another checkout.");
    let needsSigning = registerTaskResultScheme(join(bundle, "Contents/Info.plist"), run);
    if (await embedNotifications(desktop, bundle, run)) needsSigning = true;
    if (!needsSigning) {
      try { run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { stdio: "pipe" }); }
      catch { needsSigning = true; }
    }
    if (needsSigning) {
      run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "pipe" });
    }
    return { bundle, executable };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  // Do not overwrite an existing or partially generated bundle silently.
  await cp(source, bundle, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  await rename(join(bundle, "Contents/MacOS/Electron"), executable);
  const plist = join(bundle, "Contents/Info.plist");
  for (const [key, value] of Object.entries({
    CFBundleDisplayName: "Serika", CFBundleName: "Serika",
    CFBundleExecutable: "Serika", CFBundleIdentifier: "app.serika.desktop.local",
    CFBundleIconFile: "serika.icns",
  })) run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  await cp(join(desktop, "resources/serika.icns"), join(bundle, "Contents/Resources/serika.icns"));
  registerTaskResultScheme(plist, run);
  await embedNotifications(desktop, bundle, run);
  const appDirectory = join(bundle, "Contents/Resources/app");
  await mkdir(appDirectory);
  await writeFile(join(appDirectory, "package.json"), JSON.stringify({ name: "@aisdk-agent/desktop", productName: "Serika", version: "0.1.0", main: "index.cjs" }));
  await writeFile(join(appDirectory, "index.cjs"),
    `process.chdir(${JSON.stringify(desktop)});\n` +
    `import(${JSON.stringify(pathToFileURL(join(desktop, "scripts/daily-environment.mjs")).href)})\n` +
    `.then(async ({ dailyEnvironment }) => { Object.assign(process.env, await dailyEnvironment(${JSON.stringify(desktop)})); return import(${JSON.stringify(pathToFileURL(join(desktop, "out/main/index.js")).href)}); })\n` +
    `.catch(() => { const {app, dialog} = require('electron'); app.whenReady().then(() => { dialog.showErrorBox('Serika 启动失败', '请检查本地仓库构建和日用模型配置，或从终端运行 pnpm daily 查看错误。'); app.quit(); }); });\n`);
  // Changing a bundle invalidates Electron's signature. Ad-hoc signing is for
  // this machine only; it is not Developer ID signing or notarization.
  await writeFile(marker, JSON.stringify({ desktop, version }));
  try {
    run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "pipe" });
  } catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(marker);
    throw error;
  }
  return { bundle, executable };
}
