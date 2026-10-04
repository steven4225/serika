import type { LanguageModel } from "ai";
import { createRuntimeApp } from "@aisdk-agent/example-cli/dist/app.js";
import { createAssistantController } from "@aisdk-agent/example-cli/dist/assistant-controller.js";
import { resolveTuiModuleConfig } from "@aisdk-agent/example-cli/dist/tui-module-config.js";
import { enableDesktopMemory, resolveDesktopConfig } from "./desktop-config.js";
import { createDesktopThread, listDesktopThreads, registerDesktopThread, resolveDesktopIdentity, selectDesktopThread, type DesktopIdentityResolution } from "./desktop-identity.js";
import { discoverThreadDirectory, inspectThread } from "./thread-history.js";
import { RuntimeBridge, TeeOutput, type Send } from "./runtime-bridge.js";

interface Options { userData: string; cwd: string; env: NodeJS.ProcessEnv; modelAlias: string; modelId?: string; model: LanguageModel; send: Send }

/** Owns desktop selection only. Each selected Thread still uses the original controller/loop. */
export class DesktopRuntime {
  #options: Options;
  #identity!: DesktopIdentityResolution;
  #bridge!: RuntimeBridge;
  #changing = false;
  #transition: Promise<void> | undefined;

  private constructor(options: Options) { this.#options = options; }

  static async create(options: Options): Promise<DesktopRuntime> {
    const host = new DesktopRuntime(options);
    const config = await resolveDesktopConfig(options);
    const modules = await resolveTuiModuleConfig({ configPath: config.configPath }, { cwd: options.cwd });
    host.#identity = await resolveDesktopIdentity({ ...options, configPath: modules.configPath!, workspaceRoot: modules.workspaceRoot });
    host.#bridge = await host.#make(host.#identity);
    return host;
  }

  get current(): RuntimeBridge {
    if (this.#changing) throw new Error("正在切换会话，请稍候");
    return this.#bridge;
  }

  info() { return this.#bridge.info(); }
  #scope() { return { ...this.#options, configPath: this.#identity.configPath, workspaceRoot: this.#identity.workspaceRoot }; }
  #assertIdle() {
    if (this.#changing || this.#bridge.snapshot().state.kind !== "idle") throw new Error("请先等待当前执行或整理结束，再切换会话");
  }

  async #make(identity: DesktopIdentityResolution): Promise<RuntimeBridge> {
    const output = new TeeOutput(this.#options.send);
    const app = await createRuntimeApp({
      args: ["--tui", identity.transcriptDirectory, "--thread", identity.threadId, "--config", identity.configPath],
      modelAlias: this.#options.modelAlias, model: this.#options.model, output, env: this.#options.env, cwd: this.#options.cwd,
    });
    const controller = createAssistantController(app);
    output.attach(controller);
    try {
      // Await lease acquisition/recovery before publishing the new identity.
      await controller.listRuns();
      return new RuntimeBridge(app, controller, { modelAlias: this.#options.modelAlias,
        ...(this.#options.modelId === undefined ? {} : { modelId: this.#options.modelId }), temporaryThread: false, temporaryDirectory: false,
        identitySource: identity.identitySource, entryMode: this.#options.env.RUNLOOM_DESKTOP_TEST === "1" ? "test" : "daily" }, output, this.#options.send);
    } catch (error) { await controller.shutdown(); throw error; }
  }

  async listThreads() {
    const registered = await listDesktopThreads(this.#scope());
    if (!registered.some(thread => thread.threadId === this.#identity.threadId && thread.transcriptDirectory === this.#identity.transcriptDirectory)) registered.unshift(this.#identity);
    return Promise.all(registered.map(inspectThread));
  }

  discoverThreads(directory: string) { return discoverThreadDirectory(directory); }

  async registerThread(input: { threadId: string; transcriptDirectory: string; confirmedWorkspace: true }) {
    this.#assertIdle();
    if (!input || input.confirmedWorkspace !== true || typeof input.threadId !== "string") throw new Error("请明确确认旧对话属于当前工作区");
    this.#changing = true;
    try {
      const found = (await discoverThreadDirectory(input.transcriptDirectory)).find(thread => thread.threadId === input.threadId);
      if (!found || found.error) throw new Error(found?.error ?? "这个目录没有所选对话");
      await registerDesktopThread(this.#scope(), found);
    } finally { this.#changing = false; }
  }

  async #replace(select: () => Promise<DesktopIdentityResolution>): Promise<void> {
    this.#assertIdle();
    this.#changing = true;
    this.#options.send({ type: "state", state: { kind: "command", name: "thread-switch" } });
    const previous = this.#identity;
    let disposed = false;
    const transition = (async () => {
      try {
        const next = await select();
        await this.#bridge.shutdown();
        disposed = true;
        this.#bridge = await this.#make(next);
        this.#identity = next;
      } catch (error) {
        if (disposed) this.#bridge = await this.#make(previous);
        // Restore persisted selection if activating the new controller failed.
        if (previous.identitySource === "saved") await selectDesktopThread(this.#scope(), previous.threadId);
        throw error;
      } finally {
        this.#changing = false;
        this.#options.send({ type: "identity-changed", info: this.#bridge.info() });
      }
    })();
    this.#transition = transition;
    try { await transition; } finally { this.#transition = undefined; }
  }

  selectThread(threadId: string) {
    return this.#replace(() => selectDesktopThread(this.#scope(), threadId));
  }
  createThread() {
    return this.#replace(async () => {
      const thread = await createDesktopThread(this.#scope());
      return selectDesktopThread(this.#scope(), thread.threadId);
    });
  }
  enableMemory() {
    return this.#replace(async () => {
      await enableDesktopMemory(this.#identity.configPath);
      return this.#identity;
    });
  }
  async shutdown() {
    await this.#transition?.catch(() => undefined);
    await this.#bridge.shutdown();
  }
}
