import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import type { RegisteredTool } from "@serika/ai-sdk-adapter";
import type { AgentModule } from "../module-host.js";

const DEFAULT_MINUTES = 25;
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;
const MINUTE_MS = 60_000;

export interface PomodoroServiceOptions {
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /**
   * Send the completion notification outside the TUI. The callback is
   * reported separately so a desktop failure never changes timer state.
   */
  desktopNotifier?: PomodoroDesktopNotifier;
}

export interface PomodoroModuleOptions extends PomodoroServiceOptions {
  /** The embedding host owns this service; disposing the module only unsubscribes. */
  service?: PomodoroService;
}

export interface PomodoroService {
  start(minutes?: number): PomodoroResult;
  status(): PomodoroResult;
  cancel(): PomodoroResult;
  subscribe(listener: (message: string) => void): () => void;
  dispose(): void;
}

export type PomodoroDesktopNotifier = (
  message: string,
  onFailure: (kind: "notification" | "sound", error: unknown) => void,
) => void;

export type PomodoroStatus =
  | { state: "idle" }
  | {
      state: "running";
      durationMinutes: number;
      endsAt: string;
      remainingSeconds: number;
    };

export type PomodoroOutcome =
  | "started"
  | "already_running"
  | "status"
  | "cancelled"
  | "not_running";

export interface PomodoroResult {
  outcome: PomodoroOutcome;
  status: PomodoroStatus;
}

const pomodoroStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({
    state: z.literal("running"),
    durationMinutes: z.number().int().positive(),
    endsAt: z.string(),
    remainingSeconds: z.number().int().nonnegative(),
  }),
]);

const pomodoroResultSchema = z.object({
  outcome: z.enum([
    "started",
    "already_running",
    "status",
    "cancelled",
    "not_running",
  ]),
  status: pomodoroStatusSchema,
});

const startMetadata: RegisteredTool["metadata"] = {
  name: "pomodoro_start",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};

const statusMetadata: RegisteredTool["metadata"] = {
  name: "pomodoro_status",
  version: "1",
  risk: "read",
  timeoutMs: 1_000,
  idempotent: true,
};

const cancelMetadata: RegisteredTool["metadata"] = {
  name: "pomodoro_cancel",
  version: "1",
  risk: "write",
  timeoutMs: 1_000,
  idempotent: false,
};

const usage = "Usage: /pomodoro start [minutes] | status | cancel";

type TimerHandle = unknown;

interface RunningPomodoro {
  durationMinutes: number;
  endsAtMs: number;
  timer: TimerHandle;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent operation aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function isWholeMinute(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_MINUTES && value <= MAX_MINUTES;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runMacCommand(
  command: string,
  args: readonly string[],
  kind: "notification" | "sound",
  onFailure: (kind: "notification" | "sound", error: unknown) => void,
): void {
  let settled = false;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, [...args], { stdio: "ignore" });
  } catch (error) {
    onFailure(kind, error);
    return;
  }
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    onFailure(kind, error);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    if (code !== 0) {
      onFailure(
        kind,
        new Error(
          `${command} exited with ${signal === null ? `code ${String(code)}` : `signal ${signal}`}`,
        ),
      );
    }
  });
}

function notifyMacDesktop(
  message: string,
  onFailure: (kind: "notification" | "sound", error: unknown) => void,
): void {
  if (process.platform !== "darwin") {
    onFailure("notification", new Error("macOS desktop notifications are unavailable"));
    return;
  }

  const escapedMessage = message
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", " ");
  runMacCommand(
    "osascript",
    ["-e", `display notification "${escapedMessage}" with title "Serika"`],
    "notification",
    onFailure,
  );
  runMacCommand(
    "/usr/bin/afplay",
    ["/System/Library/Sounds/Glass.aiff"],
    "sound",
    onFailure,
  );
}

/** In-process state owned by a host, independently of Thread/module registration. */
export function createPomodoroService(
  options: PomodoroServiceOptions = {},
): PomodoroService {
  const now = options.now ?? Date.now;
  const schedule = options.setTimeout ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clear = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  const desktopNotifier = options.desktopNotifier ?? notifyMacDesktop;

  let running: RunningPomodoro | undefined;
  let disposed = false;
  const listeners = new Set<(message: string) => void>();
  const notify = (message: string): void => {
    for (const listener of listeners) listener(message);
  };

  const idleStatus = (): PomodoroStatus => ({ state: "idle" });

  const statusAt = (time: number): PomodoroStatus => {
    if (!running) return idleStatus();
    return {
      state: "running",
      durationMinutes: running.durationMinutes,
      endsAt: new Date(running.endsAtMs).toISOString(),
      remainingSeconds: Math.max(0, Math.ceil((running.endsAtMs - time) / 1_000)),
    };
  };

  const finish = (expected?: RunningPomodoro): void => {
    const current = running;
    if (!current || (expected !== undefined && current !== expected)) return;
    clear(current.timer);
    running = undefined;
    const message = `番茄钟结束，已完成 ${current.durationMinutes} 分钟专注。`;
    notify(message);
    try {
      desktopNotifier(message, (kind, error) => {
        const label = kind === "notification" ? "桌面通知" : "提示音";
        notify(`${label}发送失败：${errorMessage(error)}`);
      });
    } catch (error) {
      notify(`桌面提醒失败：${errorMessage(error)}`);
    }
  };

  const settleIfExpired = (time: number): void => {
    if (running && time >= running.endsAtMs) finish(running);
  };

  const currentStatus = (): PomodoroStatus => {
    const time = now();
    settleIfExpired(time);
    return statusAt(time);
  };

  const start = (minutes = DEFAULT_MINUTES): PomodoroResult => {
    if (disposed) throw new Error("Pomodoro service is disposed");
    if (!isWholeMinute(minutes)) {
      throw new RangeError("Pomodoro minutes must be an integer from 1 to 180");
    }
    const startedAtMs = now();
    settleIfExpired(startedAtMs);
    if (running) return { outcome: "already_running", status: statusAt(startedAtMs) };
    const endsAtMs = startedAtMs + minutes * MINUTE_MS;
    const current: RunningPomodoro = { durationMinutes: minutes, endsAtMs, timer: undefined };
    running = current;
    current.timer = schedule(() => finish(current), endsAtMs - startedAtMs);
    return { outcome: "started", status: statusAt(startedAtMs) };
  };

  const cancel = (): PomodoroResult => {
    settleIfExpired(now());
    if (!running) return { outcome: "not_running", status: idleStatus() };
    clear(running.timer);
    running = undefined;
    return { outcome: "cancelled", status: idleStatus() };
  };

  const status = (): PomodoroResult => ({ outcome: "status", status: currentStatus() });

  return {
    start, status, cancel,
    subscribe(listener) {
      if (disposed) throw new Error("Pomodoro service is disposed");
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (running) clear(running.timer);
      running = undefined;
      listeners.clear();
    },
  };
}

const POMODORO_INSTRUCTIONS =
  "When pomodoro tools are available and the user asks in natural language to start, check, or cancel a timer (for example, 开始番茄钟, 专注 25 分钟, 还剩多久, or 取消番茄钟), call the corresponding pomodoro tool immediately; do not only explain the /pomodoro command and do not claim a timer started unless the tool result says started. The default is 25 minutes when no duration is given. If a timer is already running, report its remaining time and do not reset it. These timer calls do not require y/n confirmation. ";

export function createPomodoroModule(
  options: PomodoroModuleOptions = {},
): AgentModule {
  return {
    id: "pomodoro",
    instructionPlacement: { section: "body", rank: 200 },
    setup(ctx) {
      const service = options.service ?? createPomodoroService(options);
      const unsubscribe = service.subscribe((message) => ctx.notify(message));
      const start = (minutes?: number): PomodoroResult => service.start(minutes);
      const status = (): PomodoroResult => service.status();
      const cancel = (): PomodoroResult => service.cancel();

      const startTool = tool({
        description:
          "Start one in-process pomodoro timer. If one is already running, report it without resetting it.",
        inputSchema: z.object({
          minutes: z.number().int().min(MIN_MINUTES).max(MAX_MINUTES).optional(),
        }),
        outputSchema: pomodoroResultSchema,
        execute: async ({ minutes }, { abortSignal }) => {
          throwIfAborted(abortSignal);
          return start(minutes);
        },
      });

      const statusTool = tool({
        description: "Read the current pomodoro timer status and remaining seconds.",
        inputSchema: z.object({}),
        outputSchema: pomodoroResultSchema,
        execute: async (_input, { abortSignal }) => {
          throwIfAborted(abortSignal);
          return status();
        },
      });

      const cancelTool = tool({
        description: "Cancel the current pomodoro timer so it will not notify when it would have ended.",
        inputSchema: z.object({}),
        outputSchema: pomodoroResultSchema,
        execute: async (_input, { abortSignal }) => {
          throwIfAborted(abortSignal);
          return cancel();
        },
      });

      // Timer calls run without y/n confirmation.
      const permission = { defaults: { approval: "auto" } } as const;
      ctx.registerTool({ metadata: startMetadata, tool: startTool }, permission);
      ctx.registerTool({ metadata: statusMetadata, tool: statusTool }, permission);
      ctx.registerTool({ metadata: cancelMetadata, tool: cancelTool }, permission);
      ctx.addInstructions(POMODORO_INSTRUCTIONS);
      ctx.registerCommand({
        name: "pomodoro",
        execute(args) {
          const parts = args.trim() === "" ? [] : args.trim().split(/\s+/);
          const [action, value, ...extra] = parts;

          if (action === "start" && extra.length === 0) {
            const minutes = value === undefined ? DEFAULT_MINUTES : Number(value);
            if (value !== undefined && !/^\d+$/.test(value)) {
              ctx.notify(usage);
              return;
            }
            if (!isWholeMinute(minutes)) {
              ctx.notify(usage);
              return;
            }
            const result = start(minutes);
            if (result.outcome === "started") {
              ctx.notify(`已启动 ${minutes} 分钟番茄钟。`);
            } else {
              ctx.notify("已有番茄钟运行中。");
            }
            return;
          }

          if (action === "status" && value === undefined) {
            const result = status();
            if (result.status.state === "idle") {
              ctx.notify("当前没有运行中的番茄钟。");
            } else {
              ctx.notify(
                `番茄钟运行中，剩余 ${result.status.remainingSeconds} 秒。`,
              );
            }
            return;
          }

          if (action === "cancel" && value === undefined) {
            const result = cancel();
            ctx.notify(
              result.outcome === "cancelled"
                ? "番茄钟已取消。"
                : "当前没有运行中的番茄钟。",
            );
            return;
          }

          ctx.notify(usage);
        },
      });

      return () => {
        unsubscribe();
        if (options.service === undefined) service.dispose();
      };
    },
  };
}
