import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveTuiModuleConfig } from "./tui-module-config.js";

function configArgs(configPath: string) {
  return { configPath } as Parameters<typeof resolveTuiModuleConfig>[0];
}

async function createConfigWorkspace(): Promise<{
  root: string;
  configDirectory: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "runloom-config-"));
  const configDirectory = join(root, "config");
  const workspace = join(configDirectory, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, configDirectory, workspace };
}

async function writeConfig(
  configDirectory: string,
  value: unknown,
  name = "runloom.json",
): Promise<string> {
  const configPath = join(configDirectory, name);
  await writeFile(configPath, JSON.stringify(value), "utf8");
  return configPath;
}

describe("resolveTuiModuleConfig", () => {
  it("uses strict config modules with omitted modules disabled", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace",
      modules: {
        "read-file": { enabled: true },
        todoist: { enabled: true },
      },
    });

    const resolved = await resolveTuiModuleConfig(configArgs("runloom.json"), {
      cwd: configDirectory,
      todoistTimeZone: "UTC",
    });

    assert.equal(resolved.configPath, configPath);
    assert.equal(resolved.workspaceRoot, await realpath(workspace));
    assert.deepEqual(resolved.enabled, {
      pomodoro: false,
      "read-file": true,
      memory: false,
      task: false,
      todoist: true,
    });
    assert.equal(resolved.autoConsolidate, false);
    assert.equal(resolved.todoistTimeZone, "Asia/Shanghai");
    if (resolved.configPath !== null) {
      assert.equal(dirname(resolved.configPath), configDirectory);
    }
  });

  it("resolves workspace relative to the config file directory", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const nestedDirectory = join(configDirectory, "nested");
    await mkdir(nestedDirectory);
    const configPath = await writeConfig(nestedDirectory, {
      version: 1,
      workspace: "../workspace",
      modules: { memory: { enabled: true } },
    });

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: tmpdir(),
    });

    assert.equal(resolved.workspaceRoot, await realpath(workspace));
  });

  it("supports memory auto consolidation only when memory is enabled", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace",
      modules: {
        memory: { enabled: true, autoConsolidate: true },
      },
    });

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: configDirectory,
    });
    assert.equal(resolved.autoConsolidate, true);
    assert.equal(resolved.workspaceRoot, await realpath(workspace));

    const disabledPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { memory: { enabled: false, autoConsolidate: true } },
    }, "disabled-memory.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(disabledPath), { cwd: configDirectory }),
      /memory\.autoConsolidate requires memory\.enabled to be true/,
    );
  });

  it("requires workspace for workspace modules but allows Todoist alone", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const todoistPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { todoist: { enabled: true, timeZone: "UTC" } },
    });
    const todoist = await resolveTuiModuleConfig(configArgs(todoistPath), {
      cwd: configDirectory,
      todoistTimeZone: "America/Los_Angeles",
    });
    assert.equal(todoist.workspaceRoot, null);
    assert.equal(todoist.todoistTimeZone, "UTC");

    const fileOnlyPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { "read-file": { enabled: true } },
    }, "file-only.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(fileOnlyPath), { cwd: configDirectory }),
      /TUI config requires workspace when read-file, memory, or task is enabled/,
    );
  });

  it("rejects unknown keys, modules, versions, and bare module booleans", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const invalidValues = [
      { version: 1, modules: {}, extra: true },
      { version: 1, modules: { calendar: { enabled: true } } },
      { version: 2, modules: {} },
      { version: 1, modules: { pomodoro: true } },
      { version: 1, modules: { memory: { enabled: true }, extra: true } },
      { version: 1, workspace: "   ", modules: {} },
      { version: 1, modules: { todoist: { enabled: true, timeZone: "   " } } },
    ];

    for (const [index, value] of invalidValues.entries()) {
      const configPath = await writeConfig(configDirectory, value, `invalid-${index}.json`);
      await assert.rejects(
        resolveTuiModuleConfig(configArgs(configPath), { cwd: configDirectory }),
        /Invalid TUI config schema/,
      );
    }
  });

  it("rejects malformed JSON and does not fall back to legacy settings", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const configPath = join(configDirectory, "malformed.json");
    await writeFile(configPath, '{"version":1,', "utf8");

    await assert.rejects(
      resolveTuiModuleConfig(configArgs(configPath), {
        cwd: configDirectory,
        todoistTimeZone: "UTC",
      }),
      /Invalid TUI config JSON/,
    );
  });

  it("preserves the legacy CLI behavior and only uses its passed timezone", async () => {
    const { root, workspace } = await createConfigWorkspace();
    const resolved = await resolveTuiModuleConfig(
      {
        workspace: "config/workspace",
        autoConsolidate: true,
        todoistEnabled: true,
      },
      { cwd: root, todoistTimeZone: "UTC" },
    );

    assert.equal(resolved.configPath, null);
    assert.equal(resolved.workspaceRoot, await realpath(workspace));
    assert.deepEqual(resolved.enabled, {
      pomodoro: true,
      "read-file": true,
      memory: true,
      task: true,
      todoist: true,
    });
    assert.equal(resolved.autoConsolidate, true);
    assert.equal(resolved.todoistTimeZone, "UTC");
  });

  it("rejects config mode combined with module selection arguments", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: {},
    });

    for (const extra of [
      { workspace: "workspace" },
      { todoistEnabled: true },
      { autoConsolidate: true },
    ]) {
      await assert.rejects(
        resolveTuiModuleConfig(
          { ...configArgs(configPath), ...extra },
          { cwd: configDirectory },
        ),
        /--config cannot be combined with module selection options/,
      );
    }
  });
});

describe("TUI module configuration entry", () => {
  it("always exposes /modules when every configurable module is disabled", async () => {
    const { root, configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: {},
    });
    const entry = fileURLToPath(new URL("./index.js", import.meta.url));
    const { TODOIST_API_TOKEN: _token, ...baseEnv } = process.env;
    const child = spawn(
      process.execPath,
      [entry, "--tui", "--config", configPath],
      {
        cwd: root,
        env: { ...baseEnv, RUNLOOM_MODEL: "mock" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.end("/modules\n");
    const [code] = await once(child, "close");

    assert.equal(code, 0, stderr);
    assert.match(stdout, /配置来源: .*runloom\.json/);
    assert.match(stdout, /Workspace: 未配置/);
    assert.match(stdout, /pomodoro: disabled/);
    assert.match(stdout, /read-file: disabled/);
    assert.match(stdout, /memory: disabled/);
    assert.match(stdout, /task: disabled/);
    assert.match(stdout, /todoist: disabled/);
    assert.match(stdout, /Todoist 规划时区: 未启用/);
    assert.match(stdout, /自动记忆整理: off/);
    assert.match(stdout, /Todoist token: missing/);
    assert.doesNotMatch(stdout, /TODOIST_API_TOKEN/);
  });
});
