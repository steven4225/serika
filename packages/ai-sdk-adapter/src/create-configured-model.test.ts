import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { streamText } from "ai";
import { AgentError } from "@aisdk-agent/core";
import {
  createConfiguredModel,
  type ModelConnectionConfig,
} from "./create-configured-model.js";

const baseConfig = {
  adapter: "openai-compatible" as const,
  baseURL: " https://example.test/v1/ ",
  modelId: " demo-model ",
};

function assertInvalid(config: unknown): void {
  assert.throws(
    () => createConfiguredModel(config as ModelConnectionConfig),
    (error: unknown) =>
      error instanceof AgentError &&
      error.data.code === "INVALID_REQUEST" &&
      error.data.phase === "runtime",
  );
}

function sseResponse(): Response {
  const body = [
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      created: 0,
      model: "demo-model",
      choices: [
        {
          delta: { role: "assistant", content: "hello" },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      choices: [
        { delta: { content: " world" }, finish_reason: null },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n");

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createConfiguredModel", () => {
  it("rejects invalid connection configuration with INVALID_REQUEST", () => {
    assertInvalid({ ...baseConfig, adapter: "anthropic" });
    assertInvalid({ ...baseConfig, adapter: 42 });
    assertInvalid({ ...baseConfig, baseURL: "   " });
    assertInvalid({ ...baseConfig, baseURL: "ftp://example.test/v1" });
    assertInvalid({ ...baseConfig, baseURL: "not a URL" });
    assertInvalid({ ...baseConfig, modelId: "   " });
    assertInvalid({ ...baseConfig, modelId: 42 });
    assertInvalid({ ...baseConfig, apiKey: 42 });
  });

  it("does not call the injected fetch while constructing a model", () => {
    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return sseResponse();
    };

    createConfiguredModel(baseConfig, { fetch: fetchImpl });

    assert.equal(fetchCalls, 0);
  });

  it("sends an OpenAI-compatible streaming request and parses text and usage", async () => {
    let requestUrl: string | undefined;
    let requestInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return sseResponse();
    };

    const model = createConfiguredModel(
      { ...baseConfig, apiKey: " secret-key " },
      { fetch: fetchImpl },
    );
    const result = streamText({
      model,
      prompt: "hello",
      maxRetries: 0,
    });

    assert.equal(await result.text, "hello world");
    const parsedUsage = await result.usage;
    assert.equal(parsedUsage.inputTokens, 3);
    assert.equal(parsedUsage.outputTokens, 2);
    assert.equal(parsedUsage.totalTokens, 5);

    assert.equal(requestUrl, "https://example.test/v1/chat/completions");
    assert.ok(requestInit);
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
    assert.equal(body.model, "demo-model");
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(
      new Headers(requestInit.headers).get("authorization"),
      "Bearer secret-key",
    );
  });

  it("omits authorization when the API key is absent or blank", async () => {
    for (const config of [
      baseConfig,
      { ...baseConfig, apiKey: "   " },
    ]) {
      let requestInit: RequestInit | undefined;
      const model = createConfiguredModel(config, {
        fetch: async (_input, init) => {
          requestInit = init;
          return sseResponse();
        },
      });

      await streamText({ model, prompt: "hello", maxRetries: 0 }).text;

      assert.ok(requestInit);
      assert.equal(new Headers(requestInit.headers).get("authorization"), null);
    }
  });
});
