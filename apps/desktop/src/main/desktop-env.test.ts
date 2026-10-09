import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { loadDesktopEnvironment, safeStartupError } from "./desktop-env.js";

it("loads an explicit env file without overriding existing settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "runloom-desktop-env-"));
  try {
    const path = join(root, ".env");
    await writeFile(path, 'RUNLOOM_MODEL=command-code\nCOMMAND_CODE_API_KEY="test-secret"\n');
    const env: NodeJS.ProcessEnv = { RUNLOOM_ENV_FILE: path, RUNLOOM_MODEL: "mock" };
    await loadDesktopEnvironment(env);
    assert.equal(env.RUNLOOM_MODEL, "mock");
    assert.equal(env.COMMAND_CODE_API_KEY, "test-secret");
    assert.equal(safeStartupError(new Error("test-secret unavailable"), env).includes("test-secret"), false);
    assert.match(safeStartupError(new Error("test-secret unavailable"), env), /已隐藏/);
    const missing: NodeJS.ProcessEnv = {};
    await loadDesktopEnvironment(missing);
    assert.deepEqual(missing, {});
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("reports missing, relative, invalid and oversized env files without leaking content", async () => {
  await assert.rejects(loadDesktopEnvironment({ RUNLOOM_ENV_FILE: "relative.env" }), /绝对路径/);
  const root = await mkdtemp(join(tmpdir(), "runloom-desktop-env-invalid-"));
  try {
    const path = join(root, ".env");
    await assert.rejects(loadDesktopEnvironment({ RUNLOOM_ENV_FILE: path }), /无法加载/);
    for (const text of ["# no configuration", "COMMAND_CODE_API_KEY=" + "x".repeat(70 * 1024)]) {
      await writeFile(path, text);
      await assert.rejects(loadDesktopEnvironment({ RUNLOOM_ENV_FILE: path }), /无法加载/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
