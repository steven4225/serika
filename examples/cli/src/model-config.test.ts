import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { streamText, tool } from "ai";
import { z } from "zod";
import { DefaultAgentRuntime, InMemoryAgentCatalog, InMemoryAgentStore } from "@aisdk-agent/core";
import { AiSdkAgentLoop, InMemoryModelRegistry, ToolRegistry } from "@aisdk-agent/ai-sdk-adapter";
import { configureCliModel } from "./model-config.js";
import { createDemoModel } from "./demo-model.js";
import { createScheduledDemoModel } from "./task-worker-entry.js";

function response(delta: object, finishReason = "stop"): Response {
  const chunks = [
    { id: "chat-test", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "chat-test", choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("CLI model configuration", () => {
  it("retains each entry's own mock and never silently falls back for invalid configuration", () => {
    for (const factory of [createDemoModel, createScheduledDemoModel]) {
      const mock = factory();
      assert.deepEqual(configureCliModel(() => mock, {}), { modelAlias: "mock/default", model: mock });
    }
    assert.throws(() => configureCliModel(createDemoModel, { RUNLOOM_MODEL: "unknown" }), /Unsupported RUNLOOM_MODEL/);
    for (const mode of ["deepseek", "minimax-m3"]) {
      assert.throws(() => configureCliModel(createDemoModel, {
        RUNLOOM_MODEL: mode, DEEPSEEK_API_KEY: " ", MINIMAX_API_KEY: " ",
      }), new RegExp(`${mode === "deepseek" ? "DEEPSEEK" : "MINIMAX"}_API_KEY is required`));
    }
    assert.throws(() => configureCliModel(createDemoModel, {
      RUNLOOM_MODEL: "deepseek", MINIMAX_API_KEY: "must-not-use-this-key",
    }), /DEEPSEEK_API_KEY is required/);
  });

  it("preserves MiniMax defaults and supports provider-specific endpoint/model overrides", async () => {
    for (const sample of [
      { env: { RUNLOOM_MODEL: "minimax-m3", MINIMAX_API_KEY: "test-key" },
        url: "https://api.minimax.io/v1/chat/completions", modelId: "MiniMax-M3", alias: "minimax/m3", thinking: undefined },
      { env: { RUNLOOM_MODEL: "minimax-m3", MINIMAX_API_KEY: "test-key", MINIMAX_BASE_URL: "https://minimax.test/v1", MINIMAX_MODEL_ID: "custom-mini" },
        url: "https://minimax.test/v1/chat/completions", modelId: "custom-mini", alias: "minimax/m3", thinking: undefined },
      { env: { RUNLOOM_MODEL: "deepseek", DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "https://deepseek.test/v1", DEEPSEEK_MODEL_ID: "deepseek-v4-pro" },
        url: "https://deepseek.test/v1/chat/completions", modelId: "deepseek-v4-pro", alias: "deepseek/default", thinking: { type: "disabled" } },
    ]) {
      let calls = 0;
      const configured = configureCliModel(createDemoModel, sample.env, {
        fetch: async (url, init) => {
          calls += 1;
          assert.equal(String(url), sample.url);
          const body = JSON.parse(String(init?.body));
          assert.equal(body.model, sample.modelId);
          assert.deepEqual(body.thinking, sample.thinking);
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");
          return response({ role: "assistant", content: "hello" });
        },
      });
      assert.equal(configured.modelAlias, sample.alias);
      assert.equal(calls, 0);
      assert.equal(await streamText({ model: configured.model, prompt: "hello", maxRetries: 0 }).text, "hello");
      assert.equal(calls, 1);
    }
  });

  it("runs a streamed DeepSeek tool call and sends its result through the existing Run loop", async () => {
    const requests: { messages: { role: string; tool_call_id?: string; content: string }[] }[] = [];
    const { modelAlias, model } = configureCliModel(createDemoModel, {
      RUNLOOM_MODEL: "deepseek", DEEPSEEK_API_KEY: " test-deepseek-key ", MINIMAX_API_KEY: "wrong-key",
    }, {
      fetch: async (url, init) => {
        assert.equal(String(url), "https://api.deepseek.com/chat/completions");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-deepseek-key");
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        assert.equal(body.model, "deepseek-flash");
        assert.equal(body.stream, true);
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.deepEqual(body.stream_options, { include_usage: true });
        return requests.length === 1
          ? response({ role: "assistant", tool_calls: [{ index: 0, id: "call-double", type: "function",
              function: { name: "double", arguments: '{"value":2}' } }] }, "tool_calls")
          : response({ role: "assistant", content: "4" });
      },
    });
    let executions = 0;
    let confirmations = 0;
    const store = new InMemoryAgentStore();
    const runtime = new DefaultAgentRuntime({
      store,
      catalog: new InMemoryAgentCatalog([{
        id: "protocol-test", version: "1", instructions: "Use double", model: modelAlias, tools: ["double"],
        limits: { maxSteps: 3, totalTimeoutMs: 5_000, stepTimeoutMs: 2_000 },
      }]),
      beforeToolExecute: () => { confirmations += 1; return { allow: true }; },
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ [modelAlias]: model }),
        tools: new ToolRegistry([{
          metadata: { name: "double", version: "1", risk: "read", timeoutMs: 1_000, idempotent: true },
          tool: tool({
            inputSchema: z.object({ value: z.number() }),
            execute: ({ value }) => { executions += 1; return { value: value * 2 }; },
          }),
        }]),
      }),
    });
    const handle = await runtime.run({
      agentId: "protocol-test", threadId: "deepseek-test",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Double 2" }] }],
    });
    assert.equal((await handle.result).status, "completed");
    assert.equal(requests.length, 2);
    assert.equal(executions, 1);
    assert.equal(confirmations, 1);
    const resultMessage = requests[1]!.messages.find((message) => message.role === "tool");
    assert.ok(resultMessage);
    assert.equal(resultMessage.tool_call_id, "call-double");
    assert.deepEqual(JSON.parse(resultMessage.content), { value: 4 });
    const transcript = await store.getMessages("deepseek-test");
    assert.ok(transcript.some((message) => message.parts.some((part) => part.type === "text" && part.text === "4")));
  });
});
