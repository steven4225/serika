import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import { DOCKER_CLEANUP_TIMEOUT_MS } from "./docker-shell-runner.js";
import { createModuleHost, type ToolPermissionFacts } from "../module-host.js";
import {
  SHELL_EXEC_DOCKER_TOOL_TIMEOUT_MS,
  SHELL_EXEC_KILL_GRACE_MS,
  SHELL_EXEC_MAX_OUTPUT_BYTES,
  SHELL_EXEC_MAX_TIMEOUT_MS,
  SHELL_EXEC_TIMEOUT_MS,
  SHELL_EXEC_TOOL_TIMEOUT_MS,
  createShellModule,
  executeShellCommand,
} from "./shell-module.js";
import type { ShellExecResult } from "./shell-module.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function nodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
}

function registeredTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const registered = tools.find((candidate) => candidate.metadata.name === name);
  assert.ok(registered, `missing registered tool: ${name}`);
  return registered;
}

async function invoke<T = unknown>(
  registered: RegisteredTool,
  input: unknown,
  abortSignal?: AbortSignal,
): Promise<T> {
  assert.ok(registered.tool.execute);
  return (await registered.tool.execute(input, {
    toolCallId: "shell-test-call",
    messages: [],
    context: {},
    ...(abortSignal === undefined ? {} : { abortSignal }),
  })) as T;
}

describe("createShellModule", () => {
  it("registers shell_exec and runs from a workspace-relative cwd", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);
    await mkdir(join(workspaceRoot, "nested"));

    const tools: RegisteredTool[] = [];
    createShellModule(workspaceRoot).setup({
      registerTool: (registered) => tools.push(registered),
      addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
      notify: () => {},
    });

    const shell = registeredTool(tools, "shell_exec");
    assert.deepEqual(shell.metadata, {
      name: "shell_exec",
      version: "1",
      risk: "external_side_effect",
      timeoutMs: SHELL_EXEC_TOOL_TIMEOUT_MS,
      idempotent: false,
    });
    assert.ok(
      SHELL_EXEC_TOOL_TIMEOUT_MS >
        SHELL_EXEC_TIMEOUT_MS + SHELL_EXEC_KILL_GRACE_MS,
    );

    const result = await invoke(shell, {
      command: nodeCommand("process.stdout.write(process.cwd())"),
      cwd: "nested",
    });
    assert.deepEqual(result, {
      ok: true,
      exitCode: 0,
      termination: "exited",
      signal: null,
      cancelled: false,
      timedOut: false,
      output: await realpath(join(workspaceRoot, "nested")),
      truncated: false,
    });
  });

  it("gives Docker sandbox execute a timeout budget that outlasts cleanup", () => {
    const tools: RegisteredTool[] = [];
    createShellModule("/tmp/runloom-docker-timeout", {
      sandbox: {
        backend: "docker",
        image: "node:22-bookworm-slim",
        readablePaths: [],
        writablePaths: [],
      },
    }).setup({
      registerTool: (registered) => tools.push(registered),
      addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
      notify: () => {},
    });

    const shell = registeredTool(tools, "shell_exec");
    assert.equal(shell.metadata.timeoutMs, SHELL_EXEC_DOCKER_TOOL_TIMEOUT_MS);
    assert.ok(
      SHELL_EXEC_DOCKER_TOOL_TIMEOUT_MS >
        SHELL_EXEC_TIMEOUT_MS +
          SHELL_EXEC_KILL_GRACE_MS +
          DOCKER_CLEANUP_TIMEOUT_MS,
    );
    assert.ok(SHELL_EXEC_DOCKER_TOOL_TIMEOUT_MS > SHELL_EXEC_TOOL_TIMEOUT_MS);
  });

  it("uses a configured command timeout for host execution and tool metadata", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-timeout-"));
    directories.push(workspaceRoot);
    const tools: RegisteredTool[] = [];
    createShellModule(workspaceRoot, { timeoutMs: 50 }).setup({
      registerTool: (registered) => tools.push(registered),
      addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
      notify: () => {},
    });
    const shell = registeredTool(tools, "shell_exec");
    assert.equal(shell.metadata.timeoutMs, 50 + SHELL_EXEC_KILL_GRACE_MS + 750);
    const result = await invoke<ShellExecResult>(shell, {
      command: nodeCommand("setTimeout(() => {}, 1000)"),
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.timedOut, true);
  });

  it("emits bounded live output with tool call identity without changing the final result", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-progress-"));
    directories.push(workspaceRoot);
    const tools: RegisteredTool[] = [];
    const progress: Array<{ toolCallId: string; sequence: number; stream: string; text: string; truncated: boolean }> = [];
    createShellModule(workspaceRoot, {
      onProgress: (event) => {
        progress.push(event);
        if (event.sequence === 1) throw new Error("UI disconnected");
      },
    }).setup({
      registerTool: (registered) => tools.push(registered),
      addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
      notify: () => {},
    });

    const result = await invoke<ShellExecResult>(registeredTool(tools, "shell_exec"), {
      command: nodeCommand("process.stdout.write('first'); setTimeout(() => process.stderr.write('second'), 30)"),
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.exitCode, 0);
      assert.match(result.output, /first/);
      assert.match(result.output, /second/);
    }
    assert.deepEqual(progress.map(({ toolCallId, sequence, stream, text, truncated }) => ({
      toolCallId, sequence, stream, text, truncated,
    })), [
      { toolCallId: "shell-test-call", sequence: 1, stream: "stdout", text: "first", truncated: false },
      { toolCallId: "shell-test-call", sequence: 2, stream: "stderr", text: "second", truncated: false },
    ]);
  });

  it("keeps the configured Docker deadline ahead of cleanup and kill grace", () => {
    const tools: RegisteredTool[] = [];
    createShellModule("/tmp/runloom-docker-custom-timeout", {
      timeoutMs: SHELL_EXEC_MAX_TIMEOUT_MS,
      sandbox: {
        backend: "docker",
        image: "node:22-bookworm-slim",
        readablePaths: [],
        writablePaths: [],
      },
    }).setup({
      registerTool: (registered) => tools.push(registered),
      addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
      notify: () => {},
    });
    const shell = registeredTool(tools, "shell_exec");
    assert.equal(
      shell.metadata.timeoutMs,
      SHELL_EXEC_MAX_TIMEOUT_MS + SHELL_EXEC_KILL_GRACE_MS + DOCKER_CLEANUP_TIMEOUT_MS + 750,
    );
  });

  it("returns a non-zero exit code and combined command output", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);
    const tools: RegisteredTool[] = [];
    createShellModule(workspaceRoot).setup({
      registerTool: (registered) => tools.push(registered),
      addInstructions: () => {}, isAssembled: () => false, registerCommand: () => {},
      notify: () => {},
    });

    const result = await invoke<ShellExecResult>(registeredTool(tools, "shell_exec"), {
      command: nodeCommand(
        "process.stdout.write('stdout'); process.stderr.write('stderr'); process.exit(3)",
      ),
    });
    assert.ok(result.ok);
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 3);
    assert.equal(result.termination, "exited");
    assert.equal(result.cancelled, false);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.match(result.output, /stdout/);
    assert.match(result.output, /stderr/);
  });
});

describe("executeShellCommand", () => {
  it("keeps split UTF-8 characters intact in live progress", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-utf8-"));
    directories.push(workspaceRoot);
    const progress: string[] = [];
    const result = await executeShellCommand(
      workspaceRoot,
      { command: nodeCommand("process.stdout.write(Buffer.from([0xe4])); setTimeout(() => process.stdout.write(Buffer.from([0xbd, 0xa0])), 15)") },
      undefined,
      { onOutput: (_stream, text) => progress.push(text) },
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.output, "你");
    assert.deepEqual(progress, ["你"]);
  });

  it("reports output truncation without buffering beyond the configured limit", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);
    const progress: Array<{ text: string; truncated: boolean }> = [];

    const result = await executeShellCommand(
      workspaceRoot,
      { command: nodeCommand("process.stdout.write('0123456789')") },
      undefined,
      { maxOutputBytes: 5, onOutput: (_stream, text, truncated) => progress.push({ text, truncated }) },
    );
    assert.deepEqual(progress, [{ text: "01234", truncated: true }]);
    assert.deepEqual(result, {
      ok: true,
      exitCode: 0,
      termination: "exited",
      signal: null,
      cancelled: false,
      timedOut: false,
      output: "01234",
      truncated: true,
    });
    assert.equal(SHELL_EXEC_MAX_OUTPUT_BYTES, 65_536);
  });

  it("terminates a command that exceeds the timeout", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);

    const result = await executeShellCommand(
      workspaceRoot,
      { command: nodeCommand("setTimeout(() => {}, 10000)") },
      undefined,
      { timeoutMs: 50 },
    );
    assert.ok(result.ok);
    assert.equal(result.exitCode, null);
    assert.equal(result.termination, "signalled");
    assert.equal(result.cancelled, false);
    assert.equal(result.timedOut, true);
  });

  it("terminates a running command when its AbortSignal is cancelled", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 50);

    try {
      const result = await executeShellCommand(
        workspaceRoot,
        { command: nodeCommand("setTimeout(() => {}, 10000)") },
        controller.signal,
        { timeoutMs: 5_000 },
      );
      assert.ok(result.ok);
      assert.equal(result.exitCode, null);
      assert.equal(result.termination, "signalled");
      assert.equal(result.cancelled, true);
      assert.equal(result.timedOut, false);
    } finally {
      clearTimeout(abortTimer);
    }
  });

  it("returns a timed-out command result before a later tool-layer abort", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);
    const toolLayer = AbortSignal.timeout(400);

    const result = await executeShellCommand(
      workspaceRoot,
      { command: nodeCommand("setTimeout(() => {}, 10000)") },
      toolLayer,
      { timeoutMs: 50 },
    );
    assert.ok(result.ok);
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.exitCode, null);
    assert.equal(result.termination, "signalled");
  });

  it("does not pass application API keys into the command environment", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-secret-do-not-inherit";

    try {
      const result = await executeShellCommand(workspaceRoot, {
        command: nodeCommand(
          "process.stdout.write(process.env.DEEPSEEK_API_KEY ?? '')",
        ),
      });
      assert.ok(result.ok);
      assert.equal(result.exitCode, 0);
      assert.equal(result.output, "");
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it("rejects a cwd outside the workspace", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "runloom-shell-module-"));
    directories.push(workspaceRoot);

    assert.deepEqual(
      await executeShellCommand(workspaceRoot, {
        command: "pwd",
        cwd: "../outside",
      }),
      {
        ok: false,
        error: {
          code: "PATH_OUTSIDE_WORKSPACE",
          message: "Path is outside the workspace",
        },
      },
    );
  });
  it("declares never-remembered shell calls, sandbox-only Run authorization, cards and instructions", () => {
    const sandbox = { backend: "docker" as const, image: "img", readablePaths: [], writablePaths: [] };
    const host = createModuleHost([createShellModule("/tmp", {})], { notify() {} });
    const docker = createModuleHost([createShellModule("/tmp", { sandbox })], { notify() {} });
    assert.deepEqual(host.toolPermissions.get("shell_exec")?.defaults, { remember: "never" });
    assert.deepEqual(docker.toolPermissions.get("shell_exec")?.defaults, { remember: "never", runAuthorization: "tool" });
    const card = (module: typeof host) => module.toolPermissions.get("shell_exec")?.confirmation?.(
      { toolName: "shell_exec", input: { command: "ls" } } as Parameters<NonNullable<ToolPermissionFacts["confirmation"]>>[0]);
    assert.match(String(card(host)), /^\nTool: shell_exec\nCommand: "ls"\nCwd: "\." \(relative to workspace\)\n/);
    assert.match(String(card(docker)), /\(relative to sandbox mounts\)\nDocker sandbox image: img; network none; root filesystem read-only\.\nReadable: none; writable: none\.\n/);
    assert.match(host.instructions("shell"), /will be shown for y\/n confirmation\./);
    assert.match(host.instructions("shell", { autonomous: true }), /The command and workspace-relative cwd will be shown for y\/n confirmation\./);
    assert.equal(docker.instructions("shell", { autonomous: true }), docker.instructions("shell"));
  });
});
