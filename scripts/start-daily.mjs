import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { spawn, spawnSync } from "node:child_process";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const backend = resolve(desktop, "../aisdk-agent-framework");
const env = { ...process.env };
env.RUNLOOM_ENV_FILE ??= resolve(backend, ".env");
const credentials = parseEnv(await readFile(env.RUNLOOM_ENV_FILE, "utf8"));
env.RUNLOOM_MODEL ??= credentials.RUNLOOM_MODEL ||
  (env.COMMAND_CODE_API_KEY || credentials.COMMAND_CODE_API_KEY ? "command-code" : env.DEEPSEEK_API_KEY || credentials.DEEPSEEK_API_KEY ? "deepseek" : "");
if (!env.RUNLOOM_MODEL || env.RUNLOOM_MODEL === "mock") throw new Error("日用入口需要真实模型。请在受信任 env 文件中配置 RUNLOOM_MODEL 与对应 API_KEY；界面测试使用 pnpm dev。");
for (const cwd of [backend, desktop]) {
  const result = spawnSync("pnpm", ["build"], { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
delete env.ELECTRON_RUN_AS_NODE;
const electronBinary = createRequire(import.meta.url)("electron");
if (typeof electronBinary !== "string") throw new Error("The electron package did not return its executable path");
const child = spawn(electronBinary, ["."], { cwd: desktop, env, stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 1));
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
