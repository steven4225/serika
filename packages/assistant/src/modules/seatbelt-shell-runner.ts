import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, release, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { AgentError } from "@serika/core";
import { seatbeltPolicy } from "./seatbelt-policy.js";
import { resolveSeatbeltRuntime, seatbeltEnvironment, type SeatbeltRuntime } from "./seatbelt-runtime.js";
import type { ShellExecInput, ShellExecOptions, ShellExecResult } from "./shell-module.js";

export interface SeatbeltShellScope { home: string; configPath?: string; protectedPaths: readonly string[] }

const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
const unavailable = (): ShellExecResult => ({ ok: false, error: { code: "SANDBOX_UNAVAILABLE", message: "Seatbelt unavailable or directory/runtime outside the approved policy. No host fallback." } });
const unknown = () => new AgentError({ code: "TOOL_OUTCOME_UNKNOWN", phase: "tool", retryable: false, message: "Seatbelt process group settlement is unknown. Inspect effects before any new invocation." });

async function canonicalDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  for (let p = resolved; p !== "/"; p = dirname(p)) if ((await lstat(p)).isSymbolicLink()) throw new Error("Symlink directory");
  if (!(await lstat(resolved)).isDirectory()) throw new Error("Not a directory");
  return realpath(resolved);
}

export class SeatbeltShellRunner {
  readonly #pending = new Set<Promise<ShellExecResult>>();
  readonly #runtime: Promise<SeatbeltRuntime | null>;
  constructor(readonly scope: SeatbeltShellScope) {
    this.#runtime = process.platform === "darwin" && process.arch === "arm64" && release() === "27.0.0"
      ? resolveSeatbeltRuntime({ ...scope, protectedPaths: [...scope.protectedPaths, fileURLToPath(new URL("../../../..", import.meta.url))] }).catch(() => null)
      : Promise.resolve(null);
  }
  execute(options: Omit<Parameters<typeof executeSeatbeltShellCommand>[0], "scope" | "runtime">): Promise<ShellExecResult> {
    const pending = executeSeatbeltShellCommand({ ...options, scope: this.scope, runtime: this.#runtime });
    this.#pending.add(pending);
    void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending));
    return pending;
  }
  async settle(): Promise<void> { await Promise.allSettled([...this.#pending]); }
}

async function executeSeatbeltShellCommand(options: {
  directory: string; scope: SeatbeltShellScope; runtime: Promise<SeatbeltRuntime | null>; input: ShellExecInput; signal: AbortSignal;
  execution: ShellExecOptions & { timeoutMs: number; maxOutputBytes: number; killGraceMs: number };
}): Promise<ShellExecResult> {
  const { input, scope, signal } = options;
  if (!input.command.trim() || input.command.includes("\0")) return { ok: false, error: { code: "INVALID_COMMAND", message: "Command must be nonempty and contain no NUL" } };
  if (signal.aborted) return { ok: true, exitCode: null, termination: "signalled", signal: null, cancelled: true, timedOut: false, output: "", truncated: false };
  let directory: string, cwd: string;
  try {
    if (process.platform !== "darwin" || process.arch !== "arm64" || release() !== "27.0.0") return unavailable();
    await access("/usr/bin/sandbox-exec", constants.X_OK);
    const runtime = await options.runtime;
    if (!runtime) return unavailable();
    directory = await canonicalDirectory(options.directory);
    cwd = await canonicalDirectory(resolve(directory, input.cwd ?? "."));
    if (!within(directory, cwd)) return unavailable();
    if (["/", "/Users", "/opt/homebrew", homedir(), userInfo().homedir, dirname(runtime.node)].includes(directory)) return unavailable();
    const forbidden = [...scope.protectedPaths,
      ...["Library", ".serika", ".ssh", ".aws", ".gnupg"].map(name => join(userInfo().homedir, name))];
    if (forbidden.some(path => within(path, directory))) return unavailable();
  } catch { return unavailable(); }
  const runtime = await options.runtime;
  if (!runtime) return unavailable();
  const control = await mkdtemp(join(await realpath(tmpdir()), "serika-seatbelt-"));
  const temp = join(control, "command");
  await mkdir(temp, { mode: 0o700 });
  const profile = join(control, "policy.sb");
  const codeRoot = fileURLToPath(new URL("../../../..", import.meta.url));
  const policy = seatbeltPolicy({ directory, temp, runtime, userHome: userInfo().homedir, protectedPaths: [...scope.protectedPaths, scope.home, codeRoot],
    ...(scope.configPath ? { configPath: scope.configPath } : {}) });
  await writeFile(profile, policy, { mode: 0o600 });
  let settled = false;
  try {
    if (signal.aborted) {
      settled = true;
      return { ok: true, exitCode: null, termination: "signalled", signal: null, cancelled: true, timedOut: false, output: "", truncated: false };
    }
    const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, "/bin/sh", "-c", input.command, "--home", scope.home], {
      cwd, env: seatbeltEnvironment({ temp, runtime }), detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    return await new Promise<ShellExecResult>((done, reject) => {
      const chunks: Buffer[] = []; let bytes = 0, truncated = false, stopped: "cancelled" | "timedOut" | undefined;
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      const max = options.execution.maxOutputBytes;
      let finished = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const group = (sig: NodeJS.Signals | 0): boolean => {
        if (child.pid === undefined) return false;
        try { process.kill(-child.pid, sig); return true; }
        catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw unknown(); }
      };
      const finish = (result?: ShellExecResult, error?: Error) => {
        if (finished) return; finished = true;
        clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener("abort", abort);
        if (error) reject(error); else if (result) { settled = true; done(result); }
      };
      const stop = (reason: "cancelled" | "timedOut") => {
        if (stopped) return; stopped = reason;
        try { group("SIGTERM"); } catch (error) { finish(undefined, error instanceof Error ? error : unknown()); return; }
        // The leader may close before a TERM-resistant descendant; keep this timer alive.
        killTimer = setTimeout(() => {
          try { group("SIGKILL"); } catch (error) { finish(undefined, error instanceof Error ? error : unknown()); }
        }, options.execution.killGraceMs);
      };
      const abort = () => stop("cancelled");
      const timer = setTimeout(() => stop("timedOut"), options.execution.timeoutMs);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      for (const stream of ["stdout", "stderr"] as const) child[stream]?.on("data", (chunk: Buffer) => {
        const accepted = chunk.subarray(0, Math.max(0, max - bytes)); bytes += accepted.length; truncated ||= chunk.length > accepted.length; chunks.push(accepted);
        const text = decoders[stream].write(accepted);
        if (!signal.aborted && text) { try { options.execution.onOutput?.(stream, text, truncated); } catch { /* Display does not settle execution. */ } }
      });
      child.once("error", () => finish(unavailable()));
      child.once("close", async (exitCode, exitSignal) => {
        if (finished) return;
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
        try {
          // Also collect background descendants after an ordinary leader exit.
          if (group(0)) { group("SIGKILL"); await new Promise(resolveWait => setTimeout(resolveWait, options.execution.killGraceMs)); }
          if (group(0)) { finish(undefined, unknown()); return; }
          finish({ ok: true, exitCode: stopped ? null : exitCode, signal: exitSignal, termination: stopped || exitSignal ? "signalled" : "exited",
            cancelled: stopped === "cancelled", timedOut: stopped === "timedOut", output: Buffer.concat(chunks).toString("utf8"), truncated });
        } catch { finish(undefined, unknown()); }
      });
    });
  } finally { if (settled) await rm(control, { recursive: true, force: true }); }
}
