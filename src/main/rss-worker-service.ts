import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parseEnv } from "node:util";
import { createTaskWorkerService } from "@aisdk-agent/example-cli/dist/task-worker-service.js";
import type { RssWorkerResponse } from "../shared/ui-contract.js";

/** Paths and credentials come only from trusted main-process configuration. */
export function createDesktopRssWorker(options: {
  workspace: string | undefined; home: string; env: NodeJS.ProcessEnv;
  workerEntry: string; platform?: NodeJS.Platform;
}) {
  let busy = false;
  async function service() {
    if ((options.platform ?? process.platform) !== "darwin") throw new Error("后台服务目前仅支持 macOS。");
    if (!options.workspace) throw new Error("尚未配置工作区。");
    const nodePath = options.env.RUNLOOM_WORKER_NODE;
    const envFile = options.env.RUNLOOM_WORKER_ENV_FILE ?? options.env.RUNLOOM_ENV_FILE;
    if (!nodePath || !envFile || !isAbsolute(nodePath) || !isAbsolute(envFile)) {
      throw new Error("启用前请在主进程环境配置绝对路径 RUNLOOM_WORKER_NODE 和 RUNLOOM_WORKER_ENV_FILE（或 RUNLOOM_ENV_FILE）。不会把当前进程密钥复制到服务。");
    }
    const text = await readFile(envFile, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("后台环境文件超过 64 KiB。");
    if (!parseEnv(text).RUNLOOM_MODEL?.trim()) throw new Error("后台环境文件必须显式写 RUNLOOM_MODEL；launchd 不继承桌面启动命令里的模型选择。");
    return createTaskWorkerService({ workspace: options.workspace, nodePath: await realpath(nodePath),
      envFile: await realpath(envFile), workerEntryPath: options.workerEntry,
      workingDirectory: dirname(dirname(dirname(dirname(options.workerEntry)))),
      launchAgentsDirectory: join(options.home, "Library/LaunchAgents"), uid: process.getuid!(), rss: true, notify: true });
  }
  async function query(action?: boolean): Promise<RssWorkerResponse> {
    if (busy) return { ok: false, message: "后台服务操作正在进行，请稍后刷新。" };
    busy = true;
    try {
      const worker = await service();
      const status = action === undefined ? await worker.status() : action ? await worker.enable() : await worker.disable();
      if (!status.registered && status.command.exitCode !== 113) throw new Error("无法确认后台服务状态，不代表服务未运行。");
      return { ok: true, registered: status.registered, running: status.running,
        rssEnabled: status.registered && /^\s*--rss\s*$/m.test(status.command.stdout) };
    } catch (error) {
      // Never return launchctl stdout, credentials or user environment to IPC.
      return { ok: false, message: error instanceof Error ? error.message : "后台服务操作失败。" };
    } finally { busy = false; }
  }
  return { status: () => query(), setEnabled: (enabled: unknown) => typeof enabled === "boolean" ? query(enabled) : Promise.resolve({ ok: false as const, message: "启用开关必须是布尔值。" }) };
}
