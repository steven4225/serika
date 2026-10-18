import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { LanguageModel } from "ai";
import { createRuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController, type AssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { tryAcquireFlock, type FlockHandle } from "@aisdk-agent/example-cli/dist/flock.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import { readQqConfig } from "./qq-config.js";
import { createOneBotApi, type OneBotApi } from "./onebot-api.js";
import { QqGateway } from "./qq-gateway.js";
import { QqStore } from "./qq-store.js";

/** Dedicated local QQ host; reuses Controller/AgentLoop with no desktop or TG grants. */
export async function startQqHost(options: { configPath: string; env: NodeJS.ProcessEnv; modelAlias: string; model: LanguageModel; api?: OneBotApi; log?: (message: string) => void }) {
  const config = await readQqConfig(options.configPath);
  // Validate transport credentials before creating runtime or persistent state.
  const api = options.api ?? createOneBotApi(config.endpoint, options.env.QQ_ACCESS_TOKEN ?? "");
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(config.stateDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) throw new Error("QQ 状态目录权限不安全。");
  const lease = await tryAcquireFlock(join(config.stateDirectory, "host.lock"));
  if (!lease) throw new Error("这个 QQ 配置已有运行中的群助手。");
  let groupLease: FlockHandle | null = null;
  let controller: AssistantController | undefined, gateway: QqGateway | undefined;
  let disposed = false;
  const close = async () => {
    if (disposed) return; disposed = true;
    try { await gateway?.close(); } finally {
      try { api.close(); await controller?.shutdown(); } finally {
        try { await groupLease?.release(); } finally { await lease.release(); }
      }
    }
  };
  try {
    groupLease = await tryAcquireFlock(join(config.binding.workspace, ".runloom", `${config.binding.threadId}.lock`));
    if (!groupLease) throw new Error("这个群工作区已有运行中的 QQ 群助手，不接受复制配置启动第二个实例。");
    const runtimePath = join(config.stateDirectory, "runtime.json"), temporary = `${runtimePath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(config.runtimeConfig)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, runtimePath);
      const parent = await open(config.stateDirectory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
    // Parse with the existing production schema before assembly. The snapshot has no secrets,
    // grants, Skills, auto tools or paths taken from the personal desktop config.
    await resolveTuiModuleConfig({ configPath: runtimePath }, { cwd: config.binding.workspace });
    const store = new QqStore(join(config.stateDirectory, "channel.json"), config.binding);
    await store.load();
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const app = await createRuntimeApp({ args: ["--tui", join(config.stateDirectory, "transcripts"), "--thread", config.binding.threadId, "--config", runtimePath],
      cwd: config.binding.workspace, env: options.env, modelAlias: options.modelAlias, model: options.model, output,
      beforePrimaryRunCreate: record => { if (!gateway) throw new Error("QQ 网关未就绪。"); return gateway.bind(record); } });
    controller = createAssistantController(app);
    await controller.listRuns();
    gateway = new QqGateway(controller, store, api, options.log);
    await gateway.start();
    return { gateway, store, controller, config, close };
  } catch (error) { await close(); throw error; }
}
