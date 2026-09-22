import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
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
  it("loads and normalizes a Docker shell sandbox configuration", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, "reports"));
    await writeFile(join(workspace, "package.json"), "{}", "utf8");
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace",
      modules: {
        shell: {
          enabled: true,
          sandbox: {
            backend: "docker",
            image: "node:22-bookworm-slim",
            readablePaths: ["package.json", "src/", "src"],
            writablePaths: ["reports/"],
          },
        },
      },
    });

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: configDirectory,
    });

    assert.equal(resolved.workspaceRoot, await realpath(workspace));
    assert.deepEqual(resolved.shellSandbox, {
      backend: "docker",
      image: "node:22-bookworm-slim",
      readablePaths: ["package.json", "src"],
      writablePaths: ["reports"],
    });
  });

  it("requires a relative existing directory workspace for a shell sandbox", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const configs = [
      {
        name: "absolute-workspace.json",
        workspace: workspace,
        expected: /workspace must be relative/i,
      },
      {
        name: "missing-workspace.json",
        workspace: "./missing",
        expected: /workspace does not exist/i,
      },
    ];

    for (const value of configs) {
      const configPath = await writeConfig(configDirectory, {
        version: 1,
        workspace: value.workspace,
        modules: {
          shell: {
            enabled: true,
            sandbox: {
              backend: "docker",
              image: "node:22-bookworm-slim",
              readablePaths: [],
              writablePaths: [],
            },
          },
        },
      }, value.name);
      await assert.rejects(
        resolveTuiModuleConfig(configArgs(configPath), { cwd: configDirectory }),
        value.expected,
      );
    }

    const filePath = join(configDirectory, "workspace-file.txt");
    await writeFile(filePath, "file", "utf8");
    const fileConfig = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace-file.txt",
      modules: {
        shell: {
          enabled: true,
          sandbox: {
            backend: "docker",
            image: "node:22-bookworm-slim",
            readablePaths: [],
            writablePaths: [],
          },
        },
      },
    }, "workspace-file.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(fileConfig), { cwd: configDirectory }),
      /workspace is not a directory/i,
    );

    const workspaceLink = join(configDirectory, "workspace-link");
    await symlink(workspace, workspaceLink, "dir");
    const symlinkConfig = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace-link",
      modules: {
        shell: {
          enabled: true,
          sandbox: {
            backend: "docker",
            image: "node:22-bookworm-slim",
            readablePaths: [],
            writablePaths: [],
          },
        },
      },
    }, "symlink-workspace.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(symlinkConfig), { cwd: configDirectory }),
      /workspace must not be a symlink/i,
    );
  });

  it("rejects missing, symlinked, and non-directory writable sandbox paths", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "package.json"), "{}", "utf8");
    await writeFile(join(workspace, "file.txt"), "file", "utf8");
    await symlink(join(workspace, "docs"), join(workspace, "docs-link"), "dir");

    const values = [
      {
        name: "missing-mount.json",
        readablePaths: ["missing"],
        writablePaths: [],
        expected: /mount path does not exist/i,
      },
      {
        name: "symlink-mount.json",
        readablePaths: ["docs-link"],
        writablePaths: [],
        expected: /symlink/i,
      },
      {
        name: "file-writable-mount.json",
        readablePaths: [],
        writablePaths: ["file.txt"],
        expected: /writable sandbox path must be a directory/i,
      },
    ];

    for (const value of values) {
      const configPath = await writeConfig(configDirectory, {
        version: 1,
        workspace: "./workspace",
        modules: {
          shell: {
            enabled: true,
            sandbox: {
              backend: "docker",
              image: "node:22-bookworm-slim",
              readablePaths: value.readablePaths,
              writablePaths: value.writablePaths,
            },
          },
        },
      }, value.name);
      await assert.rejects(
        resolveTuiModuleConfig(configArgs(configPath), { cwd: configDirectory }),
        value.expected,
      );
    }
  });

  it("requires shell.sandbox to be enabled and keeps its config outside the workspace", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const disabledPath = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace",
      modules: {
        shell: {
          enabled: false,
          sandbox: {
            backend: "docker",
            image: "node:22-bookworm-slim",
            readablePaths: [],
            writablePaths: [],
          },
        },
      },
    }, "sandbox-disabled.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(disabledPath), { cwd: configDirectory }),
      /shell\.sandbox requires shell\.enabled/i,
    );

    const insidePath = await writeConfig(workspace, {
      version: 1,
      workspace: ".",
      modules: {
        shell: {
          enabled: true,
          sandbox: {
            backend: "docker",
            image: "node:22-bookworm-slim",
            readablePaths: [],
            writablePaths: [],
          },
        },
      },
    }, "sandbox-inside.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(insidePath), { cwd: workspace }),
      /config with sandbox.*outside the workspace/i,
    );
  });

  it("loads persistent file authorization rules with the configured workspace", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace",
      modules: { "read-file": { enabled: true } },
      fileAuthorizations: [
        {
          tools: ["read_file", "search_files"],
          allowedPaths: ["docs/", "reports"],
        },
      ],
    });

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: configDirectory,
    });

    assert.equal(resolved.workspaceRoot, await realpath(workspace));
    assert.equal(resolved.fileAuthorizations.length, 1);
    assert.deepEqual(resolved.fileAuthorizations[0]?.tools, [
      "read_file",
      "search_files",
    ]);
    assert.deepEqual(resolved.fileAuthorizations[0]?.allowedPaths, [
      "docs",
      "reports",
    ]);
  });

  it("rejects invalid persistent authorization tools and paths", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const invalidValues = [
      {
        version: 1,
        workspace: "./workspace",
        modules: { "read-file": { enabled: true } },
        fileAuthorizations: [
          { tools: ["shell_exec"], allowedPaths: ["docs"] },
        ],
      },
      {
        version: 1,
        workspace: "./workspace",
        modules: { "read-file": { enabled: true } },
        fileAuthorizations: [
          { tools: ["read_file"], allowedPaths: ["../outside"] },
        ],
      },
    ];

    for (const [index, value] of invalidValues.entries()) {
      const configPath = await writeConfig(
        configDirectory,
        value,
        `invalid-file-authorization-${index}.json`,
      );
      await assert.rejects(
        resolveTuiModuleConfig(configArgs(configPath), {
          cwd: configDirectory,
        }),
        /(Invalid|authorization|tool|path)/i,
      );
    }
  });

  it("rejects persistent authorization when the config file is inside the workspace", async () => {
    const { workspace } = await createConfigWorkspace();
    const configPath = await writeConfig(workspace, {
      version: 1,
      workspace: ".",
      modules: { "read-file": { enabled: true } },
      fileAuthorizations: [
        { tools: ["read_file"], allowedPaths: ["docs"] },
      ],
    });

    await assert.rejects(
      resolveTuiModuleConfig(configArgs(configPath), { cwd: workspace }),
      /(outside|workspace|authorization)/i,
    );
  });

  it("rejects an outside config symlink that resolves into the workspace", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const insidePath = await writeConfig(workspace, {
      version: 1,
      workspace: "./workspace",
      modules: { "read-file": { enabled: true } },
      fileAuthorizations: [
        { tools: ["read_file"], allowedPaths: ["docs"] },
      ],
    }, "inside.json");
    const linkPath = join(configDirectory, "linked.json");
    await symlink(insidePath, linkPath);

    await assert.rejects(
      resolveTuiModuleConfig(configArgs(linkPath), { cwd: configDirectory }),
      /outside the workspace/,
    );
  });

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
      shell: false,
      web: false,
    });
    assert.equal(resolved.autoConsolidate, false);
    assert.equal(resolved.todoistTimeZone, "Asia/Shanghai");
    if (resolved.configPath !== null) {
      assert.equal(dirname(resolved.configPath), configDirectory);
    }
  });

  it("enables the public web reader without requiring a workspace", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { web: { enabled: true } },
    }, "web.json");

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: configDirectory,
    });

    assert.equal(resolved.workspaceRoot, null);
    assert.equal(resolved.enabled.web, true);
    assert.equal(resolved.webSearchEnabled, false);
    assert.equal(resolved.shellSandbox, null);
    assert.equal(resolved.contextCompaction.enabled, false);
  });

  it("validates an explicitly enabled context-compaction budget", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: {},
      contextCompaction: {
        enabled: true,
        contextWindowTokens: 16_000,
        maxOutputTokens: 2_000,
        safetyMarginTokens: 500,
        keepRecentTokens: 4_000,
        summaryMaxOutputTokens: 800,
      },
    }, "context-compaction.json");

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: configDirectory,
    });
    assert.deepEqual(resolved.contextCompaction, {
      enabled: true,
      contextWindowTokens: 16_000,
      maxOutputTokens: 2_000,
      safetyMarginTokens: 500,
      keepRecentTokens: 4_000,
      summaryMaxOutputTokens: 800,
    });
  });

  it("rejects an enabled context budget with no room for recent history", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: {},
      contextCompaction: {
        enabled: true,
        contextWindowTokens: 100,
        maxOutputTokens: 80,
        safetyMarginTokens: 30,
        keepRecentTokens: 1,
        summaryMaxOutputTokens: 10,
      },
    }, "invalid-context-compaction.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(configPath), { cwd: configDirectory }),
      /Invalid context compaction budget/,
    );
  });

  it("keeps web search opt-in inside the web module", async () => {
    const { configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { web: { enabled: true, search: { enabled: true } } },
    }, "web-search.json");

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: configDirectory,
    });

    assert.equal(resolved.enabled.web, true);
    assert.equal(resolved.webSearchEnabled, true);

    const searchWithoutWeb = await writeConfig(configDirectory, {
      version: 1,
      modules: { web: { enabled: false, search: { enabled: true } } },
    }, "search-without-web.json");
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(searchWithoutWeb), { cwd: configDirectory }),
      /web\.search requires web\.enabled to be true/,
    );
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
      /TUI config requires workspace when read-file, memory, task, or shell is enabled/,
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

  it("enables shell only with an explicit config and requires workspace", async () => {
    const { configDirectory, workspace } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace",
      modules: { shell: { enabled: true } },
    });

    const resolved = await resolveTuiModuleConfig(configArgs(configPath), {
      cwd: configDirectory,
    });
    assert.equal(resolved.workspaceRoot, await realpath(workspace));
    assert.equal(resolved.enabled.shell, true);

    const noWorkspacePath = await writeConfig(
      configDirectory,
      { version: 1, modules: { shell: { enabled: true } } },
      "shell-no-workspace.json",
    );
    await assert.rejects(
      resolveTuiModuleConfig(configArgs(noWorkspacePath), { cwd: configDirectory }),
      /TUI config requires workspace when read-file, memory, task, or shell is enabled/,
    );
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
      shell: false,
      web: false,
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
  it("shows persistent rules through /permissions without starting a Run", async () => {
    const { root, configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      workspace: "./workspace",
      modules: { "read-file": { enabled: true } },
      fileAuthorizations: [
        { tools: ["read_file"], allowedPaths: ["docs"] },
      ],
    }, "permissions.json");
    const entry = fileURLToPath(new URL("./index.js", import.meta.url));
    const child = spawn(
      process.execPath,
      [entry, "--tui", "--config", configPath],
      {
        cwd: root,
        env: { ...process.env, RUNLOOM_MODEL: "mock" },
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
    child.stdin.end("/permissions\n");
    const [code] = await once(child, "close");

    assert.equal(code, 0, stderr);
    assert.match(stdout, /\[permissions\]/);
    assert.match(stdout, /持久文件授权: 1 条/);
    assert.match(stdout, /tools=read_file paths=docs/);
    assert.match(stdout, /Web module: disabled/);
    assert.match(stdout, /修改或删除配置后需重启 TUI 生效/);
    assert.doesNotMatch(stdout, /Allow this call\? \[y\/n\]/);
  });

  it("exposes /authorize-web only when the web module is enabled", async () => {
    const { root, configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { web: { enabled: true } },
    }, "web.json");
    const entry = fileURLToPath(new URL("./index.js", import.meta.url));
    const child = spawn(
      process.execPath,
      [entry, "--tui", "--config", configPath],
      {
        cwd: root,
        env: { ...process.env, RUNLOOM_MODEL: "mock" },
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
    child.stdin.end("/authorize-web https://example.com\n/permissions\n");
    const [code] = await once(child, "close");

    assert.equal(code, 0, stderr);
    assert.match(stdout, /\[authorize-web\] 已为下一次 Run 授权 web_fetch/);
    assert.match(stdout, /Web module: enabled \(web_fetch\)/);
    assert.doesNotMatch(stdout, /Allow this call\? \[y\/n\]/);
  });

  it("registers keyless Exa search when web search is enabled", async () => {
    const { root, configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { web: { enabled: true, search: { enabled: true } } },
    }, "web-search.json");
    const entry = fileURLToPath(new URL("./index.js", import.meta.url));
    const { BRAVE_SEARCH_API_KEY: _searchKey, EXA_API_KEY: _exaKey, ...baseEnv } = process.env;
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
    assert.match(stdout, /web: enabled \(web_fetch\)/);
    assert.match(stdout, /web_search: enabled \(Exa MCP, no key\)/);
  });

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
    assert.match(stdout, /shell: disabled/);
    assert.match(stdout, /web: disabled/);
    assert.match(stdout, /Todoist 规划时区: 未启用/);
    assert.match(stdout, /自动记忆整理: off/);
    assert.match(stdout, /Todoist token: missing/);
    assert.doesNotMatch(stdout, /TODOIST_API_TOKEN/);
  });
});
