import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { ServiceCommandRunner } from "@aisdk-agent/example-cli/dist/task-worker-service.js";

export interface NotificationReadinessStatus {
  helperConfigured: boolean;
  authorization: "not_requested" | "authorized" | "denied" | "unknown";
  message: string;
}
export type NotificationTestResult =
  | { ok: true; submitted: true; message: string }
  | { ok: false; message: string };

const runHelper: ServiceCommandRunner = (file, args) => new Promise((resolveResult, reject) => {
  // No shell, raw output in IPC, model input, task body or API credentials in argv.
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), args[0] === "-diagnose" ? 5_000 : 120_000);
  child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 4096); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", exitCode => { clearTimeout(timer); resolveResult({ exitCode, stdout, stderr }); });
});

/** Uses only main-process configuration; status does not request permission or start a worker. */
export function createNotificationReadiness(options: {
  workspace: string | undefined;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  runner?: ServiceCommandRunner;
}) {
  const runner = options.runner ?? runHelper;
  let testing = false;
  const unknown = (helperConfigured: boolean, message: string): NotificationReadinessStatus => ({ helperConfigured, authorization: "unknown", message });
  async function helper(): Promise<string> {
    if ((options.platform ?? process.platform) !== "darwin") throw new Error("UNSUPPORTED");
    const path = options.env.RUNLOOM_NOTIFICATION_HELPER;
    if (!path || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path)) throw new Error("NOT_CONFIGURED");
    const target = await realpath(path);
    if (options.workspace) {
      const workspace = await realpath(options.workspace);
      if (target === workspace || target.startsWith(workspace + sep)) throw new Error("WORKSPACE_HELPER");
      // Also refuse a literal workspace-local alias to a trusted-looking external binary.
      const requested = resolve(path);
      const configuredWorkspace = resolve(options.workspace);
      if (requested === workspace || requested.startsWith(workspace + sep) || requested === configuredWorkspace || requested.startsWith(configuredWorkspace + sep)) throw new Error("WORKSPACE_HELPER");
    }
    if (!(await lstat(target)).isFile()) throw new Error("NOT_EXECUTABLE");
    await access(target, constants.X_OK);
    return target;
  }
  return {
    async status(): Promise<NotificationReadinessStatus> {
      if ((options.platform ?? process.platform) !== "darwin") return unknown(false, "系统通知目前仅支持 macOS。");
      if (!options.env.RUNLOOM_NOTIFICATION_HELPER) return unknown(false, "Serika 原生通知组件未就绪，请重新构建应用。");
      if (testing) return unknown(true, "正在发送测试通知；请先处理系统提示，再刷新权限状态。");
      try {
        const result = await runner(await helper(), ["-diagnose"]);
        const authorization = /^\s*authorization\s+([^\r\n]+?)\s*$/m.exec(result.stdout)?.[1];
        if (authorization === "authorized" && result.exitCode === 0) return { helperConfigured: true, authorization: "authorized", message: "系统已允许通知；专注模式或系统通知设置仍可能隐藏弹窗。" };
        if (authorization === "not requested yet" && result.exitCode === 3) return { helperConfigured: true, authorization: "not_requested", message: "尚未申请通知权限。发送一次测试通知，在 macOS 提示中自行选择允许。" };
        if (authorization === "denied" && result.exitCode === 3) return { helperConfigured: true, authorization: "denied", message: "系统通知已被拒绝。请在系统设置 → 通知中允许「Serika 通知」，再刷新。" };
        return unknown(true, "无法确认通知权限；请检查系统通知设置。不会把工具退出成功当作已授权。");
      } catch {
        return unknown(false, "Serika 原生通知组件不可用，请重新构建应用。不会执行工作区内的程序。");
      }
    },
    /** Explicit user action only; never approves the OS dialog or enables launchd. */
    async test(): Promise<NotificationTestResult> {
      if (testing) return { ok: false, message: "测试通知正在发送，请勿重复点击。" };
      testing = true;
      try {
        const result = await runner(await helper(), ["-request-authorization", "-title", "Serika", "-message", "通知测试：看到此消息说明系统已显示通知。此测试不会执行任务。"]);
        if (result.exitCode === 0) return { ok: true, submitted: true, message: "测试通知已提交给系统。请亲眼确认是否出现；提交成功不代表已经看到。" };
        if (result.exitCode === 3) return { ok: false, message: "系统未允许通知，请处理 macOS 提示或系统设置后再刷新。" };
        return { ok: false, message: "未确认测试通知提交。请检查系统提示和通知中心；这不证明通知没有发送。" };
      } catch {
        return { ok: false, message: "Serika 原生通知组件不可用或提交未确认。请检查通知中心，不要盲目重复发送。" };
      } finally { testing = false; }
    },
  };
}
