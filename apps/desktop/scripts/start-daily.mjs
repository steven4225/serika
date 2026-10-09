import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { prepareMacLauncher } from "./mac-launcher.mjs";
import { dailyEnvironment } from "./daily-environment.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const backend = resolve(desktop, "../aisdk-agent-framework");
const env = await dailyEnvironment(desktop);
for (const cwd of [backend, desktop]) {
  const result = spawnSync("pnpm", ["build"], { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const electronBinary = createRequire(import.meta.url)("electron");
if (typeof electronBinary !== "string") throw new Error("The electron package did not return its executable path");
const executable = process.platform === "darwin" ? (await prepareMacLauncher(desktop, electronBinary)).executable : electronBinary;
const child = spawn(executable, process.platform === "darwin" ? [] : ["."], { cwd: desktop, env, stdio: "inherit" });
child.on("exit", code => process.exit(code ?? 1));
child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exit(1); });
