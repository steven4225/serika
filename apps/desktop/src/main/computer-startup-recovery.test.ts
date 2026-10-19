import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import { DesktopRuntime } from "./desktop-runtime.js";
import { MockLanguageModelV3 } from "ai/test";
import { recoverComputerStartup } from "./computer-startup-recovery.js";

it("recovers a cold startup with a missing driver only after confirmation and preserves the Thread on reopen", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-cold-computer-"));
  const workspace = join(root, "workspace"), configPath = join(root, "config.json"), driver = join(root, "driver");
  await mkdir(workspace); await writeFile(driver, "never executed");
  await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { computer: { enabled: true, executable: driver, allowedBundleIds: ["com.apple.TextEdit"] }, "read-file": { enabled: true } } }));
  let modelCalls = 0, restarts = 0, confirmations = 0;
  const options = { userData: join(root, "profile"), cwd: root, env: { RUNLOOM_CONFIG: configPath }, modelAlias: "mock",
    model: new MockLanguageModelV3({ doStream: async () => { modelCalls++; throw new Error("No model expected"); } }), send: () => {} };
  let host = await DesktopRuntime.create(options);
  const threadId = host.info().threadId;
  await host.shutdown(); await rm(driver);
  try {
    let failure: unknown;
    await assert.rejects(DesktopRuntime.create(options), error => { failure = error; return true; });
    const before = await readFile(configPath, "utf8");
    const recovery = { cwd: root, confirm: async (path: string) => { confirmations++; assert.equal(path, configPath); return false; }, restart: () => { restarts++; } };
    assert.equal(await recoverComputerStartup(new Error("unrelated"), recovery), false);
    assert.equal(confirmations, 0);
    assert.equal(await recoverComputerStartup(failure, recovery), false);
    assert.equal(await readFile(configPath, "utf8"), before);
    assert.equal(restarts, 0);
    assert.equal(await recoverComputerStartup(failure, { ...recovery, confirm: async () => true }), true);
    assert.equal(restarts, 1);
    host = await DesktopRuntime.create(options);
    assert.equal(host.info().threadId, threadId);
    assert.equal(host.info().computer.enabled, false);
    assert.ok(host.info().capabilities?.tools.includes("read_file"));
    assert.equal(host.current.snapshot().state.kind, "idle");
    assert.equal(modelCalls, 0);
    await host.shutdown();
    // A user/editor replacing the config while the native confirmation is open must win.
    await writeFile(configPath, before);
    const changed = before + "\n";
    await assert.rejects(recoverComputerStartup(failure, { ...recovery, confirm: async () => { await writeFile(configPath, changed); return true; } }), /配置已变化/);
    assert.equal(await readFile(configPath, "utf8"), changed);
    assert.equal(restarts, 1);
    assert.equal((await resolveTuiModuleConfig({ configPath }, { cwd: root }).catch(() => null)), null);
  } finally { await host.shutdown(); await rm(root, { recursive: true, force: true }); }
});
