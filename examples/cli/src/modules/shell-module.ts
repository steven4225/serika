import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@aisdk-agent/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";
import { validateWorkspacePath } from "../workspace-path.js";
import {
  DOCKER_CLEANUP_TIMEOUT_MS,
  executeDockerShellCommand,
  type DockerShellRunnerOptions,
  type DockerShellSandboxConfig,
} from "./docker-shell-runner.js";

/** Maximum time a command is allowed to run before it is terminated. */
export const SHELL_EXEC_TIMEOUT_MS = 30_000;
export const SHELL_EXEC_MAX_TIMEOUT_MS = 10 * 60_000;

/** Grace period between SIGTERM and SIGKILL after timeout or cancel. */
export const SHELL_EXEC_KILL_GRACE_MS = 250;

/**
 * Tool-layer abort budget. It must outlast the command timeout plus kill
 * grace so AgentLoop receives `{ timedOut, output }` instead of rejecting
 * the execute promise first.
 */
export const SHELL_EXEC_TOOL_TIMEOUT_MS =
  SHELL_EXEC_TIMEOUT_MS + SHELL_EXEC_KILL_GRACE_MS + 750;

/**
 * Docker path must outlast command timeout, kill grace, and container
 * cleanup so AgentLoop receives `{ timedOut, output }` instead of aborting
 * execute first. Image presence is checked at TUI startup; execute uses
 * `--pull never` and does not spend this budget on inspect.
 */
export const SHELL_EXEC_DOCKER_TOOL_TIMEOUT_MS =
  SHELL_EXEC_TIMEOUT_MS +
  SHELL_EXEC_KILL_GRACE_MS +
  DOCKER_CLEANUP_TIMEOUT_MS +
  750;

/** Maximum combined stdout/stderr bytes returned to the model. */
export const SHELL_EXEC_MAX_OUTPUT_BYTES = 64 * 1024;
const SHELL_EXEC_MAX_PROGRESS_EVENTS = 256;

export const shellExecErrorCodes = [
  "INVALID_COMMAND",
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "CWD_NOT_FOUND",
  "CWD_NOT_ACCESSIBLE",
  "SPAWN_FAILED",
  "SANDBOX_UNAVAILABLE",
  "SANDBOX_CLEANUP_FAILED",
] as const;

export type ShellExecErrorCode = (typeof shellExecErrorCodes)[number];

export interface ShellExecInput {
  command: string;
  cwd?: string | undefined;
}

export interface ShellExecSuccess {
  ok: true;
  exitCode: number | null;
  termination: "exited" | "signalled";
  signal: string | null;
  cancelled: boolean;
  timedOut: boolean;
  output: string;
  truncated: boolean;
}

export interface ShellExecFailure {
  ok: false;
  error: {
    code: ShellExecErrorCode;
    message: string;
  };
}

export type ShellExecResult = ShellExecSuccess | ShellExecFailure;

export interface ShellExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  onOutput?: ((stream: "stdout" | "stderr", text: string, truncated: boolean) => void) | undefined;
}

export interface ShellProgress {
  toolCallId: string;
  sequence: number;
  stream: "stdout" | "stderr";
  text: string;
  truncated: boolean;
}

export interface ShellModuleOptions {
  timeoutMs?: number;
  onProgress?: ((event: ShellProgress) => void) | undefined;
  sandbox?: DockerShellSandboxConfig;
  dockerExecutable?: string;
}

const neverAborted = new AbortController().signal;

const shellExecInputSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
});

const shellExecOutputSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    exitCode: z.number().int().nullable(),
    termination: z.enum(["exited", "signalled"]),
    signal: z.string().nullable(),
    cancelled: z.boolean(),
    timedOut: z.boolean(),
    output: z.string(),
    truncated: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(shellExecErrorCodes),
      message: z.string(),
    }),
  }),
]);

function shellExecMetadata(
  sandbox: boolean,
  commandTimeoutMs: number,
): RegisteredTool["metadata"] {
  return {
    name: "shell_exec",
    version: "1",
    risk: "external_side_effect",
    timeoutMs: commandTimeoutMs + SHELL_EXEC_KILL_GRACE_MS +
      (sandbox ? DOCKER_CLEANUP_TIMEOUT_MS : 0) + 750,
    idempotent: false,
  };
}

function failure(
  code: ShellExecErrorCode,
  message: string,
): ShellExecFailure {
  return { ok: false, error: { code, message } };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the command environment useful for local development without handing
 * application credentials loaded by the CLI to an arbitrary subprocess.
 */
function commandEnvironment(): NodeJS.ProcessEnv {
  const sensitiveName = /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|PRIVATE_KEY)/i;
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
    // A detached process group lets cancellation terminate a shell and the
    // command it started together on POSIX. Windows falls back to child.kill.
    if (process.platform !== "win32" && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between the check and the kill request.
  }
}

function mapSpawnFailure(error: unknown, cwd: string): ShellExecFailure {
  switch (errorCode(error)) {
    case "ENOENT":
      return failure("CWD_NOT_FOUND", `Working directory not found: ${cwd}`);
    case "EACCES":
      return failure("CWD_NOT_ACCESSIBLE", `Working directory is not accessible: ${cwd}`);
    case "ENOTDIR":
      return failure("CWD_NOT_FOUND", `Working directory is not a directory: ${cwd}`);
    default:
      return failure("SPAWN_FAILED", `Unable to start command: ${errorMessage(error)}`);
  }
}

function cancelledResult(
  output: string,
  truncated: boolean,
  timedOut: boolean,
): ShellExecSuccess {
  return {
    ok: true,
    exitCode: null,
    termination: "signalled",
    signal: null,
    cancelled: !timedOut,
    timedOut,
    output,
    truncated,
  };
}

/** Execute one non-interactive shell command from a workspace-relative cwd. */
export async function executeShellCommand(
  workspace: string,
  input: ShellExecInput,
  abortSignal: AbortSignal = neverAborted,
  options: ShellExecOptions = {},
): Promise<ShellExecResult> {
  const command = input.command;
  if (command.length === 0 || command.trim().length === 0) {
    return failure("INVALID_COMMAND", "Command must be non-empty");
  }
  if (command.includes("\0")) {
    return failure("INVALID_COMMAND", "Command must not contain NUL bytes");
  }

  const workspaceRoot = resolve(workspace);
  const validatedCwd = validateWorkspacePath(workspaceRoot, input.cwd ?? ".");
  if (!validatedCwd.ok) {
    return failure(validatedCwd.code, validatedCwd.message);
  }

  if (abortSignal.aborted) {
    return cancelledResult("", false, false);
  }

  const timeoutMs = Math.max(
    1,
    Math.floor(options.timeoutMs ?? SHELL_EXEC_TIMEOUT_MS),
  );
  const maxOutputBytes = Math.max(
    0,
    Math.floor(options.maxOutputBytes ?? SHELL_EXEC_MAX_OUTPUT_BYTES),
  );
  const chunks: Buffer[] = [];
  const outputState = { bytes: 0, truncated: false };
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  const capture = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
    const wasTruncated = outputState.truncated;
    const accepted = appendOutput(chunks, chunk, outputState, maxOutputBytes);
    if (abortSignal.aborted || options.onOutput === undefined || (accepted.length === 0 && wasTruncated)) return;
    const text = decoders[stream].write(accepted);
    if (text.length === 0 && !outputState.truncated) return;
    try {
      options.onOutput(stream, text, outputState.truncated);
    } catch {
      // UI progress callbacks never determine the command outcome.
    }
  };

  let child: ChildProcess;
  try {
    child = spawn(command, {
      cwd: validatedCwd.target,
      env: commandEnvironment(),
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return mapSpawnFailure(error, validatedCwd.relativePath || ".");
  }

  return new Promise<ShellExecResult>((resolveResult) => {
    let timedOut = false;
    let cancelled = false;
    let spawnError: unknown;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(
        () => killChild(child, "SIGKILL"),
        SHELL_EXEC_KILL_GRACE_MS,
      );
    }, timeoutMs);

    const finish = (result: ShellExecResult): void => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      abortSignal.removeEventListener("abort", onAbort);
      resolveResult(result);
    };

    const onAbort = (): void => {
      if (timedOut || cancelled) return;
      cancelled = true;
      killChild(child, "SIGTERM");
      forceKillTimer = setTimeout(
        () => killChild(child, "SIGKILL"),
        SHELL_EXEC_KILL_GRACE_MS,
      );
    };

    abortSignal.addEventListener("abort", onAbort, { once: true });
    if (abortSignal.aborted) onAbort();

    child.stdout?.on("data", (chunk: Buffer | string) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => capture("stderr", chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = decoders[stream].end();
        if (tail && !abortSignal.aborted && options.onOutput !== undefined) {
          try {
            options.onOutput(stream, tail, outputState.truncated);
          } catch {
            // UI progress callbacks never determine the command outcome.
          }
        }
      }
      const output = Buffer.concat(chunks).toString("utf8");
      if (spawnError !== undefined) {
        finish(mapSpawnFailure(spawnError, validatedCwd.relativePath || "."));
        return;
      }
      finish({
        ok: true,
        exitCode: timedOut || cancelled ? null : exitCode,
        termination: signal === null && !timedOut && !cancelled ? "exited" : "signalled",
        signal,
        cancelled,
        timedOut,
        output,
        truncated: outputState.truncated,
      });
    });
  });
}

export function createShellExecTool(
  workspaceRoot: string,
  options: ShellModuleOptions = {},
): Tool<ShellExecInput, ShellExecResult> {
  return tool({
    description:
      options.sandbox === undefined
        ? "Run one non-interactive local shell command from a workspace-relative directory. The command may inspect or modify the machine; it is bounded by a timeout and output limit."
        : "Run one non-interactive shell command inside the configured Docker sandbox from a workspace-relative directory. Only the configured mounts are visible; network access is disabled; the command is bounded by a timeout and output limit.",
    inputSchema: shellExecInputSchema,
    outputSchema: shellExecOutputSchema,
    execute: ({ command, cwd }, { abortSignal, toolCallId }) => {
      const input = { command, ...(cwd === undefined ? {} : { cwd }) };
      let sequence = 0;
      const onOutput = options.onProgress === undefined ? undefined : (
        stream: "stdout" | "stderr", text: string, truncated: boolean,
      ): void => {
        if (sequence >= SHELL_EXEC_MAX_PROGRESS_EVENTS) return;
        const capped = sequence === SHELL_EXEC_MAX_PROGRESS_EVENTS - 1;
        try {
          options.onProgress?.({ toolCallId, sequence: ++sequence, stream, text: capped ? "" : text, truncated: truncated || capped });
        } catch {
          // Progress delivery cannot fail an external command.
        }
      };
      if (options.sandbox !== undefined) {
        const dockerOptions: DockerShellRunnerOptions = {
          timeoutMs: options.timeoutMs ?? SHELL_EXEC_TIMEOUT_MS,
          maxOutputBytes: SHELL_EXEC_MAX_OUTPUT_BYTES,
          ...(onOutput === undefined ? {} : { onOutput }),
          ...(options.dockerExecutable === undefined
            ? {}
            : { dockerExecutable: options.dockerExecutable }),
        };
        return executeDockerShellCommand(
          workspaceRoot,
          input,
          options.sandbox,
          abortSignal ?? neverAborted,
          dockerOptions,
        );
      }
      return executeShellCommand(
        workspaceRoot,
        input,
        abortSignal ?? neverAborted,
        { timeoutMs: options.timeoutMs ?? SHELL_EXEC_TIMEOUT_MS, onOutput },
      );
    },
  });
}

export function createShellModule(
  workspaceRoot: string,
  options: ShellModuleOptions = {},
): AgentModule {
  return {
    id: "shell",
    setup(context) {
      context.registerTool({
        metadata: shellExecMetadata(
          options.sandbox !== undefined,
          options.timeoutMs ?? SHELL_EXEC_TIMEOUT_MS,
        ),
        tool: createShellExecTool(workspaceRoot, options),
      });
    },
  };
}
