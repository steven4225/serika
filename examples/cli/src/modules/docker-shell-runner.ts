import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { rejectSymlinkComponents, validateWorkspacePath } from "../workspace-path.js";
import type {
  ShellExecFailure,
  ShellExecInput,
  ShellExecResult,
  ShellExecSuccess,
} from "./shell-module.js";

export interface DockerShellSandboxConfig {
  backend: "docker";
  image: string;
  readablePaths: readonly string[];
  writablePaths: readonly string[];
}

export interface DockerShellRunnerOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  dockerExecutable?: string;
  onOutput?: ((stream: "stdout" | "stderr", text: string, truncated: boolean) => void) | undefined;
}

const DOCKER_SANDBOX_VALIDATION_TIMEOUT_MS = 5_000;
const DOCKER_SANDBOX_VALIDATION_OUTPUT_BYTES = 8 * 1024;

const DEFAULT_DOCKER_EXECUTABLE = "docker";
/** Budget for proving `docker rm -f` after timeout or cancel. */
export const DOCKER_CLEANUP_TIMEOUT_MS = 5_000;
const DOCKER_KILL_GRACE_MS = 250;

type CaptureResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  truncated: boolean;
  spawnError?: unknown;
};

function failure(
  code: "SANDBOX_UNAVAILABLE" | "SANDBOX_CLEANUP_FAILED",
  message: string,
): ShellExecFailure {
  return { ok: false, error: { code, message } };
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const sensitiveName =
    /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|PRIVATE_KEY)/i;
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && !sensitiveName.test(name),
    ),
  );
}

function appendOutput(
  chunks: Buffer[],
  chunk: Buffer | string,
  state: { bytes: number; truncated: boolean },
  maxBytes: number,
): Buffer {
  if (state.bytes >= maxBytes) {
    state.truncated = true;
    return Buffer.alloc(0);
  }
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maxBytes - state.bytes;
  if (bytes.byteLength > remaining) {
    chunks.push(bytes.subarray(0, remaining));
    state.bytes = maxBytes;
    state.truncated = true;
    return bytes.subarray(0, remaining);
  }
  chunks.push(bytes);
  state.bytes += bytes.byteLength;
  return bytes;
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between the check and the kill request.
  }
}

function spawnCapture(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  maxOutputBytes: number,
  timeoutMs: number,
  onOutput?: (stream: "stdout" | "stderr", text: string, truncated: boolean) => void,
): Promise<CaptureResult> {
  let child: ChildProcess;
  try {
    child = spawn(executable, [...args], {
      env: commandEnvironment(),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve({
      code: null,
      signal: null,
      output: "",
      truncated: false,
      spawnError: error,
    });
  }

  return new Promise<CaptureResult>((resolveResult) => {
    const chunks: Buffer[] = [];
    const outputState = { bytes: 0, truncated: false };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const capture = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      const wasTruncated = outputState.truncated;
      const accepted = appendOutput(chunks, chunk, outputState, maxOutputBytes);
      if (signal.aborted || onOutput === undefined || (accepted.length === 0 && wasTruncated)) return;
      const text = decoders[stream].write(accepted);
      if (text.length === 0 && !outputState.truncated) return;
      try {
        onOutput(stream, text, outputState.truncated);
      } catch {
        // UI progress callbacks never determine Docker command outcome.
      }
    };
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let abortRequested = false;
    let timedOut = false;

    const terminate = (timedOutValue: boolean): void => {
      if (abortRequested) return;
      abortRequested = true;
      timedOut = timedOutValue;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(
        () => killChild(child, "SIGKILL"),
        DOCKER_KILL_GRACE_MS,
      );
    };
    const onAbort = (): void => terminate(false);
    const finish = (result: CaptureResult): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      signal.removeEventListener("abort", onAbort);
      resolveResult(result);
    };

    timeoutTimer = setTimeout(() => terminate(true), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdout?.on("data", (chunk: Buffer | string) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => capture("stderr", chunk));
    let spawnError: unknown;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, closeSignal) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = decoders[stream].end();
        if (tail && !signal.aborted && onOutput !== undefined) {
          try {
            onOutput(stream, tail, outputState.truncated);
          } catch {
            // UI progress callbacks never determine Docker command outcome.
          }
        }
      }
      finish({
        code: timedOut || abortRequested ? null : code,
        signal: closeSignal,
        output: Buffer.concat(chunks).toString("utf8"),
        truncated: outputState.truncated,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    });
  });
}

function containerTarget(relativePath: string): string {
  return relativePath === "" ? "/workspace" : `/workspace/${relativePath}`;
}

function mountSpec(source: string, target: string, readOnly: boolean): string {
  return [
    "type=bind",
    `src=${source}`,
    `dst=${target}`,
    ...(readOnly ? ["readonly"] : []),
  ].join(",");
}

/**
 * Build argv for `docker run`. Keeping this separate makes it possible to
 * verify that model input remains one argv element and is never interpreted by
 * a host shell.
 */
export function buildDockerRunArguments(
  workspaceRoot: string,
  input: ShellExecInput,
  sandbox: DockerShellSandboxConfig,
  containerName: string,
): string[] {
  const writable = new Set(sandbox.writablePaths);
  const mounts = [
    ...sandbox.readablePaths
      .filter((path) => !writable.has(path))
      .map((path) =>
        mountSpec(
          join(workspaceRoot, path),
          containerTarget(path),
          true,
        ),
      ),
    ...sandbox.writablePaths.map((path) =>
      mountSpec(join(workspaceRoot, path), containerTarget(path), false),
    ),
  ];
  const cwd = input.cwd === undefined ? "" : input.cwd;
  const cwdPath = containerTarget(cwd);
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--tmpfs",
    "/tmp:rw,size=64m",
    "--tmpfs",
    "/workspace:rw,size=64m",
    ...mounts.flatMap((mount) => ["--mount", mount]),
    sandbox.image,
    "/bin/sh",
    "-lc",
    `cd ${shellQuote(cwdPath)} && ${input.command}`,
  ];
}

/** Validate the Docker daemon and image before the TUI starts. */
export async function assertDockerShellSandboxAvailable(
  sandbox: DockerShellSandboxConfig,
  dockerExecutable = DEFAULT_DOCKER_EXECUTABLE,
): Promise<void> {
  const signal = new AbortController().signal;
  const options = {
    timeoutMs: DOCKER_SANDBOX_VALIDATION_TIMEOUT_MS,
    maxOutputBytes: DOCKER_SANDBOX_VALIDATION_OUTPUT_BYTES,
  };
  const daemon = await spawnCapture(
    dockerExecutable,
    ["version", "--format", "{{.Server.Version}}"],
    signal,
    options.maxOutputBytes,
    options.timeoutMs,
  );
  if (daemon.spawnError !== undefined || daemon.code !== 0) {
    throw new Error(
      `Docker sandbox unavailable: ${daemon.output.trim() || "Docker daemon is not running"}`,
    );
  }
  const image = await spawnCapture(
    dockerExecutable,
    ["image", "inspect", sandbox.image],
    signal,
    options.maxOutputBytes,
    options.timeoutMs,
  );
  if (image.spawnError !== undefined || image.code !== 0) {
    throw new Error(
      `Docker sandbox image is unavailable: ${sandbox.image}${image.output ? ` (${image.output.trim()})` : ""}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function validateMountPaths(
  workspaceRoot: string,
  sandbox: DockerShellSandboxConfig,
  signal: AbortSignal,
): Promise<ShellExecFailure | undefined> {
  const paths = [...sandbox.readablePaths, ...sandbox.writablePaths];
  for (const path of paths) {
    const validated = validateWorkspacePath(workspaceRoot, path);
    if (!validated.ok) {
      return failure(
        "SANDBOX_UNAVAILABLE",
        `Invalid sandbox mount path ${JSON.stringify(path)}: ${validated.message}`,
      );
    }
    try {
      if (await rejectSymlinkComponents(workspaceRoot, validated.relativePath, signal)) {
        return failure(
          "SANDBOX_UNAVAILABLE",
          `Sandbox mount path must not contain symbolic links: ${path}`,
        );
      }
      const stats = await lstat(validated.target);
      if (sandbox.writablePaths.includes(path) && !stats.isDirectory()) {
        return failure(
          "SANDBOX_UNAVAILABLE",
          `Writable sandbox path must be a directory: ${path}`,
        );
      }
    } catch (error) {
      return failure(
        "SANDBOX_UNAVAILABLE",
        `Sandbox mount path is not accessible: ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

async function cleanupContainer(
  executable: string,
  containerName: string,
  maxOutputBytes: number,
): Promise<boolean> {
  const cleanup = await spawnCapture(
    executable,
    ["rm", "-f", containerName],
    new AbortController().signal,
    maxOutputBytes,
    DOCKER_CLEANUP_TIMEOUT_MS,
  );
  if (cleanup.spawnError !== undefined) return false;
  if (cleanup.code === 0) return true;
  return /no such container|is not running/i.test(cleanup.output);
}

function dockerUnavailable(message: string): ShellExecFailure {
  return failure("SANDBOX_UNAVAILABLE", message);
}

function cancelledResult(): ShellExecSuccess {
  return {
    ok: true,
    exitCode: null,
    termination: "signalled",
    signal: null,
    cancelled: true,
    timedOut: false,
    output: "",
    truncated: false,
  };
}

export async function executeDockerShellCommand(
  workspaceRoot: string,
  input: ShellExecInput,
  sandbox: DockerShellSandboxConfig,
  abortSignal: AbortSignal,
  options: DockerShellRunnerOptions,
): Promise<ShellExecResult> {
  if (input.command.length === 0 || input.command.trim().length === 0) {
    return {
      ok: false,
      error: { code: "INVALID_COMMAND", message: "Command must be non-empty" },
    };
  }
  if (input.command.includes("\0")) {
    return {
      ok: false,
      error: { code: "INVALID_COMMAND", message: "Command must not contain NUL bytes" },
    };
  }
  const validatedCwd = validateWorkspacePath(workspaceRoot, input.cwd ?? ".");
  if (!validatedCwd.ok) {
    return {
      ok: false,
      error: { code: validatedCwd.code, message: validatedCwd.message },
    };
  }
  if (abortSignal.aborted) {
    return cancelledResult();
  }
  const mountFailure = await validateMountPaths(workspaceRoot, sandbox, abortSignal);
  if (mountFailure !== undefined) return mountFailure;

  const executable = options.dockerExecutable ?? DEFAULT_DOCKER_EXECUTABLE;
  const containerName = `runloom-shell-${randomUUID()}`;
  const runArgs = buildDockerRunArguments(
    workspaceRoot,
    { command: input.command, cwd: validatedCwd.relativePath },
    sandbox,
    containerName,
  );
  const run = await spawnCapture(
    executable,
    runArgs,
    abortSignal,
    options.maxOutputBytes,
    options.timeoutMs,
    options.onOutput,
  );
  if (run.spawnError !== undefined && !abortSignal.aborted) {
    const details =
      run.output.trim() ||
      (run.spawnError instanceof Error
        ? run.spawnError.message
        : String(run.spawnError));
    return dockerUnavailable(
      `Unable to run Docker sandbox${details ? `: ${details}` : ""}`,
    );
  }
  const interrupted = abortSignal.aborted || run.code === null;
  if (interrupted) {
    const cleaned = await cleanupContainer(executable, containerName, options.maxOutputBytes);
    if (!cleaned) {
      return failure(
        "SANDBOX_CLEANUP_FAILED",
        `Unable to prove Docker container cleanup: ${containerName}`,
      );
    }
    const timedOut = run.code === null && !abortSignal.aborted;
    return {
      ok: true,
      exitCode: null,
      termination: "signalled",
      signal: run.signal,
      cancelled: !timedOut,
      timedOut,
      output: run.output,
      truncated: run.truncated,
    } satisfies ShellExecSuccess;
  }
  if (
    run.spawnError !== undefined ||
    (run.code === 125 &&
      /docker:|cannot connect|is the docker daemon running|no such image|pull access denied|invalid reference/i.test(
        run.output,
      ))
  ) {
    return dockerUnavailable(
      `Unable to run Docker sandbox${run.output ? `: ${run.output.trim()}` : ""}`,
    );
  }
  return {
    ok: true,
    exitCode: run.code,
    termination: run.signal === null ? "exited" : "signalled",
    signal: run.signal,
    cancelled: false,
    timedOut: false,
    output: run.output,
    truncated: run.truncated,
  } satisfies ShellExecSuccess;
}
