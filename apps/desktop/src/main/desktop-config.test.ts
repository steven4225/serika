import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "@serika/assistant/testing";
import { defaultContextBudget } from "@serika/assistant";
import { safeStartupError } from "./desktop-env.js";
import { changeModuleSetting } from "./module-settings.js";
import {
  DESKTOP_DEFAULT_SHELL_TIMEOUT_MS,
  DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS,
  defaultDesktopConfig,
  enableDesktopMemory,
  resolveDesktopConfig,
  withDesktopTimeouts,
} from "./desktop-config.js";

describe("desktop TUI config", () => {
  it("surfaces the v1 upgrade instruction without rewriting the configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-desktop-v1-"));
    const configPath = join(root, "config.json");
    const original = JSON.stringify({ version: 1, authorizedDirectory: root, modules: {} });
    await writeFile(configPath, original);
    try {
      await assert.rejects(resolveDesktopConfig({ env: {}, applicationHome: root }), error => {
        assert.ok(error instanceof Error);
        assert.equal(safeStartupError(error, {}), "Runtime 无法启动：配置为 v1，请运行 node packages/assistant/scripts/config-upgrade.mjs --config <配置文件> --upgrade 升级");
        return true;
      });
      assert.equal(await readFile(configPath, "utf8"), original);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("explicitly enables automatic source-checked memory without replacing existing module settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-enable-memory-"));
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const configPath = join(root, "config.json");
      const config = { version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: {
        memory: { enabled: false, autoConsolidate: false },
        shell: { enabled: false, timeoutMs: 45_000 }, pomodoro: { enabled: false },
      }, run: { maxSteps: 6 } };
      await writeFile(configPath, JSON.stringify(config));
      await enableDesktopMemory(configPath);
      const enabled = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(enabled, { ...config, modules: { ...config.modules,
        memory: { enabled: true, autoConsolidate: true },
      } });
      // Missing modules is a valid legacy config, not a reason to report an empty/disabled module forever.
      await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }] }));
      await enableDesktopMemory(configPath);
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).modules.memory.enabled, true);
      const invalid = JSON.stringify({ version: 2 });
      await writeFile(configPath, invalid);
      await assert.rejects(enableDesktopMemory(configPath), /projectDirectory/i);
      assert.equal(await readFile(configPath, "utf8"), invalid);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refuses a broken generated config without replacing user data", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-bad-config-"));
    try {
      const path = join(root, "config.json");
      await writeFile(path, "{broken");
      await assert.rejects(resolveDesktopConfig({ env: {}, applicationHome: root }), /refusing to replace/);
      assert.equal(await readFile(path, "utf8"), "{broken");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("sets both Run and Shell budgets on a generated config", () => {
    const config = defaultDesktopConfig("/tmp/workspace");
    assert.equal((config.run as { totalTimeoutMs: number }).totalTimeoutMs, DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS);
    assert.equal(
      (config.modules as { shell: { timeoutMs: number; enabled: boolean } }).shell.timeoutMs,
      DESKTOP_DEFAULT_SHELL_TIMEOUT_MS,
    );
    assert.equal((config.modules as { shell: { enabled: boolean } }).shell.enabled, true);
    assert.ok(DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS > 30_000);
    assert.ok(DESKTOP_DEFAULT_SHELL_TIMEOUT_MS > 30_000);
    assert.deepEqual(config.contextCompaction, defaultContextBudget());
    assert.equal((config.modules as { memory: { autoConsolidate: boolean } }).memory.autoConsolidate, true);
    const memory = (config.modules as { memory: { contextView?: { enabled: boolean }; semantic?: unknown } }).memory;
    assert.equal(memory.contextView, undefined);
    assert.equal(memory.semantic, undefined, "new defaults cannot install or silently enable an embedding service");
  });

  it("fills missing timeouts without changing explicit values", () => {
    const { config, patched } = withDesktopTimeouts({
      version: 2,
      modules: { shell: { enabled: true, timeoutMs: 45_000 } },
      run: { maxSteps: 8 },
    });
    assert.equal(patched, true);
    assert.equal((config.run as { totalTimeoutMs: number; maxSteps: number }).totalTimeoutMs, DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS);
    assert.equal((config.run as { maxSteps: number }).maxSteps, 8);
    assert.equal((config.modules as { shell: { timeoutMs: number } }).shell.timeoutMs, 45_000);
  });

  it("does not silently enable derived profile or semantic indexing in existing daily configurations", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-existing-memory-config-"));
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const configPath = join(root, "config.json");
      const config = { version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { memory: { enabled: true, autoConsolidate: true }, shell: { enabled: false } } };
      await writeFile(configPath, JSON.stringify(config));
      await resolveDesktopConfig({ env: {}, applicationHome: root, cwd: root });
      assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).modules.memory, config.modules.memory);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("leaves RUNLOOM_CONFIG untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-config-"));
    const explicit = join(root, "custom.json");
    await writeFile(explicit, "{\"version\":1,\"modules\":{}}\n");
    try {
      const resolved = await resolveDesktopConfig({
        env: { RUNLOOM_CONFIG: explicit },
        applicationHome: join(root, "applicationHome"),
      });
      assert.equal(resolved.configPath, explicit);
      assert.equal(resolved.generated, false);
      assert.equal(resolved.patched, false);
      assert.equal(await readFile(explicit, "utf8"), "{\"version\":1,\"modules\":{}}\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not enable compaction in an existing explicitly disabled desktop config", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-disabled-"));
    try {
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 2, modules: {}, contextCompaction: { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: false } }));
      await resolveDesktopConfig({ env: {}, applicationHome: root });
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.contextCompaction.enabled, false);
      assert.equal(config.modules.memory, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not silently migrate legacy or explicit context budgets when filling desktop timeouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-existing-context-budget-"));
    try {
      const configPath = join(root, "config.json");
      for (const contextCompaction of [
        { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: true, summaryMaxOutputTokens: 4096 },
        ({ ...defaultContextBudget(), inputBudgetTokens: 400_000, keepRecentTokens: 64_000, summaryMaxOutputTokens: 8_000 }),
      ]) {
        await writeFile(configPath, JSON.stringify({ version: 2, modules: {}, contextCompaction }));
        await resolveDesktopConfig({ env: {}, applicationHome: root });
        const config = JSON.parse(await readFile(configPath, "utf8"));
        assert.deepEqual(config.contextCompaction, contextCompaction);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("writes a applicationHome config when none is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-userdata-"));
    try {
      await mkdir(join(root, "ws"));
      const resolved = await resolveDesktopConfig({
        env: { RUNLOOM_WORKSPACE: join(root, "ws") },
        applicationHome: join(root, "applicationHome"),
      });
      assert.equal(resolved.generated, true);
      const written = JSON.parse(await readFile(resolved.configPath, "utf8")) as {
        run: { totalTimeoutMs: number };
        modules: { shell: { timeoutMs: number } };
      };
      assert.equal(written.run.totalTimeoutMs, DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS);
      assert.equal(written.modules.shell.timeoutMs, DESKTOP_DEFAULT_SHELL_TIMEOUT_MS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes startup timeout patches, explicit memory setup and capability changes without losing unrelated fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-all-config-writers-"));
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const configPath = join(root, "config.json");
      await writeFile(configPath, JSON.stringify({ version: 2, authorizedDirectories: [{ path: workspace, access: "readwrite" }], modules: { memory: { enabled: false }, pomodoro: { enabled: true }, shell: { enabled: false } } }));
      await Promise.all([
        resolveDesktopConfig({ env: {}, applicationHome: root, cwd: root }),
        enableDesktopMemory(configPath, root),
        changeModuleSetting(configPath, { id: "pomodoro", enabled: false, expectedEnabled: true }, { cwd: root }),
      ]);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.modules.memory.enabled, true);
      assert.equal(config.modules.memory.autoConsolidate, true);
      assert.equal(config.modules.pomodoro.enabled, false);
      assert.equal(config.modules.shell.enabled, false);
      assert.equal(config.modules.shell.timeoutMs, DESKTOP_DEFAULT_SHELL_TIMEOUT_MS);
      assert.equal(config.run.totalTimeoutMs, DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS);
      assert.equal(config.authorizedDirectories[0].path, workspace);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("concurrent first startups create exactly one config and never replace the winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-config-create-once-"));
    try {
      await mkdir(join(root, "first")); await mkdir(join(root, "second"));
      const results = await Promise.all([
        resolveDesktopConfig({ env: { RUNLOOM_WORKSPACE: join(root, "first") }, applicationHome: root, cwd: root }),
        resolveDesktopConfig({ env: { RUNLOOM_WORKSPACE: join(root, "second") }, applicationHome: root, cwd: root }),
      ]);
      assert.equal(results.filter(result => result.generated).length, 1);
      assert.equal(results.some(result => result.patched), false);
      const config = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
      assert.ok([join(root, "first"), join(root, "second")].includes(config.authorizedDirectories[0].path));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
