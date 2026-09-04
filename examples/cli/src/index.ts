import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simulateReadableStream, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  JsonlAgentStore,
} from "@aisdk-agent/core";
import {
  AiSdkAgentLoop,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@aisdk-agent/ai-sdk-adapter";
import { runTui } from "./tui.js";

function usage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

function createDemoModel() {
  let callCount = 0;
  return new MockLanguageModelV3({
    doStream: async (options) => {
      callCount += 1;
      if (callCount === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              {
                type: "tool-call" as const,
                toolCallId: "call-add",
                toolName: "add",
                input: JSON.stringify({ left: 20, right: 22 }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: undefined },
                usage: usage(10, 5),
              },
            ],
          }),
        };
      }
      if (callCount === 2) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start" as const, warnings: [] },
              { type: "text-start" as const, id: "answer-1" },
              {
                type: "text-delta" as const,
                id: "answer-1",
                delta: "20 + 22 = 42",
              },
              { type: "text-end" as const, id: "answer-1" },
              {
                type: "finish" as const,
                finishReason: { unified: "stop" as const, raw: undefined },
                usage: usage(15, 8),
              },
            ],
          }),
        };
      }

      const prompt = JSON.stringify(options.prompt);
      if (!prompt.includes('"value":42')) {
        throw new Error("Second prompt did not receive the previous tool result");
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start" as const, warnings: [] },
            { type: "text-start" as const, id: "answer-2" },
            {
              type: "text-delta" as const,
              id: "answer-2",
              delta: "The previous result was 42.",
            },
            { type: "text-end" as const, id: "answer-2" },
            {
              type: "finish" as const,
              finishReason: { unified: "stop" as const, raw: undefined },
              usage: usage(15, 8),
            },
          ],
        }),
      };
    },
  });
}

const model = createDemoModel();

function parseTuiArgs(args: readonly string[]): {
  directory?: string;
  threadId?: string;
} {
  const parsedArgs = args[0] === "--" ? args.slice(1) : args;
  let directory: string | undefined;
  let threadId: string | undefined;
  for (let index = 0; index < parsedArgs.length; index += 1) {
    const arg = parsedArgs[index];
    if (arg === "--thread") {
      const value = parsedArgs[++index];
      if (!value || value.startsWith("--")) {
        throw new Error("--thread requires an id");
      }
      threadId = value;
      continue;
    }
    if (arg?.startsWith("--")) {
      throw new Error(`Unknown TUI option: ${arg}`);
    }
    if (directory !== undefined) {
      throw new Error("TUI accepts at most one transcript directory");
    }
    directory = arg;
  }
  return {
    ...(directory !== undefined ? { directory } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

const args = process.argv.slice(2);
const tuiMode = args[0] === "--tui";
const tuiArgs = tuiMode ? parseTuiArgs(args.slice(1)) : undefined;

const add = tool({
  description: "Add two numbers",
  inputSchema: z.object({ left: z.number(), right: z.number() }),
  outputSchema: z.object({ value: z.number() }),
  execute: async ({ left, right }) => ({ value: left + right }),
});

const catalog = new InMemoryAgentCatalog([
  {
    id: "calculator",
    version: "1",
    instructions: "Always use the add tool for addition, then answer briefly.",
    model: "mock/default",
    tools: ["add"],
    limits: {
      maxSteps: 4,
      totalTimeoutMs: 10_000,
      stepTimeoutMs: 5_000,
    },
  },
]);
const directory = tuiMode
  ? (tuiArgs?.directory ?? (await mkdtemp(join(tmpdir(), "runloom-tui-"))))
  : (args[0] ?? (await mkdtemp(join(tmpdir(), "runloom-demo-"))));
const threadId = tuiMode ? (tuiArgs?.threadId ?? randomUUID()) : "demo-thread";
const store = new JsonlAgentStore({ directory });
const models = new InMemoryModelRegistry({ "mock/default": model });
const tools = new ToolRegistry([
  {
    metadata: {
      name: "add",
      version: "1",
      risk: "read",
      timeoutMs: 1_000,
      idempotent: true,
    },
    tool: add,
  },
]);
const runtime = new DefaultAgentRuntime({
  catalog,
  store,
  loop: new AiSdkAgentLoop({ models, tools }),
});

async function runMessage(id: string, text: string) {
  const handle = await runtime.run({
    agentId: "calculator",
    threadId: "demo-thread",
    messages: [
      {
        id,
        role: "user",
        parts: [{ type: "text", text }],
      },
    ],
  });
  const consumeEvents = (async () => {
    for await (const event of handle.events) {
      console.log(`[${event.sequence}] ${event.type}`, event.data);
    }
  })();
  const result = await handle.result;
  await consumeEvents;
  console.log("\nResult:", result);
}

if (tuiMode) {
  console.log(`Thread: ${threadId}`);
  console.log(`Transcript directory: ${directory}`);
  await runTui({ runtime, store, threadId, agentId: "calculator" });
} else {
  await runMessage("user-1", "What is 20 + 22?");
  await runMessage("user-2", "What was the previous result?");
  console.log(`\nTranscript directory: ${directory}`);
}
