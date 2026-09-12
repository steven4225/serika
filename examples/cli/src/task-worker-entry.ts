import { join } from "node:path";
import { simulateReadableStream, type LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  JsonlAgentStore,
  type AgentStore,
} from "@aisdk-agent/core";
import {
  AiSdkAgentLoop,
  createConfiguredModel,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@aisdk-agent/ai-sdk-adapter";
import { resolveWorkspace } from "./cli-options.js";
import { createModuleHost } from "./module-host.js";
import {
  createTodoistModule,
  type TodoistModuleOptions,
} from "./modules/todoist-module.js";
import { createTaskStore, taskWorkerLockPath } from "./task-store.js";
import { runTaskWorker } from "./task-worker.js";
import { tryAcquireFlock } from "./flock.js";
import { canonicalTimeZone } from "./todoist.js";

interface TaskWorkerArgs {
  workspace: string;
  todoist?: true;
}

export function parseTaskWorkerArgs(args: readonly string[]): TaskWorkerArgs {
  const parsed = args[0] === "--" ? args.slice(1) : args;
  let workspace: string | undefined;
  let todoist = false;
  for (let index = 0; index < parsed.length; index += 1) {
    const arg = parsed[index];
    if (arg === "--workspace") {
      const value = parsed[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--workspace requires a directory");
      }
      if (workspace !== undefined) {
        throw new Error("task-worker accepts at most one --workspace option");
      }
      workspace = value;
      continue;
    }
    if (arg === "--todoist") {
      if (todoist) {
        throw new Error("task-worker accepts at most one --todoist option");
      }
      todoist = true;
      continue;
    }
    throw new Error(`Unknown task-worker option: ${arg}`);
  }

  if (workspace === undefined) {
    throw new Error("task-worker requires --workspace <directory>");
  }
  return { workspace, ...(todoist ? { todoist: true as const } : {}) };
}

function textResponse(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: undefined },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
        },
      ],
    }),
  };
}

/**
 * The mock worker model always emits plain text. It intentionally does not
 * reuse createDemoModel: that model emits an unrelated `add` call. Even when
 * Todoist is enabled, this mock does not pretend to have queried it.
 */
export function createScheduledDemoModel() {
  return new MockLanguageModelV3({
    doStream: async () => textResponse("Scheduled task completed."),
  });
}

function configureModel(): {
  modelAlias: string;
  model: ReturnType<typeof createScheduledDemoModel> | ReturnType<typeof createConfiguredModel>;
} {
  const modelMode = process.env.RUNLOOM_MODEL ?? "mock";
  if (modelMode !== "mock" && modelMode !== "minimax-m3") {
    throw new Error(
      `Unsupported RUNLOOM_MODEL: ${modelMode}. Use mock or minimax-m3`,
    );
  }

  if (modelMode === "mock") {
    return { modelAlias: "mock/default", model: createScheduledDemoModel() };
  }

  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "MINIMAX_API_KEY is required when RUNLOOM_MODEL=minimax-m3",
    );
  }
  return {
    modelAlias: "minimax/m3",
    model: createConfiguredModel({
      adapter: "openai-compatible",
      baseURL: process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1",
      modelId: process.env.MINIMAX_MODEL_ID ?? "MiniMax-M3",
      apiKey,
    }),
  };
}

export const todoistTaskWorkerInstructions = [
  "Respond to the supplied prompt in plain text.",
  "When the prompt requires current Todoist information, query Todoist during this Run.",
  "For a daily plan, call todoist_list_tasks exactly once with { view: \"planning\" }, then summarize that result.",
  "Do not replace the current planning query with historical results and do not split it into today, overdue, or upcoming queries.",
  "Build the plan only from the returned tasks; do not invent tasks.",
  "Include asOf, timeZone, window, truncated, the returned task count, and task ids or URLs for factual task references.",
  "Use these five sections: 今日三件最重要的事, 上午 / 下午 / 晚上, 逾期处理, 未来 7 天风险, and 15 分钟立即行动.",
  "If the query fails, report the failure accurately and do not retry the same query.",
  "Do not save files and do not wait for interactive confirmation.",
].join(" ");

export interface CreateTaskWorkerAgentOptions {
  modelAlias: string;
  model: LanguageModel;
  store: AgentStore;
  todoist?: TodoistModuleOptions;
}

export function createTaskWorkerAgent(
  options: CreateTaskWorkerAgentOptions,
): { runtime: DefaultAgentRuntime; dispose(): void } {
  const moduleHost = options.todoist === undefined
    ? undefined
    : createModuleHost([createTodoistModule(options.todoist)], {
        notify: () => {},
      });

  try {
    const registeredTools = moduleHost?.tools ?? [];
    if (options.todoist !== undefined) {
      const registered = registeredTools[0];
      if (
        registeredTools.length !== 1 ||
        registered?.metadata.name !== "todoist_list_tasks" ||
        registered.metadata.version !== "1" ||
        registered.metadata.risk !== "read"
      ) {
        throw new Error(
          "Invalid Todoist worker tools: expected exactly todoist_list_tasks v1 read",
        );
      }
    }

    const tools = options.todoist === undefined
      ? [] as const
      : ["todoist_list_tasks"] as const;
    const definition = {
      id: "scheduled-responder",
      version: "1",
      instructions: options.todoist === undefined
        ? "Respond to the supplied prompt in plain text."
        : todoistTaskWorkerInstructions,
      model: options.modelAlias,
      tools,
      limits: {
        maxSteps: options.todoist === undefined ? 1 : 4,
        totalTimeoutMs: 120_000,
        stepTimeoutMs: 30_000,
        maxOutputTokens: 2_048,
      },
    } as const;
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      store: options.store,
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({
          [options.modelAlias]: options.model,
        }),
        tools: new ToolRegistry(registeredTools),
      }),
    });

    return {
      runtime,
      dispose: () => moduleHost?.dispose(),
    };
  } catch (error) {
    moduleHost?.dispose();
    throw error;
  }
}

export async function startTaskWorker(args: readonly string[]): Promise<void> {
  const { workspace, todoist = false } = parseTaskWorkerArgs(args);
  const workspaceRoot = await resolveWorkspace(workspace);
  // Validate the model configuration before creating or acquiring the worker
  // lock, so a bad environment cannot temporarily claim a workspace.
  const { modelAlias, model } = configureModel();
  let todoistOptions: TodoistModuleOptions | undefined;
  let todoistTimeZone: string | undefined;
  if (todoist) {
    const apiToken = process.env.TODOIST_API_TOKEN?.trim();
    if (!apiToken) {
      throw new Error("TODOIST_API_TOKEN is required when --todoist is enabled");
    }
    const requestedTimeZone =
      process.env.RUNLOOM_TODOIST_TIMEZONE?.trim() || "Asia/Shanghai";
    todoistTimeZone = canonicalTimeZone(requestedTimeZone);
    if (!todoistTimeZone) {
      throw new Error(`Invalid RUNLOOM_TODOIST_TIMEZONE: ${requestedTimeZone}`);
    }
    todoistOptions = { apiToken, timeZone: todoistTimeZone };
  }
  const runloomDirectory = join(workspaceRoot, ".runloom");
  const taskStore = createTaskStore(workspaceRoot);
  const transcriptStore = new JsonlAgentStore({
    directory: join(runloomDirectory, "task-transcripts"),
  });
  const agent = createTaskWorkerAgent({
    modelAlias,
    model,
    store: transcriptStore,
    ...(todoistOptions === undefined ? {} : { todoist: todoistOptions }),
  });
  let lock: Awaited<ReturnType<typeof tryAcquireFlock>>;
  try {
    lock = await tryAcquireFlock(taskWorkerLockPath(workspaceRoot));
  } catch (error) {
    agent.dispose();
    throw error;
  }
  if (lock === null) {
    agent.dispose();
    throw new Error("WORKER_ALREADY_RUNNING: another task worker owns this workspace");
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort("worker_stopped");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    if (todoistTimeZone !== undefined) {
      process.stdout.write(
        `Todoist worker enabled (planning time zone: ${todoistTimeZone}). ` +
        "Todoist read access applies to every task claimed by this worker; " +
        "Todoist data is sent to the configured model and stored locally in " +
        "the existing task result and transcript.\n",
      );
    }

    await runTaskWorker({
      store: taskStore,
      runtime: agent.runtime,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      agent.dispose();
    } finally {
      await lock.release();
    }
  }
}

const isEntry = process.argv[1] !== undefined &&
  process.argv[1].endsWith("task-worker-entry.js");
if (isEntry) {
  try {
    await startTaskWorker(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`task-worker failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
