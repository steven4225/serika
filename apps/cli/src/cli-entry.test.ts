import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// Spawns the real CLI entry: these exercise argv parsing, assembly and the
// terminal commands together without starting a Run.
const ENTRY = fileURLToPath(new URL("./index.js", import.meta.url));

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

describe("TUI module configuration entry", () => {
  it("shows persistent rules through /permissions without starting a Run", async () => {
    const { root, configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      authorizedDirectories: [{ path: "./workspace", access: "readwrite" }],
      modules: { "read-file": { enabled: true } },
      fileAuthorizations: [
        { tools: ["read_file"], allowedPaths: ["docs"] },
      ],
    }, "permissions.json");
    const child = spawn(
      process.execPath,
      [ENTRY, "--tui", "--home", join(root, "home"), "--config", configPath],
      {
        cwd: root,
        env: { ...process.env, SERIKA_HOME: join(root, "implicit-home"), RUNLOOM_MODEL: "mock" },
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
    assert.ok((await stat(join(root, "home/transcripts"))).isDirectory());
    await assert.rejects(stat(join(root, "implicit-home")), { code: "ENOENT" });
    assert.match(stdout, /\[permissions\]/);
    assert.match(stdout, /持久文件授权: 1 条/);
    assert.match(stdout, /tools=read_file paths=docs/);
    assert.match(stdout, /Web module: disabled/);
    assert.match(stdout, /修改或删除配置后需重启 TUI 生效/);
    assert.match(stdout, /Shell、memory、checkpoint、Todoist、task 不受持久文件授权影响/);
    assert.doesNotMatch(stdout, /Allow this call\? \[y\/n\]/);
  });

  it("exposes /authorize-web only when the web module is enabled", async () => {
    const { root, configDirectory } = await createConfigWorkspace();
    const configPath = await writeConfig(configDirectory, {
      version: 1,
      modules: { web: { enabled: true } },
    }, "web.json");
    const child = spawn(
      process.execPath,
      [ENTRY, "--tui", "--home", join(root, "home"), "--config", configPath],
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
    const { BRAVE_SEARCH_API_KEY: _searchKey, EXA_API_KEY: _exaKey, ...baseEnv } = process.env;
    const child = spawn(
      process.execPath,
      [ENTRY, "--tui", "--home", join(root, "home"), "--config", configPath],
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
    const { TODOIST_API_TOKEN: _token, ...baseEnv } = process.env;
    const child = spawn(
      process.execPath,
      [ENTRY, "--tui", "--home", join(root, "home"), "--config", configPath],
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
