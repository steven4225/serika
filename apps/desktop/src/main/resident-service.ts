import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { assertWorkerPathSafe, writeWorkerFileAtomic } from "@aisdk-agent/example-cli/dist/task-worker-service.js";
import type { ServiceCommandRunner } from "@aisdk-agent/example-cli/dist/task-worker-service.js";
import type { ResidentServiceState } from "../shared/resident-service.js";
export type { ResidentServiceState } from "../shared/resident-service.js";

function absolute(value: string): string {
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error("常驻服务路径必须是可信绝对路径。");
  return resolve(value);
}

/** Short paths avoid macOS sockaddr_un limits; socket directories belong only to this user. */
export function resolveResidentPaths(home: string, workspace: string, uid = process.getuid?.() ?? 0) {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("常驻服务用户无效。");
  const hash = createHash("sha256").update(absolute(workspace)).digest("hex").slice(0, 20);
  const socketRoot = `/private/tmp/serika-host-${uid}`;
  const socketDirectory = join(socketRoot, hash);
  const stateDirectory = join(absolute(home), "Library/Application Support/Serika/resident", hash);
  return { label: `dev.serika.assistant-host.${hash}`, socketRoot, socketDirectory,
    socketPath: join(socketDirectory, "host.sock"), stateDirectory, identityPath: join(stateDirectory, "identity.json") };
}

export async function ensureResidentSocketDirectory(paths: ReturnType<typeof resolveResidentPaths>, uid = process.getuid?.() ?? 0) {
  for (const path of [paths.socketRoot, paths.socketDirectory]) {
    await privateDirectory(path, uid);
  }
}

// Existing directories require the same owner; never chmod somebody else's path.
async function privateDirectory(path: string, uid: number) {
  await assertWorkerPathSafe(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.uid !== uid) throw new Error("常驻服务私有目录归属不正确。");
  if ((stats.mode & 0o077) !== 0) await chmod(path, 0o700);
}

function loadedArguments(stdout: string): string[] | null {
  const lines = stdout.split("\n").map(line => line.trim());
  const start = lines.findIndex(line => /^arguments\s*=\s*\{$/.test(line));
  const end = lines.findIndex((line, i) => i > start && line === "}");
  return start < 0 || end < 0 ? null : lines.slice(start + 1, end);
}
function xml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
const runCommand: ServiceCommandRunner = (file, args) => new Promise((resolveResult, reject) => {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  child.stdout.on("data", (data: Buffer) => { stdout = (stdout + data.toString()).slice(0, 65536); });
  // Never surface command stderr: launchctl can include environment and other private state.
  child.stderr.resume();
  child.once("error", () => { clearTimeout(timer); reject(new Error("无法执行常驻服务系统命令。")); });
  child.once("close", exitCode => { clearTimeout(timer); resolveResult({ exitCode, stdout, stderr: "" }); });
});

export function createResidentService(options: {
  home: string;
  workspace: string;
  hostEntry: string;
  identityPath: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  uid?: number;
  runner?: ServiceCommandRunner;
}) {
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const paths = resolveResidentPaths(options.home, options.workspace, uid);
  const plistPath = join(absolute(options.home), "Library/LaunchAgents", `${paths.label}.plist`);
  const target = `gui/${uid}/${paths.label}`;
  const runner = options.runner ?? runCommand;
  let busy = false;
  let lastObserved = { registered: false, running: false };
  const query = async () => {
    if ((options.platform ?? process.platform) !== "darwin") throw new Error("常驻助手服务目前仅支持 macOS。");
    const result = await runner("/bin/launchctl", ["print", target]);
    if (result.exitCode !== 0 && result.exitCode !== 113) throw new Error("无法确认常驻助手状态，不代表服务已经停止。");
    lastObserved = { registered: result.exitCode === 0, running: result.exitCode === 0 && /^\s*pid = \d+\s*$/m.test(result.stdout) };
    return { ...lastObserved, stdout: result.stdout };
  };
  const argumentsForService = async () => {
    const node = options.env.RUNLOOM_HOST_NODE ?? options.env.RUNLOOM_WORKER_NODE;
    const envFile = options.env.RUNLOOM_HOST_ENV_FILE ?? options.env.RUNLOOM_WORKER_ENV_FILE ?? options.env.RUNLOOM_ENV_FILE;
    if (!node || !envFile) throw new Error("请配置 RUNLOOM_HOST_NODE 和 RUNLOOM_HOST_ENV_FILE 的绝对路径（可复用 RUNLOOM_WORKER_NODE、RUNLOOM_WORKER_ENV_FILE 或 RUNLOOM_ENV_FILE）；不会复制桌面进程中的密钥。");
    const nodePath = await realpath(absolute(node));
    const trustedEnv = absolute(envFile);
    const entry = absolute(options.hostEntry);
    const identity = absolute(options.identityPath);
    const workspace = absolute(options.workspace);
    if (trustedEnv === workspace || trustedEnv.startsWith(workspace + sep)) throw new Error("常驻助手环境文件必须放在工作区外。");
    if (identity === workspace || identity.startsWith(workspace + sep)) throw new Error("常驻助手启动身份必须放在工作区外。");
    for (const path of [trustedEnv, entry, identity]) await assertWorkerPathSafe(path);
    for (const path of [nodePath, trustedEnv, entry, identity]) {
      const stat = await lstat(path);
      if (!stat.isFile()) throw new Error("常驻助手入口、Node、身份和环境文件必须是普通文件。");
      if (path === trustedEnv && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) throw new Error("常驻助手环境文件必须属于当前用户，且权限为 600；不会修改或复制该文件。");
      if (path === identity && (stat.uid !== uid || (stat.mode & 0o022) !== 0)) throw new Error("常驻助手启动身份必须属于当前用户，且不能允许其他用户写入。");
    }
    await access(nodePath, constants.X_OK);
    const text = await readFile(trustedEnv, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("常驻助手环境文件超过 64 KiB。");
    if (!parseEnv(text).RUNLOOM_MODEL?.trim()) throw new Error("常驻助手环境文件必须显式配置 RUNLOOM_MODEL。");
    return [nodePath, `--env-file=${trustedEnv}`, entry, "--identity", identity, "--socket", paths.socketPath];
  };
  const state = async (): Promise<ResidentServiceState> => {
    const actual = await query();
    let compatible = false;
    let message: string | undefined;
    try {
      const expected = await argumentsForService();
      compatible = !actual.registered || JSON.stringify(loadedArguments(actual.stdout)) === JSON.stringify(expected);
      if (!compatible) message = "已有常驻助手与当前可信配置不一致；不会自动替换，请显式停用后重新启用。";
    } catch (error) { message = safeMessage(error); }
    return { ok: true, registered: actual.registered, running: actual.running, compatible, label: paths.label, ...(message ? { message } : {}) };
  };
  const failure = (error: unknown): ResidentServiceState => ({ ok: false, ...lastObserved, compatible: false, label: paths.label, message: safeMessage(error) });
  async function act(enable: boolean): Promise<ResidentServiceState> {
    if (busy) return failure(new Error("常驻服务操作正在进行，请稍后刷新。"));
    busy = true;
    try {
      const before = await query();
      if (enable) {
        const args = await argumentsForService();
        if (before.registered) {
          if (JSON.stringify(loadedArguments(before.stdout)) !== JSON.stringify(args)) throw new Error("已有常驻助手与当前可信配置不一致；不会自动替换，请显式停用后重新启用。");
          return state();
        }
        await privateDirectory(paths.socketRoot, uid);
        await privateDirectory(paths.socketDirectory, uid);
        await assertWorkerPathSafe(plistPath);
        const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(paths.label)}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(dirname(options.hostEntry))}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer></dict></plist>\n`;
        await writeWorkerFileAtomic(plistPath, plist);
        const result = await runner("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
        if (result.exitCode !== 0) throw new Error("常驻助手注册失败；请刷新状态，不会自动重试。");
        const after = await state();
        if (!after.registered) throw new Error("注册请求结束，但尚未确认常驻助手已注册。");
        return after;
      }
      if (before.registered) {
        const result = await runner("/bin/launchctl", ["bootout", target]);
        if (result.exitCode !== 0) throw new Error("停止常驻助手失败；请刷新状态，不会删除服务定义。");
      }
      const deadline = Date.now() + 5_000;
      let after = await query();
      while (after.registered && Date.now() < deadline) {
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
        after = await query();
      }
      if (after.registered) throw new Error("尚未确认常驻助手停止，服务定义保留。");
      await assertWorkerPathSafe(plistPath);
      await rm(plistPath, { force: true });
      return { ok: true, registered: false, running: false, compatible: true, label: paths.label };
    } catch (error) { return failure(error); }
    finally { busy = false; }
  }
  return { paths, plistPath, status: async () => { try { return await state(); } catch (error) { return failure(error); } },
    enable: () => act(true), disable: () => act(false) };
}

function safeMessage(error: unknown): string {
  // IO errors can contain credential paths but never file contents. Keep errors thrown by external runners private.
  if (!(error instanceof Error)) return "常驻服务操作失败。";
  if ((error as NodeJS.ErrnoException).code) return "常驻助手可信配置文件不可用，请检查路径、权限和 Node 执行入口。";
  return error.message.startsWith("常驻") || error.message.startsWith("请") || error.message.startsWith("已有") || error.message.startsWith("无法") || error.message.startsWith("停止") || error.message.startsWith("尚未") || error.message.startsWith("注册")
    ? error.message : "常驻服务操作失败。";
}
