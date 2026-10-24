import { dirname } from "node:path";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import type { MainToRenderer } from "../shared/ui-contract.js";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";

/**
 * State events: module notifications reach main as a structured message (no
 * `[module:id]` text parsing); the output log keeps the same text as before.
 */
test("module notifications arrive as structured messages and keep the output text", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-module-notification-"));
  await mkdir(join(root, "workspace"));
  await mkdir(join(root, "transcripts"));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 2, authorizedDirectories: [{ path: "./workspace", access: "readwrite" }], modules: { pomodoro: { enabled: true } } }));
  const messages: MainToRenderer[] = [];
  const send = (message: MainToRenderer) => { messages.push(message); };
  const output = new TeeOutput(send);
  const app = await createRuntimeApp({
    directory: join(root, "transcripts"), assistant: { dataDirectory: join(dirname(join(root, "config.json")), "workspace/.runloom"), threadId: "notifications", configPath: join(root, "config.json") },
    modelAlias: "mock", model: createDemoModel(), env: {}, cwd: root, output,
    onModuleNotification: notification => output.moduleNotification(notification),
  });
  const controller = createAssistantController(app);
  output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, send);
  try {
    assert.equal((await bridge.command("/pomodoro status")).ok, true);
    const notifications = messages.filter(message => message.type === "module-notification");
    assert.deepEqual(notifications, [{ type: "module-notification", moduleId: "pomodoro", message: "当前没有运行中的番茄钟。" }]);
    assert.ok(bridge.snapshot().recentOutput.includes("\n[module:pomodoro] 当前没有运行中的番茄钟。\n"));
  } finally { await controller.shutdown(); await app.dispose(); await rm(root, { recursive: true, force: true }); }
});
