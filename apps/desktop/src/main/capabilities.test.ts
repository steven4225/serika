import { dirname } from "node:path";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRuntimeApp } from "@serika/assistant";
import { createAssistantController } from "@serika/assistant";
import { createDemoModel } from "@serika/assistant";
import { RuntimeBridge, TeeOutput } from "./runtime-bridge.js";

test("capability configuration and pomodoro commands share the real timer without model Runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-capabilities-"));
  await mkdir(join(root, "workspace"));
  await mkdir(join(root, "transcripts"));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, authorizedDirectories: [{ path: "./workspace", access: "readwrite" }], modules: { pomodoro: { enabled: true } } }));
  const output = new TeeOutput(() => {});
  const app = await createRuntimeApp({ directory: join(root, "transcripts"), assistant: { dataDirectory: join(dirname(join(root, "config.json")), "workspace/.runloom"), threadId: "capabilities", configPath: join(root, "config.json") }, modelAlias: "mock", model: createDemoModel(), env: {}, cwd: root, output });
  const controller = createAssistantController(app);
  output.attach(controller);
  const bridge = new RuntimeBridge(app, controller, { modelAlias: "mock", temporaryThread: false, temporaryDirectory: false }, output, () => {});
  try {
    assert.equal(bridge.info().modules?.find(module => module.id === "pomodoro")?.enabled, true);
    assert.equal(bridge.info().modules?.find(module => module.id === "web")?.enabled, false);
    const capabilities = bridge.info().capabilities!;
    assert.equal(capabilities.modules.find(module => module.id === "computer")?.state, "disabled");
    assert.equal(capabilities.computer.service, "not_checked");
    assert.equal(capabilities.computer.permissions, "not_checked");
    assert.ok(capabilities.tools.includes("pomodoro_start"));
    assert.ok(!capabilities.tools.includes("computer_observe"));
    assert.equal((await bridge.command("/capabilities")).ok, true);
    assert.match(bridge.snapshot().recentOutput, /配置／实际注册，不是健康检查/);
    assert.deepEqual(bridge.info().moduleOptions, { webSearch: false, webFeed: false, autoConsolidate: false });
    assert.equal((await bridge.command("/pomodoro start 1")).ok, true);
    assert.equal((await bridge.command("/pomodoro start 2")).ok, true);
    assert.equal((await bridge.command("/pomodoro status")).ok, true);
    const replies = bridge.snapshot().recentOutput;
    assert.match(replies, /已启动 1 分钟/);
    assert.match(replies, /已有番茄钟运行中/);
    assert.match(replies, /剩余 \d+ 秒/);
    assert.equal((await bridge.command("/pomodoro cancel")).ok, true);
    assert.match(bridge.snapshot().recentOutput, /番茄钟已取消/);
    assert.equal((await bridge.command("/pomodoro status")).ok, true);
    assert.match(bridge.snapshot().recentOutput, /当前没有运行中的番茄钟/);
    assert.deepEqual(await readdir(join(root, "transcripts")), []);
  } finally { await controller.shutdown(); await app.dispose(); await rm(root, { recursive: true, force: true }); }
});
