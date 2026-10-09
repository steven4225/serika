import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

export async function dailyEnvironment(desktop, inherited = process.env) {
  const env = { ...inherited };
  env.RUNLOOM_ENV_FILE ??= resolve(desktop, "../../.env");
  if (!isAbsolute(env.RUNLOOM_ENV_FILE)) throw new Error("RUNLOOM_ENV_FILE 必须是绝对路径。");
  let credentials;
  try {
    const text = await readFile(env.RUNLOOM_ENV_FILE, "utf8");
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("oversized");
    credentials = parseEnv(text);
  } catch {
    throw new Error("无法读取日用模型配置，请检查 RUNLOOM_ENV_FILE。详情不会包含密钥。");
  }
  env.RUNLOOM_MODEL ??= credentials.RUNLOOM_MODEL ||
    (env.COMMAND_CODE_API_KEY || credentials.COMMAND_CODE_API_KEY ? "command-code" : env.DEEPSEEK_API_KEY || credentials.DEEPSEEK_API_KEY ? "deepseek" : "");
  if (!env.RUNLOOM_MODEL || env.RUNLOOM_MODEL === "mock") throw new Error("日用入口需要真实模型。请在受信任 env 文件中配置 RUNLOOM_MODEL 与对应 API_KEY；界面测试使用 pnpm dev。");
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
