import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDemoModel } from "@serika/example-cli";
import { configureCliModel, inspectCliModelConfig } from "@serika/example-cli";
import { resolveTuiModuleConfig } from "@serika/example-cli";
import { DesktopRuntime } from "./desktop-runtime.js";
import { createTelegramApi } from "./telegram-api.js";
import { TelegramStore } from "./telegram-store.js";
import { TelegramGateway } from "./telegram-gateway.js";
import { readResidentStartup, retainResidentEnvironmentSource } from "./resident-startup.js";
import { startResidentServer } from "./resident-transport.js";
import { createDesktopRssWorker } from "./rss-worker-service.js";
import { safeStartupError } from "./desktop-env.js";

async function main() {
  const arg = (name: string) => { const index = process.argv.indexOf(name); const value = process.argv[index + 1]; if (index < 0 || !value) throw new Error(`Missing ${name}`); return value; };
  const identityPath = arg("--identity"), socket = arg("--socket");
  const startup = await readResidentStartup(identityPath);
  // Node loads --env-file but does not expose its path as RUNLOOM_ENV_FILE.
  // Preserve that trusted source for the existing restricted worker adapter;
  // otherwise reminders appear unavailable only in resident mode.
  retainResidentEnvironmentSource(process.env, process.execArgv);
  Object.assign(process.env, startup.env);
  process.chdir(startup.cwd);
  const config = await resolveTuiModuleConfig({ configPath: startup.env.RUNLOOM_CONFIG! }, { cwd: startup.cwd });
  if (!config.workspaceRoot || !config.configPath) throw new Error("常驻助手需要固定工作区与配置");
  const { modelAlias, model } = configureCliModel(createDemoModel, process.env);
  const worker = (workspace: string, configPath?: string) => createDesktopRssWorker({ workspace, ...(configPath ? { configPath } : {}), home: homedir(), env: process.env,
    workerEntry: fileURLToPath(import.meta.resolve("@serika/example-cli/task-worker-entry")), todoist: !!process.env.TODOIST_API_TOKEN?.trim() });
  const server = await startResidentServer({ paths: { directory: dirname(identityPath), token: join(dirname(identityPath), "auth-token"), socket },
    scope: { userData: startup.userData, configPath: config.configPath, workspaceRoot: config.workspaceRoot },
    createRuntime: async send => {
      const runtime = await DesktopRuntime.create({ ...startup, env: process.env, modelAlias, model, modelId: inspectCliModelConfig().modelId, send,
        taskAutomation: { status: (workspace, configPath) => worker(workspace, configPath).automationStatus(), enable: (workspace, configPath) => worker(workspace, configPath).enableArrangement() } });
      try {
        const store = new TelegramStore(join(dirname(identityPath), "telegram.json"), config.workspaceRoot!);
        await store.load();
        const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
        const gateway = new TelegramGateway(runtime, store, token ? createTelegramApi(token, fetch,
          process.env.TELEGRAM_PROXY_URL ? { proxyUrl: process.env.TELEGRAM_PROXY_URL } : {}) : undefined);
        runtime.attachTelegram(gateway);
        await gateway.initialize();
        return runtime;
      } catch { runtime.telegramFailed(); }
      return runtime;
    },
    onStop: () => { void stop(); },
  });
  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    try { await server.close(); await server.runtime.shutdown(); process.exitCode = 0; }
    catch (error) { process.stderr.write(`${safeStartupError(error, process.env)}\n`); process.exitCode = 1; }
  }
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}
void main().catch(error => { process.stderr.write(`${safeStartupError(error, process.env)}\n`); process.exitCode = 1; });
