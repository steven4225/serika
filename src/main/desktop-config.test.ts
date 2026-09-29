import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DESKTOP_DEFAULT_SHELL_TIMEOUT_MS,
  DESKTOP_DEFAULT_TOTAL_TIMEOUT_MS,
  defaultDesktopConfig,
  resolveDesktopConfig,
  withDesktopTimeouts,
} from "./desktop-config.js";

describe("desktop TUI config", () => {
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
});
