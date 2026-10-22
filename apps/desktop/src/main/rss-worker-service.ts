import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { assertWorkerPathSafe, createTaskWorkerService } from "@serika/assistant";
import type { ServiceCommandRunner } from "@serika/assistant";
import { readTaskWorkerHealth } from "@serika/assistant";
import { createTaskStore } from "@serika/assistant";
import type { TaskAutomationHost } from "@serika/assistant";
import type { RssWorkerResponse } from "../shared/ui-contract.js";

/** Inspect only launchctl's loaded argument block, never similarly named environment values. */
function loadedWorkerArguments(stdout: string): string[] | null {
  const lines = stdout.split("\n").map(line => line.trim());
  const start = lines.findIndex(line => /^arguments\s*=\s*\{$/.test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line === "}");
  if (end < 0) return null;
  return lines.slice(start + 1, end);
}

/** Paths and credentials come only from trusted main-process configuration. */
export function createDesktopRssWorker(options: {
  applicationHome: string; workspace: string | undefined; home: string; env: NodeJS.ProcessEnv;
  workerEntry: string; platform?: NodeJS.Platform;
  configPath?: string;
  todoist?: boolean;
  runner?: ServiceCommandRunner;
}) {
  let busy = false;
  async function loadedWorkerStart(running: boolean, stdout: string): Promise<string | null> {
    if (!running) return null;
    const health = await readTaskWorkerHealth(join(options.applicationHome, "data"), createTaskStore(join(options.applicationHome, "data/tasks.json")));
    const pid = Number(/^\s*pid\s*=\s*(\d+)\s*$/m.exec(stdout)?.[1]);
    // A leftover heartbeat is not the currently loaded job's identity.
    return health.ownership === "held" && health.heartbeat?.pid === pid && health.heartbeat.stoppedAt === null
      ? health.heartbeat.startedAt : null;
  }
  async function service() {
    if ((options.platform ?? process.platform) !== "darwin") throw new Error("后台服务目前仅支持 macOS。");
    const nodePath = options.env.RUNLOOM_WORKER_NODE;
    const envFile = options.env.RUNLOOM_WORKER_ENV_FILE ?? options.env.RUNLOOM_ENV_FILE;
    if (!nodePath || !envFile || !isAbsolute(nodePath) || !isAbsolute(envFile)) {
      throw new Error("启用前请在主进程环境配置绝对路径 RUNLOOM_WORKER_NODE 和 RUNLOOM_WORKER_ENV_FILE（或 RUNLOOM_ENV_FILE）。不会把当前进程密钥复制到服务。");
    }
    const text = await readFile(envFile, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("后台环境文件超过 64 KiB。");
    const workerEnv = parseEnv(text);
    if (!workerEnv.RUNLOOM_MODEL?.trim()) throw new Error("后台环境文件必须显式写 RUNLOOM_MODEL；launchd 不继承桌面启动命令里的模型选择。");
    const todoistConfigured = options.todoist === true && !!workerEnv.TODOIST_API_TOKEN?.trim();
    const configuredHelper = options.env.RUNLOOM_NOTIFICATION_HELPER;
    if (configuredHelper !== undefined && !isAbsolute(configuredHelper)) throw new Error("RUNLOOM_NOTIFICATION_HELPER 必须是可信的绝对路径。");
    const notificationHelperPath = configuredHelper === undefined ? undefined : await realpath(configuredHelper);
    if (options.configPath !== undefined && !isAbsolute(options.configPath)) throw new Error("后台配置必须使用可信绝对路径。");
    // Keep the explicit config directory: relative workspace paths are resolved
    // against it by both foreground and worker. Never rewrite it to its target.
    const configPath = options.configPath === undefined ? undefined : resolve(options.configPath);
    if (configPath !== undefined) {
      try { await assertWorkerPathSafe(configPath); }
      catch (error) {
        if (error instanceof Error && error.message.includes("symlink")) throw new Error("后台配置路径含符号链接；请使用工作区外的非符号链接配置。前台可读取此配置，但后台不会改写它的相对工作区含义或自动启用服务。");
        throw error;
      }
      await realpath(configPath); // Check existence only, not the execution identity.
    }
    const trustedNodePath = await realpath(nodePath);
    const trustedEnvFile = await realpath(envFile);
    const expectedArguments = [trustedNodePath, `--env-file=${trustedEnvFile}`, resolve(options.workerEntry), "--home", resolve(options.applicationHome), ...(options.workspace ? ["--workspace", resolve(options.workspace)] : []),
      ...(configPath === undefined ? [] : ["--config", configPath]), "--notify",
      ...(notificationHelperPath === undefined ? [] : ["--notification-helper", notificationHelperPath]),
      ...(todoistConfigured ? ["--todoist"] : []), "--rss"];
    return { todoistConfigured, notificationHelperPath, configPath, expectedArguments, worker: createTaskWorkerService({ applicationHome: options.applicationHome, workspace: options.workspace, nodePath: trustedNodePath,
      envFile: trustedEnvFile, workerEntryPath: options.workerEntry,
      workingDirectory: dirname(dirname(dirname(dirname(options.workerEntry)))),
      launchAgentsDirectory: join(options.home, "Library/LaunchAgents"), uid: process.getuid!(), rss: true, notify: true,
      platform: options.platform ?? process.platform,
      ...(notificationHelperPath === undefined ? {} : { notificationHelperPath }),
      ...(configPath === undefined ? {} : { configPath }),
      todoist: todoistConfigured, ...(options.runner ? { runner: options.runner } : {}) }) };
  }
  async function query(action?: boolean): Promise<RssWorkerResponse> {
    if (busy) return { ok: false, message: "后台服务操作正在进行，请稍后刷新。" };
    busy = true;
    try {
      const { worker, notificationHelperPath, expectedArguments } = await service();
      const status = action === undefined ? await worker.status() : action ? await worker.enable() : await worker.disable();
      if (!status.registered && status.command.exitCode !== 113) throw new Error("无法确认后台服务状态，不代表服务未运行。");
      if (action === true && status.registered && JSON.stringify(loadedWorkerArguments(status.command.stdout)) !== JSON.stringify(expectedArguments)) throw new Error("后台服务当前加载的参数与可信配置不一致，请显式停用后再启用；不会自动替换。");
      const args = status.command.stdout.split("\n").map(line => line.trim());
      const helperIndex = args.indexOf("--notification-helper");
      const notifyEnabled = status.registered && /^\s*--notify\s*$/m.test(status.command.stdout);
      const setupReady = !status.registered || JSON.stringify(loadedWorkerArguments(status.command.stdout)) === JSON.stringify(expectedArguments);
      const processStartedAt = await loadedWorkerStart(status.running, status.command.stdout);
      return { ok: true, registered: status.registered, running: status.running,
        processStartedAt,
        rssEnabled: status.registered && /^\s*--rss\s*$/m.test(status.command.stdout), notifyEnabled,
        notificationRoutingEnabled: notifyEnabled && notificationHelperPath !== undefined && helperIndex >= 0 && args[helperIndex + 1] === notificationHelperPath,
        setupReady, ...(!setupReady ? { configurationMessage: "已注册的后台服务与当前可信配置不一致；请先停用再启用。安排可以保存，但暂不能依赖执行或通知，不会自动替换服务。" } : {}) };
    } catch (error) {
      // Never return launchctl stdout, credentials or user environment to IPC.
      return { ok: false, message: error instanceof Error ? error.message : "后台服务操作失败。" };
    } finally { busy = false; }
  }
  async function automationStatus(): Promise<Awaited<ReturnType<TaskAutomationHost["status"]>>> {
    try {
      const { worker, todoistConfigured, notificationHelperPath, configPath, expectedArguments } = await service();
      const status = await worker.status();
      if (!status.registered && status.command.exitCode !== 113) throw new Error("无法确认后台服务状态");
      if (status.registered && !/^\s*--notify\s*$/m.test(status.command.stdout)) {
        return { available: false, registered: true, running: status.running, todoistPlanningAvailable: false,
          message: "已有后台服务未配置通知；安排可以保存，但请显式停用并重新启用服务后再依赖通知。" };
      }
      const argumentsLines = loadedWorkerArguments(status.command.stdout) ?? [];
      const configIndex = argumentsLines.indexOf("--config");
      if (status.registered && configPath !== undefined && (configIndex < 0 || argumentsLines[configIndex + 1] !== configPath)) {
        return { available: false, registered: true, running: status.running, todoistPlanningAvailable: false,
          message: "已有后台服务绑定的配置与当前工作区配置不一致；安排可保存但不会执行，请显式停用后重新启用。不会自动替换服务。" };
      }
      const helperIndex = argumentsLines.indexOf("--notification-helper");
      if (status.registered && notificationHelperPath && (helperIndex < 0 || argumentsLines[helperIndex + 1] !== notificationHelperPath)) {
        return { available: false, registered: true, running: status.running, todoistPlanningAvailable: false,
          message: "已有后台服务没有通知点击路由；请显式停用后重新启用，不会自动替换。" };
      }
      if (status.registered && JSON.stringify(argumentsLines) !== JSON.stringify(expectedArguments)) {
        return { available: false, registered: true, running: status.running, todoistPlanningAvailable: false,
          message: "已有后台服务当前加载的 Node、执行入口、环境文件或 RSS/Todoist 开关与可信配置不一致；安排可以保存，请显式停用后重新启用。不会自动替换服务。" };
      }
      const todoistPlanningAvailable = todoistConfigured && (!status.registered || argumentsLines.includes("--todoist"));
      return { available: true, registered: status.registered, running: status.running,
        ready: await loadedWorkerStart(status.running, status.command.stdout) !== null, todoistPlanningAvailable,
        ...(options.todoist && !todoistPlanningAvailable ? { message: "已有服务未配置 Todoist；请在后台服务中显式停用后重新启用。" } : {}) };
    } catch (error) {
      return { available: false, registered: false, running: false, todoistPlanningAvailable: false,
        message: error instanceof Error ? error.message : "后台服务配置不可用" };
    }
  }
  async function enableArrangement() {
    const before = await automationStatus();
    if (!before.available) return { enabled: false, message: before.message ?? "后台服务不可用" };
    const result = await query(true);
    return result.ok ? { enabled: result.registered,
      ...(!result.registered ? { message: "安排已保存，但后台服务尚未注册" } : {}) } : { enabled: false, message: result.message };
  }
  return { status: () => query(), automationStatus, enableArrangement,
    setEnabled: async (enabled: unknown): Promise<RssWorkerResponse> => {
      if (typeof enabled !== "boolean") return { ok: false, message: "启用开关必须是布尔值。" };
      if (enabled) {
        const before = await automationStatus();
        if (!before.available) return { ok: false, message: before.message ?? "后台服务不可用。" };
      }
      return query(enabled);
    } };
}
