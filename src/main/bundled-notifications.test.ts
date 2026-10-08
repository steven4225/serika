import assert from "node:assert/strict";
import { it } from "node:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureBundledNotifications } from "./bundled-notifications.js";

it("installed and development entry use their first-party component, never an old external env helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-bundled-notifications-"));
  try {
    for (const packaged of [true, false]) {
      const resourcesPath = join(root, "installed/Contents/Resources");
      const base = packaged ? resourcesPath : join(root, "dist/native");
      const executable = join(base, "Serika Notifications.app/Contents/MacOS/SerikaNotifications");
      await mkdir(join(base, "Serika Notifications.app/Contents/MacOS"), { recursive: true });
      await writeFile(executable, "fixture"); await chmod(executable, 0o700);
      const env = { RUNLOOM_NOTIFICATION_HELPER: "/external/terminal-notifier", API_KEY: "PRIVATE_FIXTURE" };
      await configureBundledNotifications({ resourcesPath, desktopRoot: root, packaged, env, platform: "darwin" });
      assert.equal(env.RUNLOOM_NOTIFICATION_HELPER, await realpath(executable));
      assert.equal(env.API_KEY, "PRIVATE_FIXTURE");
    }
    await assert.rejects(configureBundledNotifications({ resourcesPath: join(root, "missing"), desktopRoot: root,
      packaged: true, env: { RUNLOOM_NOTIFICATION_HELPER: process.execPath }, platform: "darwin" }), /原生通知组件缺失/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
