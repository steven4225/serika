import assert from "node:assert/strict";
import { it } from "node:test";
import { simulateReadableStream, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  DefaultAgentRuntime,
  InMemoryAgentCatalog,
  InMemoryAgentStore,
  type AgentEvent,
} from "@aisdk-agent/core";
import {
  AiSdkAgentLoop,
  InMemoryModelRegistry,
  ToolRegistry,
} from "@aisdk-agent/ai-sdk-adapter";
import { createModuleHost } from "./module-host.js";
import { createWebModule } from "./modules/web-module.js";

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

function toolCall(name: string, id: string, input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "tool-call" as const, toolCallId: id, toolName: name, input: JSON.stringify(input) },
        { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage },
      ],
    }),
  };
}

function answer(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: text },
        { type: "text-end" as const, id: "answer" },
        { type: "finish" as const, finishReason: { unified: "stop" as const, raw: undefined }, usage },
      ],
    }),
  };
}

it("forwards search, failed page, and successful page results through one Run", async () => {
  const first = "https://example.org/failed";
  const second = "https://example.org/source";
  const requests: unknown[] = [];
  const model = new MockLanguageModelV3({
    doStream: async (options) => {
      requests.push(options);
      switch (requests.length) {
        case 1: return toolCall("web_search", "search-1", { query: "event loop", limit: 2 });
        case 2: return toolCall("web_fetch", "fetch-1", { url: first });
        case 3: return toolCall("web_fetch", "fetch-2", { url: second });
        default: return answer(`The event loop processes callbacks. Source: ${second}. The first page could not be verified.`);
      }
    },
  });
  const moduleHost = createModuleHost([createWebModule({
    searchEnabled: true,
    searchFetch: async () => new Response(`event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: `Title: First\nURL: ${first}\nHighlights:\ncandidate only\n\nTitle: Second\nURL: ${second}\nHighlights:\ncandidate only` }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } }),
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: async (url) => String(url) === first
      ? new Response("unavailable", { status: 503, headers: { "content-type": "text/plain" } })
      : new Response("<h1>Event loop</h1><p>The event loop processes callbacks.</p>", {
          headers: { "content-type": "text/html" },
        }),
  })], { notify: () => undefined });
  try {
    const store = new InMemoryAgentStore();
    const confirmations: string[] = [];
    const runtime = new DefaultAgentRuntime({
      store,
      catalog: new InMemoryAgentCatalog([{
        id: "web-loop-check", version: "1", model: "test", instructions: "Search, open pages, cite fetched text.",
        tools: ["web_search", "web_fetch"],
        limits: { maxSteps: 5, totalTimeoutMs: 10_000, stepTimeoutMs: 2_000 },
      }]),
      loop: new AiSdkAgentLoop({
        models: new InMemoryModelRegistry({ test: model }),
        tools: new ToolRegistry(moduleHost.tools),
      }),
      beforeToolExecute: ({ toolName }) => { confirmations.push(toolName); return { allow: true }; },
    });
    const handle = await runtime.run({
      agentId: "web-loop-check", threadId: "web-loop-check",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "Find an event loop source and answer." }] }],
    });
    const events: AgentEvent[] = [];
    const drain = (async () => { for await (const event of handle.events) events.push(event); })();
    const result = await handle.result;
    await drain;
    assert.equal(result.status, "completed");
    assert.equal(result.steps, 4);
    assert.deepEqual(confirmations, ["web_search", "web_fetch", "web_fetch"]);
    assert.equal(requests.length, 4);
    assert.ok(JSON.stringify(requests[0]).includes("web_search"));
    assert.ok(JSON.stringify(requests[0]).includes("web_fetch"));
    assert.match(JSON.stringify(requests[2]), /HTTP_STATUS/);
    assert.match(JSON.stringify(requests[3]), /The event loop processes callbacks/);
    assert.match(result.text, /Source: https:\/\/example\.org\/source/);
    assert.match(result.text, /first page could not be verified/);
    assert.equal(events.filter((event) => event.type === "tool.call.completed").length, 3);
    const transcript: UIMessage[] = await store.getMessages("web-loop-check");
    assert.match(JSON.stringify(transcript), /HTTP_STATUS/);
    assert.match(JSON.stringify(transcript), /The event loop processes callbacks/);
  } finally {
    moduleHost.dispose();
  }
});
