import { join } from "node:path";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  JsonlAgentStore,
} from "@aisdk-agent/core";
import {
  AiSdkAgentLoop,
  createConfiguredModel,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@aisdk-agent/ai-sdk-adapter";
import { resolveWorkspace } from "./cli-options.js";
import { createTaskStore, taskWorkerLockPath } from "./task-store.js";
import { runTaskWorker } from "./task-worker.js";
import { tryAcquireFlock } from "./flock.js";

interface TaskWorkerArgs {
  workspace: string;
}

export function parseTaskWorkerArgs(args: readonly string[]): TaskWorkerArgs {
  const parsed = args[0] === "--" ? args.slice(1) : args;
  let workspace: string | undefined;
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
    throw new Error(`Unknown task-worker option: ${arg}`);
  }

  if (workspace === undefined) {
    throw new Error("task-worker requires --workspace <directory>");
  }
  return { workspace };
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
 * reuse createDemoModel: that model emits an `add` call and would violate the
 * worker's empty-tool catalog contract.
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

export async function startTaskWorker(args: readonly string[]): Promise<void> {
  const { workspace } = parseTaskWorkerArgs(args);
  const workspaceRoot = await resolveWorkspace(workspace);
  // Validate the model configuration before creating or acquiring the worker
  // lock, so a bad environment cannot temporarily claim a workspace.
  const { modelAlias, model } = configureModel();
  const runloomDirectory = join(workspaceRoot, ".runloom");
  const lock = await tryAcquireFlock(taskWorkerLockPath(workspaceRoot));
  if (lock === null) {
    throw new Error("WORKER_ALREADY_RUNNING: another task worker owns this workspace");
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort("worker_stopped");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    const taskStore = createTaskStore(workspaceRoot);
    const transcriptStore = new JsonlAgentStore({
      directory: join(runloomDirectory, "task-transcripts"),
    });
    const definition = {
      id: "scheduled-responder",
      version: "1",
      instructions: "Respond to the supplied prompt in plain text.",
      model: modelAlias,
      tools: [] as const,
      limits: {
        maxSteps: 1,
        totalTimeoutMs: 120_000,
        stepTimeoutMs: 30_000,
        maxOutputTokens: 2_048,
      },
    } as const;
    const runtime = new DefaultAgentRuntime({
      catalog: new InMemoryAgentCatalog([definition]),
      store: transcriptStore,
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ [modelAlias]: model }),
        tools: new ToolRegistry([]),
      }),
    });

    await runTaskWorker({
      store: taskStore,
      runtime,
      signal: controller.signal,
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lock.release();
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
