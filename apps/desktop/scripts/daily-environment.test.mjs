import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dailyEnvironment } from "./daily-environment.mjs";

test("monorepo daily launcher defaults to the root env and keeps explicit external overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-monorepo-env-"));
  try {
    const desktop = join(root, "apps", "desktop");
    await mkdir(desktop, { recursive: true });
    await writeFile(join(root, ".env"), "RUNLOOM_MODEL=command-code\nCOMMAND_CODE_API_KEY=test-only-key\n");
    const env = await dailyEnvironment(desktop, {});
    assert.equal(env.RUNLOOM_ENV_FILE, join(root, ".env"));
    assert.equal(env.RUNLOOM_MODEL, "command-code");
    assert.equal(env.COMMAND_CODE_API_KEY, undefined);
    const external = join(root, "trusted.env");
    await writeFile(external, "RUNLOOM_MODEL=deepseek\n");
    assert.equal((await dailyEnvironment(desktop, { RUNLOOM_ENV_FILE: external })).RUNLOOM_ENV_FILE, external);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily launcher selects a real model without copying credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-launcher-env-"));
  try {
    const file = join(root, "trusted.env");
    await writeFile(file, "COMMAND_CODE_API_KEY=test-only-key\nDEEPSEEK_API_KEY=other-test-key\n");
    const inherited = { RUNLOOM_ENV_FILE: file, ELECTRON_RUN_AS_NODE: "1" };
    const env = await dailyEnvironment(root, inherited);
    assert.equal(env.RUNLOOM_MODEL, "command-code");
    assert.equal(env.COMMAND_CODE_API_KEY, undefined);
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(inherited.ELECTRON_RUN_AS_NODE, "1");
    assert.equal((await dailyEnvironment(root, { RUNLOOM_ENV_FILE: file, RUNLOOM_MODEL: "deepseek" })).RUNLOOM_MODEL, "deepseek");
    await writeFile(file, "RUNLOOM_MODEL=deepseek\nDEEPSEEK_API_KEY=test-only-key\n");
    assert.equal((await dailyEnvironment(root, { RUNLOOM_ENV_FILE: file })).RUNLOOM_MODEL, "deepseek");
    await assert.rejects(dailyEnvironment(root, { RUNLOOM_ENV_FILE: file, RUNLOOM_MODEL: "mock" }), /真实模型/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("daily launcher rejects bad files without exposing their content", async () => {
  const root = await mkdtemp(join(tmpdir(), "serika-launcher-env-"));
  try {
    const file = join(root, "trusted.env");
    await assert.rejects(dailyEnvironment(root, { RUNLOOM_ENV_FILE: "relative.env" }), /绝对路径/);
    await assert.rejects(dailyEnvironment(root, { RUNLOOM_ENV_FILE: file }), /无法读取日用模型配置/);
    await writeFile(file, "COMMAND_CODE_API_KEY=" + "secret-content".repeat(6000));
    await assert.rejects(dailyEnvironment(root, { RUNLOOM_ENV_FILE: file }), error => /无法读取日用模型配置/.test(error.message) && !error.message.includes("secret-content"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
