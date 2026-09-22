import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXA_MCP_SEARCH_URL,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_MAX_SNIPPET_LENGTH,
  WEB_SEARCH_MAX_TITLE_LENGTH,
  webSearch,
  type WebSearchResponse,
} from "./web-search.js";

function mcpResponse(text: string, options: { status?: number; isError?: boolean; sse?: boolean } = {}): Response {
  const rpc = JSON.stringify({ result: { content: [{ type: "text", text }], isError: options.isError ?? false } });
  return new Response(options.sse === false ? rpc : `event: message\ndata: ${rpc}\n\n`, {
    status: options.status ?? 200,
    headers: { "content-type": options.sse === false ? "application/json" : "text/event-stream" },
  });
}

function errorCode(result: WebSearchResponse): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("webSearch through keyless Exa MCP", () => {
  it("sends one tools/call without credentials and maps bounded discovery results", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const result = await webSearch({ query: " Runloom agents ", limit: 2 }, {
      fetch: async (input, init) => {
        requestedUrl = String(input);
        requestedInit = init;
        return mcpResponse(
          `Title: ${"T".repeat(WEB_SEARCH_MAX_TITLE_LENGTH + 20)}\nURL: https://example.com/first\nHighlights:\n${"S".repeat(WEB_SEARCH_MAX_SNIPPET_LENGTH + 20)}\n\n` +
          "Title: second\nURL: https://example.com/second\nHighlights:\nA second result",
        );
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.query, "Runloom agents");
    assert.deepEqual(result.value.results[1], {
      title: "second", url: "https://example.com/second", snippet: "A second result",
    });
    assert.equal(result.value.results[0]?.title.length, WEB_SEARCH_MAX_TITLE_LENGTH);
    assert.equal(result.value.results[0]?.snippet.length, WEB_SEARCH_MAX_SNIPPET_LENGTH);
    assert.equal(result.value.truncated, false);
    assert.equal(requestedUrl, EXA_MCP_SEARCH_URL);
    assert.equal(requestedInit?.method, "POST");
    assert.equal(requestedInit?.redirect, "error");
    assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "web_search_exa", arguments: { query: "Runloom agents", numResults: 2 } },
    });
    const headers = requestedInit?.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Accept, "application/json, text/event-stream");
    assert.equal(headers["x-api-key"], undefined);
  });

  it("accepts JSON RPC, empty results, and caps returned links", async () => {
    const empty = await webSearch({ query: "nothing" }, { fetch: async () => mcpResponse("", { sse: false }) });
    assert.deepEqual(empty, { ok: true, value: { query: "nothing", results: [], truncated: false } });
    const text = Array.from({ length: WEB_SEARCH_MAX_RESULTS + 2 }, (_, index) =>
      `Title: result ${index}\nURL: https://example.com/${index}\nHighlights:\nSummary ${index}`,
    ).join("\n\n");
    const capped = await webSearch({ query: "many", limit: WEB_SEARCH_MAX_RESULTS }, {
      fetch: async () => mcpResponse(text),
    });
    assert.equal(capped.ok, true);
    if (capped.ok) {
      assert.equal(capped.value.results.length, WEB_SEARCH_MAX_RESULTS);
      assert.equal(capped.value.truncated, true);
    }
  });

  it("filters invalid URLs and distinguishes malformed RPC from tool errors", async () => {
    const filtered = await webSearch({ query: "links", limit: 1 }, {
      fetch: async () => mcpResponse(
        "Title: private\nURL: file:///etc/passwd\nHighlights:\nno\n\n" +
        "Title: public\nURL: https://example.com/article\nHighlights:\nyes",
      ),
    });
    assert.equal(filtered.ok, true);
    if (filtered.ok) {
      assert.deepEqual(filtered.value.results.map((item) => item.url), ["https://example.com/article"]);
      assert.equal(filtered.value.truncated, false);
    }
    const malformed = await webSearch({ query: "malformed" }, {
      fetch: async () => new Response("not an MCP response"),
    });
    assert.equal(errorCode(malformed), "INVALID_RESPONSE");
    const toolError = await webSearch({ query: "error" }, {
      fetch: async () => mcpResponse("upstream unavailable", { isError: true }),
    });
    assert.equal(errorCode(toolError), "UPSTREAM_ERROR");
    const rpcError = await webSearch({ query: "rpc" }, {
      fetch: async () => new Response(JSON.stringify({ error: { code: -32000, message: "tool missing" } })),
    });
    assert.equal(errorCode(rpcError), "UPSTREAM_ERROR");
  });

  it("validates input and maps HTTP, network, timeout, and caller cancellation", async () => {
    let calls = 0;
    for (const input of [
      { query: "" }, { query: "   " }, { query: "x", limit: 0 },
      { query: "x", limit: 11 }, { query: "x", limit: 1.5 },
    ]) {
      const result = await webSearch(input, { fetch: async () => { calls++; return mcpResponse(""); } });
      assert.equal(errorCode(result), "INVALID_INPUT");
    }
    assert.equal(calls, 0);
    const rateLimited = await webSearch({ query: "rate" }, {
      fetch: async () => new Response("slow down", { status: 429 }),
    });
    assert.equal(errorCode(rateLimited), "RATE_LIMITED");
    if (!rateLimited.ok) assert.equal(rateLimited.error.status, 429);
    const upstream = await webSearch({ query: "upstream" }, {
      fetch: async () => new Response("failure", { status: 503 }),
    });
    assert.equal(errorCode(upstream), "UPSTREAM_ERROR");
    const network = await webSearch({ query: "offline" }, {
      fetch: async () => { throw new Error("connection refused"); } });
    assert.equal(errorCode(network), "NETWORK_ERROR");
    const timeout = await webSearch({ query: "slow" }, {
      timeoutMs: 5,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    });
    assert.equal(errorCode(timeout), "TIMEOUT");
    const controller = new AbortController();
    controller.abort(new Error("user stopped"));
    await assert.rejects(webSearch({ query: "cancelled" }, { signal: controller.signal }), /user stopped/);
  });
});
