import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const notificationBundleName = "Serika Notifications.app";
export const notificationExecutable = "SerikaNotifications";

/** Builds only our native component, never installs tools or requests permission. */
export async function buildNotificationHelper(desktop, run = execFileSync) {
  desktop = resolve(desktop);
  const source = join(desktop, "native/notifications/main.swift");
  const plist = join(desktop, "native/notifications/Info.plist");
  const icon = join(desktop, "resources/serika.icns");
  const fingerprint = createHash("sha256").update(process.arch)
    .update(await readFile(source)).update(await readFile(plist)).update(await readFile(icon)).digest("hex");
  const bundle = join(desktop, "dist/native", notificationBundleName);
  const executable = join(bundle, "Contents/MacOS", notificationExecutable);
  const marker = join(bundle, "Contents/Resources/build-hash");
  try {
    if ((await readFile(marker, "utf8")) === fingerprint) {
      run("/usr/bin/codesign", ["--verify", "--strict", bundle], { stdio: "pipe" });
      return { bundle, executable, fingerprint };
    }
  } catch (error) { if (error.code !== "ENOENT" && !error.status) throw error; }
  await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
  await mkdir(join(bundle, "Contents/Resources"), { recursive: true });
  const sdk = run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).trim();
  run("/usr/bin/xcrun", ["swiftc", "-O", "-swift-version", "5", "-sdk", sdk,
    "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx12.0`,
    source, "-o", executable], { stdio: "pipe" });
  await cp(plist, join(bundle, "Contents/Info.plist"));
  await cp(icon, join(bundle, "Contents/Resources/serika.icns"));
  await writeFile(marker, fingerprint);
  // Local signing, not a claim of distributable Developer ID/notarization.
  run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "app.serika.notifications", bundle], { stdio: "pipe" });
  return { bundle, executable, fingerprint };
}

/** Refresh the exact first-party child bundle, not the shared Electron install. */
export async function embedNotificationHelper(desktop, appBundle, run = execFileSync) {
  const built = await buildNotificationHelper(desktop, run);
  const destination = join(appBundle, "Contents/Resources", notificationBundleName);
  try {
    if (await readFile(join(destination, "Contents/Resources/build-hash"), "utf8") === built.fingerprint) {
      run("/usr/bin/codesign", ["--verify", "--strict", destination], { stdio: "pipe" });
      return false;
    }
  } catch (error) { if (error.code !== "ENOENT" && !error.status) throw error; }
  await cp(built.bundle, destination, { recursive: true, verbatimSymlinks: true });
  return true;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url && process.platform === "darwin") {
  buildNotificationHelper(fileURLToPath(new URL("..", import.meta.url))).then(() => {
    process.stdout.write("Serika 原生通知组件已构建（未请求权限／未发送通知）。\n");
  }).catch(error => { process.stderr.write(`Native notification build failed: ${error.message}\n`); process.exitCode = 1; });
}
