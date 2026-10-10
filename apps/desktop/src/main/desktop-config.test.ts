import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT_BUDGET_CONFIG } from "@aisdk-agent/example-cli/dist/context-budget.js";
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
  it("explicit review upgrade only changes policy, preserves query settings and supports rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-memory-policy-upgrade-"));
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const configPath = join(root, "runloom.json");
      for (const queryRewrite of [undefined, { enabled: false }, { enabled: true }] as const) {
        const config = { version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true, writePolicy: "review", ...(queryRewrite ? { queryRewrite } : {}) }, shell: { enabled: false } } };
        const original = JSON.stringify(config);
        await writeFile(configPath, original);
        const undo = await enableDesktopMemory(configPath);
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...config, modules: { ...config.modules, memory: { ...config.modules.memory, writePolicy: "automatic" } } });
        await undo();
        assert.equal(await readFile(configPath, "utf8"), original);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("explicitly enables automatic source-checked memory without replacing existing module settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-enable-memory-"));
    try {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const configPath = join(root, "runloom.json");
      const config = { version: 1, workspace, modules: {
        memory: { enabled: false, autoConsolidate: false },
        shell: { enabled: false, timeoutMs: 45_000 }, pomodoro: { enabled: false },
      }, run: { maxSteps: 6 } };
      await writeFile(configPath, JSON.stringify(config));
      await enableDesktopMemory(configPath);
      const enabled = JSON.parse(await readFile(configPath, "utf8"));
      assert.deepEqual(enabled, { ...config, modules: { ...config.modules,
        memory: { enabled: true, autoConsolidate: true, writePolicy: "automatic", queryRewrite: { enabled: true } },
      } });
      // Missing modules is a valid legacy config, not a reason to report an empty/disabled module forever.
      await writeFile(configPath, JSON.stringify({ version: 1, workspace }));
      await enableDesktopMemory(configPath);
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).modules.memory.enabled, true);
      const invalid = JSON.stringify({ version: 1 });
      await writeFile(configPath, invalid);
      await assert.rejects(enableDesktopMemory(configPath), /workspace/i);
      assert.equal(await readFile(configPath, "utf8"), invalid);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("refuses a broken generated config without replacing user data", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-bad-config-"));
    try {
      const path = join(root, "runloom.json");
      await writeFile(path, "{broken");
      await assert.rejects(resolveDesktopConfig({ env: {}, userData: root }), /refusing to replace/);
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
    assert.equal((config.contextCompaction as { enabled: boolean }).enabled, true);
    assert.equal((config.contextCompaction as { summaryMaxOutputTokens: number }).summaryMaxOutputTokens, 4096);
    assert.equal((config.modules as { memory: { writePolicy: string } }).memory.writePolicy, "automatic");
  });

  it("fills missing timeouts without changing explicit values", () => {
    const { config, patched } = withDesktopTimeouts({
      version: 1,
      modules: { shell: { enabled: true, timeoutMs: 45_000 } },
      run: { maxSteps: 8 },
    });
    assert.equal(patched, true);
    assert.equal((config.run as { totalTimeoutMs: number; maxSteps: number }).totalTimeoutMs, DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS);
    assert.equal((config.run as { maxSteps: number }).maxSteps, 8);
    assert.equal((config.modules as { shell: { timeoutMs: number } }).shell.timeoutMs, 45_000);
  });

  it("leaves RUNLOOM_CONFIG untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-config-"));
    const explicit = join(root, "custom.json");
    await writeFile(explicit, "{\"version\":1,\"modules\":{}}\n");
    try {
      const resolved = await resolveDesktopConfig({
        env: { RUNLOOM_CONFIG: explicit },
        userData: join(root, "userData"),
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
      const configPath = join(root, "runloom.json");
      await writeFile(configPath, JSON.stringify({ version: 1, modules: {}, contextCompaction: { ...DEFAULT_CONTEXT_BUDGET_CONFIG, enabled: false } }));
      await resolveDesktopConfig({ env: {}, userData: root });
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.contextCompaction.enabled, false);
      assert.equal(config.modules.memory, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not silently promote existing manual memory configs when filling timeouts", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-existing-memory-policy-"));
    try {
      const configPath = join(root, "runloom.json");
      const workspace = join(root, "workspace"); await mkdir(workspace);
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true, writePolicy: "review" } } }));
      await resolveDesktopConfig({ env: {}, userData: root });
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).modules.memory.writePolicy, "review");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: true, autoConsolidate: true } } }));
      await resolveDesktopConfig({ env: {}, userData: root });
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).modules.memory.writePolicy, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("writes a userData config when none is provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "runloom-desktop-userdata-"));
    try {
      const resolved = await resolveDesktopConfig({
        env: { RUNLOOM_WORKSPACE: join(root, "ws") },
        userData: join(root, "userData"),
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
      const configPath = join(root, "runloom.json");
      await writeFile(configPath, JSON.stringify({ version: 1, workspace, modules: { memory: { enabled: false }, pomodoro: { enabled: true }, shell: { enabled: false } } }));
      await Promise.all([
        resolveDesktopConfig({ env: {}, userData: root, cwd: root }),
        enableDesktopMemory(configPath, root),
        changeModuleSetting(configPath, { id: "pomodoro", enabled: false, expectedEnabled: true }, root),
      ]);
      const config = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(config.modules.memory.enabled, true);
      assert.equal(config.modules.memory.writePolicy, "automatic");
      assert.equal(config.modules.pomodoro.enabled, false);
      assert.equal(config.modules.shell.enabled, false);
      assert.equal(config.modules.shell.timeoutMs, DESKTOP_DEFAULT_SHELL_TIMEOUT_MS);
      assert.equal(config.run.totalTimeoutMs, DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS);
      assert.equal(config.workspace, workspace);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("concurrent first startups create exactly one config and never replace the winner", async () => {
    const root = await mkdtemp(join(tmpdir(), "serika-config-create-once-"));
    try {
      const results = await Promise.all([
        resolveDesktopConfig({ env: { RUNLOOM_WORKSPACE: join(root, "first") }, userData: root, cwd: root }),
        resolveDesktopConfig({ env: { RUNLOOM_WORKSPACE: join(root, "second") }, userData: root, cwd: root }),
      ]);
      assert.equal(results.filter(result => result.generated).length, 1);
      assert.equal(results.some(result => result.patched), false);
      const config = JSON.parse(await readFile(join(root, "runloom.json"), "utf8"));
      assert.ok([join(root, "first"), join(root, "second")].includes(config.workspace));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
