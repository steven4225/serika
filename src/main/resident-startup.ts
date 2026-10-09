import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const IDENTITY_KEYS = ["RUNLOOM_CONFIG", "RUNLOOM_WORKSPACE", "RUNLOOM_THREAD", "RUNLOOM_TRANSCRIPTS", "RUNLOOM_DESKTOP_TEST", "RUNLOOM_MODEL", "RUNLOOM_NOTIFICATION_HELPER"] as const;
/** Retain Node's trusted env-file source for the pre-existing worker adapter. */
export function retainResidentEnvironmentSource(env: NodeJS.ProcessEnv, execArgs: readonly string[]): void {
  const argument = execArgs.find(value => value.startsWith("--env-file="));
  if (argument && !env.RUNLOOM_ENV_FILE) {
    const path = argument.slice("--env-file=".length);
    if (!isAbsolute(path)) throw new Error("常驻助手环境文件必须使用可信绝对路径");
    env.RUNLOOM_ENV_FILE = path;
  }
}
export interface ResidentStartup { version: 1; userData: string; cwd: string; env: Record<string, string> }
export function residentStartup(userData: string, cwd: string, env: NodeJS.ProcessEnv): ResidentStartup {
  if (!isAbsolute(userData) || !isAbsolute(cwd)) throw new Error("助手启动身份必须使用绝对路径");
  return { version: 1, userData, cwd, env: Object.fromEntries(IDENTITY_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]])) };
}
function validate(value: unknown): ResidentStartup {
  const item = value as ResidentStartup;
  if (!item || item.version !== 1 || typeof item.userData !== "string" || !isAbsolute(item.userData) || typeof item.cwd !== "string" || !isAbsolute(item.cwd)
    || !item.env || typeof item.env !== "object" || Array.isArray(item.env) || Object.entries(item.env).some(([key, val]) => !IDENTITY_KEYS.includes(key as typeof IDENTITY_KEYS[number]) || typeof val !== "string")) {
    throw new Error("常驻助手启动身份无效，不会猜测或重建对话身份");
  }
  return item;
}
export async function readResidentStartup(path: string): Promise<ResidentStartup> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || stat.size > 64 * 1024) throw new Error("常驻助手启动身份权限或大小无效");
  return validate(JSON.parse(await readFile(path, "utf8")));
}
/** Never replace the startup identity underneath an already registered service. */
export async function saveResidentStartup(path: string, value: ResidentStartup, registered: boolean): Promise<void> {
  validate(value);
  if (registered) {
    if (JSON.stringify(await readResidentStartup(path)) !== JSON.stringify(value)) throw new Error("常驻助手使用另一份启动身份；请先停用，再从当前入口重新启用");
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
