import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareMacLauncher, registerTaskResultScheme } from "./mac-launcher.mjs";

test("local launcher registers task-result scheme once and does not replace another registration", () => {
  const commands = [];
  const run = (_file, args) => {
    commands.push(args[1]);
    if (args[1].startsWith("Print")) throw new Error("missing key");
    return "";
  };
  assert.equal(registerTaskResultScheme("/fixture/Info.plist", run), true);
  assert.ok(commands.includes("Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string serika"));
  assert.equal(registerTaskResultScheme("/fixture/Info.plist", () => "serika\n"), false);
  assert.throws(() => registerTaskResultScheme("/fixture/Info.plist", () => "another-app\n"), /unexpected/);
  assert.throws(() => registerTaskResultScheme("/fixture/Info.plist", (_file, args) => {
    if (args[1].includes("URLSchemes:0")) throw new Error("missing");
    return "existing URLTypes";
  }), /incomplete/);
});

test("cached launcher treats trailing slashes as the same checkout without changing its marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-launcher-identity-"));
  try {
    const desktop = join(root, "desktop");
    const bundle = join(desktop, "dist/local-44.4.5/Serika.app");
    const marker = join(bundle, "Contents/Resources/serika-local.json");
    await mkdir(join(bundle, "Contents/Resources"), { recursive: true });
    const run = (file, args) => {
      if (args[1] === "Print :CFBundleShortVersionString") return "44.4.5\n";
      if (args[1] === "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0") return "serika\n";
      assert.equal(file, "/usr/bin/codesign");
      assert.equal(args[0], "--verify"); // Cached valid bundles must not be rewritten or resigned.
      return "";
    };
    for (const savedDesktop of [desktop, `${desktop}/`]) {
      const before = JSON.stringify({ desktop: savedDesktop, version: "44.4.5" });
      await writeFile(marker, before);
      assert.deepEqual(await prepareMacLauncher(`${desktop}/`, join(root, "Electron.app/Contents/MacOS/Electron"), run, async () => false), {
        bundle, executable: join(bundle, "Contents/MacOS/Serika"),
      });
      assert.equal(await readFile(marker, "utf8"), before);
    }
    await writeFile(marker, JSON.stringify({ desktop: join(root, "other-checkout"), version: "44.4.5" }));
    await assert.rejects(prepareMacLauncher(`${desktop}/`, join(root, "Electron.app/Contents/MacOS/Electron"), run), /another checkout/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
