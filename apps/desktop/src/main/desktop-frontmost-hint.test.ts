import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readDesktopFrontmost } from "@aisdk-agent/example-cli/dist/task-notification-presentation.js";
import { installDesktopFrontmostHint, type FrontmostWindow } from "./desktop-frontmost-hint.js";

test("a frontmost window publishes a hint and blur or quit removes it without touching task files", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-frontmost-hint-"));
  const other = await mkdtemp(join(tmpdir(), "serika-frontmost-other-"));
  const listeners = new Map<string, () => void>();
  let visible = true;
  let focused = true;
  let minimized = false;
  let current = root;
  const window: FrontmostWindow = {
    isDestroyed: () => false,
    isVisible: () => visible,
    isFocused: () => focused,
    isMinimized: () => minimized,
    on: (event, listener) => { listeners.set(event, listener); },
  };
  const hint = installDesktopFrontmostHint(window, () => current, { schedule: () => () => undefined });
  await hint.settled();
  assert.equal(await readDesktopFrontmost(root), true);
  focused = false;
  listeners.get("blur")?.();
  await hint.settled();
  assert.equal(await readDesktopFrontmost(root), false);
  focused = true;
  listeners.get("focus")?.();
  await hint.settled();
  assert.equal(await readDesktopFrontmost(root), true);
  minimized = true;
  listeners.get("minimize")?.();
  await hint.settled();
  assert.equal(await readDesktopFrontmost(root), false, "a minimized window is not the foreground surface");
  minimized = false;
  current = other;
  listeners.get("focus")?.();
  await hint.settled();
  assert.equal(await readDesktopFrontmost(root), false);
  assert.equal(await readDesktopFrontmost(other), true);
  await hint.stop();
  assert.equal(await readDesktopFrontmost(other), false);
  assert.equal(visible, true);
  const main = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(main, /installDesktopFrontmostHint\(window, \(\) => host\.info\(\)\.workspaceRoot \?\? null\)/);
  assert.match(main, /frontmostHint\?\.stop\(\)/);
});
