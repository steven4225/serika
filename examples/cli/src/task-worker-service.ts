import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export interface ServiceCommandResult { exitCode: number | null; stdout: string; stderr: string }
export type ServiceCommandRunner = (file: string, args: string[]) => Promise<ServiceCommandResult>;
export interface TaskWorkerServiceOptions {
  workspace: string;
  nodePath: string;
  workerEntryPath: string;
  workingDirectory: string;
  launchAgentsDirectory: string;
  uid: number;
  envFile?: string;
  notify?: boolean;
  todoist?: boolean;
  workspaceContext?: boolean;
  safeRetry?: boolean;
  rss?: boolean;
  runner?: ServiceCommandRunner;
  platform?: NodeJS.Platform;
}
export interface TaskWorkerServiceStatus {
  label: string;
  plistPath: string;
  registered: boolean;
  running: boolean;
  pid: number | null;
  /** launchctl failure is not proof that the worker ownership lock is free. */
  command: ServiceCommandResult;
}

function absolute(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\n")) throw new Error("Service paths must be absolute and contain no NUL/newline");
  return resolve(value);
}

/** Refuse existing symlinks at every component, including the workspace root. */
export async function assertWorkerPathSafe(path: string): Promise<void> {
  const target = absolute(path);
  let current = parse(target).root;
  for (const part of target.slice(current.length).split(sep)) {
    current = join(current, part);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`Worker path is a symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

export async function writeWorkerFileAtomic(path: string, text: string): Promise<void> {
  await assertWorkerPathSafe(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertWorkerPathSafe(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const runCommand: ServiceCommandRunner = (file, args) => new Promise((resolveResult, reject) => {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(0, 8192); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 8192); });
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("close", (exitCode) => { clearTimeout(timer); resolveResult({ exitCode, stdout, stderr }); });
});

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function createTaskWorkerService(options: TaskWorkerServiceOptions) {
  const workspace = absolute(options.workspace);
  const nodePath = absolute(options.nodePath);
  const workerEntryPath = absolute(options.workerEntryPath);
  const workingDirectory = absolute(options.workingDirectory);
  const launchAgentsDirectory = absolute(options.launchAgentsDirectory);
  const envFile = options.envFile === undefined ? undefined : absolute(options.envFile);
  if (!Number.isSafeInteger(options.uid) || options.uid < 0) throw new Error("Invalid service uid");
  const label = `dev.runloom.task-worker.${createHash("sha256").update(workspace).digest("hex").slice(0, 20)}`;
  const plistPath = join(launchAgentsDirectory, `${label}.plist`);
  const domain = `gui/${options.uid}`;
  const target = `${domain}/${label}`;
  const runner = options.runner ?? runCommand;
  const ensurePlatform = () => { if ((options.platform ?? process.platform) !== "darwin") throw new Error("Task worker service requires macOS launchd"); };
  const status = async (): Promise<TaskWorkerServiceStatus> => {
    ensurePlatform();
    const command = await runner("/bin/launchctl", ["print", target]);
    const registered = command.exitCode === 0;
    const pidMatch = registered ? /^\s*pid = (\d+)\s*$/m.exec(command.stdout) : null;
    const pid = pidMatch === null ? null : Number(pidMatch[1]);
    return { label, plistPath, registered, running: registered && pid !== null, pid, command };
  };
  return {
    label, plistPath, status,
    async enable(): Promise<TaskWorkerServiceStatus> {
      ensurePlatform();
      for (const path of [workspace, nodePath, workerEntryPath, workingDirectory, ...(envFile === undefined ? [] : [envFile])]) await assertWorkerPathSafe(path);
      for (const path of [workspace, workingDirectory]) if (!(await lstat(path)).isDirectory()) throw new Error(`Service directory does not exist: ${path}`);
      for (const path of [nodePath, workerEntryPath, ...(envFile === undefined ? [] : [envFile])]) if (!(await lstat(path)).isFile()) throw new Error(`Service input is not a regular file: ${path}`);
      await access(nodePath, constants.X_OK);
      await access(workerEntryPath, constants.R_OK);
      if (envFile !== undefined) await access(envFile, constants.R_OK);
      const before = await status();
      if (before.registered) return before;
      if (before.command.exitCode !== 113) throw new Error(`Cannot establish launchd service absence (${String(before.command.exitCode)})`);
      const args = [nodePath, ...(envFile === undefined ? [] : [`--env-file=${envFile}`]), workerEntryPath, "--workspace", workspace,
        ...(options.notify === true ? ["--notify"] : []), ...(options.todoist === true ? ["--todoist"] : []), ...(options.workspaceContext === true ? ["--workspace-context"] : []), ...(options.safeRetry === true ? ["--safe-retry"] : []), ...(options.rss === true ? ["--rss"] : [])];
      // No environment values or credentials are copied into the service definition.
      const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(workingDirectory)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`;
      await writeWorkerFileAtomic(plistPath, plist);
      const boot = await runner("/bin/launchctl", ["bootstrap", domain, plistPath]);
      if (boot.exitCode !== 0) throw new Error(`launchctl bootstrap failed (${String(boot.exitCode)}): ${boot.stderr}`);
      return status();
    },
    async disable(): Promise<TaskWorkerServiceStatus> {
      ensurePlatform();
      const before = await status();
      if (!before.registered && before.command.exitCode !== 113) throw new Error(`Cannot establish launchd service absence (${String(before.command.exitCode)})`);
      if (before.registered) {
        const result = await runner("/bin/launchctl", ["bootout", target]);
        if (result.exitCode !== 0) throw new Error(`launchctl bootout failed (${String(result.exitCode)}): ${result.stderr}`);
      }
      await assertWorkerPathSafe(plistPath);
      await rm(plistPath, { force: true });
      return status();
    },
  };
}
