import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";

/** Explicit, main-process-only input. Never infer a file from cwd or copy secrets to IPC. */
export async function loadDesktopEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = env.RUNLOOM_ENV_FILE?.trim();
  if (!path) return;
  if (!isAbsolute(path)) throw new Error("RUNLOOM_ENV_FILE 必须是受信任环境文件的绝对路径");
  let parsed: Record<string, string | undefined>;
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("oversized");
    parsed = parseEnv(text);
    if (Object.keys(parsed).length === 0) throw new Error("empty or invalid");
  } catch {
    // Parsing/filesystem exceptions can contain input; do not send that input to the renderer.
    throw new Error("无法加载 RUNLOOM_ENV_FILE：请检查文件存在、可读且包含有效配置（最多 64 KiB）");
  }
  for (const [key, value] of Object.entries(parsed)) if (env[key] === undefined && value !== undefined) env[key] = value;
}

export function safeStartupError(error: unknown, env: NodeJS.ProcessEnv): string {
  let text = error instanceof Error ? error.message : "未知启动错误";
  const secrets = Object.entries(env).filter(([key, value]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key) && value)
    .map(([, value]) => value!).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.split(secret).join("[已隐藏]");
  return `Runtime 无法启动：${text.slice(0, 1000)}`;
}
