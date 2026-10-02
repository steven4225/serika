import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

import { abortReason, throwIfAborted } from "./workspace-path.js";

/**
 * The Node standard library does not currently expose POSIX flock(2).  Keep
 * the adapter deliberately small: a short-lived system helper owns the
 * advisory lock and holds it until the parent closes stdin. macOS lockf(1)
 * uses the BSD flock(2) locking described by its man page; Linux uses the
 * util-linux flock(1) equivalent. Closing stdin also releases the lock if the
 * parent is SIGKILLed.
 */
const HOLDER_SCRIPT = [
  "process.stdin.resume();",
  "process.stdout.write('runloom-flock-ready\\n');",
  "process.stdin.on('end', () => process.exit(0));",
  "process.stdin.on('error', () => process.exit(0));",
].join(" ");

const neverAborted = new AbortController().signal;

export interface FlockHandle {
  release(): Promise<void>;
}

export class FlockError extends Error {
  readonly code: "BUSY" | "UNAVAILABLE";

  constructor(code: "BUSY" | "UNAVAILABLE", message: string) {
    super(message);
    this.name = "FlockError";
    this.code = code;
  }
}

interface AcquireOptions {
  nonBlocking?: boolean;
}

function lockCommand(nonBlocking: boolean): { file: string; args: string[] } {
  if (process.platform === "darwin") {
    // macOS lockf -n means "do not create". -t 0 is the non-blocking form.
    return {
      file: "/usr/bin/lockf",
      args: [...(nonBlocking ? ["-t", "0"] : []), "-k"],
    };
  }
  return {
    file: "/usr/bin/flock",
    args: nonBlocking ? ["-n"] : [],
  };
}

async function ensureLockFile(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  await handle.close();
}

function closeCodeMessage(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return signal === null
    ? `flock helper exited with code ${String(code)}`
    : `flock helper terminated by ${signal}`;
}

/**
 * Non-blocking helpers exit before the holder starts when the lock is taken.
 * macOS `lockf -t 0` uses EX_TEMPFAIL (75); Linux `flock -n` uses 1.
 */
function nonBlockingLockWasBusy(
  code: number | null,
  exitSignal: NodeJS.Signals | null,
): boolean {
  return exitSignal === null && code !== null && code !== 0;
}

function killQuietly(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may already have exited.
  }
}

/** Acquire a blocking advisory lock. The wait is interruptible by signal. */
export async function acquireFlock(
  path: string,
  signal: AbortSignal = neverAborted,
): Promise<FlockHandle> {
  return acquire(path, signal, {});
}

/** Try an advisory lock without waiting. `null` means another process holds it. */
export async function tryAcquireFlock(
  path: string,
  signal: AbortSignal = neverAborted,
): Promise<FlockHandle | null> {
  try {
    return await acquire(path, signal, { nonBlocking: true });
  } catch (error) {
    if (error instanceof FlockError && error.code === "BUSY") return null;
    throw error;
  }
}

async function acquire(
  path: string,
  signal: AbortSignal,
  options: AcquireOptions,
): Promise<FlockHandle> {
  throwIfAborted(signal);
  await ensureLockFile(path);
  const command = lockCommand(options.nonBlocking === true);
  const child = spawn(
    command.file,
    [...command.args, path, process.execPath, "-e", HOLDER_SCRIPT],
    {
      stdio: ["pipe", "pipe", "pipe"],
      // Embedded Electron uses its own executable as process.execPath. The
      // holder is a Node script, not another desktop application instance.
      ...(process.versions.electron ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } } : {}),
    },
  );
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8");
  child.stderr.resume();

  let ready = false;
  let settled = false;
  let output = "";
  let abortListener: (() => void) | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const failBeforeReady = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectReady(error);
  };

  child.stdout.on("data", (chunk: string) => {
    if (ready || settled) return;
    output += chunk;
    if (!output.includes("runloom-flock-ready\n")) return;
    ready = true;
    settled = true;
    resolveReady();
  });
  child.once("error", (error) => {
    if (!ready) {
      failBeforeReady(
        new FlockError("UNAVAILABLE", `Unable to start flock helper: ${String(error)}`),
      );
    }
  });
  child.once("close", (code, signalName) => {
    resolveClosed?.();
    if (!ready) {
      if (options.nonBlocking === true && nonBlockingLockWasBusy(code, signalName)) {
        failBeforeReady(new FlockError("BUSY", "Lock is already held"));
      } else {
        failBeforeReady(new FlockError("UNAVAILABLE", closeCodeMessage(code, signalName)));
      }
      return;
    }
  });

  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      killQuietly(child);
      reject(abortReason(signal));
    };
    if (signal.aborted) {
      abortListener();
      return;
    }
    signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    await Promise.race([readyPromise, abortPromise]);
  } catch (error) {
    killQuietly(child);
    await closed;
    throw error;
  } finally {
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
  try {
    throwIfAborted(signal);
  } catch (error) {
    killQuietly(child);
    await closed;
    throw error;
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released || !ready) return;
      released = true;
      try {
        child.stdin.write("x");
        child.stdin.end();
      } catch {
        killQuietly(child);
      }
      await closed;
    },
  };
}
