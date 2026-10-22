import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { registerDesktopThread, selectDesktopThread } from "./desktop-identity.js";

export interface RecoverySelection { version: 1; sourceConfigPath: string; sourceWorkspace: string; configPath: string; workspaceRoot: string; recoveryRoot: string }
async function readPrivate(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error("恢复入口权限或内容无效；未切换工作区");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
export async function readRecoverySelection(applicationHome: string, sourceConfigPath: string): Promise<RecoverySelection | null> {
  let selection: RecoverySelection;
  try { selection = await readPrivate(join(applicationHome, "desktop", "recovery-selection.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if ((selection as unknown as { version?: unknown; inactive?: unknown }).version === 1 && (selection as unknown as { inactive?: unknown }).inactive === true) return null;
  if (!selection || selection.version !== 1 || [selection.sourceConfigPath, selection.sourceWorkspace, selection.configPath, selection.workspaceRoot, selection.recoveryRoot].some(path => typeof path !== "string" || !isAbsolute(path)) ||
      selection.configPath !== join(selection.recoveryRoot, "recovery-config.json") || selection.workspaceRoot !== join(selection.recoveryRoot, "workspace")) throw new Error("恢复入口无效；不会悄悄生成新对话");
  if (selection.sourceConfigPath !== sourceConfigPath) return null; // Explicit different launch remains authoritative.
  await validateRecoveryRoot(selection.recoveryRoot);
  const config = await readPrivate(selection.configPath);
  if (config.workspace !== selection.workspaceRoot) throw new Error("恢复配置工作区不匹配；未混合数据");
  return selection;
}
async function writePrivate(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`; let renamed = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); renamed = true;
    const directory = await open(resolve(path, ".."), "r"); try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { if (renamed) throw new Error("恢复入口保存结果未确认，请核对后重新连接；不会重做任务", { cause: error }); throw error; }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function saveRecoverySelection(applicationHome: string, selection: RecoverySelection | null) {
  await mkdir(join(applicationHome, "desktop"), { recursive: true });
  // A null selection is a committed explicit return to the original launch.
  await writePrivate(join(applicationHome, "desktop", "recovery-selection.json"), selection ?? { version: 1, inactive: true });
}
export async function validateRecoveryRoot(root: string): Promise<{ threads: string[]; originWorkspace: string }> {
  if (!isAbsolute(root) || await realpath(root) !== root) throw new Error("请选择可信的恢复目录，不允许符号链接");
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) throw new Error("恢复目录权限无效");
  const marker = await readPrivate(join(root, "recovery.json"));
  if (marker.version !== 1 || marker.futureExecutionDisabled !== true || typeof marker.originWorkspace !== "string" || !isAbsolute(marker.originWorkspace) || !Array.isArray(marker.threads) || marker.threads.length > 100 || marker.threads.some((id: unknown) => typeof id !== "string" || !id || id.length > 256) || new Set(marker.threads).size !== marker.threads.length) throw new Error("恢复目录清单无效");
  for (const child of ["data", "workspace", "transcripts"]) if (await realpath(join(root, child)) !== join(root, child)) throw new Error("恢复数据路径含符号链接");
  return marker;
}
export async function prepareRecoveryProfile(options: { root: string; applicationHome: string; cwd: string; sourceConfigPath: string; sourceWorkspace: string }) {
  const marker = await validateRecoveryRoot(options.root);
  const configPath = join(options.root, "recovery-config.json"), workspaceRoot = join(options.root, "workspace");
  try {
    const existing = await readPrivate(configPath);
    if (existing.workspace !== workspaceRoot) throw new Error("已有恢复配置归属不匹配");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writePrivate(configPath, { version: 1, workspace: workspaceRoot, modules: { "read-file": { enabled: true }, memory: { enabled: true, autoConsolidate: false, writePolicy: "review" },
      shell: { enabled: false }, task: { enabled: true }, checkpoint: { enabled: true }, pomodoro: { enabled: true } } });
  }
  const scope = { applicationHome: options.root, cwd: options.cwd, configPath, workspaceRoot };
  for (const threadId of marker.threads) await registerDesktopThread(scope, { threadId, transcriptDirectory: join(options.root, "transcripts") });
  if (marker.threads[0]) await selectDesktopThread(scope, marker.threads[0]);
  return { version: 1 as const, sourceConfigPath: options.sourceConfigPath, sourceWorkspace: options.sourceWorkspace, configPath, workspaceRoot, recoveryRoot: options.root };
}
